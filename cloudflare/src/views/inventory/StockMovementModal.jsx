import React from 'react';
import StockMovementTable from '../../components/stock/StockMovementTable';

/**
 * StockMovementModal (alias / view-level component for Stock Movement Log)
 * Re-exports StockMovementTable with support for both product and selectedProduct props,
 * ensuring seamless schema matching and self-healing ghost stock handling.
 */
export function StockMovementModal(props) {
  return <StockMovementTable {...props} />;
}

export default StockMovementModal;
