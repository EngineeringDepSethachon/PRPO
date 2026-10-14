import React, { createContext, useContext, useMemo } from 'react';
import { useAppContext } from './AppContext';
import { storageService } from '../services/storageService';
import { workflowEngine } from '../services/workflowEngine';
import { generateNextPRId } from '../utils/idGenerator';

const PRContext = createContext(null);

export function PRProvider({ children }) {
  const app = useAppContext ? useAppContext() : {};

  const value = useMemo(() => ({
    prs: app?.prs || storageService.getPRs() || [],
    setPRs: app?.setPRs || ((prs) => storageService.savePRs(prs)),
    createPR: app?.createPR || workflowEngine.createPR.bind(workflowEngine),
    handleSavePR: app?.createPR || workflowEngine.createPR.bind(workflowEngine),
    updatePR: app?.updatePR || workflowEngine.updatePR.bind(workflowEngine),
    generateNextPRId: (dept, yr) => generateNextPRId(app?.prs || storageService.getPRs() || [], dept, yr),
    selectedPRForModal: app?.selectedPRForModal,
    setSelectedPRForModal: app?.setSelectedPRForModal
  }), [app]);

  return (
    <PRContext.Provider value={value}>
      {children}
    </PRContext.Provider>
  );
}

export const usePRContext = () => {
  const context = useContext(PRContext);
  if (!context) {
    const prs = storageService.getPRs() || [];
    return {
      prs,
      setPRs: (newPrs) => storageService.savePRs(newPrs),
      createPR: workflowEngine.createPR.bind(workflowEngine),
      handleSavePR: workflowEngine.createPR.bind(workflowEngine),
      updatePR: workflowEngine.updatePR.bind(workflowEngine),
      generateNextPRId: (dept, yr) => generateNextPRId(prs, dept, yr)
    };
  }
  return context;
};

export default PRContext;
