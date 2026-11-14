/**
 * The README tool catalog, rendered from the same registry catalog
 * (`createServer(config).catalog`) as the landing page and llms.txt.
 *
 * `scripts/readme-catalog.ts` writes it between the markers below; with
 * `--check` it exits non-zero when README.md differs from what the registry
 * renders, which is how CI keeps the README from drifting.
 */
import type { ToolCatalogEntry } from './landing.js';

export const CATALOG_START =
  '<!-- BEGIN GENERATED TOOL CATALOG: edit the tool registrations, then run `pnpm readme:catalog` -->';
export const CATALOG_END = '<!-- END GENERATED TOOL CATALOG -->';

/** Collapse whitespace and escape the characters that would break a table cell. */
function cell(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/** Render the generated block, markers included. */
export function renderReadmeCatalog(catalog: ToolCatalogEntry[]): string {
  const groups = new Map<string, ToolCatalogEntry[]>();
  for (const tool of catalog) {
    const list = groups.get(tool.category);
    if (list) list.push(tool);
    else groups.set(tool.category, [tool]);
  }
  const publicCount = catalog.filter((t) => t.auth === 'public').length;

  const lines: string[] = [CATALOG_START, ''];
  lines.push(
    `${catalog.length} tools in ${groups.size} categories. ${publicCount} work without an API key ` +
      '(Auth `public`); the rest need one (Auth `required`).'
  );
  for (const [category, tools] of groups) {
    lines.push('', `### ${category}`, '', '| Tool | Auth | Hints | Description |', '|---|---|---|---|');
    for (const tool of tools) {
      const hints: string[] = [];
      if (tool.readOnly) hints.push('read-only');
      if (tool.destructive) hints.push('destructive');
      lines.push(`| \`${tool.name}\` | ${tool.auth} | ${hints.join(', ')} | ${cell(tool.description)} |`);
    }
  }
  lines.push('', CATALOG_END);
  return lines.join('\n');
}

/**
 * Replace the generated block in `readme` with `block`. Throws unless the
 * README holds exactly one start marker followed by one end marker, so a
 * mangled README fails loudly instead of being silently rewritten.
 */
export function spliceReadme(readme: string, block: string): string {
  const start = readme.indexOf(CATALOG_START);
  const end = readme.indexOf(CATALOG_END);
  if (
    start === -1 ||
    end === -1 ||
    end < start ||
    readme.indexOf(CATALOG_START, start + 1) !== -1 ||
    readme.indexOf(CATALOG_END, end + 1) !== -1
  ) {
    throw new Error('README.md must contain exactly one generated tool catalog block (start marker, then end marker)');
  }
  return readme.slice(0, start) + block + readme.slice(end + CATALOG_END.length);
}
