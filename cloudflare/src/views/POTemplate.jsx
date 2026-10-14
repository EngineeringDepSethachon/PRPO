import React from 'react';
import PrintablePO from '../components/po/PrintablePO';

export default function POTemplate({ po, ...props }) {
  return <PrintablePO po={po} {...props} />;
}

export { PrintablePO, PrintablePO as POTemplate };
