import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export default function Portal({ children }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  if (typeof document === 'undefined') {
    return children;
  }

  if (!mounted) return null;

  return createPortal(children, document.body);
}
