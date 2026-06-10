import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF-hardened fetch for *user-supplied* URLs.
 *
 * The server runs in-cluster (k8s) next to the Civitai app, so a naive fetch of
 * an arbitrary user URL could reach internal services, the kubelet, or the cloud
 * metadata endpoint. This helper:
 *   - allows only http:/https:
 *   - resolves the hostname and rejects loopback / RFC1918 / link-local
 *     (incl. 169.254/16 cloud metadata) / unique-local + loopback IPv6
 *   - rejects internal hostnames (.svc, .cluster.local, .internal, localhost,
 *     metadata.google.internal)
 *   - optionally enforces a hostname allowlist
 *   - follows redirects manually (max 3), re-validating every hop
 *   - enforces a 10s timeout via AbortSignal
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

/** Parse a dotted IPv4 string into its four octets, or null if malformed. */
function ipv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return octets as [number, number, number, number];
}

function isPrivateIPv4(ip: string): boolean {
  const octets = ipv4Octets(ip);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  let addr = ip.toLowerCase();
  // Strip zone id (e.g. fe80::1%eth0)
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);
  if (addr === '::' || addr === '::1') return true; // unspecified / loopback
  if (addr.startsWith('fe80')) return true; // link-local
  if (addr.startsWith('fc') || addr.startsWith('fd')) return true; // unique-local fc00::/7
  // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded v4 address.
  const mapped = addr.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return false;
}

/**
 * Validate a single URL: scheme + hostname + all resolved IPs. Throws SsrfError
 * if anything is internal. Resolving every A/AAAA record and rejecting if ANY is
 * private rejects the common rebinding case (a host that resolves to one public
 * + one private record).
 *
 * RESIDUAL RISK (documented): native fetch re-resolves DNS when it connects, so
 * a TOCTOU window exists between this validation and the actual connection — an
 * attacker controlling DNS could return a public IP here and a private IP to the
 * connect(). Fully closing this requires pinning the connection to the validated
 * IP via a custom undici dispatcher `lookup`; we keep this project dep-free
 * instead and accept the narrow window. The fetch happens immediately after
 * validation (no awaited work in between) to keep the window as small as
 * possible, and every redirect hop is re-validated.
 */
async function validateUrl(url: URL, allowedHosts?: string[]): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`Blocked URL scheme "${url.protocol}" (only http/https allowed)`);
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (isBlockedHostname(hostname)) {
    throw new SsrfError(`Blocked internal hostname "${hostname}"`);
  }
  if (isOutsideAllowlist(hostname, allowedHosts)) {
    throw new SsrfError(`Hostname "${hostname}" is not in the configured fetch allowlist`);
  }

  // If the host is already a literal IP, validate it directly (no DNS).
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new SsrfError(`Blocked private/internal IP address "${hostname}"`);
    }
    return;
  }

  // Resolve every A/AAAA record; reject if ANY is private (rebinding-safe).
  const records = await lookup(hostname, { all: true });
  if (records.length === 0) {
    throw new SsrfError(`Could not resolve hostname "${hostname}"`);
  }
  for (const { address } of records) {
    if (isPrivateAddress(address)) {
      throw new SsrfError(`Hostname "${hostname}" resolves to private/internal IP "${address}"`);
    }
  }
}

/**
 * Fetch a *user-supplied* URL with SSRF protections. Validates the host, then
 * follows up to 3 redirects manually, re-validating every hop. Enforces the
 * FETCH_TIMEOUT_MS deadline. Caller owns size limits and body consumption.
 */
export async function safeFetchUrl(
  rawUrl: string,
  init: RequestInit = {},
  allowedHosts?: string[]
): Promise<Response> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new SsrfError(`Invalid URL: ${rawUrl}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await validateUrl(current, allowedHosts);

      const res = await fetch(current, {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
      });

      // Manual redirect handling: re-validate the target before following.
      if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
        if (hop === MAX_REDIRECTS) {
          throw new SsrfError(`Too many redirects (max ${MAX_REDIRECTS})`);
        }
        const location = res.headers.get('location')!;
        // Drain the redirect body so the socket can be reused/closed.
        await res.body?.cancel().catch(() => undefined);
        try {
          current = new URL(location, current);
        } catch {
          throw new SsrfError(`Invalid redirect target: ${location}`);
        }
        continue;
      }

      return res;
    }
    // Unreachable: loop either returns a response or throws.
    throw new SsrfError('Redirect handling failed');
  } finally {
    clearTimeout(timeout);
  }
}
