import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { logEvent } from './log.js';
import { SERVER_NAME, SERVER_VERSION } from '../version.js';

/**
 * SSRF-hardened fetch for *user-supplied* URLs.
 *
 * The server may run next to other private services, so a naive fetch of an
 * arbitrary user URL could reach internal endpoints, the node, or a cloud
 * metadata endpoint. This helper:
 *   - allows only http:/https:
 *   - when an allowlist is configured, refuses IP-literal hosts outright and
 *     admits only allowlisted hostnames (exact or subdomain)
 *   - rejects internal hostnames (.svc, .cluster.local, .internal, localhost,
 *     metadata.google.internal)
 *   - parses every candidate address to bytes (IPv4 and IPv6), unwraps IPv6
 *     forms that embed an IPv4 address (IPv4-mapped, NAT64, 6to4), and rejects
 *     any non-public range (see classifyAddress)
 *   - resolves DNS ONCE, validates every returned address, and pins the TCP
 *     connection to those validated addresses (a custom `lookup` on the
 *     request), so a second, different DNS answer can never be connected to
 *   - follows redirects manually (max 3), re-validating and re-pinning every hop
 *   - enforces one 10s total deadline covering every hop and the body read
 *   - sends a descriptive User-Agent, refuses URLs carrying credentials,
 *     protocol upgrades and compressed responses
 *   - logs one structured line per hop decision (hostname + reason only)
 *
 * NOTE: the env-configured CIVITAI_API_URL is *trusted operator config* and must
 * NOT go through this helper. Only user-supplied URLs do.
 */

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10_000;

/** Hostnames that are always blocked (case-insensitive, suffix or exact). */
const BLOCKED_HOST_EXACT = new Set(['localhost', 'metadata.google.internal']);
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.svc', '.cluster.local', '.internal'];

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOST_EXACT.has(host)) return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** True if an allowlist is set and the host is NOT on it (exact or subdomain). */
export function isOutsideAllowlist(hostname: string, allowedHosts?: string[]): boolean {
  if (!allowedHosts || allowedHosts.length === 0) return false;
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return !allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
}

// ---------------------------------------------------------------------------
// Address classification (byte-level)
// ---------------------------------------------------------------------------

/** Parse a dotted-quad IPv4 string into its four octets, or null if malformed. */
function ipv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  if (parts.some((p) => !/^\d{1,3}$/.test(p))) return null;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => n > 255)) return null;
  return octets as [number, number, number, number];
}

/**
 * Parse an IPv6 string (any textual form: compressed, expanded, hex or dotted
 * IPv4 tail, optional zone id) into its 16 bytes, or null if malformed.
 */
