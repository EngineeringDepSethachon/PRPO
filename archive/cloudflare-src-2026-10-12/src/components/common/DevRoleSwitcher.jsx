/**
 * @deprecated DevRoleSwitcher Component (Permanently Unmounted & Deprecated)
 * 
 * The floating DevRoleSwitcher widget has been unmounted and deprecated from the application
 * layout to eliminate state-race conditions, context desynchronization, and visual clutter.
 * 
 * Authentic persona switching is strictly enforced via clean authentication lifecycles:
 * Sign Out (Sidebar/Profile Modal) -> /login (1-Click Persona Selection) -> Dashboard Session Hydration.
 */

import React from 'react';

export default function DevRoleSwitcher() {
  return null;
}
