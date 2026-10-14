// COMPLETED (รับครบ/ปิดจากการรับของ ตาม GAS apiReceivePO) ไม่มี label ใน PO_STATUS เดิม
// ใช้เป็น fallback ต่อจาก PO_STATUS ในหน้าที่แสดงสถานะ PO เพื่อไม่ให้โชว์รหัสดิบ ; คืน null ถ้าไม่ใช่ COMPLETED
const COMPLETED_LABEL = { label: 'เสร็จสิ้น', color: 'bg-teal-50 text-teal-700 border-teal-200' };

export const getCompletedPOStatus = (status) => (status === 'COMPLETED' ? COMPLETED_LABEL : null);
