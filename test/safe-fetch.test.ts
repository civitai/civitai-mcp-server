import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import {
  isPrivateAddress,
  isBlockedHostname,
  isOutsideAllowlist,
  safeFetchUrl,
  SsrfError,
} from '../src/lib/safe-fetch.js';

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('flags shared-address-space, benchmarking, protocol, documentation and reserved IPv4', () => {
    for (const ip of [
      '100.64.0.1',
      '100.127.255.254',
      '198.18.0.1',
      '198.19.255.255',
      '192.0.0.8',
      '192.0.2.1',
      '198.51.100.7',
      '203.0.113.9',
      '240.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows public IPv4 addresses, including neighbours of blocked ranges', () => {
    for (const ip of [
      '8.8.8.8',
      '1.1.1.1',
      '172.32.0.1',
      '93.184.216.34',
      '100.63.255.255', // just below 100.64/10
      '100.128.0.1', // just above 100.64/10
      '198.17.255.255',
      '198.20.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('flags IPv6 loopback / link-local / unique-local / multicast and mapped private v4', () => {
    for (const ip of [
      '::1',
      '::',
      'fe80::1',
      'fe80::1%eth0',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('flags IPv4-embedding IPv6 forms written in hex (mapped, compatible, NAT64, 6to4)', () => {
    for (const ip of [
      '::ffff:a00:1', // IPv4-mapped 10.0.0.1, hex form (what the URL parser emits)
      '::ffff:7f00:1', // IPv4-mapped 127.0.0.1
      '::ffff:a9fe:a9fe', // IPv4-mapped 169.254.169.254
      '0:0:0:0:0:ffff:a00:1', // expanded mapped
      '::a00:1', // IPv4-compatible 10.0.0.1
      '::7f00:1', // IPv4-compatible 127.0.0.1
      '64:ff9b::a00:1', // NAT64 10.0.0.1
      '64:ff9b::10.0.0.1', // NAT64, dotted tail
      '64:ff9b:1::1', // local-use NAT64
      '2002:a00:1::1', // 6to4 of 10.0.0.1
      '2001:0:4136:e378::1', // Teredo
      '2001:db8::1', // documentation
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows public IPv6, and IPv4-embedding forms of PUBLIC v4', () => {
    for (const ip of [
      '2606:4700:4700::1111',
      '::ffff:8.8.8.8',
      '::ffff:808:808',
      '64:ff9b::808:808',
      '2002:808:808::1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('fails closed on non-IP input', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
    expect(isPrivateAddress('')).toBe(true);
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

// ---------------------------------------------------------------------------
// Network fakes. Both the global fetch and node:http(s).request are scripted so
// no test touches the network whichever transport the implementation uses, and
// every outbound attempt is recorded.
// ---------------------------------------------------------------------------

interface Scripted {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

interface Attempt {
  url: string;
  lookup?: (...args: unknown[]) => void;
}

function scriptNetwork(script: Scripted[]): { attempts: Attempt[] } {
  const attempts: Attempt[] = [];
  let i = 0;
  const next = (): Scripted => script[Math.min(i++, script.length - 1)]!;

  const fakeRequest = ((url: URL, opts: { lookup?: Attempt['lookup'] }, cb: (res: unknown) => void) => {
    attempts.push({ url: String(url), lookup: opts?.lookup });
    const s = next();
    const req = new EventEmitter() as EventEmitter & { end: () => unknown };
    req.end = () => {
      setImmediate(() => {
        const res = Readable.from([Buffer.from(s.body ?? '')]) as Readable & Record<string, unknown>;
        res.statusCode = s.status;
        res.statusMessage = '';
        res.headers = Object.fromEntries(
          Object.entries(s.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
        );
        cb(res);
      });
      return req;
    };
    return req;
  }) as unknown as typeof http.request;
  vi.spyOn(http, 'request').mockImplementation(fakeRequest);
  vi.spyOn(https, 'request').mockImplementation(fakeRequest as unknown as typeof https.request);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (u: unknown) => {
      attempts.push({ url: String(u) });
      const s = next();
      return new Response(s.body ?? '', { status: s.status, headers: s.headers });
    })
  );
  return { attempts };
}

type LookupResult = Array<{ address: string; family: number }>;

/** Script dns.promises.lookup: answer i-th call with answers[i] (last repeats). */
function scriptDns(answers: Record<string, LookupResult[]>): { calls: string[] } {
  const calls: string[] = [];
  const seen: Record<string, number> = {};
  vi.spyOn(dns.promises, 'lookup').mockImplementation((async (host: string) => {
    calls.push(host);
    const list = answers[host];
    if (!list) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    const n = seen[host] ?? 0;
    seen[host] = n + 1;
    return list[Math.min(n, list.length - 1)]!;
  }) as unknown as typeof dns.promises.lookup);
  return { calls };
}

/** Invoke a captured connect-time lookup in both callback shapes. */
async function askLookup(lookup: Attempt['lookup'], host: string) {
  const single = await new Promise<{ address: string; family: number }>((resolve, reject) =>
    lookup!(host, {}, (err: unknown, address: string, family: number) =>
      err ? reject(err) : resolve({ address, family })
    )
  );
  const all = await new Promise<LookupResult>((resolve, reject) =>
    lookup!(host, { all: true }, (err: unknown, list: LookupResult) =>
      err ? reject(err) : resolve(list)
    )
  );
  return { single, all };
}

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

  // Every IP-literal spelling of a non-public address, as the URL parser
  // canonicalises it, must be refused without any outbound attempt.
  const literalBypasses = [
    'http://[::ffff:a00:1]/', // IPv4-mapped, hex
    'http://[::ffff:10.0.0.1]/', // IPv4-mapped, dotted (parser emits hex)
    'http://[::ffff:7f00:1]:8080/', // IPv4-mapped loopback
    'http://[::ffff:169.254.169.254]/', // IPv4-mapped link-local
    'http://[::a00:1]/', // IPv4-compatible
    'http://[64:ff9b::a00:1]/', // NAT64
    'http://[2002:a00:1::1]/', // 6to4
    'http://[fe80::1]/',
    'http://[fc00::1]/',
    'http://[ff02::1]/',
    'http://100.64.0.1/', // shared address space
    'http://198.18.0.1/', // benchmarking
    'http://192.0.0.170/',
    'http://167772161/', // decimal 10.0.0.1
    'http://012.0.0.1/', // octal 10.0.0.1
    'http://0x7f.1/', // hex 127.0.0.1
    'http://0/', // 0.0.0.0
  ];
  for (const url of literalBypasses) {
    it(`refuses ${url} without connecting`, async () => {
      const { attempts } = scriptNetwork([{ status: 200, body: 'internal' }]);
      await expect(safeFetchUrl(url)).rejects.toBeInstanceOf(SsrfError);
      expect(attempts).toEqual([]);
    });
  }

  it('refuses an IP-literal host when an allowlist is set, even one spelled in the list', async () => {
    const { attempts } = scriptNetwork([{ status: 200 }]);
    await expect(safeFetchUrl('http://8.8.8.8/', {}, ['8.8.8.8'])).rejects.toBeInstanceOf(SsrfError);
    await expect(
      safeFetchUrl('http://[2606:4700:4700::1111]/', {}, ['2606:4700:4700::1111'])
    ).rejects.toBeInstanceOf(SsrfError);
    expect(attempts).toEqual([]);
  });

  it('refuses a hostname with ANY private record', async () => {
    scriptDns({
      'mixed.example': [[{ address: '93.184.216.34', family: 4 }, { address: '::ffff:a00:1', family: 6 }]],
    });
    const { attempts } = scriptNetwork([{ status: 200 }]);
    await expect(safeFetchUrl('http://mixed.example/')).rejects.toBeInstanceOf(SsrfError);
    expect(attempts).toEqual([]);
  });

  it('DNS rebinding: resolves once and pins the connection to the checked address', async () => {
    // First answer public, every later answer private: a connect-time re-resolve
    // would land on the private address.
    const { calls } = scriptDns({
      'rebind.example': [[{ address: '93.184.216.34', family: 4 }], [{ address: '10.0.0.1', family: 4 }]],
    });
    const { attempts } = scriptNetwork([{ status: 200, body: 'ok' }]);

    const res = await safeFetchUrl('http://rebind.example/img.png');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');

    expect(attempts).toHaveLength(1);
    expect(calls).toEqual(['rebind.example']); // resolved exactly once
    const lookup = attempts[0]!.lookup;
    expect(typeof lookup).toBe('function'); // connection carries a pinned lookup
    const { single, all } = await askLookup(lookup, 'rebind.example');
    expect(single).toEqual({ address: '93.184.216.34', family: 4 });
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);
    expect(calls).toEqual(['rebind.example']); // the pinned lookup never consults DNS
  });

  it('refuses a redirect to an IPv4-mapped private literal', async () => {
    // Public IP-literal start, so no DNS is involved on either hop.
    const { attempts } = scriptNetwork([
      { status: 302, headers: { location: 'http://[::ffff:a00:1]/secret' } },
      { status: 200, body: 'internal' },
    ]);
    await expect(safeFetchUrl('http://93.184.216.34/')).rejects.toBeInstanceOf(SsrfError);
    expect(attempts).toHaveLength(1);
  });

  it('refuses a redirect to a hostname that resolves private', async () => {
    scriptDns({
      'public.example': [[{ address: '93.184.216.34', family: 4 }]],
      'inside.example': [[{ address: '100.64.1.2', family: 4 }]],
    });
    const { attempts } = scriptNetwork([
      { status: 301, headers: { location: 'http://inside.example/' } },
      { status: 200, body: 'internal' },
    ]);
    await expect(safeFetchUrl('http://public.example/')).rejects.toBeInstanceOf(SsrfError);
    expect(attempts).toHaveLength(1);
  });

  it('follows a redirect to a public host and re-pins to that host', async () => {
    scriptDns({
      'a.example': [[{ address: '93.184.216.34', family: 4 }]],
      'b.example': [[{ address: '2606:4700:4700::1111', family: 6 }]],
    });
    const { attempts } = scriptNetwork([
      { status: 302, headers: { location: 'http://b.example/final' } },
      { status: 200, body: 'final' },
    ]);
    const res = await safeFetchUrl('http://a.example/start');
    expect(await res.text()).toBe('final');
    expect(attempts.map((a) => a.url)).toEqual(['http://a.example/start', 'http://b.example/final']);
    const { single } = await askLookup(attempts[1]!.lookup, 'b.example');
    expect(single).toEqual({ address: '2606:4700:4700::1111', family: 6 });
  });

  it('logs one decision line per hop with hostname and reason only', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    scriptDns({ 'pub.example': [[{ address: '93.184.216.34', family: 4 }]] });
    scriptNetwork([
      { status: 302, headers: { location: 'http://[::ffff:a00:1]/p?sig=REDIRECTSECRET' } },
    ]);
    await expect(safeFetchUrl('http://pub.example/path?token=QUERYSECRET')).rejects.toBeInstanceOf(
      SsrfError
    );
    const events = lines.map((l) => JSON.parse(l));
    expect(events.map(({ ts: _ts, ...rest }) => rest)).toEqual([
      { event: 'outbound_fetch', decision: 'allowed', reason: 'validated', host: 'pub.example', hop: 0 },
      {
        event: 'outbound_fetch',
        decision: 'refused',
        reason: 'address:ipv4-mapped:private',
        host: '::ffff:a00:1',
        hop: 1,
      },
    ]);
    const all = lines.join('');
    expect(all).not.toContain('SECRET');
    expect(all).not.toContain('/path');
  });
});

describe('requestPinned (real socket)', () => {
  it('connects to the pinned address without resolving the URL hostname', async () => {
    const { requestPinned } = await import('../src/lib/safe-fetch.js');
    const server = http.createServer((req, res) => {
      res.setHeader('x-host-seen', req.headers.host ?? '');
      res.end('pinned-ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const lookupSpy = vi.spyOn(dns, 'lookup');
    try {
      // `.invalid` never resolves (RFC 6761): success proves the pinned lookup was used.
      const res = await requestPinned(new URL(`http://pinned.invalid:${port}/x`), [
        { address: '127.0.0.1', family: 4 },
      ]);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('pinned-ok');
      expect(res.headers.get('x-host-seen')).toBe(`pinned.invalid:${port}`);
      expect(lookupSpy).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
