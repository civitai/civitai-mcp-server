import { credentialSpans } from './credscan.js';

/**
 * Removes what platform feedback must not carry off to Civitai, BEFORE anything
 * is sent. A port of the Civitai CLI's `internal/redact` (civitai/cli,
 * `internal/redact/redact.go`), kept rule-for-rule so an agent reporting through
 * this server and one reporting through `civitai feedback send` get the same
 * text removed. Its test vectors are ported too (test/redact.test.ts).
 *
 * The rules, in the order they run:
 *
 *  1. URLs, on the ORIGINAL text. A URL is one token: from `scheme://` to the
 *     next white space. Everything between `://` and its LAST `@` is replaced
 *     (kind credential), and everything from its first `?` or `#` to its end is
 *     dropped (kind url-query, so a fragment too). When a `?` or `#` came
 *     before that `@`, the rest of the token goes as well.
 *  2. credential — the value of an `Authorization` header, whatever the scheme,
 *     from the first non-blank character after the `:` or `=` (on that line or
 *     a later one) to the end of the line that character is on.
 *  3. token — each configured credential value, matched EXACTLY (here: the
 *     Civitai API key this request is made with).
 *  4. credential — a PEM private-key block; an `x-api-key` / `api-key` value
 *     that has a digit; a bare `Bearer <value>` that has a digit; and what
 *     `credscan.ts` locates: known token formats and the value of a strict
 *     `KEY=value` assignment that passes its entropy gate.
 *  5. email — an e-mail address.
 *  6. home-path — the home directory, replaced by `~` (only when one is given).
 *  7. user-path — the user segment of `/home/<u>`, `/Users/<u>` and
 *     `C:\Users\<u>`.
 *
 * URLs go first for a measured reason (in the CLI): later rules leave
 * placeholders containing `<`/`>`, and a query strip that ran after them
 * stopped at the `<` and sent the rest of the query.
 *
 * 🔴 It is not a guarantee that no secret leaves. The exact-token rule matches a
 * known string; the others match SHAPES. The lists below are the CLI's,
 * verbatim, and each entry is demonstrated by an input in test/redact.test.ts.
 *
 * KNOWN MISSES — sent as typed:
 *
 *   - a bare `Bearer <value>` with no `Authorization` header in front of it,
 *     when the value has no digit
 *   - an `x-api-key` / `api-key` value that has no digit
 *   - the query or fragment of a URL written without a scheme
 *     (`cdn.example/f?sig=…`)
 *   - a credential that appears transformed: URL-encoded, base64 of itself, or
 *     split across lines
 *   - a configured credential shorter than 8 characters (stderr says when one
 *     was skipped)
 *   - a URL query that contains a literal space: the URL token ends at the
 *     space, so `?q=hello world&sig=…` keeps `world&sig=…`
 *   - a JSON-escaped URL (`https:\/\/…?sig=…`): it is not recognised as a URL,
 *     so its query is kept
 *
 * KNOWN OVER-REDACTIONS — removed although not a secret:
 *
 *   - everything after `Authorization:` to the end of that line, whatever it is
 *     — prose included, and anything else that shares the line
 *   - the line after an `Authorization` header whose own line holds no value —
 *     the value is looked for across line breaks
 *   - an `api-key` / `apiKey` assignment whose value has a digit, even when the
 *     value is a variable name
 *   - any URL userinfo, even a bare user name (`ssh://git@host/…` is counted as
 *     a credential)
 *   - everything between `://` and the last `@` of a URL token — so an `@` in a
 *     path or query takes the host with it — and, when a `?` or `#` came before
 *     that `@`, the rest of the token too
 *   - a URL's `#fragment`, and whatever is glued to a URL after its first `?`
 *     or `#` with no white space: closing quotes, brackets, a trailing full
 *     stop, the rest of a minified JSON line
 *   - a Windows user segment runs to the next backslash on the line, so
 *     `copy C:\Users\ingrid .\dist\out` loses `ingrid .`
 *   - `/home/<name>` and `/Users/<name>` wherever they appear, including inside
 *     a URL path
 *   - the words of a private-key header (`BEGIN … PRIVATE KEY`) in prose
 *
 * (In this server the "stderr says" note of the short-token miss is the
 * `skippedShortTokens` count; the API key it would apply to is far longer.)
 *
 * Porting notes: Go's ASCII `\s`/`\S` are spelled out (JavaScript's `\s` is
 * wider), every pattern carries the `u` flag so `(?i)` folds as RE2 does, and
 * lengths the CLI counts in UTF-16 units (ApplyClipped) are JavaScript lengths.
 */

