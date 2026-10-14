import React, { createContext, useContext, useMemo } from 'react';
import { useAppContext } from './AppContext';
import { storageService } from '../services/storageService';

const DUMMY_BLACKLIST = new Set(['P01', 'P02', 'PROD-01', 'PROD-02']);
const isBlacklisted = (item) => {
  if (!item) return false;
  const actual = item.product || item.item || item;
  const code = String(actual.code || actual.id || '').trim().toUpperCase();
  const id = String(actual.id || '').trim().toUpperCase();
  const name = String(actual.name || actual.itemName || actual.title || '').trim().toLowerCase();
  return DUMMY_BLACKLIST.has(code) || DUMMY_BLACKLIST.has(id) || name === 'item 1' || name === 'item 2';
};

const deduplicateMasterData = (list = []) => {
  const map = new Map();
  (Array.isArray(list) ? list : []).forEach(item => {
    if (!item) return;
    const actual = item.product || item.item || item;
    if (isBlacklisted(actual)) return;
    const key = String(actual.code || actual.id || '').trim().toUpperCase();
    if (key && !map.has(key)) {
      map.set(key, actual);
    }
  });
  return Array.from(map.values());
};

const MasterDataContext = createContext(null);

export function MasterDataProvider({ children }) {
  let app = null;
  try {
    app = useAppContext ? useAppContext() : null;
  } catch (e) {
    app = null;
  }

  const value = useMemo(() => ({
    products: deduplicateMasterData(app?.products || storageService.getProducts() || []),
    vendors: app?.vendors || storageService.getVendors() || [],
    departments: app?.departments || storageService.getDepartments() || [],
    storageLocations: app?.storageLocations || storageService.getStorageLocations() || [],
    usageUnits: app?.usageUnits || storageService.getUsageUnits() || [],
    saveProduct: app?.saveProduct,
    saveVendor: app?.saveVendor,
    deleteProduct: app?.deleteProduct,
    deleteVendor: app?.deleteVendor
  }), [app]);

  return (
    <MasterDataContext.Provider value={value}>
      {children}
    </MasterDataContext.Provider>
  );
}

export const useMasterDataContext = () => {
  const ctx = useContext(MasterDataContext);
  if (!ctx) {
    return {
      products: deduplicateMasterData(storageService.getProducts() || []),
      vendors: storageService.getVendors() || [],
      departments: storageService.getDepartments() || [],
      storageLocations: storageService.getStorageLocations() || [],
      usageUnits: storageService.getUsageUnits() || []
    };
  }
  return ctx;
};

export default MasterDataContext;
