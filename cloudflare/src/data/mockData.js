// Initial Mock Master Data for Production (PD) & Quality Control (QC)
// Designed for local testing without pre-existing PR/PO workflow documents

// ─── STORAGE LOCATIONS MASTER DATA ──────────────────────────────────────────
export const initialStorageLocations = [
  // PRODUCTION (PD)
  {
    id: 'LOC-PD-001',
    name: 'ชั้นวาง A-01 (สารหล่อลื่น & น้ำมัน)',
    department: 'PD'
  },
  {
    id: 'LOC-PD-002',
    name: 'ชั้นวาง A-02 (อะไหล่เครื่องจักร & สายพาน)',
    department: 'PD'
  },
  {
    id: 'LOC-PD-003',
    name: 'ตู้เก็บอุปกรณ์ความปลอดภัย (PPE)',
    department: 'PD'
  },
  {
    id: 'LOC-PD-004',
    name: 'ห้องแพ็คเกจจิ้ง',
    department: 'PD'
  },

  // QUALITY CONTROL (QC)
  {
    id: 'LOC-QC-001',
    name: 'ตู้เก็บสารเคมีทดสอบ (Lab 1)',
    department: 'QC'
  },
  {
    id: 'LOC-QC-002',
    name: 'ชั้นวางอาหารเลี้ยงเชื้อ (Media Shelf B)',
    department: 'QC'
  },
  {
    id: 'LOC-QC-003',
    name: 'ตู้ควบคุมอุณหภูมิ 4°C (Cold Storage)',
    department: 'QC'
  },

  // SHARED / GENERAL (ALL)
  {
    id: 'LOC-GEN-001',
    name: 'คลังพัสดุกลาง',
    department: 'ALL'
  }
];

