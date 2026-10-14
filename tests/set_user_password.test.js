// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSetPasswordSql, checkPassword, checkOutPath } from '../scripts/set-user-password.js';
import { verifyPassword } from '../functions/_lib/password.js';

let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

describe('scripts/set-user-password.js', () => {
  it('rejects forbidden / short passwords', () => {
    expect(checkPassword('123456')).toBeTruthy();
    expect(checkPassword('Admin123')).toBeTruthy();
    expect(checkPassword('PASSWORD123')).toBeTruthy();
    expect(checkPassword('abc')).toBeTruthy();
    expect(checkPassword('x'.repeat(257))).toBeTruthy();
    expect(checkPassword('Str0ng-pass')).toBeNull();
  });

  it('rejects leading / trailing whitespace (server trims at login)', async () => {
    expect(checkPassword(' Str0ng-pass')).toBeTruthy();
    expect(checkPassword('Str0ng-pass ')).toBeTruthy();
    expect(checkPassword('Str0ng-pass\n')).toBeTruthy();
    expect(checkPassword('Str0ng pass')).toBeNull();
    await expect(buildSetPasswordSql('admin', ' Str0ng-pass ')).rejects.toThrow();
  });

  it('refuses a non-TTY (piped) stdin, no bypass', async () => {
    const { spawnSync } = await import('node:child_process');
    const script = path.resolve('scripts/set-user-password.js');
    const out = path.join(os.tmpdir(), `prpo-nontty-${process.pid}.sql`);
    const r = spawnSync(process.execPath, [script, '--username', 'admin', '--out', out], { input: 'Str0ng-pass\nStr0ng-pass\n', encoding: 'utf8', env: { ...process.env, PRPO_ALLOW_PIPED_STDIN: '1' } });
    expect(r.status).toBe(1);
    expect(fs.existsSync(out)).toBe(false);
    expect(r.stderr).toContain('ไม่ใช่เทอร์มินัล');
  });

  it('out path must be outside the repo and end with .sql', () => {
    expect(() => checkOutPath(path.join(process.cwd(), 'x.sql'))).toThrow();
    expect(() => checkOutPath(path.join(os.tmpdir(), 'x.txt'))).toThrow();
    expect(checkOutPath(path.join(os.tmpdir(), 'prpo-no-such-file-xyz.sql'))).toBeTruthy();
  });

  it('SQL has no plaintext and the stored hash verifies with the server verifyPassword', async () => {
    const pw = "Pa'ss\"w0rd-ทดสอบ";
    const sql = await buildSetPasswordSql('  Admin ', pw);
    expect(sql).not.toContain(pw);
    expect(sql).toMatch(/mustChangePassword = 1/);
    expect(sql).toMatch(/tokenVersion = COALESCE\(tokenVersion, 0\) \+ 1/);
    if (!DatabaseSync) return;
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE users (id TEXT, username TEXT, password TEXT, pin TEXT, passwordHash TEXT, passwordSalt TEXT, passwordAlgo TEXT,
      passwordIterations INTEGER, passwordUpdatedAt TEXT, mustChangePassword INTEGER DEFAULT 0, tokenVersion INTEGER DEFAULT 0);
      INSERT INTO users (id, username, password, tokenVersion) VALUES ('u1','admin','admin123',2), ('u2','other','keep',0);`);
    db.exec(sql);
    const u = db.prepare("SELECT * FROM users WHERE id='u1'").get();
    expect(u.tokenVersion).toBe(3);
    expect(u.mustChangePassword).toBe(1);
    expect(u.password).toBe('');
    expect(await verifyPassword(pw, { hash: u.passwordHash, salt: u.passwordSalt, iterations: u.passwordIterations, algo: u.passwordAlgo })).toBe(true);
    expect(await verifyPassword('wrong-pass', { hash: u.passwordHash, salt: u.passwordSalt, iterations: u.passwordIterations, algo: u.passwordAlgo })).toBe(false);
    expect(db.prepare("SELECT password FROM users WHERE id='u2'").get().password).toBe('keep');
    db.close();
  });
});
