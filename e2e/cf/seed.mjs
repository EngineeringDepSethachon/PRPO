// Test infra for the Cloudflare-mode e2e (local only): migrations + seed into a PERSISTED LOCAL D1 under test-results/e2e-d1.
// Never touches --remote, .dev.vars, data/ . Safe to re-run : every mutable table is emptied and the fixtures are re-inserted.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../../functions/_lib/password.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PERSIST = 'test-results/e2e-d1';
export const DB_ID = 'c64022bb-88eb-485f-94f7-dd9e9617e44c'; // wrangler.toml database_id (LOCAL sqlite only, nothing remote is contacted)
export const PASSWORD = 'E2e-Pass#2026';

export const USERS = {
  L1: { id: 'E2E-L1', username: 'e2e.req', name: 'E2E Requester', department: 'PD', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1, depts: ['PD'] },
  L2: { id: 'E2E-L2', username: 'e2e.asst', name: 'E2E Asst Manager', department: 'PD', roleId: 'ASST_MANAGER', canonicalRole: 'REVIEWER', level: 2, depts: ['PD'] },
  L3: { id: 'E2E-L3', username: 'e2e.plant', name: 'E2E Plant Manager', department: 'MGT', roleId: 'PLANT_MANAGER', canonicalRole: 'APPROVER', level: 3, depts: ['*'], viewAll: 1 },
  ONLINE: { id: 'E2E-ON', username: 'e2e.online', name: 'E2E Online', department: 'PUR', roleId: 'ONLINE_PURCHASER', canonicalRole: 'PURCHASER', level: 2, depts: ['*'], viewAll: 1 }, // viewAll = canViewAllDepts : admin-created users get 1 for online / level >= 2 (functions/api/[[route]].js POST /api/users default)
  // another department (QC only) : must never see a PD document's file (GET /api/files/:id -> 404)
  OTHER: { id: 'E2E-QC', username: 'e2e.qc', name: 'E2E QC Requester', department: 'QC', roleId: 'REQUESTER_QC', canonicalRole: 'REQUESTER', level: 1, depts: ['QC'] },
  LOCK_API: { id: 'E2E-LA', username: 'e2e.lockapi', name: 'E2E Lock API', department: 'PD', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1, depts: ['PD'] },
  LOCK_UI: { id: 'E2E-LU', username: 'e2e.lockui', name: 'E2E Lock UI', department: 'PD', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1, depts: ['PD'] },
  // an account the admin just created / reset : must choose its own password at the first login
  MUST: { id: 'E2E-MU', username: 'e2e.must', name: 'E2E Must Change', department: 'PD', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1, depts: ['PD'], mustChange: true }
};

const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

function wrangler(args) {
  // กันฐานจริง: seed สั่ง DELETE จึงต้องเป็น local เท่านั้น และห้ามมี --remote เด็ดขาด
  if (!args.includes('--local') || args.includes('--remote')) {
    throw new Error(`BLOCKED: wrangler ${args.join(' ')} ต้องมี --local และต้องไม่มี --remote (seed ห้ามแตะฐานข้อมูลจริง)`);
  }
  const r = spawnSync('npx', ['wrangler', ...args], { cwd: root, shell: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`wrangler ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

export async function buildSeedSql() {
  const lines = [];
  for (const t of ['login_attempts', 'audit_logs', 'stock_logs', 'budget_transactions', 'pos', 'prs', 'doc_counters', 'attachments', 'file_refs', 'upload_attempts', 'products', 'budgets', 'departments', 'users']) {
    lines.push(`DELETE FROM ${t};`);
  }
  for (const [code, name] of [['PD', 'ฝ่ายผลิต'], ['PUR', 'จัดซื้อ'], ['MGT', 'ผู้บริหาร'], ['QC', 'ฝ่ายควบคุมคุณภาพ (QC/R&D)']]) {
    lines.push(`INSERT INTO departments (id, code, name, isActive) VALUES (${q('DEPT-' + code)}, ${q(code)}, ${q(name)}, 1);`);
  }
  for (const u of Object.values(USERS)) {
    const h = await hashPassword(PASSWORD);
    lines.push(`INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status, passwordHash, passwordSalt, passwordAlgo, passwordIterations, mustChangePassword, canViewAllDepts)
      VALUES (${q(u.id)}, ${q(u.username)}, '', ${q(u.name)}, ${q(u.department)}, ${q(JSON.stringify(u.depts))}, ${q(u.roleId)}, ${q(u.canonicalRole)}, ${u.level}, 'ACTIVE', ${q(h.hash)}, ${q(h.salt)}, ${q(h.algo)}, ${h.iterations}, ${u.mustChange ? 1 : 0}, ${u.viewAll ? 1 : 0});`);
  }
  lines.push(`INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalAllocated, totalUsed, totalRemaining) VALUES ('PD', 'PD', ${new Date().getFullYear()}, 100000, 100000, 1000, 99000);`);
  lines.push(`INSERT INTO products (id, code, name, category, purchaseUnit, usageUnit, conversionRate, minStock, currentStock, standardPrice, department, isDeleted) VALUES ('E2E-P1', 'E2E-P1', 'จาระบี E2E', 'PD', 'กระป๋อง', 'กระป๋อง', 1, 1, 10, 100, 'PD', 0);`);
  // a product of ANOTHER department (QC) : the client's stock sync (PUT /api/products/batch) sends every department's products, a PD user must not break on it
  lines.push(`INSERT INTO products (id, code, name, category, purchaseUnit, usageUnit, conversionRate, minStock, currentStock, standardPrice, department, isDeleted) VALUES ('E2E-QC1', 'E2E-QC1', 'น้ำยา QC E2E', 'QC', 'ขวด', 'ขวด', 1, 1, 7, 50, 'QC', 0);`);
  return lines.join('\n');
}

export async function setupLocalD1() {
  wrangler(['d1', 'migrations', 'apply', 'prpo-db', '--local', '--persist-to', PERSIST]);
  const file = path.join(root, 'test-results', 'e2e-seed.sql');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, await buildSeedSql(), 'utf8');
  wrangler(['d1', 'execute', 'prpo-db', '--local', '--persist-to', PERSIST, '--file', file, '--yes']);
}
