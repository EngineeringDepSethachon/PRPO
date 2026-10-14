// GitHub Pages deploy was closed on 2026-10-13 : the workflow only checks (lint / test / build), it never deploys.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');

describe('.github/workflows/deploy.yml', () => {
  const yml = read('.github', 'workflows', 'deploy.yml');
  it('has no GitHub Pages job / permission / action', () => {
    for (const bad of ['build-and-deploy', 'pages: write', 'id-token: write', 'deploy-pages', 'configure-pages', 'upload-pages-artifact', 'github-pages', "group: 'pages'"]) {
      expect(yml, bad).not.toContain(bad);
    }
  });
  it('keeps the test job that runs on every push', () => {
    expect(yml).toMatch(/^jobs:\n {2}test:/m);
    expect(yml).toMatch(/push:\s*\n\s+branches:\s*\n\s+- main\s*\n\s+- uat/);
    for (const step of ['npm run lint', 'npm test', 'npm run build', 'npm run build:cf']) expect(yml).toContain(`run: ${step}`);
    expect(yml.slice(yml.indexOf('\njobs:')).match(/^ {2}[a-z-]+:\s*$/gm)).toEqual(['  test:']); // the only job
  });
  it('GITHUB_PAGES_DEPLOYMENT.md says it is no longer used (file kept)', () => {
    expect(read('GITHUB_PAGES_DEPLOYMENT.md').split('\n')[0]).toContain('เลิกใช้แล้ว');
  });
});