function ipv6Bytes(ip: string): Uint8Array | null {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);
  if (isIP(addr) !== 6) return null;

  // A dotted IPv4 tail (e.g. ::ffff:10.0.0.1) becomes two hex groups.
  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    const o = ipv4Octets(tail);
    if (!o) return null;
    addr =
      addr.slice(0, lastColon + 1) +
      `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<string>(fill).fill('0'), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i]!;
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes[2 * i] = v >> 8;
    bytes[2 * i + 1] = v & 0xff;
  }
  return bytes;
}

/** True if the first `bits` bits of `bytes` equal those of `prefix`. */
function prefixMatch(bytes: Uint8Array, prefix: Uint8Array, bits: number): boolean {
  const full = bits >> 3;
  for (let i = 0; i < full; i++) if (bytes[i] !== prefix[i]) return false;
  const rem = bits & 7;
  if (rem === 0) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return ((bytes[full]! ^ prefix[full]!) & mask) === 0;
}

interface Range {
  prefix: Uint8Array;
  bits: number;
  reason: string;
}

function v4Range(cidr: string, reason: string): Range {
  const [ip, bits] = cidr.split('/') as [string, string];
  return { prefix: Uint8Array.from(ipv4Octets(ip)!), bits: Number(bits), reason };
}

function v6Range(cidr: string, reason: string): Range {
  const [ip, bits] = cidr.split('/') as [string, string];
  return { prefix: ipv6Bytes(ip)!, bits: Number(bits), reason };
}

/** IPv4 ranges that are never a legitimate public fetch target. */
const BLOCKED_V4: Range[] = [
  v4Range('0.0.0.0/8', 'this-network'),
  v4Range('10.0.0.0/8', 'private'),
  v4Range('100.64.0.0/10', 'shared-address-space'),
  v4Range('127.0.0.0/8', 'loopback'),
  v4Range('169.254.0.0/16', 'link-local'),
  v4Range('172.16.0.0/12', 'private'),
  v4Range('192.0.0.0/24', 'ietf-protocol-assignments'),
  v4Range('192.0.2.0/24', 'documentation'),
  v4Range('192.88.99.0/24', '6to4-relay-anycast'),
  v4Range('192.168.0.0/16', 'private'),
  v4Range('198.18.0.0/15', 'benchmarking'),
  v4Range('198.51.100.0/24', 'documentation'),
  v4Range('203.0.113.0/24', 'documentation'),
  v4Range('224.0.0.0/4', 'multicast'),
  v4Range('240.0.0.0/4', 'reserved'), // includes 255.255.255.255 broadcast
];

/** IPv6 ranges blocked outright (checked after embedded-IPv4 unwrapping). */
const BLOCKED_V6: Range[] = [
  v6Range('::ffff:0:0:0/96', 'ipv4-translated'),
  v6Range('64:ff9b:1::/48', 'nat64-local-use'),
  v6Range('100::/64', 'discard-only'),
  v6Range('2001::/32', 'teredo'),
  v6Range('2001:2::/48', 'benchmarking'),
  v6Range('2001:10::/28', 'orchid'),
  v6Range('2001:20::/28', 'orchid'),
  v6Range('2001:db8::/32', 'documentation'),
  v6Range('3fff::/20', 'documentation'),
  v6Range('fc00::/7', 'unique-local'),
  v6Range('fe80::/10', 'link-local'),
  v6Range('fec0::/10', 'site-local'),
  v6Range('ff00::/8', 'multicast'),
];

const MAPPED_V4 = v6Range('::ffff:0:0/96', 'ipv4-mapped');
const COMPAT_V4 = v6Range('::/96', 'ipv4-compatible');
const NAT64_WKP = v6Range('64:ff9b::/96', 'nat64');
const SIX_TO_FOUR = v6Range('2002::/16', '6to4');

function classifyV4Bytes(o: Uint8Array): string | null {
  for (const r of BLOCKED_V4) if (prefixMatch(o, r.prefix, r.bits)) return r.reason;
  return null;
}

function classifyV6Bytes(b: Uint8Array): string | null {
  // Forms that embed an IPv4 address: judge the embedded address.
  if (prefixMatch(b, MAPPED_V4.prefix, MAPPED_V4.bits)) {
    const inner = classifyV4Bytes(b.subarray(12, 16));
    return inner ? `ipv4-mapped:${inner}` : null;
  }
  if (prefixMatch(b, COMPAT_V4.prefix, COMPAT_V4.bits)) {
    const last = b.subarray(12, 16);
    if (last.every((x) => x === 0)) return 'unspecified';
    if (last[0] === 0 && last[1] === 0 && last[2] === 0 && last[3] === 1) return 'loopback';
    // Deprecated IPv4-compatible form (RFC 4291): never a legitimate target.
    return 'ipv4-compatible';
  }
  if (prefixMatch(b, NAT64_WKP.prefix, NAT64_WKP.bits)) {
    const inner = classifyV4Bytes(b.subarray(12, 16));
    return inner ? `nat64:${inner}` : null;
  }
  if (prefixMatch(b, SIX_TO_FOUR.prefix, SIX_TO_FOUR.bits)) {
    const inner = classifyV4Bytes(b.subarray(2, 6));
    return inner ? `6to4:${inner}` : null;
  }
  for (const r of BLOCKED_V6) if (prefixMatch(b, r.prefix, r.bits)) return r.reason;
  return null;
}

/**
 * Why an address is not a permitted fetch target, or null if it is public.
 * Anything that does not parse as an IP address is refused ('unparseable').
 */
export function classifyAddress(ip: string): string | null {
  const v4 = ipv4Octets(ip);
  if (v4) return classifyV4Bytes(Uint8Array.from(v4));
  const v6 = ipv6Bytes(ip);
  if (v6) return classifyV6Bytes(v6);
  return 'unparseable';
}

export function isPrivateAddress(ip: string): boolean {
  return classifyAddress(ip) !== null;
}

// ---------------------------------------------------------------------------
// Validation + pinned request
// ---------------------------------------------------------------------------

export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

/** The URL's host without IPv6 brackets (no port, path or query). */
function bareHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

/** Log a refusal (hostname + reason only) and throw. */
function refuse(host: string, hop: number, reason: string, message: string): never {
  logEvent('outbound_fetch', { decision: 'refused', reason, host, hop });
  throw new SsrfError(message);
}

/**
 * Validate one URL and return the addresses the connection may use. Throws
 * SsrfError if anything is internal. Every A/AAAA record must be public: a host
 * that resolves to one public and one private record is refused.
 */
async function validateUrl(
  url: URL,
  hop: number,
  allowedHosts?: string[]
): Promise<PinnedAddress[]> {
  const hostname = bareHost(url);
  // Credentials in the URL would be sent as Basic auth; never forward them.
  if (url.username !== '' || url.password !== '') {
    refuse(hostname, hop, 'userinfo', 'URLs containing credentials (user:pass@) are not allowed');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    refuse(hostname, hop, 'scheme', `Blocked URL scheme "${url.protocol}" (only http/https allowed)`);
  }

  const literalFamily = isIP(hostname);
  const allowlistSet = !!allowedHosts && allowedHosts.length > 0;
  // With an allowlist, only named hosts are acceptable: an IP literal can never
  // be an allowlisted hostname, so refuse it before any other check.
  if (allowlistSet && literalFamily !== 0) {
    refuse(hostname, hop, 'ip-literal-with-allowlist', `IP-literal host "${hostname}" is not allowed when a fetch allowlist is configured`);
  }
  if (isBlockedHostname(hostname)) {
    refuse(hostname, hop, 'blocked-hostname', `Blocked internal hostname "${hostname}"`);
  }
  if (isOutsideAllowlist(hostname, allowedHosts)) {
    refuse(hostname, hop, 'not-in-allowlist', `Hostname "${hostname}" is not in the configured fetch allowlist`);
  }

  // Literal IP: validate it directly (no DNS).
  if (literalFamily !== 0) {
    const why = classifyAddress(hostname);
    if (why) refuse(hostname, hop, `address:${why}`, `Blocked private/internal IP address "${hostname}"`);
    return [{ address: hostname, family: literalFamily as 4 | 6 }];
  }

  // Resolve ONCE; the connection is later pinned to exactly these addresses.
  let records: dns.LookupAddress[];
  try {
    records = await dns.promises.lookup(hostname, { all: true });
  } catch {
    refuse(hostname, hop, 'unresolvable', `Could not resolve hostname "${hostname}"`);
  }
  if (records.length === 0) {
    refuse(hostname, hop, 'unresolvable', `Could not resolve hostname "${hostname}"`);
  }
  const pinned: PinnedAddress[] = [];
  for (const { address, family } of records) {
    const why = classifyAddress(address);
    if (why) {
      refuse(hostname, hop, `resolved:${why}`, `Hostname "${hostname}" resolves to private/internal IP "${address}"`);
    }
    pinned.push({ address, family: family === 6 ? 6 : 4 });
  }
  return pinned;
}

/**
 * A `lookup` for net/tls connect that never consults DNS: it answers only with
 * the already-validated addresses. Handles both the single-address and the
 * `all: true` (Happy Eyeballs / autoSelectFamily) callback shapes.
 */
export function pinnedLookup(addresses: PinnedAddress[]): LookupFunction {
  return ((_hostname: string, options: unknown, callback?: unknown) => {
    let opts = options as { all?: boolean; family?: number | string } | number | undefined;
    let cb = callback as (...args: unknown[]) => void;
    if (typeof options === 'function') {
      cb = options as (...args: unknown[]) => void;
      opts = undefined;
    }
    const o = typeof opts === 'number' ? { family: opts } : (opts ?? {});
    const fam = o.family === 'IPv4' ? 4 : o.family === 'IPv6' ? 6 : Number(o.family ?? 0);
    const usable = fam === 4 || fam === 6 ? addresses.filter((a) => a.family === fam) : addresses;
    if (usable.length === 0) {
      const err = Object.assign(new Error('No validated address for requested family'), {
        code: 'ENOTFOUND',
      });
      process.nextTick(() => cb(err));
      return;
    }
    if (o.all) {
      process.nextTick(() => cb(null, usable.map((a) => ({ ...a }))));
    } else {
      const first = usable[0]!;
      process.nextTick(() => cb(null, first.address, first.family));
    }
  }) as LookupFunction;
}

/** Statuses whose responses carry no body (the Response constructor rejects one). */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * Sent on every outbound request. Some hosts refuse requests without a
 * User-Agent. Caller headers override these, except accept-encoding.
 */
export const DEFAULT_FETCH_HEADERS: Readonly<Record<string, string>> = {
  'user-agent': `${SERVER_NAME}/${SERVER_VERSION} (+https://mcp.civitai.com)`,
  accept: 'image/*,*/*;q=0.8',
};

