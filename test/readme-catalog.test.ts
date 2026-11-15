import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CATALOG_END,
  CATALOG_START,
  renderReadmeCatalog,
  spliceReadme,
} from '../src/lib/readme-catalog.js';
import type { ToolCatalogEntry } from '../src/lib/landing.js';
import { createServer } from '../src/server.js';
import { parseConfig } from '../src/config.js';

const sample: ToolCatalogEntry[] = [
  {
    name: 'search_things',
    description: 'Find things.\n  Supports a | b filters.',
    category: 'Browse (no auth required)',
    readOnly: true,
    destructive: false,
    auth: 'public',
  },
  {
    name: 'drop_thing',
    description: 'Delete a thing.',
    category: 'Things',
    readOnly: false,
    destructive: true,
    auth: 'required',
  },
];

describe('renderReadmeCatalog', () => {
  it('renders the exact block for a known catalog', () => {
    expect(renderReadmeCatalog(sample)).toBe(
      [
        CATALOG_START,
        '',
        '2 tools in 2 categories. 1 work without an API key (Auth `public`); the rest need one (Auth `required`).',
        '',
        '### Browse (no auth required)',
        '',
        '| Tool | Auth | Hints | Description |',
        '|---|---|---|---|',
        '| `search_things` | public | read-only | Find things. Supports a \\| b filters. |',
        '',
        '### Things',
        '',
        '| Tool | Auth | Hints | Description |',
        '|---|---|---|---|',
        '| `drop_thing` | required | destructive | Delete a thing. |',
        '',
        CATALOG_END,
      ].join('\n')
    );
  });
});

describe('spliceReadme', () => {
  const block = renderReadmeCatalog(sample);

  it('replaces only the text between the markers', () => {
    const readme = `# Title\n\nintro\n\n${CATALOG_START}\nstale table\n${CATALOG_END}\n\n## After\n`;
    expect(spliceReadme(readme, block)).toBe(`# Title\n\nintro\n\n${block}\n\n## After\n`);
  });

  it.each([
    ['no markers', '# Title\n'],
    ['only a start marker', `${CATALOG_START}\n`],
    ['end before start', `${CATALOG_END}\n${CATALOG_START}\n`],
    ['two blocks', `${CATALOG_START}\n${CATALOG_END}\n${CATALOG_START}\n${CATALOG_END}\n`],
  ])('refuses a README with %s', (_label, readme) => {
    expect(() => spliceReadme(readme, block)).toThrow(/exactly one generated tool catalog block/);
  });
});

describe('README.md', () => {
  it('holds the catalog the live registry renders (run `pnpm readme:catalog` if this fails)', () => {
    const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
    const { catalog } = createServer(parseConfig({}));
    expect(spliceReadme(readme, renderReadmeCatalog(catalog))).toBe(readme);
  });
});
