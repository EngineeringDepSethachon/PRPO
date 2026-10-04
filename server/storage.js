import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initialProducts, initialVendors } from '../src/data/mockData.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root data directory
export const rootDir = path.resolve(__dirname, '..');
export const dataDir = path.join(rootDir, 'data');
export const uploadsDir = path.join(dataDir, 'uploads');
export const backupsDir = path.join(dataDir, 'backups');

// Ensure essential directories exist
[dataDir, uploadsDir, backupsDir].forEach(dir => {
  if (!fsSync.existsSync(dir)) {
    fsSync.mkdirSync(dir, { recursive: true });
  }
});

// Initial mock data definitions for seeding if files don't exist
export const initialStorageLocations = [
  { id: 'LOC-PD-001', name: 'ชั้นวาง A-01 (สารหล่อลื่น & น้ำมัน)', department: 'PD' },
  { id: 'LOC-PD-002', name: 'ชั้นวาง A-02 (อะไหล่เครื่องจักร & สายพาน)', department: 'PD' },
  { id: 'LOC-PD-003', name: 'ตู้เก็บอุปกรณ์ความปลอดภัย (PPE)', department: 'PD' },
  { id: 'LOC-PD-004', name: 'ห้องแพ็คเกจจิ้ง', department: 'PD' },
  { id: 'LOC-QC-001', name: 'ตู้เก็บสารเคมีทดสอบ (Lab 1)', department: 'QC' },
  { id: 'LOC-QC-002', name: 'ชั้นวางอาหารเลี้ยงเชื้อ (Media Shelf B)', department: 'QC' },
  { id: 'LOC-QC-003', name: 'ตู้เก็บแก้วและอุปกรณ์สอบเทียบ (Calibration Room)', department: 'QC' },
  { id: 'LOC-QC-004', name: 'จุดพักตัวอย่างรอตรวจ (Pending Sample Area)', department: 'QC' }
];

