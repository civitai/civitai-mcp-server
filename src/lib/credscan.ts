/**
 * Credential-shape detectors, ported from the Civitai CLI's `internal/credscan`
 * (civitai/cli, `internal/credscan/credscan.go` + `spans.go`). Only what
 * `credentialSpans` needs is ported: the strict-assignment detector (A2) and
 * the known-format table (B), with their gates. The CLI's file scanner, labels
 * and reporting are not needed here.
 *
 * It exists for one consumer, `redact.ts`, which removes what these detectors
 * LOCATE before platform feedback leaves the process.
 *
 * Porting notes (Go RE2 -> JavaScript):
 *  - Go's `\s` is ASCII `[\t\n\f\r ]` and `\S` its complement. JavaScript's
 *    `\s` also matches Unicode spaces and `\v`, so every pattern spells the
 *    ASCII class out. Using JS `\s` would end a value at a non-breaking space
 *    the CLI keeps going through.
 *  - Every pattern carries the `u` flag, so `(?i)` case folding (Kelvin sign,
 *    long s) and per-code-point matching behave as RE2 does.
 *  - Lengths and entropy that the CLI measures in BYTES are measured on the
 *    UTF-8 encoding here (`utf8Length`, `shannonBitsPerChar`), so a non-ASCII
 *    value passes or fails the same gate it does in the CLI.
 *
 * 🔴 IT INHERITS EVERY DELIBERATE SILENCE OF THE CLI'S DETECTORS. An empty
 * result is not "this line holds no secret": a placeholder-shaped or
 * low-entropy value, a Google-API-key shape and a headerless key body are all
 * unreported on purpose.
 */

/** ASCII white space, as Go's RE2 `\s` defines it. */
const WS = '\\t\\n\\f\\r ';

/** A half-open range [start, end) of one line, in UTF-16 code units. */
export interface Span {
  start: number;
  end: number;
}

// assignRe: `<key containing a credential word> <op> <value>`. Submatches:
// 1 = the key, 2 = the credential word, 3 = the operator, 4 = the value
// (bounded at 512 — a complexity fix in the CLI, see wholeValue).
const assignRe = new RegExp(
  `([A-Za-z0-9_.\\-\\[\\]"']{0,40}(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?)[A-Za-z0-9_.\\-"']{0,24})[${WS}]*(:=|=>|=|:)[${WS}]*([^${WS}]{1,512})`,
  'giud'
);

/** The length assignRe's value group stops at. */
const ASSIGN_VALUE_BOUND = 512;

/** Openings of a value nobody ever pasted a live credential into (prefix, case-insensitive). */
export const placeholderPrefixes = [
  'your', 'my', 'the', '<', '$', 'null', 'true', 'false',
  'example', 'sample', 'dummy', 'fake', 'placeholder', 'todo',
  'changeme', 'redacted', 'hidden', 'xxx', '...',
];

const interpolationMarkers = ['${', 'process.env', 'import.meta'];

const rejectRe =
  /(mock|dummy|fake|sample|example|placeholder|localhost|changeme|redacted|not[._-]?a[._-]?real|xxxx|test|demo|dev\.)/iu;

const dottedRefRe = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)+$/u;

const MIN_VALUE_LEN = 12;
const MIN_ENTROPY_BITS_PER_CHAR = 3.0;

/** A Google API key shape: public by design for Firebase web keys, so deliberately silent. */
const publicByDesignRe = /^AIza[0-9A-Za-z_-]{35}$/u;

function utf8Length(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Shannon entropy over the UTF-8 byte frequencies, in bits per character. */
export function shannonBitsPerChar(s: string): number {
  if (s === '') return 0;
  const bytes = Buffer.from(s, 'utf8');
  const counts = new Array<number>(256).fill(0);
  for (const b of bytes) counts[b]!++;
  const n = bytes.length;
  let h = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

const hasDigit = (s: string) => /[0-9]/.test(s);
const hasLetter = (s: string) => /[A-Za-z]/.test(s);

/** A quoted value ends at its closing quote; a backslash escapes the next character. */
function untilClosingQuote(raw: string): string | null {
  if (raw === '') return null;
  const q = raw[0];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] === '\\' && q !== '`') {
      i++;
      continue;
    }
    if (raw[i] === q) return raw.slice(1, i);
  }
  return null;
}

