/**
 * @file prepare-cloudflare.js
 * @description Prepares, organizes, and synchronizes the standalone Cloudflare
 * deployment package in cloudflare/ directory.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const CF_DIR = path.join(ROOT_DIR, 'cloudflare');
// --backend-only : refresh only functions/, d1_schema.sql, package.json, README in cloudflare/
const BACKEND_ONLY = process.argv.includes('--backend-only');

function copyRecursiveSync(src, dest, ignoreList = []) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats.isDirectory();

  if (isDirectory) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    fs.readdirSync(src).forEach((childItemName) => {
      if (ignoreList.includes(childItemName)) return;
      copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName), ignoreList);
    });
  } else {
    fs.copyFileSync(src, dest);
  }
}

async function prepareCloudflare() {
  console.log('====================================================');
  console.log('  Preparing Standalone Cloudflare Deployment Folder');
  console.log('====================================================\n');

  if (!fs.existsSync(CF_DIR)) {
    fs.mkdirSync(CF_DIR, { recursive: true });
  }

  // 1. Copy D1 SQL Schema
  const sqlSrc = path.join(ROOT_DIR, 'd1_schema.sql');
  const sqlDest = path.join(CF_DIR, 'd1_schema.sql');
  fs.copyFileSync(sqlSrc, sqlDest);
  console.log('âœ… Copied d1_schema.sql');

  // 2. Copy Cloudflare Pages Functions
  const funcSrc = path.join(ROOT_DIR, 'functions');
  const funcDest = path.join(CF_DIR, 'functions');
  copyRecursiveSync(funcSrc, funcDest);
  console.log('âœ… Copied functions/ (Cloudflare Pages Functions API, incl. _lib/)');

  // 2b. migrations are NOT copied : root migrations/ is the single source of truth (cloudflare/wrangler.toml points migrations_dir at ../migrations)

  // 3. Copy Frontend App Source (skipped with --backend-only: sync functions/schema/package/README only)
  const dirsToCopy = BACKEND_ONLY ? [] : ['src', 'public'];
  if (dirsToCopy.includes('src')) {
    console.warn('âš ï¸  à¸„à¸±à¸” src/ à¹„à¸›à¸—à¸µà¹ˆ cloudflare/src (à¸ªà¸³à¹€à¸™à¸²) â€” deploy à¸ˆà¸²à¸ root à¹€à¸—à¹ˆà¸²à¸™à¸±à¹‰à¸™ (npm run build:cf à¸—à¸µà¹ˆ root); à¸ªà¸³à¹€à¸™à¸² cloudflare/src à¹„à¸¡à¹ˆà¹ƒà¸Šà¹ˆà¹à¸«à¸¥à¹ˆà¸‡à¸ˆà¸£à¸´à¸‡');
  }
  for (const dir of dirsToCopy) {
    const s = path.join(ROOT_DIR, dir);
    const d = path.join(CF_DIR, dir);
    copyRecursiveSync(s, d, ['__tests__']);
    console.log(`âœ… Copied ${dir}/`);
  }

  // 4. Copy Frontend Config Files
  const filesToCopy = [
    'index.html',
    'vite.config.js',
    'tailwind.config.js',
    'postcss.config.js',
    'jsconfig.json',
    '.env.production'
  ];
  for (const file of BACKEND_ONLY ? [] : filesToCopy) {
    const s = path.join(ROOT_DIR, file);
    const d = path.join(CF_DIR, file);
    if (fs.existsSync(s)) {
      fs.copyFileSync(s, d);
      console.log(`âœ… Copied ${file}`);
    }
  }

  // 5. wrangler.toml (skipped with --backend-only so the root wrangler.toml is never rewritten)
  const wranglerTomlContent = `# ====================================================================
# Cloudflare Pages + D1 Database Configuration
# Project: PRPO_PDQC System
# ====================================================================

name = "prpo-pdqc"
pages_build_output_dir = "dist"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

# Cloudflare D1 SQL Database Binding
[[d1_databases]]
binding = "DB"
database_name = "prpo-db"
database_id = "c64022bb-88eb-485f-94f7-dd9e9617e44c"
migrations_dir = "../migrations"

# Preview deployments must NOT share the production database : see the root wrangler.toml
[[env.preview.d1_databases]]
binding = "DB"
database_name = "prpo-db-preview"
database_id = "<PREVIEW_DATABASE_ID>"
migrations_dir = "../migrations"

# File storage : private R2 buckets (binding FILES), served only through /api/files/:id
[[r2_buckets]]
binding = "FILES"
bucket_name = "prpo-files"

[[env.preview.r2_buckets]]
binding = "FILES"
bucket_name = "prpo-files-preview"

[vars]
FILE_STORAGE = "r2"

[env.preview.vars]
FILE_STORAGE = "r2"
`;
  if (!BACKEND_ONLY) {
  fs.writeFileSync(path.join(CF_DIR, 'wrangler.toml'), wranglerTomlContent, 'utf8');
  console.log('âœ… Created cloudflare/wrangler.toml');

  // 6. Create wrangler.toml.example in cloudflare/
  const wranglerExampleContent = `# ====================================================================
# Cloudflare Pages + D1 Database Configuration Template
# à¹ƒà¸Šà¹‰à¹€à¸›à¹‡à¸™à¸•à¸±à¸§à¸­à¸¢à¹ˆà¸²à¸‡à¸ªà¸³à¸«à¸£à¸±à¸šà¹ƒà¸«à¹‰à¸—à¸µà¸¡à¸‡à¸²à¸™/à¹€à¸„à¸£à¸·à¹ˆà¸­à¸‡à¸­à¸·à¹ˆà¸™/à¸œà¸¹à¹‰à¸žà¸±à¸’à¸™à¸²à¸­à¸·à¹ˆà¸™ Deploy
# ====================================================================

name = "prpo-pdqc"
pages_build_output_dir = "dist"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

# Cloudflare D1 SQL Database Binding
# 1. à¸£à¸±à¸™à¸„à¸³à¸ªà¸±à¹ˆà¸‡à¸ªà¸£à¹‰à¸²à¸‡à¸à¸²à¸™à¸‚à¹‰à¸­à¸¡à¸¹à¸¥: npx wrangler d1 create YOUR_DATABASE_NAME
# 2. à¸™à¸³ database_id à¸—à¸µà¹ˆà¹„à¸”à¹‰à¸¡à¸²à¹ƒà¸ªà¹ˆà¹ƒà¸™à¸Šà¹ˆà¸­à¸‡ database_id à¸”à¹‰à¸²à¸™à¸¥à¹ˆà¸²à¸‡
# 3. Apply migrations (à¸—à¸”à¸ªà¸­à¸š local): npx wrangler d1 migrations apply prpo-db --local
#    Production: npx wrangler d1 migrations apply prpo-db --remote (à¸œà¸¹à¹‰à¹ƒà¸Šà¹‰à¸£à¸±à¸™à¹€à¸­à¸‡à¹€à¸—à¹ˆà¸²à¸™à¸±à¹‰à¸™)
[[d1_databases]]
binding = "DB"
database_name = "prpo-db"
database_id = "YOUR_CLOUDFLARE_D1_DATABASE_ID_HERE"
migrations_dir = "../migrations"

# File storage : private R2 buckets (binding FILES) ; FILE_STORAGE = "r2" (default) | "drive"
[[r2_buckets]]
binding = "FILES"
bucket_name = "prpo-files"

[[env.preview.r2_buckets]]
binding = "FILES"
bucket_name = "prpo-files-preview"

[vars]
FILE_STORAGE = "r2"
`;
  fs.writeFileSync(path.join(CF_DIR, 'wrangler.toml.example'), wranglerExampleContent, 'utf8');
  console.log('âœ… Created cloudflare/wrangler.toml.example');

  // The ROOT wrangler.toml / wrangler.toml.example are the source of truth (they carry the Preview D1 block, DRIVE_ROOT_FOLDER_ID ...) :
  // this script only writes the copies inside cloudflare/ and NEVER touches the root files (it used to overwrite them).
  console.warn('â„¹ï¸  root wrangler.toml / wrangler.toml.example à¹„à¸¡à¹ˆà¸–à¸¹à¸à¹à¸à¹‰à¹„à¸‚ (à¹à¸«à¸¥à¹ˆà¸‡à¸ˆà¸£à¸´à¸‡à¸­à¸¢à¸¹à¹ˆà¸—à¸µà¹ˆ root) â€” à¹„à¸Ÿà¸¥à¹Œà¹ƒà¸™ cloudflare/ à¹€à¸›à¹‡à¸™à¸ªà¸³à¹€à¸™à¸²à¹à¸šà¸šà¸¢à¹ˆà¸­ à¸«à¹‰à¸²à¸¡à¹ƒà¸Šà¹‰ deploy');
  }

  // 7. Create standalone package.json in cloudflare/
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const cfPkg = {
    name: 'prpo-pdqc-cloudflare',
    private: true,
    version: '1.0.0',
    type: 'module',
    scripts: {
      dev: 'vite',
      'dev:pages': 'npx wrangler pages dev dist',
      build: 'vite build --mode cloudflare',
      'build:cf': 'vite build --mode cloudflare',
      preview: 'vite preview',
      deploy: 'npm run build &&npx wrangler pages deploy dist',
      'db:create': 'npx wrangler d1 create prpo-db',
      // no --remote here: add it yourself per the deployment guide when you really mean production
      'db:migrate': 'npx wrangler d1 migrations apply prpo-db',
      'db:migrate:local': 'npx wrangler d1 migrations apply prpo-db --local',
      lint: 'oxlint'
    },
    dependencies: rootPkg.dependencies,
    devDependencies: {
      ...rootPkg.devDependencies,
      wrangler: '^3.109.2'
    }
  };
  fs.writeFileSync(path.join(CF_DIR, 'package.json'), JSON.stringify(cfPkg, null, 2) + '\n', 'utf8');
  console.log('âœ… Created cloudflare/package.json');

  // 8. Create .env.example in cloudflare/
  const cfEnvExample = `# Cloudflare Deployment Environment Variables
# à¸ªà¸³à¸«à¸£à¸±à¸šà¹‚à¸«à¸¡à¸” Cloudflare D1 / Pages Functions à¹ƒà¸«à¹‰à¹€à¸§à¹‰à¸™à¸§à¹ˆà¸²à¸‡ VITE_GAS_API_URL à¹„à¸§à¹‰
VITE_GAS_API_URL=
# à¹‚à¸«à¸¡à¸” backend: mock | gas | cloudflare (build:cf à¸•à¸±à¹‰à¸‡à¹€à¸›à¹‡à¸™ cloudflare à¹ƒà¸«à¹‰à¸­à¸±à¸•à¹‚à¸™à¸¡à¸±à¸•à¸´)
VITE_BACKEND_MODE=cloudflare
`;
  if (!BACKEND_ONLY) {
    fs.writeFileSync(path.join(CF_DIR, '.env.example'), cfEnvExample, 'utf8');
    fs.writeFileSync(path.join(CF_DIR, '.env.production'), cfEnvExample, 'utf8');
    console.log('âœ… Created cloudflare/.env.example and .env.production');
  }

  // 9. Create README.md in cloudflare/
  const cfReadme = `# ðŸš€ à¸„à¸¹à¹ˆà¸¡à¸·à¸­à¸à¸²à¸£à¸•à¸´à¸”à¸•à¸±à¹‰à¸‡à¹à¸¥à¸° Deploy à¹‚à¸›à¸£à¹€à¸ˆà¸à¸•à¹Œ PRPO_PDQC à¸šà¸™ Cloudflare Pages & D1 Database

> **âš ï¸ à¹à¸«à¸¥à¹ˆà¸‡à¸ˆà¸£à¸´à¸‡à¸­à¸¢à¸¹à¹ˆà¸—à¸µà¹ˆ root à¸‚à¸­à¸‡à¹‚à¸›à¸£à¹€à¸ˆà¸à¸•à¹Œ â€” à¹ƒà¸«à¹‰ deploy à¸ˆà¸²à¸ root à¹€à¸—à¹ˆà¸²à¸™à¸±à¹‰à¸™**
> - Build: \`npm run build:cf\` (à¸—à¸µà¹ˆ root) à¹à¸¥à¹‰à¸§à¸£à¸±à¸™ \`wrangler pages ...\` à¸—à¸µà¹ˆ root (à¹ƒà¸Šà¹‰ \`functions/\`, \`migrations/\`, \`wrangler.toml\` à¸‚à¸­à¸‡ root)
> - à¹‚à¸Ÿà¸¥à¹€à¸”à¸­à¸£à¹Œ \`cloudflare/\` à¹€à¸›à¹‡à¸™à¸ªà¸³à¹€à¸™à¸²à¸—à¸µà¹ˆ **à¸ªà¸£à¹‰à¸²à¸‡à¸ˆà¸²à¸à¸ªà¸„à¸£à¸´à¸›à¸•à¹Œ \`node scripts/prepare-cloudflare.js\` à¹€à¸—à¹ˆà¸²à¸™à¸±à¹‰à¸™** à¸«à¹‰à¸²à¸¡à¹à¸à¹‰à¹„à¸Ÿà¸¥à¹Œà¹ƒà¸™à¸™à¸µà¹‰à¸”à¹‰à¸§à¸¢à¸¡à¸·à¸­ (à¸ˆà¸°à¸–à¸¹à¸à¹€à¸‚à¸µà¸¢à¸™à¸—à¸±à¸š) ; à¹à¸à¹‰à¸—à¸µà¹ˆ root à¹à¸¥à¹‰à¸§à¸£à¸±à¸™à¸ªà¸„à¸£à¸´à¸›à¸•à¹Œà¹ƒà¸«à¸¡à¹ˆ
> - à¸•à¸±à¹‰à¸‡à¸„à¹ˆà¸² secret \`AUTH_TOKEN_SECRET\` à¸”à¹‰à¸§à¸¢ \`wrangler pages secret put AUTH_TOKEN_SECRET\` (à¸”à¸¹ \`.dev.vars.example\`) à¹à¸¥à¸° apply migrations à¸—à¸±à¹‰à¸‡à¸«à¸¡à¸” (0001-0005+) à¸à¹ˆà¸­à¸™à¹ƒà¸Šà¹‰à¸‡à¸²à¸™
> - à¹„à¸¡à¹ˆà¸¡à¸µà¸£à¸«à¸±à¸ªà¸œà¹ˆà¸²à¸™à¹€à¸£à¸´à¹ˆà¸¡à¸•à¹‰à¸™à¹ƒà¸™à¸£à¸°à¸šà¸š à¸•à¹‰à¸­à¸‡à¸ªà¸£à¹‰à¸²à¸‡à¸œà¸¹à¹‰à¹ƒà¸Šà¹‰à¹à¸£à¸à¹à¸šà¸š hash à¹€à¸­à¸‡ (\`d1_schema.sql\` à¹„à¸¡à¹ˆà¸¡à¸µ seed users)

à¹‚à¸Ÿà¸¥à¹€à¸”à¸­à¸£à¹Œà¸™à¸µà¹‰à¸£à¸§à¸šà¸£à¸§à¸¡à¹„à¸Ÿà¸¥à¹Œà¸—à¸±à¹‰à¸‡à¸«à¸¡à¸”à¸—à¸µà¹ˆà¹ƒà¸Šà¹‰à¸ªà¸³à¸«à¸£à¸±à¸šà¸à¸²à¸£ Deploy à¸£à¸°à¸šà¸š **PRPO_PDQC** à¸‚à¸¶à¹‰à¸™à¸ªà¸¹à¹ˆ **Cloudflare Pages** à¹à¸¥à¸°à¸à¸²à¸™à¸‚à¹‰à¸­à¸¡à¸¹à¸¥ **Cloudflare D1 (SQL)** à¹„à¸§à¹‰à¸­à¸¢à¹ˆà¸²à¸‡à¸„à¸£à¸šà¸–à¹‰à¸§à¸™à¹à¸¥à¸°à¹à¸¢à¸à¹€à¸›à¹‡à¸™à¸ªà¸±à¸”à¸ªà¹ˆà¸§à¸™à¸ªà¸¡à¸šà¸¹à¸£à¸“à¹Œ

---

## ðŸ“ à¹‚à¸„à¸£à¸‡à¸ªà¸£à¹‰à¸²à¸‡à¹„à¸Ÿà¸¥à¹Œà¹ƒà¸™à¹‚à¸Ÿà¸¥à¹€à¸”à¸­à¸£à¹Œ \`cloudflare/\`

\`\`\`
cloudflare/
â”œâ”€â”€ d1_schema.sql          # DEPRECATED (à¸¡à¸µà¸„à¸³à¸ªà¸±à¹ˆà¸‡ DROP) à¹ƒà¸Šà¹‰ migrations/ à¹à¸—à¸™
â”œâ”€â”€ functions/             # Cloudflare Pages Functions (Native Serverless REST API)
â”‚   â””â”€â”€ api/
â”‚       â””â”€â”€ [[route]].js   # API Gateway à¹€à¸Šà¸·à¹ˆà¸­à¸¡à¹‚à¸¢à¸‡ Cloudflare D1 Database (Binding: DB)
â”œâ”€â”€ src/                   # Source Code Frontend React SPA à¸—à¸±à¹‰à¸‡à¸«à¸¡à¸”
â”œâ”€â”€ public/                # Static Assets à¹à¸¥à¸° Fonts
â”œâ”€â”€ index.html             # Main HTML Template
â”œâ”€â”€ vite.config.js         # à¸à¸²à¸£à¸•à¸±à¹‰à¸‡à¸„à¹ˆà¸² Vite Build
â”œâ”€â”€ tailwind.config.js     # à¸à¸²à¸£à¸•à¸±à¹‰à¸‡à¸„à¹ˆà¸² Tailwind CSS
â”œâ”€â”€ postcss.config.js      # PostCSS
â”œâ”€â”€ wrangler.toml          # à¹„à¸Ÿà¸¥à¹Œà¸„à¸­à¸™à¸Ÿà¸´à¸ Cloudflare à¸žà¸£à¹‰à¸­à¸¡à¸œà¸¹à¸ Binding Database ID à¹à¸¥à¹‰à¸§
â”œâ”€â”€ wrangler.toml.example  # à¹„à¸Ÿà¸¥à¹Œà¸„à¸­à¸™à¸Ÿà¸´à¸à¸•à¸±à¸§à¸­à¸¢à¹ˆà¸²à¸‡à¸ªà¸³à¸«à¸£à¸±à¸šà¹ƒà¸«à¹‰à¹€à¸„à¸£à¸·à¹ˆà¸­à¸‡à¸­à¸·à¹ˆà¸™à¸«à¸£à¸·à¸­à¸„à¸™à¸­à¸·à¹ˆà¸™à¸™à¸³à¹„à¸› Deploy
â”œâ”€â”€ .env.production        # Environment variables à¸ªà¸³à¸«à¸£à¸±à¸š Production à¸šà¸™ Cloudflare
â”œâ”€â”€ .env.example           # à¸•à¸±à¸§à¸­à¸¢à¹ˆà¸²à¸‡ Environment variables
â””â”€â”€ package.json           # à¸ªà¸„à¸£à¸´à¸›à¸•à¹Œà¸„à¸³à¸ªà¸±à¹ˆà¸‡à¸ªà¸³à¸«à¸£à¸±à¸š Build, Deploy à¹à¸¥à¸°à¸£à¸±à¸™ D1 Migrations
\`\`\`

---

## âš™ï¸ à¸‚à¹‰à¸­à¸¡à¸¹à¸¥ Cloudflare D1 à¸›à¸£à¸°à¸ˆà¸³à¸£à¸°à¸šà¸š

| à¸£à¸²à¸¢à¸à¸²à¸£ | à¸„à¹ˆà¸²à¸›à¸±à¸ˆà¸ˆà¸¸à¸šà¸±à¸™ |
|---|---|
| **Database Name** | \`prpo-db\` |
| **Database ID** | \`c64022bb-88eb-485f-94f7-dd9e9617e44c\` |
| **D1 Binding Name** | \`DB\` |
| **Pages Project** | \`prpo-pdqc\` |

---

## ðŸ› ï¸ à¸‚à¸±à¹‰à¸™à¸•à¸­à¸™à¸à¸²à¸£ Deploy à¸ªà¸³à¸«à¸£à¸±à¸šà¸œà¸¹à¹‰à¸žà¸±à¸’à¸™à¸²à¸„à¸™à¸­à¸·à¹ˆà¸™ (Deployment Guide for Others)

à¸«à¸²à¸à¸•à¹‰à¸­à¸‡à¸à¸²à¸£à¸™à¸³à¹‚à¸„à¹‰à¸”à¸Šà¸¸à¸”à¸™à¸µà¹‰à¹„à¸› Deploy à¸šà¸™ Cloudflare Account à¸­à¸·à¹ˆà¸™ à¸«à¸£à¸·à¸­à¸ªà¸£à¹‰à¸²à¸‡ Environment à¹ƒà¸«à¸¡à¹ˆ à¹ƒà¸«à¹‰à¸›à¸à¸´à¸šà¸±à¸•à¸´à¸•à¸²à¸¡ 5 à¸‚à¸±à¹‰à¸™à¸•à¸­à¸™à¸”à¸±à¸‡à¸™à¸µà¹‰:

### 1. à¸•à¸´à¸”à¸•à¸±à¹‰à¸‡ Dependencies
à¹€à¸›à¸´à¸” Terminal à¹ƒà¸™à¹‚à¸Ÿà¸¥à¹€à¸”à¸­à¸£à¹Œà¸™à¸µà¹‰ à¹à¸¥à¹‰à¸§à¸£à¸±à¸™:
\`\`\`bash
npm install
\`\`\`

### 2. à¸¥à¹‡à¸­à¸à¸­à¸´à¸™à¹€à¸‚à¹‰à¸²à¸ªà¸¹à¹ˆà¸£à¸°à¸šà¸š Cloudflare
\`\`\`bash
npx wrangler login
\`\`\`
*(à¹€à¸šà¸£à¸²à¸§à¹Œà¹€à¸‹à¸­à¸£à¹Œà¸ˆà¸°à¹€à¸›à¸´à¸”à¸‚à¸¶à¹‰à¸™à¸¡à¸²à¹ƒà¸«à¹‰à¸à¸” Allow à¸ªà¸´à¸—à¸˜à¸´à¹Œà¸à¸²à¸£à¹€à¸‚à¹‰à¸²à¸–à¸¶à¸‡ Cloudflare)*

### 3. à¸ªà¸£à¹‰à¸²à¸‡à¸à¸²à¸™à¸‚à¹‰à¸­à¸¡à¸¹à¸¥ D1 Database à¹ƒà¸«à¸¡à¹ˆ (à¸à¸£à¸“à¸µà¹€à¸›à¹‡à¸™à¸£à¸°à¸šà¸šà¹ƒà¸«à¸¡à¹ˆ)
\`\`\`bash
npx wrangler d1 create prpo-db
\`\`\`
à¹€à¸¡à¸·à¹ˆà¸­à¸„à¸³à¸ªà¸±à¹ˆà¸‡à¸—à¸³à¸‡à¸²à¸™à¹€à¸ªà¸£à¹‡à¸ˆ à¸ˆà¸°à¹„à¸”à¹‰à¸£à¸±à¸šà¸‚à¹‰à¸­à¸„à¸§à¸²à¸¡à¹à¸ªà¸”à¸‡ **database_id** à¸•à¸±à¸§à¸­à¸¢à¹ˆà¸²à¸‡à¹€à¸Šà¹ˆà¸™:
\`\`\`
âœ… Successfully created DB 'prpo-db' with ID 'a1b2c3d4-e5f6-7890-abcd-1234567890ef'
\`\`\`

### 4. à¸­à¸±à¸›à¹€à¸”à¸•à¹„à¸Ÿà¸¥à¹Œà¸„à¸­à¸™à¸Ÿà¸´à¸ \`wrangler.toml\`
à¸™à¸³ **database_id** à¸—à¸µà¹ˆà¹„à¸”à¹‰à¸ˆà¸²à¸à¸‚à¸±à¹‰à¸™à¸•à¸­à¸™à¸—à¸µà¹ˆ 3 à¹„à¸›à¹ƒà¸ªà¹ˆà¹ƒà¸™à¹„à¸Ÿà¸¥à¹Œ \`wrangler.toml\`:
\`\`\`toml
name = "prpo-pdqc"
pages_build_output_dir = "dist"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "prpo-db"
database_id = "à¹ƒà¸ªà¹ˆ_DATABASE_ID_à¸‚à¸­à¸‡à¸„à¸¸à¸“à¸—à¸µà¹ˆà¸™à¸µà¹ˆ"
\`\`\`

### 5. Apply D1 migrations
\`\`\`bash
npm run db:migrate:local      # à¸à¸²à¸™à¸‚à¹‰à¸­à¸¡à¸¹à¸¥ local
npm run db:migrate            # à¸ªà¸„à¸£à¸´à¸›à¸•à¹Œà¸™à¸µà¹‰à¹„à¸¡à¹ˆà¹ƒà¸ªà¹ˆ --remote à¹ƒà¸«à¹‰ ; à¸–à¹‰à¸²à¸ˆà¸° apply à¸‚à¸¶à¹‰à¸™ production à¹ƒà¸«à¹‰à¹€à¸žà¸´à¹ˆà¸¡ --remote à¹€à¸­à¸‡à¸•à¸²à¸¡à¸„à¸¹à¹ˆà¸¡à¸·à¸­
\`\`\`

### 6. à¸ªà¸±à¹ˆà¸‡ Build à¹à¸¥à¸° Deploy à¸‚à¸¶à¹‰à¸™ Cloudflare Pages
\`\`\`bash
npm run deploy
\`\`\`
à¸„à¸³à¸ªà¸±à¹ˆà¸‡à¸™à¸µà¹‰à¸ˆà¸°à¸—à¸³à¸à¸²à¸£:
1. à¸„à¸­à¸¡à¹„à¸žà¸¥à¹Œ Frontend à¸”à¹‰à¸§à¸¢ Vite (\`npm run build\`) à¹„à¸›à¹„à¸§à¹‰à¸—à¸µà¹ˆà¹‚à¸Ÿà¸¥à¹€à¸”à¸­à¸£à¹Œ \`dist/\`
2. à¸ªà¹ˆà¸‡à¹„à¸Ÿà¸¥à¹Œ \`dist/\` à¹à¸¥à¸° \`functions/\` à¸‚à¸¶à¹‰à¸™ Cloudflare Pages à¸­à¸±à¸•à¹‚à¸™à¸¡à¸±à¸•à¸´

---

## ðŸ”— à¸à¸²à¸£à¸œà¸¹à¸ D1 Binding à¸šà¸™ Cloudflare Dashboard (à¸à¸£à¸“à¸µ Deploy à¸œà¹ˆà¸²à¸™ Git)

à¸«à¸²à¸à¹€à¸Šà¸·à¹ˆà¸­à¸¡à¸•à¹ˆà¸­ GitHub à¹€à¸‚à¹‰à¸²à¸à¸±à¸š Cloudflare Pages à¹ƒà¸«à¹‰à¹€à¸‚à¹‰à¸²à¹„à¸›à¸•à¸±à¹‰à¸‡à¸„à¹ˆà¸²à¸—à¸µà¹ˆ Cloudflare Dashboard:
1. à¹„à¸›à¸—à¸µà¹ˆ **Workers & Pages** â†’ à¹€à¸¥à¸·à¸­à¸à¹‚à¸›à¸£à¹€à¸ˆà¸à¸•à¹Œ **prpo-pdqc**
2. à¹„à¸›à¸—à¸µà¹ˆà¹à¸—à¹‡à¸š **Settings** â†’ **Functions**
3. à¹€à¸¥à¸·à¹ˆà¸­à¸™à¸¥à¸‡à¸¡à¸²à¸—à¸µà¹ˆà¸«à¸±à¸§à¸‚à¹‰à¸­ **D1 database bindings**
4. à¸à¸” **Add binding**:
   - **Variable name**: à¸•à¹‰à¸­à¸‡à¸•à¸±à¹‰à¸‡à¹€à¸›à¹‡à¸™ \`DB\` à¹€à¸—à¹ˆà¸²à¸™à¸±à¹‰à¸™
   - **D1 database**: à¹€à¸¥à¸·à¸­à¸ \`prpo-db\`
5. à¸à¸” **Save** à¹à¸¥à¹‰à¸§à¸ªà¸±à¹ˆà¸‡ Trigger Deploy à¹ƒà¸«à¸¡à¹ˆà¸­à¸µà¸à¸„à¸£à¸±à¹‰à¸‡

---

## ðŸ§ª à¸šà¸±à¹Šà¸à¸—à¸µà¹ˆà¹„à¸”à¹‰à¸£à¸±à¸šà¸à¸²à¸£à¹à¸à¹‰à¹„à¸‚à¹ƒà¸™à¹€à¸§à¸­à¸£à¹Œà¸Šà¸±à¸™à¸™à¸µà¹‰ (Data Submission & Sync Bug Fixes)

1. **à¸à¸²à¸£à¸ªà¸£à¹‰à¸²à¸‡ PR (\`POST /api/prs\`):** à¹à¸à¹‰à¹„à¸‚à¹ƒà¸«à¹‰à¸„à¸·à¸™à¸„à¹ˆà¸² Full PR Data Object à¸„à¸£à¸šà¸–à¹‰à¸§à¸™ à¹€à¸žà¸·à¹ˆà¸­à¹ƒà¸«à¹‰à¸«à¸™à¹‰à¸² UI à¹„à¸”à¹‰à¸‚à¹‰à¸­à¸¡à¸¹à¸¥ PR à¸—à¸µà¹ˆà¸ªà¸£à¹‰à¸²à¸‡à¸—à¸±à¸™à¸—à¸µ à¹„à¸¡à¹ˆà¸„à¸·à¸™à¹€à¸žà¸µà¸¢à¸‡ \`{ count: 1 }\`
2. **à¸à¸²à¸£à¸­à¸±à¸›à¹€à¸”à¸•à¹à¸¥à¸°à¸šà¸±à¸™à¸—à¸¶à¸ PR (\`PUT /api/prs/:id\`):** à¸šà¸±à¸™à¸—à¸¶à¸à¸„à¹ˆà¸² \`totalAmount\`, \`reason\`, \`attachmentsJson\` à¹à¸¥à¸°à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸ªà¸´à¸™à¸„à¹‰à¸²à¹€à¸‚à¹‰à¸² D1 à¸ªà¸¡à¸šà¸¹à¸£à¸“à¹Œ à¹„à¸¡à¹ˆà¸ªà¸¹à¸à¸«à¸²à¸¢à¹€à¸¡à¸·à¹ˆà¸­à¸à¸”à¹à¸à¹‰à¹„à¸‚
3. **à¸à¸²à¸£à¸ªà¸±à¹ˆà¸‡à¸‹à¸·à¹‰à¸­à¹à¸¥à¸°à¸ªà¹ˆà¸‡à¸•à¹ˆà¸­à¸‡à¸²à¸™ (\`PUT /api/pos/:id\`):** à¸šà¸±à¸™à¸—à¸¶à¸à¸Šà¸·à¹ˆà¸­à¸£à¹‰à¸²à¸™à¸„à¹‰à¸² (\`vendorName\`), \`vendorId\`, à¸£à¸²à¸„à¸²à¸£à¸§à¸¡à¸ˆà¸£à¸´à¸‡ (\`totalAmount\`, \`grandTotal\`) à¹à¸¥à¸°à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸à¸²à¸£à¸ªà¸±à¹ˆà¸‡à¸‹à¸·à¹‰à¸­à¸­à¸­à¸™à¹„à¸¥à¸™à¹Œà¹€à¸‚à¹‰à¸²à¸ªà¸¹à¹ˆ Cloudflare D1 à¸—à¸±à¸™à¸—à¸µ
4. **à¸£à¸°à¸šà¸šà¸•à¸£à¸§à¸ˆà¸£à¸±à¸šà¸ªà¸´à¸™à¸„à¹‰à¸² GRN (\`POST /api/pos/:id/receive\`):** à¹€à¸Šà¸·à¹ˆà¸­à¸¡à¹‚à¸¢à¸‡à¸£à¸°à¸šà¸šà¸•à¸£à¸§à¸ˆà¸£à¸±à¸šà¸ªà¸´à¸™à¸„à¹‰à¸²à¹€à¸‚à¹‰à¸² D1 à¸­à¸¢à¹ˆà¸²à¸‡à¸ªà¸¡à¸šà¸¹à¸£à¸“à¹Œ à¸­à¸±à¸›à¹€à¸”à¸•à¸ªà¸•à¹‡à¸­à¸à¸ªà¸´à¸™à¸„à¹‰à¸²à¹ƒà¸™à¸•à¸²à¸£à¸²à¸‡ \`products\` à¹à¸¥à¸°à¹€à¸žà¸´à¹ˆà¸¡à¸›à¸£à¸°à¸§à¸±à¸•à¸´à¹ƒà¸™à¸•à¸²à¸£à¸²à¸‡ \`stock_logs\` à¸­à¸±à¸•à¹‚à¸™à¸¡à¸±à¸•à¸´
5. **à¸£à¸°à¸šà¸šà¸›à¸´à¸”à¸‡à¸²à¸™à¹à¸¥à¸°à¹€à¸„à¸¥à¸¡ (\`POST /api/pos/:id/settle\`):** à¸šà¸±à¸™à¸—à¸¶à¸à¸£à¸²à¸¢à¸à¸²à¸£à¸„à¸·à¸™à¸‡à¸šà¸›à¸£à¸°à¸¡à¸²à¸“à¹€à¸‚à¹‰à¸²à¸•à¸²à¸£à¸²à¸‡ \`budget_transactions\` à¹à¸¥à¸°à¸›à¸£à¸±à¸šà¸¥à¸”à¸¢à¸­à¸”à¹ƒà¸Šà¹‰à¸ˆà¹ˆà¸²à¸¢à¹ƒà¸™ \`budgets\` à¸šà¸™ D1
6. **à¸à¸²à¸£à¸ˆà¸±à¸”à¸ªà¸£à¸£à¸‡à¸šà¸›à¸£à¸°à¸¡à¸²à¸“ (\`POST /api/budgets/allocate\`):** à¸ªà¹ˆà¸‡à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¸›à¸£à¸°à¸§à¸±à¸•à¸´à¹à¸¥à¸° Delta à¸˜à¸¸à¸£à¸à¸£à¸£à¸¡à¸‡à¸šà¸›à¸£à¸°à¸¡à¸²à¸“à¹€à¸‚à¹‰à¸²à¸šà¸±à¸™à¸—à¸¶à¸à¹ƒà¸™ D1 à¸—à¸±à¸™à¸—à¸µà¸—à¸µà¹ˆà¸¡à¸µà¸à¸²à¸£à¸›à¸£à¸±à¸šà¸‡à¸š
`;
  fs.writeFileSync(path.join(CF_DIR, 'README.md'), cfReadme, 'utf8');
  console.log('âœ… Created cloudflare/README.md');

  console.log('\nðŸŽ‰ Cloudflare standalone package prepared successfully at:');
  console.log(`   ${CF_DIR}\n`);
}

prepareCloudflare().catch(err => {
  console.error('Error preparing Cloudflare deployment:', err);
  process.exit(1);
});
