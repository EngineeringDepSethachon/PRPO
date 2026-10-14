import React from 'react';
import PrintablePO from '../components/po/PrintablePO';

export default function POPrintView({ po, ...props }) {
  return <PrintablePO po={po} {...props} />;
}

export { PrintablePO };