export const initialUsageUnits = [
  { id: 'UNIT-PD-001', name: 'ห้อง K1', department: 'PD', dot: 'bg-blue-500', color: 'bg-blue-50 text-blue-700 border-blue-200/80', status: 'ACTIVE' },
  { id: 'UNIT-PD-002', name: 'ห้อง K2', department: 'PD', dot: 'bg-violet-500', color: 'bg-violet-50 text-violet-700 border-violet-200/80', status: 'ACTIVE' },
  { id: 'UNIT-PD-003', name: 'ห้องผลไม้', department: 'PD', dot: 'bg-emerald-500', color: 'bg-emerald-50 text-emerald-700 border-emerald-200/80', status: 'ACTIVE' },
  { id: 'UNIT-PD-004', name: 'ห้องแพ็ค', department: 'PD', dot: 'bg-amber-500', color: 'bg-amber-50 text-amber-700 border-amber-200/80', status: 'ACTIVE' },
  { id: 'UNIT-PD-005', name: 'ออฟฟิศ PD', department: 'PD', dot: 'bg-slate-500', color: 'bg-slate-100 text-slate-700 border-slate-200/80', status: 'ACTIVE' },
  { id: 'UNIT-QC-001', name: 'Lab เคมี', department: 'QC', dot: 'bg-cyan-500', color: 'bg-cyan-50 text-cyan-700 border-cyan-200/80', status: 'ACTIVE' },
  { id: 'UNIT-QC-002', name: 'Lab จุลชีววิทยา', department: 'QC', dot: 'bg-teal-500', color: 'bg-teal-50 text-teal-700 border-teal-200/80', status: 'ACTIVE' },
  { id: 'UNIT-QC-003', name: 'ห้อง Sensory', department: 'QC', dot: 'bg-fuchsia-500', color: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200/80', status: 'ACTIVE' }
];

export const initialDepartments = [
  {
    id: 'DEPT-PD',
    code: 'PD',
    name: 'ฝ่ายผลิต',
    nameEn: 'Production',
    prefix: 'PD',
    description: 'รับผิดชอบกระบวนการแปรรูป ควบคุมการผลิต และดูแลไลน์ผลิตสินค้า',
    monthlyBudget: 250000,
    isActive: true,
    color: 'blue',
    managerName: 'คุณประเสริฐ ยิ่งยง',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  },
  {
    id: 'DEPT-QC',
    code: 'QC',
    name: 'ฝ่ายควบคุมคุณภาพ',
    nameEn: 'Quality Control & Lab',
    prefix: 'QC',
    description: 'ตรวจสอบคุณภาพ วัตถุดิบ สารเคมี บรรจุภัณฑ์ และงานแล็บวิเคราะห์',
    monthlyBudget: 150000,
    isActive: true,
    color: 'amber',
    managerName: 'ดร. กรรณิการ์ จิตเจริญ',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  },
  {
    id: 'DEPT-WH',
    code: 'WH',
    name: 'ฝ่ายคลังสินค้า',
    nameEn: 'Warehouse & Inventory',
    prefix: 'WH',
    description: 'บริหารคลังจัดเก็บสินค้า วัตถุดิบ ชิ้นส่วน และตรวจรับกระจายสต็อก',
    monthlyBudget: 120000,
    isActive: true,
    color: 'emerald',
    managerName: 'คุณสมคิด คลังทอง',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  },
  {
    id: 'DEPT-PUR',
    code: 'PUR',
    name: 'ฝ่ายจัดซื้อ',
    nameEn: 'Procurement & Sourcing',
    prefix: 'PUR',
    description: 'จัดหาผู้จัดจำหน่าย เปรียบเทียบราคา จัดซื้อพัสดุและอุปกรณ์',
    monthlyBudget: 100000,
    isActive: true,
    color: 'purple',
    managerName: 'คุณสุดา จัดหาดี',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  },
  {
    id: 'DEPT-ENG',
    code: 'ENG',
    name: 'ฝ่ายวิศวกรรมและซ่อมบำรุง',
    nameEn: 'Engineering & Maintenance',
    prefix: 'ENG',
    description: 'ดูแลรักษาเครื่องจักร ระบบสาธารณูปโภค และงานซ่อมบำรุงโรงงาน',
    monthlyBudget: 180000,
    isActive: true,
    color: 'cyan',
    managerName: 'วิศวกร ช่างทอง',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
];

export const initialUsers = [];


export const initialBudgets = {
  PD: { monthlyBudget: 250000, spent: 0, pending: 0, variance: 250000, history: {}, historicalSpent: {} },
  QC: { monthlyBudget: 150000, spent: 0, pending: 0, variance: 150000, history: {}, historicalSpent: {} },
  WH: { monthlyBudget: 120000, spent: 0, pending: 0, variance: 120000, history: {}, historicalSpent: {} },
  PUR: { monthlyBudget: 100000, spent: 0, pending: 0, variance: 100000, history: {}, historicalSpent: {} },
  ENG: { monthlyBudget: 180000, spent: 0, pending: 0, variance: 180000, history: {}, historicalSpent: {} }
};

export const initialCounters = {
  PD: { PR: 0, PO: 0 },
  QC: { PR: 0, PO: 0 },
  WH: { PR: 0, PO: 0 },
  PUR: { PR: 0, PO: 0 },
  ENG: { PR: 0, PO: 0 }
};

// Seed product items from initial catalog (Only used if file does not exist on disk)
export const defaultSeedCatalog = {
  'products.json': initialProducts,
  'vendors.json': initialVendors,
  'storageLocations.json': initialStorageLocations,
  'usageUnits.json': initialUsageUnits,
  'departments.json': initialDepartments,
  'users.json': initialUsers,
  'budgets.json': initialBudgets,
  'prCounters.json': initialCounters,
  'prs.json': [],
  'pos.json': [],
  'stockLogs.json': [],
  'budgetTransactions.json': [],
  'auditLogs.json': [],
  'notifications.json': []
};

// File helpers with atomic write to prevent read-during-write corruption
export const getFilePath = (fileName) => path.join(dataDir, fileName);

// Central synchronous atomic file writer with formatted Pretty JSON (SSOT)
export function saveDataToFile(fileName, data) {
  const filePath = getFilePath(fileName);
  const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fsSync.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fsSync.renameSync(tmpPath, filePath);
  } catch {
    try { fsSync.unlinkSync(tmpPath); } catch {}
    fsSync.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}

export async function writeFile(fileName, data) {
  saveDataToFile(fileName, data);
}

// Single Source of Truth (SSOT) reader
export async function readFile(fileName, defaultValue = []) {
  const filePath = getFilePath(fileName);
  try {
    if (!fsSync.existsSync(filePath)) {
      const fallback = defaultSeedCatalog[fileName] !== undefined ? defaultSeedCatalog[fileName] : defaultValue;
      saveDataToFile(fileName, fallback);
      return fallback;
    }
    const content = await fs.readFile(filePath, 'utf-8');
    if (!content || !content.trim()) {
      const fallback = defaultSeedCatalog[fileName] !== undefined ? defaultSeedCatalog[fileName] : defaultValue;
      saveDataToFile(fileName, fallback);
      return fallback;
    }
    return JSON.parse(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      const fallback = defaultSeedCatalog[fileName] !== undefined ? defaultSeedCatalog[fileName] : defaultValue;
      saveDataToFile(fileName, fallback);
      return fallback;
    }
    console.error(`[Backend SSOT] Read error for ${fileName}:`, err);
    return defaultSeedCatalog[fileName] !== undefined ? defaultSeedCatalog[fileName] : defaultValue;
  }
}

// ── One-Time Bootstrap Lock ──
// Strictly preserves existing data on disk. Only seeds if file is missing completely.
export function ensureBootstrapData() {
  console.log('[SSOT Lock] Verifying Single Source of Truth data files...');
  for (const [fileName, seedData] of Object.entries(defaultSeedCatalog)) {
    const filePath = getFilePath(fileName);
    if (!fsSync.existsSync(filePath)) {
      console.log(`[SSOT Lock] Initializing missing master data file on disk: ${fileName}`);
      saveDataToFile(fileName, seedData);
    } else {
      console.log(`[SSOT Lock] File exists on disk, preserving on-disk user data: ${fileName}`);
    }
  }
}

// ── Permanent Blacklist Guard against Test / Mock Artifacts ──
export const DUMMY_BLACKLIST = new Set(['P01', 'P02', 'PROD-01', 'PROD-02']);
export const isBlacklistedProduct = (item) => {
  if (!item || typeof item !== 'object') return false;
  const actual = item.product || item.item || item;
  const code = String(actual.code || actual.id || '').trim().toUpperCase();
  const id = String(actual.id || '').trim().toUpperCase();
  const name = String(actual.name || actual.itemName || actual.title || '').trim().toLowerCase();
  return DUMMY_BLACKLIST.has(code) || DUMMY_BLACKLIST.has(id) || name === 'item 1' || name === 'item 2';
};

// ── Auto-Backup Subsystem ──
/**
 * Automatically creates timestamped snapshot of all JSON data files in data/backups/
 * Maintains rolling window of latest backups (max 15).
 */
export async function performAutoBackup(triggerReason = 'AUTO') {
  try {
    if (!fsSync.existsSync(backupsDir)) {
      fsSync.mkdirSync(backupsDir, { recursive: true });
    }

    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const targetFolder = `backup_${timestamp}_${triggerReason.toLowerCase()}`;
    const targetPath = path.join(backupsDir, targetFolder);

    fsSync.mkdirSync(targetPath, { recursive: true });

    // Read all files in dataDir
    const entries = await fs.readdir(dataDir, { withFileTypes: true });
    let backedUpCount = 0;

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        const srcFile = path.join(dataDir, entry.name);
        const destFile = path.join(targetPath, entry.name);
        await fs.copyFile(srcFile, destFile);
        backedUpCount++;
      }
    }

    // Write backup metadata
    const meta = {
      timestamp: now.toISOString(),
      triggerReason,
      filesCount: backedUpCount,
      version: '1.0.0'
    };
    await fs.writeFile(path.join(targetPath, 'manifest.json'), JSON.stringify(meta, null, 2), 'utf-8');

    // Rolling cleanup: keep latest 15 backups
    const backupFolders = (await fs.readdir(backupsDir, { withFileTypes: true }))
      .filter(d => d.isDirectory() && d.name.startsWith('backup_'))
      .map(d => d.name)
      .sort();

    const MAX_BACKUPS = 15;
    if (backupFolders.length > MAX_BACKUPS) {
      const toRemove = backupFolders.slice(0, backupFolders.length - MAX_BACKUPS);
      for (const folder of toRemove) {
        try {
          await fs.rm(path.join(backupsDir, folder), { recursive: true, force: true });
        } catch (rmErr) {
          console.warn('[AutoBackup] Could not remove old backup:', folder, rmErr.message);
        }
      }
    }

    console.log(`[AutoBackup] Successfully archived ${backedUpCount} files to backups/${targetFolder} (Trigger: ${triggerReason})`);
    return {
      success: true,
      backupFolder: targetFolder,
      targetPath,
      backedUpCount,
      timestamp: now.toISOString()
    };
  } catch (err) {
    console.error('[AutoBackup] Error during auto-backup:', err);
    return { success: false, error: err.message };
  }
}
