import React from 'react';
import { RouterProvider } from 'react-router-dom';
import { router } from './routes';

/**
 * Root Application Component
 * Delegates all client-side navigation, layouts, and route guards to React Router DOM (HashRouter).
 * (The one-off MAC "migration" for the sample product "ถุงมือกันร้อน" that used to run here on every start is gone :
 *  on Cloudflare it called POST /api/products/recalculate-mac for a product that does not exist and showed a NOT_FOUND modal, 2026-10-15.)
 */
export default function App() {
  return <RouterProvider router={router} />;
}
