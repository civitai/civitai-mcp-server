/**
 * Dual-audience index page generation.
 *
 * A single source-of-truth tool catalog (derived from the real tool
 * registrations at server build time — see `createServer`) feeds BOTH the
 * human-facing HTML landing page and the agent-facing llms.txt. This avoids
 * drift: the tool list is never hand-duplicated.
 */

/** Auth requirement for a tool. `public` tools work anonymously; `required`
 *  tools need an Authorization: Bearer header (and trigger the OAuth challenge). */
export type ToolAuth = 'public' | 'required';

/** One registered tool, captured at registration time. */
export interface ToolCatalogEntry {
  name: string;
  title?: string;
  description: string;
  category: string;
  readOnly: boolean;
  destructive: boolean;
  /** Whether the tool can run anonymously or needs a bearer token. */
  auth: ToolAuth;
}

/** Server identity + tool catalog, the input to both renderers. */
export interface LandingData {
  serverName: string;
  serverVersion: string;
  /** Tools grouped by category, in registration order. */
  catalog: ToolCatalogEntry[];
}

/** True when the User-Agent looks like a web browser (heuristic: contains "Mozilla/"). */
export function isBrowserUserAgent(userAgent: string | undefined): boolean {
  if (!userAgent) return false;
  return userAgent.includes('Mozilla/');
}

/**
 * Resolve the externally-visible base URL of this server.
 *
 * If `override` is provided (the `PUBLIC_BASE_URL` env knob), it wins outright —
 * the canonical hosted deployment advertises its fixed address regardless of
 * what a proxy forwards. Otherwise the URL is derived from request headers,
 * honoring the proxy/ingress headers k8s sets (X-Forwarded-Proto / -Host), and
 * falling back to the Host header and http when nothing is forwarded.
 */
export function resolveBaseUrl(
  headers: {
    forwardedProto?: string;
    forwardedHost?: string;
    host?: string;
  },
  override?: string
): string {
  const canonical = override?.replace(/\/+$/, '');
  if (canonical) return canonical;
  const proto = first(headers.forwardedProto) ?? 'http';
  const host = first(headers.forwardedHost) ?? headers.host ?? 'localhost';
  return `${proto}://${host}`;
}

/** Canonical hosted endpoint, used as a documented fallback in static copy. */
export const CANONICAL_BASE_URL = 'https://mcp.civitai.com';

/** Take the first value of a possibly comma-joined forwarded header. */
function first(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const part = value.split(',')[0]?.trim();
  return part || undefined;
}

/** Group catalog entries by category, preserving first-seen order. */
function groupByCategory(catalog: ToolCatalogEntry[]): Array<{ category: string; tools: ToolCatalogEntry[] }> {
  const groups: Array<{ category: string; tools: ToolCatalogEntry[] }> = [];
  const index = new Map<string, number>();
  for (const tool of catalog) {
    let i = index.get(tool.category);
    if (i === undefined) {
      i = groups.length;
      index.set(tool.category, i);
      groups.push({ category: tool.category, tools: [] });
    }
    groups[i]!.tools.push(tool);
  }
  return groups;
}