export const initialProducts = [
  // ─── PRODUCTION (PD) ITEMS ───
  {
    id: 'PROD-PD-001',
    code: 'PD-OIL-068',
    name: 'น้ำมันไฮดรอลิกอุตสาหกรรม (Hydraulic Oil ISO VG 68)',
    category: 'PD',
    purchaseUnit: 'ถัง (200L)',
    stockUnit: 'ลิตร',
    conversionRate: 200,
    unit: 'ลิตร',
    price: 14500,
    stockBalance: 2400,
    reorderPoint: 1000,
    leadTimeDays: 5,
    supplierId: null,
    locationId: 'LOC-PD-001',
    locationName: 'ชั้นวาง A-01 (สารหล่อลื่น & น้ำมัน)'
  },
  {
    id: 'PROD-PD-002',
    code: 'PD-GRS-002',
    name: 'จาระบีทนความร้อนสูงเกรดอาหาร (High-Temp Food Grade Grease NLGI 2)',
    category: 'PD',
    purchaseUnit: 'กล่อง (12 กระป๋อง)',
    stockUnit: 'กระป๋อง',
    conversionRate: 12,
    unit: 'กระป๋อง',
    price: 9600,
    stockBalance: 25,
    reorderPoint: 10,
    leadTimeDays: 3,
    supplierId: null,
    locationId: 'LOC-PD-001',
    locationName: 'ชั้นวาง A-01 (สารหล่อลื่น & น้ำมัน)'
  },
  {
    id: 'PROD-PD-003',
    code: 'PD-BLT-380',
    name: 'สายพานลำเลียงทนความร้อน (Timing Belt 380-5M-15)',
    category: 'PD',
    purchaseUnit: 'เส้น',
    stockUnit: 'เส้น',
    conversionRate: 1,
    unit: 'เส้น',
    price: 620,
    stockBalance: 6,
    reorderPoint: 8,
    leadTimeDays: 7,
    supplierId: null,
    locationId: 'LOC-PD-002',
    locationName: 'ชั้นวาง A-02 (อะไหล่เครื่องจักร & สายพาน)'
  },
  {
    id: 'PROD-PD-004',
    code: 'PD-GLV-NBR',
    name: 'ถุงมือไนไตรล์ป้องกันสารเคมี (Nitrile Chemical Resistant Gloves Size L)',
    category: 'PD',
    purchaseUnit: 'กล่อง (100 ชิ้น)',
    stockUnit: 'ชิ้น',
    conversionRate: 100,
    unit: 'ชิ้น',
    price: 320,
    stockBalance: 2000,
    reorderPoint: 750,
    leadTimeDays: 3,
    supplierId: null,
    locationId: 'LOC-PD-003',
    locationName: 'ตู้เก็บอุปกรณ์ความปลอดภัย (PPE)'
  },
  {
    id: 'PROD-PD-005',
    code: 'PD-CLN-IND',
    name: 'น้ำยาทำความสะอาดคราบน้ำมันเครื่องจักร (Heavy Duty Degreaser Cleaner)',
    category: 'PD',
    purchaseUnit: 'แกลลอน (20L)',
    stockUnit: 'ลิตร',
    conversionRate: 20,
    unit: 'ลิตร',
    price: 1850,
    stockBalance: 360,
    reorderPoint: 120,
    leadTimeDays: 4,
    supplierId: null,
    locationId: 'LOC-PD-001',
    locationName: 'ชั้นวาง A-01 (สารหล่อลื่น & น้ำมัน)'
  },
  {
    id: 'PROD-PD-006',
    code: 'PD-FLT-050',
    name: 'ไส้กรองน้ำมันระบบหล่อเย็น (Coolant Cartridge Filter 50 Micron)',
    category: 'PD',
    purchaseUnit: 'กล่อง (10 ชิ้น)',
    stockUnit: 'ชิ้น',
    conversionRate: 10,
    unit: 'ชิ้น',
    price: 4200,
    stockBalance: 30,
    reorderPoint: 12,
    leadTimeDays: 5,
    supplierId: null,
    locationId: 'LOC-PD-002',
    locationName: 'ชั้นวาง A-02 (อะไหล่เครื่องจักร & สายพาน)'
  },
  {
    id: 'PROD-PD-007',
    code: 'PD-STP-015',
    name: 'สายรัดพาเลทพลาสติก PP Band (15mm x 3000m)',
    category: 'PD',
    purchaseUnit: 'ม้วน',
    stockUnit: 'ม้วน',
    conversionRate: 1,
    unit: 'ม้วน',
    price: 980,
    stockBalance: 20,
    reorderPoint: 8,
    leadTimeDays: 3,
    supplierId: null,
    locationId: 'LOC-PD-004',
    locationName: 'ห้องแพ็คเกจจิ้ง'
  },
  {
    id: 'PROD-PD-008',
    code: 'PD-STF-001',
    name: 'ฟิล์มยืดพันพาเลท (Stretch Film 15 Micron 500mm x 300m)',
    category: 'PD',
    purchaseUnit: 'ลัง (6 ม้วน)',
    stockUnit: 'ม้วน',
    conversionRate: 6,
    unit: 'ม้วน',
    price: 1100,
    stockBalance: 60,
    reorderPoint: 25,
    leadTimeDays: 2,
    supplierId: null,
    locationId: 'LOC-PD-004',
    locationName: 'ห้องแพ็คเกจจิ้ง'
  },
  {
    id: 'PROD-PD-009',
    code: 'PD-BRG-620',
    name: 'ตลับลูกปืนเม็ดกลมร่องลึก (Deep Groove Ball Bearing 6205-2RS)',
    category: 'PD',
    purchaseUnit: 'ตลับ',
    stockUnit: 'ตลับ',
    conversionRate: 1,
    unit: 'ตลับ',
    price: 280,
    stockBalance: 22,
    reorderPoint: 10,
    leadTimeDays: 5,
    supplierId: null,
    locationId: 'LOC-PD-002',
    locationName: 'ชั้นวาง A-02 (อะไหล่เครื่องจักร & สายพาน)'
  },
  {
    id: 'PROD-PD-010',
    code: 'PD-MSK-N95',
    name: 'หน้ากากป้องกันฝุ่นละอองและละอองสารเคมี N95',
    category: 'PD',
    purchaseUnit: 'กล่อง (20 ชิ้น)',
    stockUnit: 'ชิ้น',
    conversionRate: 20,
    unit: 'ชิ้น',
    price: 480,
    stockBalance: 700,
    reorderPoint: 300,
    leadTimeDays: 3,
    supplierId: null,
    locationId: 'LOC-PD-003',
    locationName: 'ตู้เก็บอุปกรณ์ความปลอดภัย (PPE)'
  },

  // ─── QUALITY CONTROL (QC) ITEMS ───
  {
    id: 'PROD-QC-001',
    code: 'QC-BUF-PH7',
    name: 'สารละลายบัฟเฟอร์มาตรฐานสอบเทียบ pH 7.00 Buffer Solution (500ml)',
    category: 'QC',
    purchaseUnit: 'ขวด',
    stockUnit: 'ขวด',
    conversionRate: 1,
    unit: 'ขวด',
    price: 750,
    stockBalance: 8,
    reorderPoint: 4,
    leadTimeDays: 5,
    supplierId: null,
    locationId: 'LOC-QC-001',
    locationName: 'ตู้เก็บสารเคมีทดสอบ (Lab 1)'
  },
  {
    id: 'PROD-QC-002',
    code: 'QC-BUF-PH4',
    name: 'สารละลายบัฟเฟอร์มาตรฐานสอบเทียบ pH 4.01 Buffer Solution (500ml)',
    category: 'QC',
    purchaseUnit: 'ขวด',
    stockUnit: 'ขวด',
    conversionRate: 1,
    unit: 'ขวด',
    price: 750,
    stockBalance: 6,
    reorderPoint: 3,
    leadTimeDays: 5,
    supplierId: null,
    locationId: 'LOC-QC-001',
    locationName: 'ตู้เก็บสารเคมีทดสอบ (Lab 1)'
  },
  {
    id: 'PROD-QC-003',
    code: 'QC-PPT-100',
    name: 'ทิปปิเปตไมโครสีขาว (Micropipette Tips 100-1000 uL, DNase/RNase Free)',
    category: 'QC',
    purchaseUnit: 'กล่อง (1000 ชิ้น)',
    stockUnit: 'ชิ้น',
    conversionRate: 1000,
    unit: 'ชิ้น',
    price: 1200,
    stockBalance: 15000,
    reorderPoint: 5000,
    leadTimeDays: 4,
    supplierId: null,
    locationId: 'LOC-QC-001',
    locationName: 'ตู้เก็บสารเคมีทดสอบ (Lab 1)'
  },
  {
    id: 'PROD-QC-004',
    code: 'QC-FLT-WAT',
    name: 'กระดาษกรองเชิงคุณภาพ Whatman Grade 1 (เส้นผ่านศูนย์กลาง 110mm)',
    category: 'QC',
    purchaseUnit: 'กล่อง (100 แผ่น)',
    stockUnit: 'แผ่น',
    conversionRate: 100,
    unit: 'แผ่น',
    price: 950,
    stockBalance: 1200,
    reorderPoint: 400,
    leadTimeDays: 7,
    supplierId: null,
    locationId: 'LOC-QC-002',
    locationName: 'ชั้นวางอาหารเลี้ยงเชื้อ (Media Shelf B)'
  },
  {
    id: 'PROD-QC-005',
    code: 'QC-AGR-PCA',
    name: 'อาหารเลี้ยงเชื้อ Plate Count Agar (PCA) สำหรับทดสอบจุลชีววิทยา (500g)',
    category: 'QC',
    purchaseUnit: 'ขวด (500g)',
    stockUnit: 'กรัม',
    conversionRate: 500,
    unit: 'กรัม',
    price: 2850,
    stockBalance: 2500,
    reorderPoint: 1000,
    leadTimeDays: 10,
    supplierId: null,
    locationId: 'LOC-QC-002',
    locationName: 'ชั้นวางอาหารเลี้ยงเชื้อ (Media Shelf B)'
  },
  {
    id: 'PROD-QC-006',
    code: 'QC-PDI-STR',
    name: 'แผ่นทดสอบความสะอาดสวอปสำเร็จรูป (Surface Hygiene Swab Test Kits)',
    category: 'QC',
    purchaseUnit: 'กล่อง (50 ชิ้น)',
    stockUnit: 'ชิ้น',
    conversionRate: 50,
    unit: 'ชิ้น',
    price: 3600,
    stockBalance: 400,
    reorderPoint: 150,
    leadTimeDays: 7,
    supplierId: null,
    locationId: 'LOC-QC-003',
    locationName: 'ตู้ควบคุมอุณหภูมิ 4°C (Cold Storage)'
  },
  {
    id: 'PROD-QC-007',
    code: 'QC-THM-CAL',
    name: 'โพรบวัดอุณหภูมิดิจิตอลพร้อมใบรับรองการสอบเทียบ ISO/IEC 17025',
    category: 'QC',
    purchaseUnit: 'ชุด',
    stockUnit: 'ชุด',
    conversionRate: 1,
    unit: 'ชุด',
    price: 4500,
    stockBalance: 4,
    reorderPoint: 2,
    leadTimeDays: 14,
    supplierId: null,
    locationId: 'LOC-QC-001',
    locationName: 'ตู้เก็บสารเคมีทดสอบ (Lab 1)'
  },
  {
    id: 'PROD-QC-008',
    code: 'QC-GLV-EXM',
    name: 'ถุงมือตรวจโรคลาเท็กซ์ไม่มีแป้งสำหรับการทดสอบแล็บ (Powder-Free Latex Gloves Size M)',
    category: 'QC',
    purchaseUnit: 'กล่อง (100 ชิ้น)',
    stockUnit: 'ชิ้น',
    conversionRate: 100,
    unit: 'ชิ้น',
    price: 260,
    stockBalance: 1200,
    reorderPoint: 400,
    leadTimeDays: 3,
    supplierId: null,
    locationId: 'LOC-QC-001',
    locationName: 'ตู้เก็บสารเคมีทดสอบ (Lab 1)'
  },
  {
    id: 'PROD-QC-009',
    code: 'QC-ETH-995',
    name: 'เอทานอลบริสุทธิ์เกรดวิเคราะห์ Ethanol Absolute 99.5% AR Grade (4.0L)',
    category: 'QC',
    purchaseUnit: 'ขวด (4.0L)',
    stockUnit: 'ลิตร',
    conversionRate: 4,
    unit: 'ลิตร',
    price: 1650,
    stockBalance: 24,
    reorderPoint: 8,
    leadTimeDays: 5,
    supplierId: null,
    locationId: 'LOC-QC-001',
    locationName: 'ตู้เก็บสารเคมีทดสอบ (Lab 1)'
  },
  {
    id: 'PROD-QC-010',
    code: 'QC-ALC-PAD',
    name: 'แผ่นแอลกอฮอล์ฆ่าเชื้อสำหรับทำความสะอาดอุปกรณ์วัด (Alcohol Prep Pads)',
    category: 'QC',
    purchaseUnit: 'กล่อง (200 แผ่น)',
    stockUnit: 'แผ่น',
    conversionRate: 200,
    unit: 'แผ่น',
    price: 180,
    stockBalance: 2000,
    reorderPoint: 800,
    leadTimeDays: 3,
    supplierId: null,
    locationId: 'LOC-QC-001',
    locationName: 'ตู้เก็บสารเคมีทดสอบ (Lab 1)'
  }
];