export const KIND_TOKEN = 'token';
export const KIND_CREDENTIAL = 'credential';
export const KIND_EMAIL = 'email';
export const KIND_URL_QUERY = 'url-query';
export const KIND_HOME_PATH = 'home-path';
export const KIND_USER_PATH = 'user-path';

export type RedactionKind =
  | typeof KIND_TOKEN
  | typeof KIND_CREDENTIAL
  | typeof KIND_EMAIL
  | typeof KIND_URL_QUERY
  | typeof KIND_HOME_PATH
  | typeof KIND_USER_PATH;

/** The order counts are reported in. */
export const KIND_ORDER: readonly RedactionKind[] = [
  KIND_TOKEN,
  KIND_CREDENTIAL,
  KIND_EMAIL,
  KIND_URL_QUERY,
  KIND_HOME_PATH,
  KIND_USER_PATH,
];

export interface RedactionCount {
  kind: RedactionKind;
  count: number;
}

const placeholderOf: Record<RedactionKind, string> = {
  token: '<token>',
  credential: '<credential>',
  email: '<email>',
  'url-query': '',
  'home-path': '~',
  'user-path': '<user>',
};

/**
 * Each replacement leaves a marker code point behind it, and the counts are
 * read off whatever text is finally returned — so a placeholder a later rule
 * swallowed, or text clipped away, is not counted. U+FDD0–U+FDEF are Unicode
 * noncharacters; any already in the input are removed first.
 */
const markerOf: Record<RedactionKind, string> = {
  token: '\uFDD0',
  credential: '\uFDD1',
  email: '\uFDD2',
  'url-query': '\uFDD3',
  'home-path': '\uFDD4',
  'user-path': '\uFDD5',
};

const kindOfMarker = new Map<string, RedactionKind>(
  (Object.entries(markerOf) as Array<[RedactionKind, string]>).map(([k, m]) => [m, k])
);

const MARKER_CLASS = '\\uFDD0-\\uFDEF';
const markerRe = new RegExp(`[${MARKER_CLASS}]`, 'gu');
const isMarker = (ch: string) => ch >= '\uFDD0' && ch <= '\uFDEF';

const stripMarkers = (s: string) => s.replace(markerRe, '');
const markersIn = (s: string) => (s.match(markerRe) ?? []).join('');

/** What stands in for `removed`: the placeholder, its marker, and any markers `removed` held. */
const replaced = (kind: RedactionKind, removed: string) =>
  placeholderOf[kind] + markerOf[kind] + markersIn(removed);

/** The shortest configured credential the exact rule will match. */
export const MIN_TOKEN_LEN = 8;

/** ASCII white space, as Go's RE2 `\s` defines it. */
const WS = '\\t\\n\\f\\r ';

const urlTokenRe = new RegExp(`[A-Za-z][A-Za-z0-9+.\\-]*://[^${WS}]*`, 'gu');
const pemBlockRe =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gu;
const authHeaderRe = new RegExp(
  `\\b(authorization["']?[ \\t]*[:=][${WS}]*)([^${WS}][^\\r\\n]*)`,
  'giu'
);
const apiKeyRe = new RegExp(
  `\\b((?:x[-_])?api[-_]?key["']?[${WS}]*[:=][${WS}]*["']?)([^${WS}"'&,;<][^${WS}"'&,;]{7,})`,
  'giu'
);
const bearerRe = new RegExp(`\\b(Bearer[${WS}]+)([A-Za-z0-9._~+/=-]{16,})`, 'giu');
const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu;
const unixUserRe = new RegExp(`(/home/|/Users/)[^/\\\\${WS}"'<>:${MARKER_CLASS}]+`, 'gu');
const windowsUserRe = new RegExp(
  `([A-Za-z]:\\\\{1,2}Users\\\\{1,2})(?:[^/\\\\"'<>:\\r\\n${MARKER_CLASS}]+(\\\\)|[^/\\\\${WS}"'<>:${MARKER_CLASS}]+)`,
  'giu'
);

