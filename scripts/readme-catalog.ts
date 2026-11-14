/**
 * Regenerate the README tool catalog from the live tool registry.
 *
 *   pnpm readme:catalog   rewrite README.md in place
 *   pnpm readme:check     exit 1 if README.md is stale (CI runs this)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { renderReadmeCatalog, spliceReadme } from '../src/lib/readme-catalog.js';

const readmePath = fileURLToPath(new URL('../README.md', import.meta.url));
const check = process.argv.includes('--check');

const current = readFileSync(readmePath, 'utf8');
const { catalog } = createServer(parseConfig({}));
const next = spliceReadme(current, renderReadmeCatalog(catalog));

if (check) {
  if (next !== current) {
    console.error(
      'README.md tool catalog is out of date with the tool registry. Run `pnpm readme:catalog` and commit the result.'
    );
    process.exit(1);
  }
  console.log(`README.md tool catalog is up to date (${catalog.length} tools).`);
} else if (next !== current) {
  writeFileSync(readmePath, next);
  console.log(`README.md tool catalog regenerated (${catalog.length} tools).`);
} else {
  console.log(`README.md tool catalog already up to date (${catalog.length} tools).`);
}