export const initialVendors = [
  {
    id: 'VEND-001',
    code: 'VEND-IND-01',
    name: 'บริษัท สยามอินดัสเตรียลซัพพลาย จำกัด',
    department: 'PD',
    contactPerson: 'คุณสมชาย มุ่งมั่น',
    phone: '02-123-4567',
    email: 'sales@siamind.co.th',
    taxId: '0105551234567',
    address: '88/9 หมู่ 4 นิคมอุตสาหกรรมบางชัน ถ.เสรีไทย คันนายาว กทม. 10230'
  },
  {
    id: 'VEND-002',
    code: 'VEND-OIL-02',
    name: 'บริษัท ปิโตรเลียมแอนด์ลูบริแคนท์ เทรดดิ้ง จำกัด',
    department: 'PD',
    contactPerson: 'คุณวิภาวรรณ ชัยเจริญ',
    phone: '02-987-6543',
    email: 'contact@petrolube.com',
    taxId: '0105559876543',
    address: '123/45 ถ.วิภาวดีรังสิต จตุจักร กทม. 10900'
  },
  {
    id: 'VEND-003',
    code: 'VEND-SAF-03',
    name: 'ห้างหุ้นส่วนจำกัด เซฟตี้เฟิร์สท์ โปรดักส์',
    department: 'PD',
    contactPerson: 'คุณธวัชชัย รักษ์ดี',
    phone: '081-456-7890',
    email: 'service@safetyfirst.co.th',
    taxId: '0103554567890',
    address: '45/12 ถ.กิ่งแก้ว ต.ราชาเทวะ อ.บางพลี จ.สมุทรปราการ 10540'
  },
  {
    id: 'VEND-004',
    code: 'VEND-LAB-01',
    name: 'บริษัท ไซแอนติฟิคแล็บ แอนด์เคมิคอล จำกัด',
    department: 'QC',
    contactPerson: 'ดร.กิตติศักดิ์ วิริยะ',
    phone: '02-456-7890',
    email: 'order@scilabchem.co.th',
    taxId: '0105554567891',
    address: '99/1 อาคารไซแอนซ์ปาร์ค ถ.พหลโยธิน คลองหนึ่ง คลองหลวง ปทุมธานี 12120'
  },
  {
    id: 'VEND-005',
    code: 'VEND-INS-02',
    name: 'บริษัท เพรสซิชั่นอินสตรูเมนท์ส (ไทยแลนด์) จำกัด',
    department: 'QC',
    contactPerson: 'คุณนุชนาถ สุขเกษม',
    phone: '02-789-0123',
    email: 'support@precision-inst.co.th',
    taxId: '0105557890123',
    address: '55/3 ซอยสุขุมวิท 63 แขวงคลองตันเหนือ เขตวัฒนา กทม. 10110'
  },
  {
    id: 'VEND-006',
    code: 'VEND-GEN-01',
    name: 'บริษัท ออฟฟิศแอนด์แฟคทอรี่ ดีโป้ จำกัด',
    department: 'BOTH',
    contactPerson: 'คุณปริญญา มั่นคง',
    phone: '02-333-4444',
    email: 'info@officedepot-th.com',
    taxId: '0105553334444',
    address: '100/8 ถ.พระราม 9 แขวงห้วยขวาง เขตห้วยขวาง กทม. 10310'
  }
];

