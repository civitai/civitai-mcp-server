import { describe, it, expect } from 'vitest';
import {
  isPrivateAddress,
  isBlockedHostname,
  isOutsideAllowlist,
  safeFetchUrl,
  SsrfError,
} from '../src/lib/safe-fetch.js';

describe('isPrivateAddress', () => {
  it('flags IPv4 private / loopback / link-local / metadata ranges', () => {
    for (const ip of [
      '0.0.0.0',
      '10.0.0.1',
      '127.0.0.1',
      '169.254.169.254', // cloud metadata
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '224.0.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows public IPv4 addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('flags IPv6 loopback / link-local / unique-local and mapped private v4', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows public IPv6 and mapped public v4', () => {
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });
});

describe('isBlockedHostname', () => {
  it('blocks internal/cluster/metadata hostnames', () => {
    for (const h of [
      'localhost',
      'metadata.google.internal',
      'civitai-app.default.svc',
      'svc.cluster.local',
      'foo.internal',
      'app.localhost',
    ]) {
      expect(isBlockedHostname(h), h).toBe(true);
    }
  });

  it('allows public hostnames', () => {
    for (const h of ['civitai.com', 'example.com', 'cdn.example.org']) {
      expect(isBlockedHostname(h), h).toBe(false);
    }
  });
});

describe('isOutsideAllowlist', () => {
  it('passes everything when no allowlist set', () => {
    expect(isOutsideAllowlist('anything.com')).toBe(false);
    expect(isOutsideAllowlist('anything.com', [])).toBe(false);
  });

  it('allows exact and subdomain matches', () => {
    expect(isOutsideAllowlist('cdn.civitai.com', ['civitai.com'])).toBe(false);
    expect(isOutsideAllowlist('civitai.com', ['civitai.com'])).toBe(false);
  });

  it('rejects hosts off the allowlist', () => {
    expect(isOutsideAllowlist('evil.com', ['civitai.com'])).toBe(true);
  });
});

describe('safeFetchUrl', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(safeFetchUrl('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfError);
    await expect(safeFetchUrl('ftp://example.com')).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects internal hostnames before any network call', async () => {
    await expect(safeFetchUrl('http://metadata.google.internal/')).rejects.toBeInstanceOf(SsrfError);
    await expect(safeFetchUrl('http://localhost:8080/')).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects literal private IPs', async () => {
    await expect(safeFetchUrl('http://169.254.169.254/latest/meta-data')).rejects.toBeInstanceOf(
      SsrfError
    );
    await expect(safeFetchUrl('http://127.0.0.1/')).rejects.toBeInstanceOf(SsrfError);
    await expect(safeFetchUrl('http://[::1]/')).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects hosts outside an allowlist', async () => {
    await expect(
      safeFetchUrl('http://8.8.8.8/', {}, ['civitai.com'])
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects malformed URLs', async () => {
    await expect(safeFetchUrl('not a url')).rejects.toBeInstanceOf(SsrfError);
  });
});
