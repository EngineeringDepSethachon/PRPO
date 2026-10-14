/**
 * Unit Conversion & Formatting Utility (Facade / Re-export of uomEngine.js)
 * Maintained for full backward compatibility across all legacy consumers.
 */

export {
  getValidConversionRate,
  toStockQuantity,
  toStockUnitCost,
  toStockQty,
  toPurchaseQuantity,
  toPurchaseQty,
  formatDualStock,
  getPurchaseConversionHint,
  normalizeProductUnits
} from './uomEngine.js';
