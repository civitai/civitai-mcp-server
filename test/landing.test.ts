import { describe, it, expect } from 'vitest';
import {
  isBrowserUserAgent,
  resolveBaseUrl,
  renderLlmsTxt,
  renderLandingHtml,
  type LandingData,
} from '../src/lib/landing.js';
import { createServer } from '../src/server.js';
import { parseConfig } from '../src/config.js';

const sampleData: LandingData = {
  serverName: 'civitai-mcp-server',
  serverVersion: '0.1.0',
  catalog: [
    {
      name: 'search_models',
      title: 'Search models',
      description: 'Search Civitai models.\n  Returns AIR URNs.',
      category: 'Browse (no auth required)',
      readOnly: true,
      destructive: false,
    },
    {
      name: 'delete_announcement',
      title: 'Delete announcement',
      description: 'Delete an announcement by ID.',
      category: 'Announcements (moderator)',
      readOnly: false,
      destructive: true,
    },
  ],
};

describe('isBrowserUserAgent', () => {
  it('treats Mozilla/ UAs as browsers', () => {
    expect(
      isBrowserUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
      )
    ).toBe(true);
    expect(isBrowserUserAgent('Mozilla/5.0 (Macintosh) Firefox/121.0')).toBe(true);
  });

  it('treats agents / CLI clients / missing UA as non-browser', () => {
    expect(isBrowserUserAgent(undefined)).toBe(false);
    expect(isBrowserUserAgent('')).toBe(false);
    expect(isBrowserUserAgent('curl/8.4.0')).toBe(false);
    expect(isBrowserUserAgent('python-requests/2.31.0')).toBe(false);
    expect(isBrowserUserAgent('node')).toBe(false);
    expect(isBrowserUserAgent('claude-code/1.0')).toBe(false);
  });
});

describe('resolveBaseUrl', () => {
  it('prefers X-Forwarded-Proto / -Host (k8s ingress)', () => {
    expect(
      resolveBaseUrl({
        forwardedProto: 'https',
        forwardedHost: 'mcp.civitai.com',
        host: 'civitai-mcp:3100',
      })
    ).toBe('https://mcp.civitai.com');
  });

  it('takes the first value of comma-joined forwarded headers', () => {
    expect(
      resolveBaseUrl({ forwardedProto: 'https, http', forwardedHost: 'mcp.civitai.com, internal' })
    ).toBe('https://mcp.civitai.com');
  });

  it('falls back to Host and http when nothing is forwarded', () => {
    expect(resolveBaseUrl({ host: 'localhost:3100' })).toBe('http://localhost:3100');
  });

  it('falls back to localhost when no host at all', () => {
    expect(resolveBaseUrl({})).toBe('http://localhost');
  });
});

describe('renderLlmsTxt', () => {
  const txt = renderLlmsTxt(sampleData, 'https://mcp.civitai.com');

  it('embeds the derived MCP endpoint URL', () => {
    expect(txt).toContain('MCP endpoint: https://mcp.civitai.com/mcp');
    expect(txt).toContain('claude mcp add --transport http civitai https://mcp.civitai.com/mcp');
    expect(txt).toContain('"url": "https://mcp.civitai.com/mcp"');
  });

  it('documents transport and auth', () => {
    expect(txt).toContain('Streamable HTTP');
    expect(txt).toContain('Authorization: Bearer');
    expect(txt).toContain('civitai.com/user/account');
  });

  it('lists every tool grouped by category with flags, one line each', () => {
    expect(txt).toContain('### Browse (no auth required)');
    expect(txt).toContain('- search_models [read-only]: Search Civitai models. Returns AIR URNs.');
    expect(txt).toContain('### Announcements (moderator)');
    expect(txt).toContain('- delete_announcement [destructive]: Delete an announcement by ID.');
    // multi-line descriptions are collapsed
    expect(txt).not.toMatch(/search_models.*\n {2}Returns/);
  });
});

describe('renderLandingHtml', () => {
  const html = renderLandingHtml(sampleData, 'https://mcp.civitai.com');

  it('is a self-contained HTML doc with no external assets', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/https?:\/\/(?!mcp\.civitai\.com|civitai\.com|modelcontextprotocol\.io)/);
  });

  it('includes connect snippets and endpoints', () => {
    expect(html).toContain('https://mcp.civitai.com/mcp');
    expect(html).toContain('https://mcp.civitai.com/llms.txt');
    expect(html).toContain('claude mcp add --transport http civitai');
    expect(html).toContain('Bearer YOUR_CIVITAI_API_KEY');
  });

  it('renders the tool catalog from the provided data', () => {
    expect(html).toContain('<code>search_models</code>');
    expect(html).toContain('<code>delete_announcement</code>');
    expect(html).toContain('read-only');
    expect(html).toContain('destructive');
  });

  it('escapes HTML in tool content', () => {
    const evil = renderLandingHtml(
      {
        ...sampleData,
        catalog: [{ ...sampleData.catalog[0]!, name: '<x>', description: 'a & b <tag>' }],
      },
      'https://mcp.civitai.com'
    );
    expect(evil).toContain('&lt;x&gt;');
    expect(evil).toContain('a &amp; b &lt;tag&gt;');
  });
});

describe('catalog is sourced from the real tool registry', () => {
  it('createServer exposes one catalog entry per registered tool', () => {
    const { toolCount, catalog } = createServer(parseConfig({}));
    expect(catalog.length).toBe(toolCount);
    const names = catalog.map((t) => t.name);
    expect(names).toContain('search_models');
    expect(names).toContain('whoami');
    expect(names).toContain('upsert_article');
    // categories are populated for grouping
    expect(catalog.every((t) => t.category && t.category.length > 0)).toBe(true);
    // browse tools are flagged read-only
    expect(catalog.find((t) => t.name === 'search_models')?.readOnly).toBe(true);
  });
});
