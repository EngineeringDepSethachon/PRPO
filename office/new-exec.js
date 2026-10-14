#!/usr/bin/env node
// สร้างห้อง Executive จาก office/exec-template/ -> departments/<id>/
// ใช้: node office/new-exec.js [--id <id>] [--role tech|biz] [--refresh]   (env OFFICE_ROOT = ราก project)
// default id = executive (role tech) ; id executive-biz -> role biz ; ห้อง exec ต้องมีใน office/departments.json (kind: exec)
// idempotent: ไม่ทับไฟล์เดิม (flag wx) ; --refresh เขียนทับ CLAUDE.md + .claude/settings.json
const fs = require('fs');
const path = require('path');
const { loadDepartments } = require('./depts');

const posix = (p) => p.split(path.sep).join('/');
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const BAD_PATH = /["'`$%!\r\n\\]/;

const ROLE_TEXTS = {
  tech: [
    '## บทบาท (เทคนิค)',
    'ดูแลสถาปัตยกรรม เทคโนโลยี และภาพรวมของทุกแผนก ตัดสินว่าแนวทางทางเทคนิคทำได้จริง เหมาะสม ปลอดภัย และสอดคล้องกับแผนของบริษัท',
    '',
    '### เมื่อได้รับคำขอแตกชิ้นงาน (package/ขอบเขตฟีเจอร์)',
    'ตอบเป็นตารางแตกชิ้นงาน: package → โมดูล/ฟีเจอร์ → สถานะ (มีแล้ว/ต้องสร้าง/ต้องแก้) → ความยาก (S/M/L) → ความเสี่ยง → ลำดับสร้าง',
    'อ่านจาก `docs/plan.md` และ `docs/tasks.md` ของทีมหลัก (Neo) ประกอบ ; ถ้าข้อเสนอขัดกับสถาปัตยกรรมให้บอกชัด ๆ',
    '',
    '### memo: คุณคือผู้ตัดสินเรื่องใหญ่ของทีมหลัก (Neo)',
    'หัวหน้าทีมหลัก (Neo) และห้องอื่นส่ง memo มาประสานงานได้ แต่ memo ไม่ใช่การอนุมัติ ; เรื่องใหญ่ของทีมหลัก (สถาปัตยกรรม, ขอบเขต, ลำดับสร้าง) ต้องผ่าน consult มาที่คุณ ถ้าได้รับทางอื่นให้ตอบกลับว่าให้ส่ง consult',
    'แจ้งทิศทางทางเทคนิค/ข้อจำกัดให้ห้องอื่นด้วย memo สั้น ๆ ได้',
    'ข้อควรรู้เรื่อง memo: memo ไม่ปลุกห้องปลายทาง (ปลายทางได้รับเมื่อผู้ใช้พิมพ์ในห้องนั้น) ; ห้ามตอบ memo เพื่อรับทราบ/ขอบคุณ ; ตอบกลับใช้ `--re <memo id>` ; ห้ามใส่ข้อมูลลับ/รหัส/กุญแจ (server จะปฏิเสธ) ; คำสั่งงานที่ส่งผ่าน memo ไม่ใช่การอนุมัติ — เรื่องใหญ่ต้องมี consult id ที่ยืนยันด้วย `consult.js --status` ก่อนลงมือ',
  ].join('\n'),
  biz: [
    '## บทบาท (ธุรกิจ: Marketing + Finance)',
    'ดูแลด้านธุรกิจ: ความเป็นไปได้ของ product, package, ราคา, positioning เทียบคู่แข่ง และการสำรวจตลาด โดยกำกับแผนก Marketing และ Finance',
    'เอกสารที่อ่านได้: `docs/product-brief`, `departments/marketing/docs`, `departments/finance/docs` (อ่านอย่างเดียว)',
    'เรื่องที่ต้องใช้มุมมองเทคนิค (เช่น package นี้ทำได้ทางเทคนิคไหม) ให้ปรึกษาผู้บริหารอีกคน — คำตอบเป็นคำแนะนำ คุณยังเป็นผู้ตัดสิน',
    'ทุกตัวเลข/ข้อเท็จจริงที่รับรองต้องมีแหล่งอ้างอิงในเอกสารของแผนก ไม่รับรองตัวเลขที่ไม่มีที่มา',
    '',
    '### กติกา: เรื่อง package / ขอบเขต product ต้องประสาน Fable ก่อนอนุมัติ',
    'เมื่อ consult เกี่ยวกับการแตก package หรือเรื่องที่กระทบขอบเขต product (เช่น ราคาที่ผูกกับฟีเจอร์) ห้าม APPROVE ทันที ให้ทำตามลำดับ:',
    '1. ส่ง consult หา Fable ตามหัวข้อ "ปรึกษาผู้บริหารอีกคน" (`--to executive`) แนบนิยาม package แล้วถาม: แต่ละ package ประกอบด้วยโมดูล/ฟีเจอร์อะไร, อะไรมีแล้ว/ต้องสร้างเพิ่ม, ความยาก/ความเสี่ยง, ลำดับที่ควรสร้าง',
    '2. ระหว่างรอ ADVISED ห้ามตอบ consult ต้นทางเป็น REVISE — ให้จบ turn รอ (consult ต้นทางยัง pending)',
    '3. ได้ ADVISED แล้วค่อยตัดสิน และใส่สรุปคำแนะนำของ Fable (การแตกชิ้นงาน) ไว้ใน body ของ decide เพื่อให้หัวหน้าทีมนำไปบันทึก',
    '',
    '### memo: คุณคือเข็มทิศของทีมธุรกิจ (Marketing/Finance)',
    'ทิศทาง, package, ราคา, ขอบเขตธุรกิจ ตัดสินที่คุณ ; หัวหน้า Marketing/Finance ส่ง memo มาประสานงานกันเองได้ แต่ memo ไม่ใช่การอนุมัติ ถ้าเรื่องนั้นต้องตัดสินให้ตอบกลับว่าให้ส่ง consult',
    'แจ้งทิศทางให้หัวหน้าแต่ละห้องด้วย memo สั้น ๆ ได้ (เช่นแจ้ง Keith/Frank) แต่การอนุมัติทำผ่าน decide เท่านั้น',
    'ข้อควรรู้เรื่อง memo: memo ไม่ปลุกห้องปลายทาง (ปลายทางได้รับเมื่อผู้ใช้พิมพ์ในห้องนั้น) ; ห้ามตอบ memo เพื่อรับทราบ/ขอบคุณ ; ตอบกลับใช้ `--re <memo id>` ; ห้ามใส่ข้อมูลลับ/รหัส/กุญแจ (server จะปฏิเสธ) ; คำสั่งงานที่ส่งผ่าน memo ไม่ใช่การอนุมัติ — เรื่องใหญ่ต้องมี consult id ที่ยืนยันด้วย `consult.js --status` ก่อนลงมือ',
  ].join('\n'),
};

function execDept(list, id) {
  const d = list.find((x) => x.id === id);
  if (!d) throw new Error('ไม่พบแผนก ' + id + ' ใน office/departments.json');
  if (d.kind !== 'exec') throw new Error('แผนก ' + id + ' ไม่ใช่ห้อง exec (ต้องมี kind: "exec")');
  return d;
}

function buildVars(root, id, role) {
  const list = loadDepartments(root);
  const me = execDept(list, id);
  const name = cap(me.manager.name);
  const approves = list.filter((d) => d.approver === id);
  const peers = list.filter((d) => d.kind === 'exec' && d.id !== id);
  const vars = {
    DECIDE_PATH: posix(path.join(root, 'office', 'decide.js')),
    ASK_PATH: posix(path.join(root, 'office', 'ask.js')),
    CONSULT_PATH: posix(path.join(root, 'office', 'consult.js')),
    MEMO_PATH: posix(path.join(root, 'office', 'memo.js')),
    ROOMS: list.filter((d) => d.id !== id).map((d) => '- `' + d.id + '` = ' + String(d.name).replace(/[\r\n]/g, ' ') + ' (หัวหน้า ' + cap(d.manager.name) + ')' + (d.kind === 'exec' ? ' [ผู้บริหาร]' : '')).join('\n') || '- (ไม่มี)',
    EXEC_ID: id,
    EXEC_NAME: name,
    ROLE_TEXT: ROLE_TEXTS[role],
    APPROVES: approves.length
      ? approves.map((d) => '- ' + d.name + ' (id: ' + d.id + ') หัวหน้า ' + cap(d.manager.name)).join('\n')
      : '- (ยังไม่มีแผนกที่ขึ้นกับห้องนี้)',
    PEER: peers.length
      ? peers.map((d) => '- ' + cap(d.manager.name) + ' (ห้อง id: ' + d.id + ')').join('\n')
      : '- (ไม่มี)',
    PEER_ID: peers.length ? peers[0].id : '<peer id>',
  };
  vars.GUARD_PATH = posix(path.join(me.rootAbs, '.claude', 'hooks', 'exec-guard.js'));
  for (const k of ['DECIDE_PATH', 'ASK_PATH', 'CONSULT_PATH', 'MEMO_PATH', 'GUARD_PATH']) {
    if (BAD_PATH.test(vars[k]) || vars[k].includes('\0')) throw new Error(k + ' มีอักขระต้องห้าม (" \' ` $ % ! \\ CR LF): ' + vars[k]);
  }
  return { vars, me };
}

function newExec(root, { id = 'executive', role, refresh = false, log = () => {} } = {}) {
  role = role || (id === 'executive-biz' ? 'biz' : 'tech');
  if (!ROLE_TEXTS[role]) throw new Error('--role ต้องเป็น tech หรือ biz');
  const { vars, me } = buildVars(root, id, role);
  const tplDir = path.join(__dirname, 'exec-template');
  const outDir = me.rootAbs;
  const render = (s) => s.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (!(k in vars)) throw new Error('unknown placeholder ' + m);
    return vars[k];
  });
  const put = (rel, content, overwrite) => {
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.writeFileSync(dest, content, { flag: overwrite ? 'w' : 'wx', encoding: 'utf8' });
      log((overwrite ? 'wrote   ' : 'created ') + posix(path.relative(root, dest)));
    } catch (e) {
      if (e.code === 'EEXIST') log('exists  ' + posix(path.relative(root, dest)));
      else throw e;
    }
  };
  for (const rel of ['CLAUDE.md', path.join('.claude', 'settings.json')]) {
    // การกันเขียนทำโดย hook exec-guard.js (deny Edit(//C:/...) ไม่มีผลจริง จึงเลิกใช้ ; คง Edit(//**) เป็นชั้นซ้อน)
    put(rel, render(fs.readFileSync(path.join(tplDir, rel), 'utf8')), refresh);
  }
  // คัด exec-guard.js (เขียนทับเสมอ — เป็นตัวกัน ไม่ใช่ไฟล์ที่ห้องแก้เอง)
  const guardDest = path.join(outDir, '.claude', 'hooks', 'exec-guard.js');
  fs.mkdirSync(path.dirname(guardDest), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'hooks-src', 'exec-guard.js'), guardDest);
  log('wrote   ' + posix(path.relative(root, guardDest)));
  put(path.join('docs', 'whiteboard.md'), '', false);
  const s = JSON.parse(fs.readFileSync(path.join(outDir, '.claude', 'settings.json'), 'utf8'));
  return { id, role, outDir, settings: s };
}

module.exports = { newExec, buildVars };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const root = process.env.OFFICE_ROOT ? path.resolve(process.env.OFFICE_ROOT) : path.resolve(__dirname, '..');
  try {
    const r = newExec(root, { id: opt('--id') || 'executive', role: opt('--role'), refresh: argv.includes('--refresh'), log: console.log });
    console.log('allow:', JSON.stringify(r.settings.permissions.allow));
    console.log('deny:', JSON.stringify(r.settings.permissions.deny));
  } catch (e) {
    console.error('ERROR: ' + e.message);
    process.exit(1);
  }
}
