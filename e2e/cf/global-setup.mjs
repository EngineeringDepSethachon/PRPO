// Run BEFORE wrangler pages dev (chained in the playwright.cf.config.js webServer command) : migrations + seed of the local D1.
import { setupLocalD1 } from './seed.mjs';

await setupLocalD1();
console.log('[e2e-cf] local D1 migrated + seeded');
