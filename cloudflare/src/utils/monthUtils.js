// Helper สำหรับหน้าจัดซื้อออนไลน์: ใช้เดือน/ปีปัจจุบันแทนค่าฝังตายตัว (2026-09 ฯลฯ)

const pad2 = (n) => String(n).padStart(2, '0');

/** คืนเดือนปัจจุบันในรูปแบบ 'YYYY-MM' */
export function currentYM(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

/** คืนปี ค.ศ. ปัจจุบัน */
export function currentYear(date = new Date()) {
  return date.getFullYear();
}

/** คืนรายการเดือน 'YYYY-MM' ย้อนหลังจากเดือนปัจจุบัน (ใหม่สุดก่อน) */
export function recentMonthKeys(count = 12, date = new Date()) {
  const keys = [];
  for (let i = 0; i < count; i += 1) {
    const d = new Date(date.getFullYear(), date.getMonth() - i, 1);
    keys.push(currentYM(d));
  }
  return keys;
}
