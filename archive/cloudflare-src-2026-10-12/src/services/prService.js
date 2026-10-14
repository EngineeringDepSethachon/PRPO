import { storageService } from './storageService.js';
import { workflowEngine } from './workflowEngine.js';
import { apiService } from './apiService.js';
import { getNextPRNumber, generateNextPRId } from '../utils/idGenerator.js';

export const prService = {
  getNextPRNumber(allPRs = null, department = 'PD', year = 2026) {
    const prs = allPRs || storageService.getPRs() || [];
    return getNextPRNumber(prs, department, year);
  },

  generateNextPRId(department = 'PD', year = 2026) {
    const prs = storageService.getPRs() || [];
    return getNextPRNumber(prs, department, year);
  },

  async handleSavePR(prData, user, isDraft = false) {
    return workflowEngine.createPR(prData, user, isDraft);
  },

  async createPR(prData, user, isDraft = false) {
    return apiService.createPR(prData, user, isDraft);
  },

  async updatePR(prId, prData, user, isDraft = false) {
    return apiService.updatePR(prId, prData, user, isDraft);
  },

  getPRs() {
    return storageService.getPRs() || [];
  },

  getPRById(id) {
    const prs = this.getPRs();
    return prs.find(p => p.id === id || p.prNo === id || p.prNumber === id);
  }
};

export { getNextPRNumber, generateNextPRId };
export default prService;
