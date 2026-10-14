export const sortByNewestFirst = (a, b) => {
  // 1. ดึงค่า Timestamp (ป้องกัน NaN ด้วย fallback 0)
  const parseTime = (item) => {
    const val = item?.createdAt || item?.issueDate || item?.date || item?.updatedAt || item?.timestamp;
    if (!val) return 0;
    const t = new Date(val).getTime();
    return isNaN(t) ? 0 : t;
  };

  const timeA = parseTime(a);
  const timeB = parseTime(b);

  // หาก Timestamp ต่างกัน ให้เอาค่ามาก (เวลาล่าสุด) ขึ้นก่อน
  if (timeB !== timeA && timeB > 0 && timeA > 0) {
    return timeB - timeA;
  }

  // 2. Fallback: หากเวลาเท่ากัน หรือไม่มีเวลา ให้สกัดเลขเอกสารมาเทียบย้อนกลับ (เช่น PD005 > PD004)
  const getDocCode = (item) => String(item?.prNo || item?.poNo || item?.id || item?.docNo || '');
  return getDocCode(b).localeCompare(getDocCode(a), undefined, { numeric: true, sensitivity: 'base' });
};