/** The api-key and bare-Bearer rules only fire on a value with a digit. */
const valueLooksReal = (v: string) => /[0-9]/.test(v);

function replaceGroup2(re: RegExp, s: string, redactIf?: (v: string) => boolean): string {
  return s.replace(re, (m: string, g1: string, g2: string) =>
    redactIf && !redactIf(g2) ? m : g1 + replaced(KIND_CREDENTIAL, g2)
  );
}

/** Whether `rest` begins with something that could continue a file-name segment. */
function continuesPathSegment(rest: string): boolean {
  if (rest === '') return false;
  const c = String.fromCodePoint(rest.codePointAt(0)!);
  if (isMarker(c)) return false;
  if (/^[A-Za-z0-9_.-]$/.test(c)) return true;
  return c.codePointAt(0)! >= 0x80;
}

export interface RedactorOptions {
  /** The home directory to replace with `~`, or undefined to skip that rule. */
  home?: string;
  /** Credential values to remove exactly. Empty and duplicate entries are ignored. */
  tokens?: Array<string | undefined>;
}

/**
 * Applies the rules and accumulates counts across its apply/applyClipped calls,
 * so one instance covers every field of one report.
 */
export class Redactor {
  private readonly home: string | undefined;
  private readonly tokenList: string[] = [];
  private skippedShort = 0;
  private readonly counts = new Map<RedactionKind, number>();

  constructor(opts: RedactorOptions = {}) {
    const home = (opts.home ?? '').replace(/[/\\]+$/, '');
    // A home of "" or a bare root would turn every absolute path into "~".
    if (home.length > 1) this.home = home;

    const seen = new Set<string>();
    for (const raw of opts.tokens ?? []) {
      const t = (raw ?? '').trim();
      if (t === '' || seen.has(t)) continue;
      seen.add(t);
      if (utf8Len(t) < MIN_TOKEN_LEN) {
        this.skippedShort++;
        continue;
      }
      this.tokenList.push(t);
    }
    // Longest first, so a token that contains another is removed whole.
    this.tokenList.sort((a, b) => utf8Len(b) - utf8Len(a));
  }

  /** How many configured credential values were too short for the exact rule. */
  skippedShortTokens(): number {
    return this.skippedShort;
  }

  /** The credential values the exact rule covers. */
  tokens(): string[] {
    return [...this.tokenList];
  }

  /** What was removed from the text returned so far, in rule order, omitting kinds that never fired. */
  countsList(): RedactionCount[] {
    const out: RedactionCount[] = [];
    for (const kind of KIND_ORDER) {
      const count = this.counts.get(kind) ?? 0;
      if (count > 0) out.push({ kind, count });
    }
    return out;
  }

  /** Returns `s` with every rule applied, adding what it removed to the counts. */
  apply(s: string): string {
    if (s === '') return s;
    return this.settle(this.mark(s));
  }

