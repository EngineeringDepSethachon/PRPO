/**
 * Dual-UOM Calculation & Conversion Engine
 * Single Source of Truth for:
 * 1. Dual-UOM quantity conversions (Purchase Unit <-> Stock Unit)
 * 2. Dual-UOM unit cost calculations
 * 3. Strict guardrails against conversionRate <= 0 (fallback to 1 to prevent division by zero / Infinity)
 */

/**
 * Validates and normalizes conversion rate.
 * Guarantees a strictly positive number (> 0), falling back to 1.0 if rate <= 0 or invalid.
 *
 * @param {number|object} rateOrProduct - Conversion rate number or product object containing conversionRate / conversionRatio
 * @returns {number} Normalized rate guaranteed > 0
 */
export function getValidConversionRate(rateOrProduct) {
  let rate;
  if (typeof rateOrProduct === 'object' && rateOrProduct !== null) {
    rate = Number(rateOrProduct.conversionRate || rateOrProduct.conversionRatio || 1);
  } else {
    rate = Number(rateOrProduct);
  }

  // Guard against conversionRate <= 0 or NaN/Infinity to prevent division errors
  if (isNaN(rate) || !isFinite(rate) || rate <= 0) {
    return 1;
  }
  return rate;
}

/**
 * Convert purchase quantity to stock quantity.
 * Formula: purchaseQty * (conversionRate || 1)
 *
 * @param {number|string} purchaseQty - Quantity in purchase units
 * @param {number|object} conversionRate - Rate or product object
 * @returns {number} Quantity in stock units
 */
export function toStockQuantity(purchaseQty, conversionRate = 1) {
  const rate = getValidConversionRate(conversionRate);
  const qty = Number(purchaseQty) || 0;
  return Math.round(qty * rate * 1000) / 1000;
}

/**
 * Convert purchase price to unit cost in stock units.
 * Formula: purchasePrice / (conversionRate || 1)
 *
 * @param {number|string} purchasePrice - Price in purchase units
 * @param {number|object} conversionRate - Rate or product object
 * @returns {number} Cost per stock unit
 */
export function toStockUnitCost(purchasePrice, conversionRate = 1) {
  const rate = getValidConversionRate(conversionRate);
  const price = Number(purchasePrice) || 0;
  return Math.round((price / rate) * 1000) / 1000;
}

/**
 * Convert stock quantity back to purchase quantity equivalent.
 * Formula: stockQty / (conversionRate || 1)
 *
 * @param {number|string} stockQty - Quantity in stock units
 * @param {number|object} conversionRate - Rate or product object
 * @returns {number} Quantity in purchase units
 */
export function toPurchaseQuantity(stockQty, conversionRate = 1) {
  const rate = getValidConversionRate(conversionRate);
  const qty = Number(stockQty) || 0;
  return Math.round((qty / rate) * 100) / 100;
}

// Backward-compatible aliases
export const toStockQty = toStockQuantity;
export const toPurchaseQty = toPurchaseQuantity;

/**
 * Format dual unit display for stock inventory.
 * e.g. "2,400 ลิตร (≈ 12 ถัง)" or "25 ชิ้น" (if 1:1)
 *
 * @param {number|string} stockQty - Current stock balance in stock units
 * @param {object} product - Product object
 * @returns {string} Formatted string
 */
export function formatDualStock(stockQty, product) {
  if (!product) return `${stockQty || 0}`;
  const sUnit = product.stockUnit || product.unit || 'ชิ้น';
  const pUnit = product.purchaseUnit || product.unit || sUnit;
  const rate = getValidConversionRate(product);

  const formattedStock = Number(stockQty || 0).toLocaleString();

  if (rate > 1 && pUnit !== sUnit) {
    const purchaseEquiv = toPurchaseQuantity(stockQty, rate);
    const purchaseStr = purchaseEquiv % 1 === 0
      ? purchaseEquiv.toLocaleString()
      : purchaseEquiv.toFixed(1).replace(/\.0$/, '');
    return `${formattedStock} ${sUnit} (≈ ${purchaseStr} ${pUnit})`;
  }

  return `${formattedStock} ${sUnit}`;
}

/**
 * Format conversion hint text for PR/PO creation.
 * e.g. "= 60 ลิตร เข้าคลัง"
 *
 * @param {number|string} purchaseQty - Quantity in purchase units
 * @param {object} product - Product object
 * @returns {string|null} Conversion hint or null if 1:1
 */
export function getPurchaseConversionHint(purchaseQty, product) {
  if (!product) return null;
  const rate = getValidConversionRate(product);
  const sUnit = product.stockUnit || product.unit || 'ชิ้น';
  const pUnit = product.purchaseUnit || product.unit || sUnit;

  if (rate > 1 || (pUnit && sUnit && pUnit !== sUnit)) {
    const sQty = toStockQuantity(purchaseQty, rate);
    return `= ${sQty.toLocaleString()} ${sUnit} เข้าคลัง`;
  }
  return null;
}

/**
 * Normalize product unit fields with safe defaults.
 *
 * @param {object} product - Raw product object
 * @returns {object} Normalized product object
 */
export function normalizeProductUnits(product) {
  if (!product) return product;
  const rawUnit = product.unit || 'ชิ้น';
  const sUnit = product.stockUnit || rawUnit;
  const pUnit = product.purchaseUnit || rawUnit;
  const rate = getValidConversionRate(product);

  return {
    ...product,
    purchaseUnit: pUnit,
    stockUnit: sUnit,
    unit: sUnit,
    conversionRate: rate
  };
}
