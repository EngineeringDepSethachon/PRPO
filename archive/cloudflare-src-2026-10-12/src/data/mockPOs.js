import { storageService } from '../services/storageService';

export const getMockPOs = () => storageService.getPOs() || [];
export default getMockPOs;
