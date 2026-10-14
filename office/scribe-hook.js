'use strict';
// แทนคำสั่ง hook ใน kafae-scribe.md ให้เป็น path เต็มของ whiteboard-only.js (กัน hook fail-open เมื่อ cwd ไม่ใช่ราก)
const path = require('path');

const HOOK_LINE = /^(\s*command:\s*)'node \.claude\/hooks\/whiteboard-only\.js'[ \t]*(\r?)$/m;

// destClaudeDir = โฟลเดอร์ .claude ปลายทาง ; คืนข้อความใหม่ (throw ถ้า path มีอักขระที่ quote ไม่ปลอดภัย หรือไม่พบบรรทัด hook)
function hookCommand(destClaudeDir) {
  const hook = path.resolve(destClaudeDir, 'hooks', 'whiteboard-only.js').replace(/\\/g, '/');
  if (/["'`$%!\r\n\0]/.test(hook)) throw new Error('path ปลายทางมีอักขระที่ใช้ใน hook command ไม่ได้ (" \' ` $ % !): ' + hook);
  return "node \"" + hook + "\"";
}

function rewriteScribeHook(text, destClaudeDir) {
  if (!HOOK_LINE.test(text)) throw new Error("kafae-scribe.md: ไม่พบบรรทัด command: 'node .claude/hooks/whiteboard-only.js' ให้แทนที่ (ไฟล์ต้นฉบับถูกแก้รูปแบบ?)");
  const cmd = hookCommand(destClaudeDir);
  return { text: text.replace(HOOK_LINE, (_, pre, cr) => pre + "'" + cmd + "'" + cr), changed: true };
}

module.exports = { rewriteScribeHook, hookCommand };
