import React from 'react';
import { RouterProvider } from 'react-router-dom';
import { router } from './routes';

import { runMacMigration } from './utils/macMigration';

/**
 * Root Application Component
 * Delegates all client-side navigation, layouts, and route guards to React Router DOM (HashRouter).
 */
export default function App() {
  React.useEffect(() => {
    runMacMigration();
  }, []);

  return <RouterProvider router={router} />;
}
