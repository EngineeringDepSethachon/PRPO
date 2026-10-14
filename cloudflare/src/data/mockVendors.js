import { initialVendors } from './mockData';
import { storageService } from '../services/storageService';

export const mockVendors = initialVendors;
export const getMockVendors = () => storageService.getVendors() || initialVendors;
export default mockVendors;