/** Removes a `//` or `#` comment that starts the value or follows white space. */
function stripTrailingComment(s: string): string {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '#' && !(s[i] === '/' && s[i + 1] === '/')) continue;
    if (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t') return s.slice(0, i);
  }
  return s;
}

/** Reduces the raw capture to the value itself, and reports whether it was quoted. */
function cleanValue(raw: string): { value: string; quoted: boolean } {
  const closed = untilClosingQuote(raw);
  if (closed !== null) return { value: closed, quoted: true };
  let v = stripTrailingComment(raw).trim();
  const i = v.search(/[,}\])]/);
  if (i >= 0) v = v.slice(0, i);
  v = v.replace(/[,;]+$/, '').trim();
  if (v.length >= 2) {
    const q = v[0];
    if ((q === '"' || q === "'" || q === '`') && v[v.length - 1] === q) {
      return { value: v.slice(1, -1), quoted: true };
    }
  }
  return { value: v, quoted: false };
}

/** A2's gate: every condition must hold, then the rejections must not. */
export function valueLooksLikeSecret(value: string, quoted: boolean): boolean {
  if (utf8Length(value) < MIN_VALUE_LEN) return false;
  for (const marker of interpolationMarkers) if (value.includes(marker)) return false;
  const lower = value.toLowerCase();
  for (const p of placeholderPrefixes) if (lower.startsWith(p)) return false;
  if (!quoted && dottedRefRe.test(value)) return false;
  if (!hasDigit(value) || !hasLetter(value)) return false;
  if (rejectRe.test(value)) return false;
  if (publicByDesignRe.test(value)) return false;
  return shannonBitsPerChar(value) >= MIN_ENTROPY_BITS_PER_CHAR;
}

const localHostRe = /@(127\.0\.0\.1|0\.0\.0\.0|\[::1\]|localhost)(:|$)/u;
const reservedHostTLDs = new Set(['localhost', 'test', 'invalid', 'example', 'local']);
const reservedExampleDomains = new Set(['example.com', 'example.net', 'example.org']);

function hostWithoutPort(host: string): string {
  if (host.startsWith('[')) {
    const i = host.indexOf(']');
    return i >= 0 ? host.slice(1, i) : host;
  }
  const i = host.indexOf(':');
  return i >= 0 ? host.slice(0, i) : host;
}

/** Whole-label test for a documentation/local-use host name (RFC 6761/2606/6762). */
function hostIsReserved(host: string): boolean {
  const h = hostWithoutPort(host).replace(/\.$/, '').toLowerCase();
  const labels = h.split('.');
  const n = labels.length;
  if (reservedHostTLDs.has(labels[n - 1]!)) return true;
  if (n >= 2 && reservedExampleDomains.has(`${labels[n - 2]}.${labels[n - 1]}`)) return true;
  return false;
}

const MIN_URL_PASSWORD_ENTROPY = 2.5;

/** Keeps the URL-with-password format off documentation. */
function urlPasswordLooksReal(match: string): boolean {
  const at = match.lastIndexOf('@');
  if (at < 0) return false;
  const colon = match.slice(0, at).lastIndexOf(':');
  if (colon < 0) return false;
  let user = match.slice(0, colon);
  const sl = user.indexOf('//');
  if (sl >= 0) user = user.slice(sl + 2);
  const pw = match.slice(colon + 1, at);
  if (rejectRe.test(`${user}:${pw}`)) return false;
  if (localHostRe.test(match) || hostIsReserved(match.slice(at + 1))) return false;
  const lower = pw.toLowerCase();
  for (const p of placeholderPrefixes) if (lower.startsWith(p)) return false;
  if (['password', 'passwd', 'pwd', 'secret', 'hunter2', 'changeit'].includes(lower)) return false;
  // Go strings.EqualFold: simple Unicode case folding; toLowerCase is close enough for user names.
  if (pw.toLowerCase() === user.toLowerCase()) return false;
  if (/[$%]/.test(pw)) return false;
  return shannonBitsPerChar(pw) >= MIN_URL_PASSWORD_ENTROPY;
}

