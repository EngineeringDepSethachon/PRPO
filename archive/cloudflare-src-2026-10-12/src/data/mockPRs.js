import { storageService } from '../services/storageService';

export const mockPRs = [];

export const getMockPRs = () => storageService.getPRs() || mockPRs;
export default mockPRs;