/** Collapse a multi-line description to a single trimmed line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// llms.txt (text/plain) — optimized for an agent to self-configure.
// ---------------------------------------------------------------------------

export function renderLlmsTxt(data: LandingData, baseUrl: string): string {
  const mcpUrl = `${baseUrl}/mcp`;
  const groups = groupByCategory(data.catalog);
  const lines: string[] = [];

  lines.push(`# ${data.serverName}`);
  lines.push('');
  lines.push(
    '> MCP (Model Context Protocol) server that turns an AI agent into a full Civitai ' +
      'participant. Browse models, images, and creators; post and publish images; react, ' +
      'review, follow, and collect; write articles and comments; send and reply to direct ' +
      'messages; create and enter bounties; and (for moderators) manage site announcements ' +
      'and the changelog.'
  );
  lines.push('');
  lines.push('## Connect');
  lines.push('');
  lines.push(`- MCP endpoint: ${mcpUrl}`);
  if (mcpUrl !== `${CANONICAL_BASE_URL}/mcp`) {
    lines.push(`- Hosted (recommended): ${CANONICAL_BASE_URL}/mcp`);
  }
  lines.push('- Transport: Streamable HTTP (JSON-RPC over HTTP POST)');
  lines.push(
    '- Auth: send `Authorization: Bearer <CIVITAI_API_KEY>` with each request. ' +
      'Browse/read tools work unauthenticated; user-action tools (articles, comments, DMs, ' +
      'uploads, announcements, changelog) require the key.'
  );
  lines.push('- Get an API key at https://civitai.com/user/account');
  lines.push('');
  lines.push('### Claude Code (CLI)');
  lines.push('');
  lines.push('```bash');
  lines.push(`claude mcp add --transport http civitai ${mcpUrl} \\`);
  lines.push('  --header "Authorization: Bearer YOUR_CIVITAI_API_KEY"');
  lines.push('```');
  lines.push('');
  lines.push('### .mcp.json');
  lines.push('');
  lines.push('```json');
  lines.push('{');
  lines.push('  "mcpServers": {');
  lines.push('    "civitai": {');
  lines.push('      "type": "http",');
  lines.push(`      "url": "${mcpUrl}",`);
  lines.push('      "headers": { "Authorization": "Bearer YOUR_CIVITAI_API_KEY" }');
  lines.push('    }');
  lines.push('  }');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('## Tools');
  lines.push('');
  for (const group of groups) {
    lines.push(`### ${group.category}`);
    for (const tool of group.tools) {
      const flags: string[] = [];
      if (tool.readOnly) flags.push('read-only');
      if (tool.destructive) flags.push('destructive');
      const suffix = flags.length ? ` [${flags.join(', ')}]` : '';
      lines.push(`- ${tool.name}${suffix}: ${oneLine(tool.description)}`);
    }
    lines.push('');
  }
  lines.push(
    'Each tool exposes a zod input schema (inspect via the MCP tools/list call) and returns ' +
      'both a human-readable text block and structured JSON.'
  );
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Landing page (text/html) — friendly explainer for a human in a browser.
// ---------------------------------------------------------------------------

export function renderLandingHtml(data: LandingData, baseUrl: string): string {
  const mcpUrl = `${baseUrl}/mcp`;
  const llmsUrl = `${baseUrl}/llms.txt`;
  const groups = groupByCategory(data.catalog);

  const catalogHtml = groups
    .map((group) => {
      const rows = group.tools
        .map((tool) => {
          const flags: string[] = [];
          if (tool.readOnly) flags.push('<span class="flag read">read-only</span>');
          if (tool.destructive) flags.push('<span class="flag danger">destructive</span>');
          return `        <tr>
          <td><code>${escapeHtml(tool.name)}</code> ${flags.join(' ')}</td>
          <td>${escapeHtml(oneLine(tool.description))}</td>
        </tr>`;
        })
        .join('\n');
      return `      <h3>${escapeHtml(group.category)}</h3>
      <table>
        <tbody>
${rows}
        </tbody>
      </table>`;
    })
    .join('\n');

  const mcpAdd = escapeHtml(
    `claude mcp add --transport http civitai ${mcpUrl} \\\n  --header "Authorization: Bearer YOUR_CIVITAI_API_KEY"`
  );

  const mcpJson = escapeHtml(
    JSON.stringify(
      {
        mcpServers: {
          civitai: {
            type: 'http',
            url: mcpUrl,
            headers: { Authorization: 'Bearer YOUR_CIVITAI_API_KEY' },
          },
        },
      },
      null,
      2
    )
  );

  const cursorJson = escapeHtml(
    JSON.stringify(
      {
        mcpServers: {
          civitai: {
            url: mcpUrl,
            headers: { Authorization: 'Bearer YOUR_CIVITAI_API_KEY' },
          },
        },
      },
      null,
      2
    )
  );

  const canonicalNote =
    mcpUrl === `${CANONICAL_BASE_URL}/mcp`
      ? ''
      : `<p class="muted" style="margin-top:6px;">Hosted (recommended): <code>${escapeHtml(
          `${CANONICAL_BASE_URL}/mcp`
        )}</code></p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Civitai MCP Server</title>
<style>
  :root {
    --bg: #0b0e14;
    --panel: #141925;
    --panel-2: #1b2230;
    --border: #2a3344;
    --text: #e6eaf2;
    --muted: #97a3b6;
    --accent: #1971c2;
    --accent-2: #22b8cf;
    --code-bg: #0e1320;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent-2); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 48px 24px 80px; }
  header {
    background: linear-gradient(120deg, var(--accent), var(--accent-2));
    border-radius: 16px;
    padding: 40px 32px;
    margin-bottom: 40px;
  }
  header h1 { margin: 0 0 8px; font-size: 30px; letter-spacing: -0.02em; color: #fff; }
  header p { margin: 0; color: rgba(255,255,255,0.92); font-size: 17px; max-width: 620px; }
  .badge {
    display: inline-block; font-size: 12px; font-weight: 600; letter-spacing: 0.04em;
    text-transform: uppercase; color: #fff; background: rgba(255,255,255,0.18);
    border-radius: 999px; padding: 4px 12px; margin-bottom: 14px;
  }
  section { margin: 0 0 40px; }
  h2 { font-size: 20px; margin: 0 0 14px; letter-spacing: -0.01em; }
  h3 { font-size: 15px; margin: 24px 0 8px; color: var(--accent-2); text-transform: uppercase; letter-spacing: 0.04em; }
  p { color: var(--text); }
  .muted { color: var(--muted); }
  .panel {
    background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 20px 22px;
  }
  pre {
    background: var(--code-bg); border: 1px solid var(--border); border-radius: 10px;
    padding: 14px 16px; overflow-x: auto; margin: 10px 0 0;
  }
  code { font-family: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; font-size: 13px; }
  pre code { color: #cdd6e6; }
  p code, td code { background: var(--panel-2); border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px; color: #cdd6e6; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0 4px; }
  td { border-top: 1px solid var(--border); padding: 9px 8px; vertical-align: top; font-size: 14px; }
  td:first-child { width: 230px; white-space: nowrap; }
  td:last-child { color: var(--muted); }
  .flag { display: inline-block; font-size: 10px; font-weight: 600; border-radius: 4px; padding: 1px 5px; vertical-align: middle; }
  .flag.read { background: rgba(34,184,207,0.15); color: var(--accent-2); }
  .flag.danger { background: rgba(224,49,49,0.16); color: #ff8787; }
  .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 640px) {
    .cards { grid-template-columns: 1fr; }
    td:first-child { width: auto; white-space: normal; }
  }
  .card h3 { margin-top: 0; }
  .share {
    background: var(--panel-2); border: 1px dashed var(--accent); border-radius: 12px;
    padding: 18px 20px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px;
  }
  .share strong { color: var(--text); }
  footer { color: var(--muted); font-size: 13px; border-top: 1px solid var(--border); padding-top: 20px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="badge">Model Context Protocol</span>
    <h1>Civitai MCP Server</h1>
    <p>Turn your AI agent into a full Civitai participant: browse models and images, post and
    publish work, react, review, follow, collect, comment, send DMs, and enter bounties. Point
    your agent at this URL and it configures itself.</p>
  </header>

  <section>
    <div class="share">
      <strong>Share this with your agent:</strong>
      <a href="${escapeHtml(llmsUrl)}"><code>${escapeHtml(llmsUrl)}</code></a>
      <span class="muted">— an agent that fetches this URL gets everything it needs to connect.</span>
    </div>
  </section>

  <section>
    <h2>Connect your agent</h2>
    <p class="muted">MCP endpoint: <code>${escapeHtml(mcpUrl)}</code> &nbsp;·&nbsp; Transport: Streamable HTTP</p>
    ${canonicalNote}
    <div class="cards">
      <div class="panel card">
        <h3>Claude Code</h3>
        <pre><code>${mcpAdd}</code></pre>
        <p class="muted" style="margin:14px 0 4px;">…or add to <code>.mcp.json</code>:</p>
        <pre><code>${mcpJson}</code></pre>
      </div>
      <div class="panel card">
        <h3>claude.ai / Claude Desktop</h3>
        <p class="muted">Custom connectors here are <strong>OAuth-only</strong> — the UI has no
        field for a static API key. Until Civitai OAuth is live, use Claude <em>Code</em> (left)
        or Cursor (below). The hosted endpoint is:</p>
        <pre><code>${escapeHtml(mcpUrl)}</code></pre>
        <h3 style="margin-top:18px;">Cursor / generic HTTP</h3>
        <pre><code>${cursorJson}</code></pre>
      </div>
    </div>
  </section>

  <section>
    <h2>Authentication</h2>
    <div class="panel">
      <p style="margin-top:0;">Send your API key as a bearer token with every request:</p>
      <pre><code>Authorization: Bearer YOUR_CIVITAI_API_KEY</code></pre>
      <p class="muted" style="margin-bottom:0;">Grab a key from
      <a href="https://civitai.com/user/account">civitai.com/user/account</a>.
      Browse / read tools work without a key; user-action tools (articles, comments, DMs,
      uploads, announcements, changelog) require one.</p>
    </div>
  </section>

  <section>
    <h2>Tools</h2>
${catalogHtml}
  </section>

  <footer>
    ${escapeHtml(data.serverName)} v${escapeHtml(data.serverVersion)} ·
    <a href="${escapeHtml(llmsUrl)}">llms.txt</a> ·
    <a href="https://modelcontextprotocol.io">Model Context Protocol</a>
  </footer>
</div>
</body>
</html>
`;
}
