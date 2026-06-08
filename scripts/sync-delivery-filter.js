/**
 * CINQ Shopify Delivery Filter Sync
 *
 * Purpose:
 * - Reads inventory quantities for every Shopify variant across two locations.
 * - Writes the variant metafield custom.delivery_filter for Search & Discovery filters.
 *
 * Mapping:
 * - Location 84664811651 => Доставка по Україні
 * - Location 91178336387 => Доставка з Європи/США
 *
 * Required Admin API scopes:
 * - read_products
 * - write_products
 * - read_inventory
 *
 * Important:
 * - Do not paste Admin API tokens into GitHub.
 * - Keep the token only in a local .env file or in GitHub Actions secrets.
 */

import 'dotenv/config';

const CONFIG = {
  SHOP_DOMAIN: process.env.SHOPIFY_SHOP_DOMAIN,
  ADMIN_API_ACCESS_TOKEN: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,

  API_VERSION: process.env.SHOPIFY_API_VERSION || '2026-04',

  // true = only logs what would be changed. false = writes metafields to Shopify.
  DRY_RUN: String(process.env.DRY_RUN || 'true').toLowerCase() !== 'false',

  UKRAINE_LOCATION_ID:
    process.env.UKRAINE_LOCATION_ID || 'gid://shopify/Location/84664811651',
  EUROPE_USA_LOCATION_ID:
    process.env.EUROPE_USA_LOCATION_ID || 'gid://shopify/Location/91178336387',

  METAFIELD_NAMESPACE: 'custom',
  METAFIELD_KEY: 'delivery_filter',
  METAFIELD_TYPE: 'single_line_text_field',

  LABEL_UKRAINE: 'Доставка по Україні',
  LABEL_EUROPE_USA: 'Доставка з Європи/США',

  VARIANTS_PAGE_SIZE: 50,
  INVENTORY_LEVELS_PAGE_SIZE: 20,
  METAFIELDS_BATCH_SIZE: 25,

  DELAY_BETWEEN_PAGES_MS: 300,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function adminApiUrl() {
  return `https://${CONFIG.SHOP_DOMAIN}/admin/api/${CONFIG.API_VERSION}/graphql.json`;
}

async function shopifyGraphQL(query, variables = {}) {
  const response = await fetch(adminApiUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': CONFIG.ADMIN_API_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await response.text();

  let json;

  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`Shopify returned non-JSON response:\n${text}`);
  }

  if (!response.ok) {
    throw new Error(`Shopify HTTP ${response.status}:\n${JSON.stringify(json, null, 2)}`);
  }

  if (json.errors) {
    throw new Error(`Shopify GraphQL errors:\n${JSON.stringify(json.errors, null, 2)}`);
  }

  return json.data;
}

function getAvailableQtyForLocation(inventoryLevels, locationId) {
  const level = inventoryLevels.find((inventoryLevel) => {
    return inventoryLevel.location && inventoryLevel.location.id === locationId;
  });

  if (!level || !Array.isArray(level.quantities)) {
    return 0;
  }

  const availableQuantity = level.quantities.find((quantity) => quantity.name === 'available');

  return Number(availableQuantity?.quantity || 0);
}

function calculateDeliveryFilter(variant) {
  const inventoryLevels = variant.inventoryItem?.inventoryLevels?.nodes || [];

  const ukraineQty = getAvailableQtyForLocation(
    inventoryLevels,
    CONFIG.UKRAINE_LOCATION_ID
  );

  const europeUsaQty = getAvailableQtyForLocation(
    inventoryLevels,
    CONFIG.EUROPE_USA_LOCATION_ID
  );

  if (ukraineQty > 0) {
    return {
      value: CONFIG.LABEL_UKRAINE,
      ukraineQty,
      europeUsaQty,
    };
  }

  if (europeUsaQty > 0) {
    return {
      value: CONFIG.LABEL_EUROPE_USA,
      ukraineQty,
      europeUsaQty,
    };
  }

  return {
    value: null,
    ukraineQty,
    europeUsaQty,
  };
}

function chunkArray(array, size) {
  const chunks = [];

  for (let index = 0; index < array.length; index += size) {
    chunks.push(array.slice(index, index + size));
  }

  return chunks;
}