export const initialPRs = [];
export const initialPOs = [];
export const initialStockLogs = [];
export const initialBudgets = {
  PD: {
    monthlyBudget: 250000,
    spent: 0,
    pending: 0,
    variance: 0,
    history: {
      "2024-10": 250000, "2024-11": 250000, "2024-12": 250000,
      "2025-01": 250000, "2025-02": 250000, "2025-03": 250000,
      "2025-04": 250000, "2025-05": 250000, "2025-06": 250000,
      "2025-07": 250000, "2025-08": 250000, "2025-09": 250000,
      "2025-10": 250000, "2025-11": 250000, "2025-12": 250000,
      "2026-01": 250000, "2026-02": 250000, "2026-03": 250000,
      "2026-04": 250000, "2026-05": 250000, "2026-06": 250000,
      "2026-07": 250000, "2026-08": 250000, "2026-09": 250000
    },
    historicalSpent: {
      "2024-10": 0, "2024-11": 0, "2024-12": 0,
      "2025-01": 0, "2025-02": 0, "2025-03": 0,
      "2025-04": 0, "2025-05": 0, "2025-06": 0,
      "2025-07": 0, "2025-08": 0, "2025-09": 0,
      "2025-10": 0, "2025-11": 0, "2025-12": 0,
      "2026-01": 0, "2026-02": 0, "2026-03": 0,
      "2026-04": 0, "2026-05": 0, "2026-06": 0,
      "2026-07": 0, "2026-08": 0, "2026-09": 0
    }
  },
  QC: {
    monthlyBudget: 150000,
    spent: 0,
    pending: 0,
    variance: 0,
    history: {
      "2024-10": 150000, "2024-11": 150000, "2024-12": 150000,
      "2025-01": 150000, "2025-02": 150000, "2025-03": 150000,
      "2025-04": 150000, "2025-05": 150000, "2025-06": 150000,
      "2025-07": 150000, "2025-08": 150000, "2025-09": 150000,
      "2025-10": 150000, "2025-11": 150000, "2025-12": 150000,
      "2026-01": 150000, "2026-02": 150000, "2026-03": 150000,
      "2026-04": 150000, "2026-05": 150000, "2026-06": 150000,
      "2026-07": 150000, "2026-08": 150000, "2026-09": 150000
    },
    historicalSpent: {
      "2024-10": 0, "2024-11": 0, "2024-12": 0,
      "2025-01": 0, "2025-02": 0, "2025-03": 0,
      "2025-04": 0, "2025-05": 0, "2025-06": 0,
      "2025-07": 0, "2025-08": 0, "2025-09": 0,
      "2025-10": 0, "2025-11": 0, "2025-12": 0,
      "2026-01": 0, "2026-02": 0, "2026-03": 0,
      "2026-04": 0, "2026-05": 0, "2026-06": 0,
      "2026-07": 0, "2026-08": 0, "2026-09": 0
    }
  }
};
export const initialCounters = {
  PD: { PR: 0, PO: 0 },
  QC: { PR: 0, PO: 0 }
};