export class FetchTimeoutError extends Error {
  constructor(message = 'Upstream fetch timed out') {
    super(message);
    this.name = 'FetchTimeoutError';
  }
}

/** Keep only characters a Response reason phrase may hold (printable ASCII + tab). */
function safeStatusText(raw: string | undefined): string {
  return (raw ?? '').replace(/[^\t\x20-\x7e]/g, '');
}

/**
 * One GET whose TCP connection can only go to `addresses` (no DNS at connect
 * time). Exported for tests. Uses a fresh agent so no pooled socket is reused.
 *
 * Always settles exactly once: on a response, a socket error, a protocol
 * upgrade (refused), an unusable response (refused), or `signal` aborting.
 * An abort after the response has resolved destroys the connection, so a
 * pending body read errors instead of hanging. `onClose` fires when the
 * response stream closes (body fully read, cancelled or destroyed).
 *
 * Only identity encoding is requested; a response that is compressed anyway is
 * refused rather than decompressed, so the caller's size cap always applies to
 * the bytes actually used.
 */
export function requestPinned(
  url: URL,
  addresses: PinnedAddress[],
  headers: Record<string, string> = {},
  signal?: AbortSignal,
  onClose?: () => void
): Promise<Response> {
  const client = url.protocol === 'https:' ? https : http;
  const sent: Record<string, string> = { ...DEFAULT_FETCH_HEADERS };
  for (const [k, v] of Object.entries(headers)) sent[k.toLowerCase()] = v;
  sent['accept-encoding'] = 'identity';

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let response: http.IncomingMessage | undefined;
    const fail = (err: Error): void => {
      if (!settled) {
        settled = true;
        reject(err);
      }
      response?.destroy(err);
      req.destroy(err);
    };
    const onAbort = (): void => fail(new FetchTimeoutError());

    const req = client.request(
      url,
      { method: 'GET', headers: sent, agent: false, lookup: pinnedLookup(addresses) },
      (res) => {
        response = res;
        res.once('close', () => {
          signal?.removeEventListener('abort', onAbort);
          onClose?.();
        });
        // Any throw here would escape the promise (this is an event callback),
        // so every failure is routed through fail().
        try {
          const status = res.statusCode ?? 0;
          if (status < 200 || status > 599) {
            throw new Error(`Unexpected upstream status ${status}`);
          }
          const encoding = String(res.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
          if (encoding !== '' && encoding !== 'identity') {
            throw new Error('Upstream sent a compressed response although identity encoding was requested');
          }
          const out = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined) continue;
            for (const one of Array.isArray(v) ? v : [v]) out.append(k, one);
          }
          let body: ReadableStream<Uint8Array> | null = null;
          if (NULL_BODY_STATUSES.has(status)) res.resume();
          else body = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>;
          const built = new Response(body, { status, statusText: safeStatusText(res.statusMessage), headers: out });
          if (!settled) {
            settled = true;
            resolve(built);
          }
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
      }
    );
    // A protocol switch is never a valid answer to a plain GET.
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      fail(new Error('Upstream attempted a protocol upgrade'));
    });
    req.on('error', (err) => fail(err));
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end();
  });
}