interface KnownFormat {
  name: string;
  re: RegExp;
  validate?: (match: string) => boolean;
}

/** B — credential shapes that identify themselves, no assignment required. */
const knownFormats: KnownFormat[] = [
  { name: 'PEM private key block', re: /BEGIN [A-Z0-9 ]*PRIVATE KEY/gu },
  { name: 'JWT', re: /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/gu },
  { name: 'AWS access key id', re: /(AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}/gu },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36,}/gu },
  { name: 'Slack token', re: /xox[abprs]-[A-Za-z0-9-]{10,}/gu },
  { name: 'OpenAI API key', re: /sk-[A-Za-z0-9]{32,}/gu },
  { name: 'Stripe API key', re: /[sr]k_(live|test)_[A-Za-z0-9]{16,}/gu },
  { name: 'npm token', re: /npm_[A-Za-z0-9]{36}/gu },
  {
    name: 'URL with an embedded password',
    re: new RegExp(`[a-zA-Z][a-zA-Z0-9+.\\-]*://[^${WS}:/?#@]+:[^${WS}:/?#@]+@[^${WS}/?#@]{1,255}`, 'gu'),
    validate: urlPasswordLooksReal,
  },
];

/**
 * Extends a span that stopped at assignRe's capture bound to the real end of
 * the value: redacting the first 512 characters of a 700-character secret
 * would send the rest.
 */
function wholeValue(line: string, rawStart: number, sp: Span): Span {
  const q = line[rawStart];
  if (q === '"' || q === "'" || q === '`') {
    if (sp.start === rawStart) sp.start++;
    for (let i = sp.end; i < line.length; i++) {
      if (line[i] === '\\' && q !== '`') {
        i++;
        continue;
      }
      if (line[i] === q) {
        sp.end = i;
        return sp;
      }
    }
    sp.end = line.length;
    return sp;
  }
  while (sp.end < line.length && !' \t\r\n,}])'.includes(line[sp.end]!)) sp.end++;
  return sp;
}

/** Sorts spans and joins any that overlap or touch. */
function mergeSpans(spans: Span[]): Span[] {
  if (spans.length < 2) return spans;
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [spans[0]!];
  for (const s of spans.slice(1)) {
    const last = out[out.length - 1]!;
    if (s.start <= last.end) {
      if (s.end > last.end) last.end = s.end;
      continue;
    }
    out.push(s);
  }
  return out;
}

/**
 * Where, in ONE line, the two detectors find credential material: the value
 * of every strict assignment that passes valueLooksLikeSecret, and every
 * known-format match that passes its validator. Sorted, non-overlapping.
 */
export function credentialSpans(line: string): Span[] {
  const out: Span[] = [];

  for (let pos = 0; pos < line.length; ) {
    assignRe.lastIndex = pos;
    const m = assignRe.exec(line);
    if (!m || !m.indices) break;
    const [rawStart, rawEnd] = m.indices[4]!;
    const raw = line.slice(rawStart, rawEnd);
    const { value, quoted } = cleanValue(raw);
    if (valueLooksLikeSecret(value, quoted)) {
      const i = raw.indexOf(value);
      if (i >= 0) {
        let sp: Span = { start: rawStart + i, end: rawStart + i + value.length };
        // The capture hit its bound (counted in code points, as the pattern
        // counts) and the value runs to its end: the value may continue.
        if ([...raw].length === ASSIGN_VALUE_BOUND && sp.end === rawEnd) {
          sp = wholeValue(line, rawStart, sp);
        }
        out.push(sp);
      }
    }
    // Resume just past this match's operator; always advance at least one.
    const next = m.indices[3]![1];
    pos = next > pos ? next : pos + 1;
  }

  for (const f of knownFormats) {
    for (const m of line.matchAll(f.re)) {
      if (f.validate && !f.validate(m[0])) continue;
      out.push({ start: m.index!, end: m.index! + m[0].length });
    }
  }

  return mergeSpans(out);
}