  /**
   * Redacts `s`, trims surrounding white space, and returns at most `max`
   * UTF-16 code units of the result, reporting whether anything was cut. Only
   * what is returned is counted, and a cut that would land inside a
   * placeholder backs up to the placeholder's start.
   */
  applyClipped(s: string, max: number): { text: string; clipped: boolean } {
    const m = this.mark(s).trim();

    let cut = m.length;
    let units = 0;
    for (let i = 0; i < m.length; ) {
      const cp = m.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      if (!isMarker(ch)) {
        if (units + ch.length > max) {
          cut = i;
          break;
        }
        units += ch.length;
      }
      i += ch.length;
    }
    if (cut < m.length) {
      // The first marker at or after the cut closes a placeholder that ends
      // right before it. If that placeholder began before the cut, the cut is
      // inside it.
      for (let i = cut; i < m.length; i++) {
        const ch = m[i]!;
        if (!isMarker(ch)) continue;
        const start = i - placeholderOf[kindOfMarker.get(ch)!].length;
        if (start < cut) cut = start;
        break;
      }
    }
    const clipped = stripMarkers(m.slice(cut)) !== '';
    return { text: this.settle(m.slice(0, cut)).trim(), clipped };
  }

  private settle(marked: string): string {
    for (const ch of marked) {
      const kind = kindOfMarker.get(ch);
      if (kind) this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
    }
    return stripMarkers(marked);
  }

  private mark(input: string): string {
    let s = stripMarkers(input);
    s = this.urls(s);
    s = s.replace(authHeaderRe, (_m: string, g1: string, g2: string) => g1 + replaced(KIND_CREDENTIAL, g2));
    s = this.exactTokens(s);
    s = this.credentials(s);
    s = s.replace(emailRe, (m: string) => replaced(KIND_EMAIL, m));
    s = this.homeDir(s);
    s = this.userPaths(s);
    return s;
  }

  private urls(s: string): string {
    return s.replace(urlTokenRe, (tok: string) => {
      const sep = tok.indexOf('://') + 3;
      const scheme = tok.slice(0, sep);
      let rest = tok.slice(sep);
      let out = scheme;
      const at = rest.lastIndexOf('@');
      if (at >= 0) {
        const userinfo = rest.slice(0, at);
        out += replaced(KIND_CREDENTIAL, userinfo) + '@';
        rest = rest.slice(at + 1);
        if (/[?#]/.test(userinfo)) return out + replaced(KIND_URL_QUERY, rest);
      }
      const cut = rest.search(/[?#]/);
      if (cut >= 0) return out + rest.slice(0, cut) + replaced(KIND_URL_QUERY, rest.slice(cut));
      return out + rest;
    });
  }

  private exactTokens(s: string): string {
    for (const t of this.tokenList) {
      if (s.includes(t)) s = s.split(t).join(replaced(KIND_TOKEN, ''));
    }
    return s;
  }

  private credentials(input: string): string {
    let s = input.replace(pemBlockRe, (m: string) => replaced(KIND_CREDENTIAL, m));
    s = replaceGroup2(apiKeyRe, s, valueLooksReal);
    s = replaceGroup2(bearerRe, s, valueLooksReal);
    // The detectors are line-oriented; keep the line breaks exactly.
    return s
      .split('\n')
      .map((line) => {
        const spans = credentialSpans(line);
        if (spans.length === 0) return line;
        let b = '';
        let prev = 0;
        for (const sp of spans) {
          b += line.slice(prev, sp.start) + replaced(KIND_CREDENTIAL, line.slice(sp.start, sp.end));
          prev = sp.end;
        }
        return b + line.slice(prev);
      })
      .join('\n');
  }

  private homeDir(input: string): string {
    const home = this.home;
    if (!home || !input.includes(home)) return input;
    let s = input;
    let b = '';
    for (;;) {
      const i = s.indexOf(home);
      if (i < 0) break;
      const end = i + home.length;
      if (continuesPathSegment(s.slice(end))) {
        b += s.slice(0, end);
        s = s.slice(end);
        continue;
      }
      b += s.slice(0, i) + replaced(KIND_HOME_PATH, '');
      s = s.slice(end);
    }
    return b + s;
  }

  private userPaths(input: string): string {
    let s = input.replace(unixUserRe, (_m: string, g1: string) => g1 + replaced(KIND_USER_PATH, ''));
    s = s.replace(
      windowsUserRe,
      (_m: string, g1: string, g2: string | undefined) => g1 + replaced(KIND_USER_PATH, '') + (g2 ?? '')
    );
    return s;
  }
}

function utf8Len(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}