export interface SafeFetchInit {
  headers?: Record<string, string>;
  /** Total deadline for all hops AND reading the body (default 10s). */
  timeoutMs?: number;
}

/**
 * GET a *user-supplied* URL with SSRF protections. Validates the host, pins the
 * connection to the validated addresses, and follows up to 3 redirects
 * manually, re-validating every hop. One total deadline (FETCH_TIMEOUT_MS by
 * default) covers every hop and the final body read: when it fires, the
 * connection is destroyed and a pending read rejects. Caller owns size limits
 * and body consumption.
 */
export async function safeFetchUrl(
  rawUrl: string,
  init: SafeFetchInit = {},
  allowedHosts?: string[]
): Promise<Response> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    refuse('', 0, 'invalid-url', `Invalid URL: ${rawUrl}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? FETCH_TIMEOUT_MS);
  timeout.unref?.();
  let returned = false;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const addresses = await validateUrl(current, hop, allowedHosts);
      logEvent('outbound_fetch', {
        decision: 'allowed',
        reason: 'validated',
        host: bareHost(current),
        hop,
      });

      let closed = false;
      const res = await requestPinned(current, addresses, init.headers, controller.signal, () => {
        closed = true;
        if (returned) clearTimeout(timeout);
      });

      // Manual redirect handling: re-validate the target before following.
      if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
        const location = res.headers.get('location')!;
        // Drain the redirect body so the socket can be closed.
        await res.body?.cancel().catch(() => undefined);
        if (hop === MAX_REDIRECTS) {
          refuse(bareHost(current), hop, 'too-many-redirects', `Too many redirects (max ${MAX_REDIRECTS})`);
        }
        try {
          current = new URL(location, current);
        } catch {
          refuse(bareHost(current), hop, 'invalid-redirect', `Invalid redirect target: ${location}`);
        }
        continue;
      }

      // The deadline now guards the body read; it is cleared when the
      // response stream closes.
      returned = true;
      if (closed) clearTimeout(timeout);
      return res;
    }
    // Unreachable: loop either returns a response or throws.
    throw new SsrfError('Redirect handling failed');
  } finally {
    if (!returned) clearTimeout(timeout);
  }
}