async function setVariantMetafields(metafields) {
  if (!metafields.length) {
    return;
  }

  if (CONFIG.DRY_RUN) {
    console.log(`DRY_RUN: would set ${metafields.length} metafields`);
    return;
  }

  const mutation = `
    mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          ownerType
          namespace
          key
          value
        }
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  const chunks = chunkArray(metafields, CONFIG.METAFIELDS_BATCH_SIZE);

  for (const [index, chunk] of chunks.entries()) {
    const data = await shopifyGraphQL(mutation, { metafields: chunk });
    const errors = data.metafieldsSet.userErrors || [];

    if (errors.length) {
      throw new Error(`metafieldsSet errors:\n${JSON.stringify(errors, null, 2)}`);
    }

    console.log(`Saved metafields batch ${index + 1}/${chunks.length}`);
  }
}

async function deleteVariantMetafields(metafieldsToDelete) {
  if (!metafieldsToDelete.length) {
    return;
  }

  if (CONFIG.DRY_RUN) {
    console.log(`DRY_RUN: would delete ${metafieldsToDelete.length} metafields`);
    return;
  }

  const mutation = `
    mutation MetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
      metafieldsDelete(metafields: $metafields) {
        deletedMetafields {
          ownerId
          namespace
          key
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const chunks = chunkArray(metafieldsToDelete, CONFIG.METAFIELDS_BATCH_SIZE);

  for (const [index, chunk] of chunks.entries()) {
    const data = await shopifyGraphQL(mutation, { metafields: chunk });
    const errors = data.metafieldsDelete.userErrors || [];

    if (errors.length) {
      throw new Error(`metafieldsDelete errors:\n${JSON.stringify(errors, null, 2)}`);
    }

    console.log(`Deleted metafields batch ${index + 1}/${chunks.length}`);
  }
}

async function syncDeliveryFilter() {
  let hasNextPage = true;
  let cursor = null;

  let checkedVariants = 0;
  let setUkraine = 0;
  let setEuropeUsa = 0;
  let clearedNoStock = 0;

  const query = `
    query GetProductVariants($first: Int!, $after: String) {
      productVariants(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          title
          sku
          product {
            id
            title
            handle
          }
          inventoryItem {
            id
            inventoryLevels(first: ${CONFIG.INVENTORY_LEVELS_PAGE_SIZE}) {
              nodes {
                location {
                  id
                  name
                }
                quantities(names: ["available"]) {
                  name
                  quantity
                }
              }
            }
          }
        }
      }
    }
  `;

  while (hasNextPage) {
    const data = await shopifyGraphQL(query, {
      first: CONFIG.VARIANTS_PAGE_SIZE,
      after: cursor,
    });

    const variants = data.productVariants.nodes;

    const metafieldsToSet = [];
    const metafieldsToDelete = [];

    for (const variant of variants) {
      checkedVariants += 1;

      const result = calculateDeliveryFilter(variant);

      const productTitle = variant.product?.title || 'Unknown product';
      const variantTitle = variant.title || 'Default';
      const sku = variant.sku || '-';

      if (result.value) {
        metafieldsToSet.push({
          ownerId: variant.id,
          namespace: CONFIG.METAFIELD_NAMESPACE,
          key: CONFIG.METAFIELD_KEY,
          type: CONFIG.METAFIELD_TYPE,
          value: result.value,
        });

        if (result.value === CONFIG.LABEL_UKRAINE) {
          setUkraine += 1;
        }

        if (result.value === CONFIG.LABEL_EUROPE_USA) {
          setEuropeUsa += 1;
        }

        console.log(
          `[SET] ${productTitle} / ${variantTitle} / SKU ${sku} -> ${result.value} | UA=${result.ukraineQty} | EU/USA=${result.europeUsaQty}`
        );
      } else {
        metafieldsToDelete.push({
          ownerId: variant.id,
          namespace: CONFIG.METAFIELD_NAMESPACE,
          key: CONFIG.METAFIELD_KEY,
        });

        clearedNoStock += 1;

        console.log(
          `[CLEAR] ${productTitle} / ${variantTitle} / SKU ${sku} -> no stock | UA=${result.ukraineQty} | EU/USA=${result.europeUsaQty}`
        );
      }
    }

    await setVariantMetafields(metafieldsToSet);
    await deleteVariantMetafields(metafieldsToDelete);

    hasNextPage = data.productVariants.pageInfo.hasNextPage;
    cursor = data.productVariants.pageInfo.endCursor;

    console.log('');
    console.log('==============================');
    console.log(`Checked variants: ${checkedVariants}`);
    console.log(`Set Ukraine: ${setUkraine}`);
    console.log(`Set Europe/USA: ${setEuropeUsa}`);
    console.log(`Cleared no-stock: ${clearedNoStock}`);
    console.log(`Next page: ${hasNextPage ? 'yes' : 'no'}`);
    console.log('==============================');
    console.log('');

    await sleep(CONFIG.DELAY_BETWEEN_PAGES_MS);
  }

  console.log('');
  console.log('DONE');
  console.log(`Total checked variants: ${checkedVariants}`);
  console.log(`Total Ukraine: ${setUkraine}`);
  console.log(`Total Europe/USA: ${setEuropeUsa}`);
  console.log(`Total cleared: ${clearedNoStock}`);
}

async function main() {
  if (!CONFIG.SHOP_DOMAIN) {
    throw new Error('Заполни SHOPIFY_SHOP_DOMAIN в .env. Нужен домен вида your-store.myshopify.com');
  }

  if (!CONFIG.ADMIN_API_ACCESS_TOKEN) {
    throw new Error('Заполни SHOPIFY_ADMIN_API_ACCESS_TOKEN в .env');
  }

  console.log('Starting CINQ delivery filter sync...');
  console.log(`Shop: ${CONFIG.SHOP_DOMAIN}`);
  console.log(`Dry run: ${CONFIG.DRY_RUN ? 'YES' : 'NO'}`);
  console.log(`Ukraine location: ${CONFIG.UKRAINE_LOCATION_ID}`);
  console.log(`Europe/USA location: ${CONFIG.EUROPE_USA_LOCATION_ID}`);
  console.log('');

  await syncDeliveryFilter();
}

main().catch((error) => {
  console.error('');
  console.error('SYNC FAILED');
  console.error(error);
  process.exit(1);
});
