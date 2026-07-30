import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config.js';
import { bearerFromHeader, AuthContext } from '../src/client/auth.js';

describe('parseConfig', () => {
  it('applies defaults when env is empty', () => {
    const c = parseConfig({});
    expect(c.apiUrl).toBe('https://civitai.com');
    expect(c.transport).toBe('http');
    expect(c.port).toBe(3100);
    expect(c.apiKey).toBeUndefined();
    expect(c.userId).toBeUndefined();
  });

  it('strips trailing slashes from apiUrl', () => {
    expect(parseConfig({ CIVITAI_API_URL: 'http://civitai-app:3000/' }).apiUrl).toBe('http://civitai-app:3000');
  });

  it('defaults webUrl to civitai.com independent of apiUrl', () => {
    // The bug: when apiUrl is an internal cluster service, webUrl must stay public.
    const c = parseConfig({ CIVITAI_API_URL: 'http://civitai-app:3000' });
    expect(c.apiUrl).toBe('http://civitai-app:3000');
    expect(c.webUrl).toBe('https://civitai.com');
  });

  it('parses CIVITAI_WEB_URL and strips a trailing slash', () => {
    expect(parseConfig({ CIVITAI_WEB_URL: 'https://civitai.red/' }).webUrl).toBe('https://civitai.red');
  });

  it('rejects a non-url CIVITAI_WEB_URL', () => {
    expect(() => parseConfig({ CIVITAI_WEB_URL: 'not a url' })).toThrow();
  });

  it('coerces numeric env vars', () => {
    const c = parseConfig({ PORT: '8080', CIVITAI_USER_ID: '123' });
    expect(c.port).toBe(8080);
    expect(c.userId).toBe(123);
  });

  it('accepts stdio transport', () => {
    expect(parseConfig({ MCP_TRANSPORT: 'stdio' }).transport).toBe('stdio');
  });

  it('rejects an invalid transport', () => {
    expect(() => parseConfig({ MCP_TRANSPORT: 'grpc' })).toThrow();
  });

  it('rejects a non-url apiUrl', () => {
    expect(() => parseConfig({ CIVITAI_API_URL: 'not a url' })).toThrow();
  });

  it('leaves publicBaseUrl unset by default', () => {
    expect(parseConfig({}).publicBaseUrl).toBeUndefined();
  });

  it('parses PUBLIC_BASE_URL and strips a trailing slash', () => {
    expect(parseConfig({ PUBLIC_BASE_URL: 'https://mcp.civitai.com/' }).publicBaseUrl).toBe(
      'https://mcp.civitai.com'
    );
  });

  it('rejects a non-url PUBLIC_BASE_URL', () => {
    expect(() => parseConfig({ PUBLIC_BASE_URL: 'not a url' })).toThrow();
  });
});

describe('bearerFromHeader', () => {
  it('extracts a bearer token (case-insensitive scheme)', () => {
    expect(bearerFromHeader('Bearer abc123')).toBe('abc123');
    expect(bearerFromHeader('bearer xyz')).toBe('xyz');
  });

  it('handles array header values', () => {
    expect(bearerFromHeader(['Bearer arr'])).toBe('arr');
  });

  it('returns undefined for missing or malformed headers', () => {
    expect(bearerFromHeader(undefined)).toBeUndefined();
    expect(bearerFromHeader('Basic abc')).toBeUndefined();
    expect(bearerFromHeader('')).toBeUndefined();
  });
});

describe('AuthContext key resolution', () => {
  it('prefers the per-request key over the env key', () => {
    const config = parseConfig({ CIVITAI_API_KEY: 'envkey' });
    expect(new AuthContext(config, 'reqkey').apiKey).toBe('reqkey');
    expect(new AuthContext(config, undefined).apiKey).toBe('envkey');
  });

  it('requireKey throws when no key is available', () => {
    const config = parseConfig({});
    expect(() => new AuthContext(config, undefined).requireKey()).toThrow(/No API key/);
  });

  it('returns config userId as cached self id when set', () => {
    const config = parseConfig({ CIVITAI_USER_ID: '55' });
    expect(new AuthContext(config, undefined).getCachedSelfId()).toBe(55);
  });
});

describe('CIVITAI_API_KEY placeholder rejection', () => {
  // An MCP client with "CIVITAI_API_KEY": "${CIVITAI_API_KEY}" in its config passes
  // the literal through when the launching process has no such variable. It used to
  // be accepted and sent as a bearer token, producing a 401 whose message points at
  // the public API — i.e. it reads as Civitai blocking third-party tRPC access.
  it.each(['${CIVITAI_API_KEY}', '${FOO}', '$(CIVITAI_API_KEY)'])(
    'rejects the unexpanded literal %s',
    (literal) => {
      expect(() => parseConfig({ CIVITAI_API_KEY: literal })).toThrow();
    }
  );

  it('accepts a real 32-hex key', () => {
    const key = 'a'.repeat(32);
    expect(parseConfig({ CIVITAI_API_KEY: key }).apiKey).toBe(key);
  });

  it('still accepts a key of an unexpected shape (warn at startup, never reject)', () => {
    // Deliberate: refusing to start on a guess about key format would lock out a
    // perfectly valid key. getConfig() logs a pointer instead.
    const odd = 'not-32-hex-but-possibly-valid';
    expect(parseConfig({ CIVITAI_API_KEY: odd }).apiKey).toBe(odd);
  });
});
