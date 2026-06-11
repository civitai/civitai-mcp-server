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
