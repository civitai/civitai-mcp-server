import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  KIND_CREDENTIAL,
  KIND_EMAIL,
  KIND_HOME_PATH,
  KIND_ORDER,
  KIND_TOKEN,
  KIND_URL_QUERY,
  KIND_USER_PATH,
  MIN_TOKEN_LEN,
  Redactor,
  type RedactionCount,
  type RedactionKind,
} from '../src/lib/redact.js';
import { credentialSpans } from '../src/lib/credscan.js';

/**
 * The Civitai CLI's redaction vectors, ported row for row from civitai/cli
 * `internal/redact/redact_test.go`, `redact_audit_test.go`,
 * `redact_lists_test.go`, `redact_property_test.go` and
 * `internal/credscan/spans_test.go`. The fixtures are the CLI's own: invented,
 * shaped like the real thing, and pairwise distinct, so a rule firing for the
 * wrong row cannot satisfy this one. Where a row's expectation differs from the
 * CLI's, it says so — none currently does.
 */

const testHome = '/home/mkestrel';
const testToken = 'c1v1tai4f6b8d0a2c4e6f8091a2b3c4d5';
const testEnvToken = '9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b';

const newTestRedactor = () => new Redactor({ home: testHome, tokens: [testToken, testEnvToken] });

interface RedactionRow {
  name: string;
  in: string;
  secret: string;
  wantOut: string;
  kind: RedactionKind;
  wantCount: number;
}

const redactionRows: RedactionRow[] = [
  // --- token: exact match
  { name: 'the configured token, bare, in a sentence', in: `login printed ${testToken} and then hung`, secret: testToken, wantOut: 'login printed <token> and then hung', kind: KIND_TOKEN, wantCount: 1 },
  { name: 'the CIVITAI_TOKEN value, twice', in: `tried ${testEnvToken} then again ${testEnvToken}`, secret: testEnvToken, wantOut: 'tried <token> then again <token>', kind: KIND_TOKEN, wantCount: 2 },
  { name: 'the configured token after a bare Bearer', in: `sent Bearer ${testToken} and got 403`, secret: testToken, wantOut: 'sent Bearer <token> and got 403', kind: KIND_TOKEN, wantCount: 1 },
  // --- credential
  { name: 'a GitHub token', in: 'git push said bad credentials for ghp_4Hn8Wq2Zr6Tb0Vx3Ly7Kc1Md5Pf9Sg2Uj6Ea', secret: 'ghp_4Hn8Wq2Zr6Tb0Vx3Ly7Kc1Md5Pf9Sg2Uj6Ea', wantOut: 'git push said bad credentials for <credential>', kind: KIND_CREDENTIAL, wantCount: 1 },
  { name: 'an npm token', in: 'npm ERR! 401 with npm_7Rt2Yq9Lm4Zx8Bv1Nc6Kd3Wf0Hs5Pg2Tj8Ua', secret: 'npm_7Rt2Yq9Lm4Zx8Bv1Nc6Kd3Wf0Hs5Pg2Tj8Ua', wantOut: 'npm ERR! 401 with <credential>', kind: KIND_CREDENTIAL, wantCount: 1 },
  { name: 'a JWT', in: 'dev token was eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiI4MTkzMDIiLCJhdWQiOiJibG9jayJ9.Zk4Tn8Wq1Xc7Lb3Rv9Hy2Md6Pf0Sg5Uj', secret: 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiI4MTkzMDIiLCJhdWQiOiJibG9jayJ9.Zk4Tn8Wq1Xc7Lb3Rv9Hy2Md6Pf0Sg5Uj', wantOut: 'dev token was <credential>', kind: KIND_CREDENTIAL, wantCount: 1 },
  { name: 'an AWS access key id', in: 'upload failed: InvalidAccessKeyId AKIA5RT8WQ2ZLMNB7VCX', secret: 'AKIA5RT8WQ2ZLMNB7VCX', wantOut: 'upload failed: InvalidAccessKeyId <credential>', kind: KIND_CREDENTIAL, wantCount: 1 },
  { name: 'a connection string with an embedded password', in: 'connect ECONNREFUSED mysql://svc_blocks:Tq7Zw3Lp9Rc5@db-7.prod-internal.net:3306/blocks', secret: 'svc_blocks:Tq7Zw3Lp9Rc5', wantOut: 'connect ECONNREFUSED mysql://<credential>@db-7.prod-internal.net:3306/blocks', kind: KIND_CREDENTIAL, wantCount: 1 },
  { name: 'a strict KEY=value assignment', in: "ran with BUZZ_API_SECRET=Hq3Zt8Wm2Lx7Rb5Vn9Kc and it 500'd", secret: 'Hq3Zt8Wm2Lx7Rb5Vn9Kc', wantOut: "ran with BUZZ_API_SECRET=<credential> and it 500'd", kind: KIND_CREDENTIAL, wantCount: 1 },
  { name: 'a quoted JSON credential value', in: 'config was {"clientSecret": "Pd6Yk1Vr8Nq4Wz2Lb7Tc0Hs"}', secret: 'Pd6Yk1Vr8Nq4Wz2Lb7Tc0Hs', wantOut: 'config was {"clientSecret": "<credential>"}', kind: KIND_CREDENTIAL, wantCount: 1 },
  { name: "an authorization header carrying some other service's credential", in: '< authorization: bearer 8f2c61d09ab347e5b1c0d4f6a7e89321', secret: '8f2c61d09ab347e5b1c0d4f6a7e89321', wantOut: '< authorization: <credential>', kind: KIND_CREDENTIAL, wantCount: 1 },
  {
    name: 'a whole PEM private-key block, not just its header',
    in:
      'ssh said:\n-----BEGIN OPENSSH PRIVATE KEY-----\n' +
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz\n' +
      'c2gtZWQyNTUxOQAAACD3Qm7Zk1Lx9Rv4Tn8Wq2Yc6Hb0Md5Pf3Sg7Uj1KaAAAA\n' +
      '-----END OPENSSH PRIVATE KEY-----\nthen exited',
    secret: 'c2gtZWQyNTUxOQAAACD3Qm7Zk1Lx9Rv4Tn8Wq2Yc6Hb0Md5Pf3Sg7Uj1KaAAAA',
    wantOut: 'ssh said:\n<credential>\nthen exited',
    kind: KIND_CREDENTIAL,
    wantCount: 1,
  },
  {
    name: 'a PEM block cut off before its END line',
    in: '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIJ4Xt9Wq2Lm7Zk3Rv8Nc1Hb6Yd0Pf5Sg9Uj2Ka4Te7oAoGCCqGSM49',
    secret: 'MHcCAQEEIJ4Xt9Wq2Lm7Zk3Rv8Nc1Hb6Yd0Pf5Sg9Uj2Ka4Te7oAoGCCqGSM49',
    wantOut: '<credential>',
    kind: KIND_CREDENTIAL,
    wantCount: 1,
  },
  // --- email
  { name: 'an e-mail address', in: 'the review mail went to priya.raman@northwind-labs.io instead', secret: 'priya.raman@northwind-labs.io', wantOut: 'the review mail went to <email> instead', kind: KIND_EMAIL, wantCount: 1 },
  { name: 'a plus-addressed e-mail in a git author line', in: 'Author: Dana Okafor <d.okafor+cli@fieldstone.dev>', secret: 'd.okafor+cli@fieldstone.dev', wantOut: 'Author: Dana Okafor <<email>>', kind: KIND_EMAIL, wantCount: 1 },
  // --- url-query
  { name: "a presigned URL's query string", in: 'GET https://blobs.civitai.com/dl/8841.safetensors?X-Amz-Signature=6b1f0c9d2e7a4835&X-Amz-Expires=900 returned 403', secret: '6b1f0c9d2e7a4835', wantOut: 'GET https://blobs.civitai.com/dl/8841.safetensors returned 403', kind: KIND_URL_QUERY, wantCount: 1 },
  { name: 'a query string and the fragment after it are both dropped', in: 'see https://developer.civitai.com/apps/guide?ref=ck_41d7e2#scopes', secret: 'ck_41d7e2', wantOut: 'see https://developer.civitai.com/apps/guide', kind: KIND_URL_QUERY, wantCount: 1 },
  // --- home-path
  { name: "this machine's home directory, as a path prefix", in: `ENOENT: ${testHome}/work/my-app/block.manifest.json`, secret: 'mkestrel', wantOut: 'ENOENT: ~/work/my-app/block.manifest.json', kind: KIND_HOME_PATH, wantCount: 1 },
  { name: 'the home directory at the very end of the text', in: `cwd was ${testHome}`, secret: 'mkestrel', wantOut: 'cwd was ~', kind: KIND_HOME_PATH, wantCount: 1 },
  // --- user-path
  { name: "another Linux user's home", in: 'cache at /home/tvasquez/.npm/_logs/2026-10-11.log', secret: 'tvasquez', wantOut: 'cache at /home/<user>/.npm/_logs/2026-10-11.log', kind: KIND_USER_PATH, wantCount: 1 },
  { name: 'a macOS home', in: 'Error: EACCES /Users/lindqvist/Library/pnpm/store', secret: 'lindqvist', wantOut: 'Error: EACCES /Users/<user>/Library/pnpm/store', kind: KIND_USER_PATH, wantCount: 1 },
  { name: 'a Windows home', in: 'cannot find C:\\Users\\hbrandt\\AppData\\Roaming\\civitai\\config.yaml', secret: 'hbrandt', wantOut: 'cannot find C:\\Users\\<user>\\AppData\\Roaming\\civitai\\config.yaml', kind: KIND_USER_PATH, wantCount: 1 },
  { name: 'a Windows home with JSON-doubled backslashes', in: '"path":"D:\\\\Users\\\\oyelaran\\\\src\\\\app"', secret: 'oyelaran', wantOut: '"path":"D:\\\\Users\\\\<user>\\\\src\\\\app"', kind: KIND_USER_PATH, wantCount: 1 },
  { name: "a user whose name extends the home directory's", in: 'owned by /home/mkestrel2/app', secret: 'mkestrel2', wantOut: 'owned by /home/<user>/app', kind: KIND_USER_PATH, wantCount: 1 },
];

function expectCounts(got: RedactionCount[], want: Array<[RedactionKind, number]>) {
  expect(got).toEqual(want.map(([kind, count]) => ({ kind, count })));
}

describe('redaction rules (ported CLI vectors)', () => {
  it('fixtures have pairwise-distinct secrets', () => {
    const seen = new Map<string, string>();
    for (const row of redactionRows) {
      if (row.secret === testToken || row.secret === testEnvToken || row.kind === KIND_HOME_PATH) continue;
      expect(seen.get(row.secret), `rows share the secret ${row.secret}`).toBeUndefined();
      seen.set(row.secret, row.name);
    }
  });

  for (const row of redactionRows) {
    it(`removes its secret: ${row.name}`, () => {
      expect(row.in).toContain(row.secret);
      const r = newTestRedactor();
      const got = r.apply(row.in);
      expect(got).not.toContain(row.secret);
      expect(got).toBe(row.wantOut);
      expectCounts(r.countsList(), [[row.kind, row.wantCount]]);
    });
  }

  it('every kind has a positive control', () => {
    const kinds = new Set(redactionRows.map((r) => r.kind));
    for (const k of KIND_ORDER) expect(kinds.has(k), `no row exercises ${k}`).toBe(true);
  });

  it('leaves ordinary text alone', () => {
    for (const s of [
      'app submit exits 1 with no message when the bundle has no index.html',
      'Bearer authentication is required, but the docs never say which scope',
      '@civitai/app-sdk@0.69.0 has no typed helper for the buzz balance call',
      'ssh: connect to host tunnel port 22: user@host is how the docs spell it',
      'see https://developer.civitai.com/apps/guide for the page I mean',
      'the token field is empty: token="" in the generated config',
      'exit code 3 from `civitai app status my-app --json`',
      '~/work/my-app is where I ran it',
    ]) {
      const r = newTestRedactor();
      expect(r.apply(s)).toBe(s);
      expect(r.countsList()).toEqual([]);
    }
  });

  it('accumulates counts across fields, in rule order', () => {
    const r = newTestRedactor();
    r.apply(`from ${testHome}/a and ${testHome}/b`);
    r.apply(`mail rosalind.achterberg@quietharbor.org about ${testToken}`);
    r.apply('also /Users/nwosu/x');
    expectCounts(r.countsList(), [[KIND_TOKEN, 1], [KIND_EMAIL, 1], [KIND_HOME_PATH, 2], [KIND_USER_PATH, 1]]);
  });

  it('skips and reports a token shorter than the floor; matches one at the floor', () => {
    const r = new Redactor({ tokens: ['ab12', testToken] });
    expect(r.skippedShortTokens()).toBe(1);
    const got = r.apply(`cab12 is a taxi; the long one is ${testToken}`);
    expect(got).toContain('cab12');
    expect(got).not.toContain(testToken);
    const edge = 'Zq7Lm2Xv';
    expect(edge.length).toBe(MIN_TOKEN_LEN);
    const r2 = new Redactor({ tokens: [edge] });
    expect(r2.apply(`x ${edge} y`)).toBe('x <token> y');
    expect(r2.skippedShortTokens()).toBe(0);
  });

  it('a home of root or empty disables the home rule', () => {
    for (const home of ['', '/', '\\']) {
      const r = new Redactor({ home });
      const s = '/etc/hosts and /var/log/syslog';
      expect(r.apply(s)).toBe(s);
    }
  });

  it('removes a longer token whole when it contains a shorter one', () => {
    const short = 'Wq8Zt3Lm6Xr1';
    const long = `${short}Bv5Nc9Kd2Hf7`;
    expect(new Redactor({ tokens: [short, long] }).apply(`value ${long} end`)).toBe('value <token> end');
  });

  it('a bare mention of a key header does not eat the sentence', () => {
    expect(
      newTestRedactor().apply('the BEGIN RSA PRIVATE KEY line is missing from the docs example, and step 4 then fails')
    ).toBe('the <credential> line is missing from the docs example, and step 4 then fails');
  });
});

// --- KNOWN MISSES / KNOWN OVER-REDACTIONS (redact_lists_test.go) -------------

interface KnownCase {
  tokens?: string[];
  in: string;
  want?: string;
  survives?: string;
}
interface KnownEntry {
  doc: string;
  cases: KnownCase[];
}

const b64Token = Buffer.from(testToken).toString('base64');

const knownMisses: KnownEntry[] = [
  { doc: 'a bare `Bearer <value>` with no `Authorization` header in front of it, when the value has no digit', cases: [{ in: 'sent Bearer QwErTyUiOpAsDfGhJkLzXcVbNm to it' }] },
  { doc: 'an `x-api-key` / `api-key` value that has no digit', cases: [{ in: 'x-api-key: QwErTyUiOpAsDfGhJk' }] },
  { doc: 'the query or fragment of a URL written without a scheme (`cdn.example/f?sig=…`)', cases: [{ in: 'curl cdn.fieldstone.dev/f.bin?sig=Yt6Ru8Ei0Ow2Pq4La' }] },
  {
    doc: 'a credential that appears transformed: URL-encoded, base64 of itself, or split across lines',
    cases: [
      { tokens: ['Kd4+Rb6/Zq7=Lm2Xv9'], in: 'value Kd4%2BRb6%2FZq7%3DLm2Xv9 was rejected' },
      { in: `value ${b64Token} was rejected` },
      { in: `value ${testToken.slice(0, 16)}\n${testToken.slice(16)} was rejected` },
    ],
  },
  { doc: 'a configured credential shorter than 8 characters (stderr says when one was skipped)', cases: [{ tokens: ['ab12cd3'], in: 'the key ab12cd3 failed' }] },
  {
    doc: 'a URL query that contains a literal space: the URL token ends at the space, so `?q=hello world&sig=…` keeps `world&sig=…`',
    cases: [
      {
        in: 'GET https://h.fieldstone.dev/s?q=hello world&sig=Gh5Jk7Lm9Np1Qr3St failed',
        want: 'GET https://h.fieldstone.dev/s world&sig=Gh5Jk7Lm9Np1Qr3St failed',
        survives: 'sig=Gh5Jk7Lm9Np1Qr3St',
      },
    ],
  },
  { doc: 'a JSON-escaped URL (`https:\\/\\/…?sig=…`): it is not recognised as a URL, so its query is kept', cases: [{ in: '{"url":"https:\\/\\/cdn.fieldstone.dev\\/f.bin?sig=Uv2Wx4Yz6Ab8Cd0Ef"}' }] },
];

const knownOverRedactions: KnownEntry[] = [
  {
    doc: 'everything after `Authorization:` to the end of that line, whatever it is — prose included, and anything else that shares the line',
    cases: [
      { in: 'Authorization: Bearer credentials missing', want: 'Authorization: <credential>' },
      { in: 'curl -H "Authorization: Basic xyz" https://api.fieldstone.dev/v1', want: 'curl -H "Authorization: <credential>' },
    ],
  },
  {
    doc: 'the line after an `Authorization` header whose own line holds no value — the value is looked for across line breaks',
    cases: [{ in: 'Authorization:\nHost: api.fieldstone.dev\nAccept: */*', want: 'Authorization:\n<credential>\nAccept: */*' }],
  },
  { doc: 'an `api-key` / `apiKey` assignment whose value has a digit, even when the value is a variable name', cases: [{ in: 'const apiKey = options.apiKey2', want: 'const apiKey = <credential>' }] },
  { doc: 'any URL userinfo, even a bare user name (`ssh://git@host/…` is counted as a credential)', cases: [{ in: 'clone ssh://git@github.com/civitai/cli.git', want: 'clone ssh://<credential>@github.com/civitai/cli.git' }] },
  {
    doc: 'everything between `://` and the last `@` of a URL token — so an `@` in a path or query takes the host with it — and, when a `?` or `#` came before that `@`, the rest of the token too',
    cases: [
      { in: 'see https://h.fieldstone.dev/users/@ingrid/posts', want: 'see https://<credential>@ingrid/posts' },
      { in: 'GET https://h.fieldstone.dev/p?notify=ops@fieldstone.dev&x=1', want: 'GET https://<credential>@' },
    ],
  },
  {
    doc: "a URL's `#fragment`, and whatever is glued to a URL after its first `?` or `#` with no white space: closing quotes, brackets, a trailing full stop, the rest of a minified JSON line",
    cases: [
      { in: '(see https://developer.civitai.com/apps/guide#scopes).', want: '(see https://developer.civitai.com/apps/guide' },
      { in: '{"url":"https://h.fieldstone.dev/p?a=1","retries":3}', want: '{"url":"https://h.fieldstone.dev/p' },
    ],
  },
  { doc: 'a Windows user segment runs to the next backslash on the line, so `copy C:\\Users\\ingrid .\\dist\\out` loses `ingrid .`', cases: [{ in: 'copy C:\\Users\\ingrid .\\dist\\out', want: 'copy C:\\Users\\<user>\\dist\\out' }] },
  { doc: '`/home/<name>` and `/Users/<name>` wherever they appear, including inside a URL path', cases: [{ in: 'docs at https://docs.fieldstone.dev/home/welcome/intro', want: 'docs at https://docs.fieldstone.dev/home/<user>/intro' }] },
  { doc: 'the words of a private-key header (`BEGIN … PRIVATE KEY`) in prose', cases: [{ in: 'the BEGIN RSA PRIVATE KEY line is missing', want: 'the <credential> line is missing' }] },
];

const redactorFor = (c: KnownCase) =>
  c.tokens ? new Redactor({ home: testHome, tokens: c.tokens }) : newTestRedactor();

describe('KNOWN MISSES and KNOWN OVER-REDACTIONS (ported CLI lists)', () => {
  it('every known miss is still a miss', () => {
    for (const e of knownMisses) {
      expect(e.cases.length, e.doc).toBeGreaterThan(0);
      for (const c of e.cases) {
        const r = redactorFor(c);
        const got = r.apply(c.in);
        const want = c.want ?? c.in;
        expect(got, e.doc).toBe(want);
        if (c.survives) expect(got, e.doc).toContain(c.survives);
        if (want === c.in) expect(r.countsList(), e.doc).toEqual([]);
      }
    }
    expect(new Redactor({ tokens: ['ab12cd3'] }).skippedShortTokens()).toBe(1);
  });

  it('every known over-redaction still happens, with the exact text left', () => {
    for (const e of knownOverRedactions) {
      expect(e.cases.length, e.doc).toBeGreaterThan(0);
      for (const c of e.cases) {
        const got = redactorFor(c).apply(c.in);
        expect(got, e.doc).not.toBe(c.in);
        expect(got, e.doc).toBe(c.want);
      }
    }
  });

  it("the lists in redact.ts's doc comment are exactly these entries", () => {
    const src = readFileSync(new URL('../src/lib/redact.ts', import.meta.url), 'utf8');
    const section = (from: string, to: string) => {
      const i = src.indexOf(from);
      expect(i, `no ${from} heading`).toBeGreaterThanOrEqual(0);
      const rest = src.slice(i + from.length);
      const j = rest.indexOf(to);
      expect(j, `nothing matching ${to} follows ${from}`).toBeGreaterThanOrEqual(0);
      const raw = rest.slice(0, j);
      const bullets = (raw.match(/^\s*\*\s+- /gm) ?? []).length;
      const text = raw.replace(/^\s*\*/gm, '').replace(/\s+/g, ' ').trim();
      return { text, bullets };
    };
    for (const [list, from, to] of [
      [knownMisses, 'KNOWN MISSES —', 'KNOWN OVER-REDACTIONS —'],
      [knownOverRedactions, 'KNOWN OVER-REDACTIONS —', '(In this server'],
    ] as const) {
      const { text, bullets } = section(from, to);
      for (const e of list) expect(text, `missing: ${e.doc}`).toContain(e.doc.replace(/\s+/g, ' '));
      expect(bullets).toBe(list.length);
    }
  });
});

// --- audit-round findings (redact_audit_test.go) ------------------------------

describe('URL tokens lose their userinfo and everything from the first ? or #', () => {
  const cases: Array<{ name: string; in: string; leaks: string[]; wantOut: string; want: Array<[RedactionKind, number]> }> = [
    { name: 'the configured token is one of several query parameters', in: `GET https://civitai.com/api/v1/models/1?token=${testToken}&sig=Zx9Kq2Lm7Rv4Tn8Wc1 failed`, leaks: [testToken, 'Zx9Kq2Lm7Rv4Tn8Wc1', 'sig='], wantOut: 'GET https://civitai.com/api/v1/models/1 failed', want: [[KIND_URL_QUERY, 1]] },
    { name: 'an e-mail address is one of several query parameters', in: 'open https://app.northwind-labs.io/reset?email=bo.tanaka@corp-mail.io&session=Hd5Yq8Lw2Zr6Tb0Vx3 now', leaks: ['bo.tanaka', 'corp-mail.io', 'Hd5Yq8Lw2Zr6Tb0Vx3', 'session='], wantOut: 'open https://<credential>@ now', want: [[KIND_CREDENTIAL, 1], [KIND_URL_QUERY, 1]] },
    { name: 'a URL with userinfo AND a query', in: 'fetch https://deploy:Pw7Zk3Lq9Rc5Xm@registry.fieldstone.dev/v2/pkg?x=1&y=Nb4Vc8Xz2Lk6Jh0Gf5 timed out', leaks: ['Pw7Zk3Lq9Rc5Xm', 'Nb4Vc8Xz2Lk6Jh0Gf5', 'deploy:', 'x=1'], wantOut: 'fetch https://<credential>@registry.fieldstone.dev/v2/pkg timed out', want: [[KIND_CREDENTIAL, 1], [KIND_URL_QUERY, 1]] },
    { name: "the user's own angle bracket inside a query does not end the strip", in: 'see https://docs.quietharbor.org/p?id=<id>&key=Tg6Yh2Uj8Ik4Ol0Pq9 for it', leaks: ['Tg6Yh2Uj8Ik4Ol0Pq9', 'key='], wantOut: 'see https://docs.quietharbor.org/p for it', want: [[KIND_URL_QUERY, 1]] },
    { name: 'two URLs are two redactions', in: 'a https://one.saltmarsh.studio/x?p=Qa1Ws2Ed3Rf4 b https://two.saltmarsh.studio/y?q=Zx5Cv6Bn7Mm8#frag', leaks: ['Qa1Ws2Ed3Rf4', 'Zx5Cv6Bn7Mm8', 'frag'], wantOut: 'a https://one.saltmarsh.studio/x b https://two.saltmarsh.studio/y', want: [[KIND_URL_QUERY, 2]] },
    { name: 'a single quote inside the query', in: "fetch https://h.harborlight.dev/p?name='x'&sig=Rk3Vt9Wm2Xq7Zb5Lc1 failed", leaks: ['Rk3Vt9Wm2Xq7Zb5Lc1', 'sig=', "'x'"], wantOut: 'fetch https://h.harborlight.dev/p failed', want: [[KIND_URL_QUERY, 1]] },
    { name: 'a double quote inside the query', in: 'fetch https://h.harborlight.dev/q?name="y"&sig=Jn6Bh2Gy8Tf4Rd0Es3 failed', leaks: ['Jn6Bh2Gy8Tf4Rd0Es3', 'sig='], wantOut: 'fetch https://h.harborlight.dev/q failed', want: [[KIND_URL_QUERY, 1]] },
    { name: 'a backtick inside the query', in: 'fetch https://h.harborlight.dev/r?name=`z`&sig=Pl9Ok8Ij7Uh6Yg5Tf4 failed', leaks: ['Pl9Ok8Ij7Uh6Yg5Tf4', 'sig='], wantOut: 'fetch https://h.harborlight.dev/r failed', want: [[KIND_URL_QUERY, 1]] },
    { name: 'a secret in the fragment', in: 'redirected to https://app.harborlight.dev/cb#access_token=Mz4Nx8Bc2Vd6Fg0Hj5 then closed', leaks: ['Mz4Nx8Bc2Vd6Fg0Hj5', 'access_token'], wantOut: 'redirected to https://app.harborlight.dev/cb then closed', want: [[KIND_URL_QUERY, 1]] },
    { name: 'an @ inside the password', in: 'dial postgres://svc_tides:p@ssw0rdQv7Lm3@db.harborlight.dev:5432/tides refused', leaks: ['ssw0rdQv7Lm3', 'svc_tides'], wantOut: 'dial postgres://<credential>@db.harborlight.dev:5432/tides refused', want: [[KIND_CREDENTIAL, 1]] },
    { name: 'a ? inside the password', in: 'dial postgres://deploy:Xk9?mQ2vLp7wHs4@db2.harborlight.dev:5432/app refused', leaks: ['Xk9', 'mQ2vLp7wHs4', 'deploy'], wantOut: 'dial postgres://<credential>@ refused', want: [[KIND_CREDENTIAL, 1], [KIND_URL_QUERY, 1]] },
    { name: 'a / and a # inside the password', in: 'dial redis://cache:Aa1/Bb2#Cc3Dd4Ee5@cache.harborlight.dev:6379/0 refused', leaks: ['Aa1', 'Bb2', 'Cc3Dd4Ee5'], wantOut: 'dial redis://<credential>@ refused', want: [[KIND_CREDENTIAL, 1], [KIND_URL_QUERY, 1]] },
    { name: 'an @ after the ? keeps nothing that followed it', in: 'GET https://api.harborlight.dev/v1/n?cc=@Ty5Ru3Ei1Ow9Pq7La done', leaks: ['Ty5Ru3Ei1Ow9Pq7La', 'cc='], wantOut: 'GET https://<credential>@ done', want: [[KIND_CREDENTIAL, 1], [KIND_URL_QUERY, 1]] },
  ];
  for (const tc of cases) {
    it(tc.name, () => {
      const r = newTestRedactor();
      const got = r.apply(tc.in);
      for (const leak of tc.leaks) {
        expect(tc.in).toContain(leak);
        expect(got).not.toContain(leak);
      }
      expect(got).toBe(tc.wantOut);
      expectCounts(r.countsList(), tc.want);
    });
  }
});

describe('a Windows user name can contain a space', () => {
  for (const [name, input, leak, want] of [
    ['doubled backslashes', '"cwd":"C:\\\\Users\\\\Ingrid Solberg\\\\src\\\\app"', 'Solberg', '"cwd":"C:\\\\Users\\\\<user>\\\\src\\\\app"'],
    ['single backslashes', 'cannot open C:\\Users\\Tomas Achterberg\\AppData\\x.log', 'Achterberg', 'cannot open C:\\Users\\<user>\\AppData\\x.log'],
    ['the control: a one-word name still ends at whitespace', 'in C:\\Users\\wkowalczyk and elsewhere', 'wkowalczyk', 'in C:\\Users\\<user> and elsewhere'],
  ] as const) {
    it(name, () => {
      const r = newTestRedactor();
      const got = r.apply(input);
      expect(got).not.toContain(leak);
      expect(got).toBe(want);
      expectCounts(r.countsList(), [[KIND_USER_PATH, 1]]);
    });
  }
});

describe('header-borne credentials', () => {
  const cases: Array<[string, string, string, string]> = [
    ['Authorization: Basic', '> Authorization: Basic ZGVwbG95OnN3b3JkZmlzaGJsdWU=', 'ZGVwbG95OnN3b3JkZmlzaGJsdWU=', '> Authorization: <credential>'],
    ['Authorization: Bearer with no digit in the value', 'authorization: Bearer QwErTyUiOpAsDfGhJkLzXcVbNm', 'QwErTyUiOpAsDfGhJkLzXcVbNm', 'authorization: <credential>'],
    ['a JSON headers object', '{"Authorization":"Token k8Hs3Lq9Zx2Vb7Nm"}', 'k8Hs3Lq9Zx2Vb7Nm', '{"Authorization":<credential>'],
    ['Authorization: Digest, every parameter', 'Authorization: Digest username="Mufasa", realm="api@harborlight.dev", nonce="dcd98b7102dd2f0e8b11d0f6", response="6629fae49393a05397450978507c4ef1"', '6629fae49393a05397450978507c4ef1', 'Authorization: <credential>'],
    ['an unknown Authorization scheme', 'Authorization: AWS4-HMAC-SHA256 Credential=AKIDharbor/20261014, Signature=fe5f80f77d5fa3beca038a248ff027d0', 'fe5f80f77d5fa3beca038a248ff027d0', 'Authorization: <credential>'],
    ['only that line: the next one is kept', 'Authorization: Bearer Hy6Tg5Rf4Ed3Ws2Qa1\nHost: api.harborlight.dev', 'Hy6Tg5Rf4Ed3Ws2Qa1', 'Authorization: <credential>\nHost: api.harborlight.dev'],
    ['the value on the next line, JSON-quoted, LF', '  "Authorization":\n    "Basic dXNlcjpwYXNzd29yZA==",\n  "Accept": "*/*"', 'dXNlcjpwYXNzd29yZA==', '  "Authorization":\n    <credential>\n  "Accept": "*/*"'],
    ['the value on the next line, JSON-quoted, CRLF', '  "Authorization":\r\n    "Basic c3ZjOnRpZGVwb29sczEyMw==",\r\n  "Accept": "*/*"', 'c3ZjOnRpZGVwb29sczEyMw==', '  "Authorization":\r\n    <credential>\r\n  "Accept": "*/*"'],
    ['the value on the next line, bare, no digit in it', 'Authorization:\n  Bearer ZxCvBnMaSdFgHjKlQwErTyUi\nHost: api.harborlight.dev', 'ZxCvBnMaSdFgHjKlQwErTyUi', 'Authorization:\n  <credential>\nHost: api.harborlight.dev'],
    ['the value on the next line, bare, CRLF', 'Authorization:\r\n\tBearer Lk8Jh7Gf6Ds5Aq4Pw3Oe2\r\nHost: api.harborlight.dev', 'Lk8Jh7Gf6Ds5Aq4Pw3Oe2', 'Authorization:\r\n\t<credential>\r\nHost: api.harborlight.dev'],
    ['the value after a blank line', 'Authorization =\n\n  Token Mn2Bv3Cx4Zl5Kj6Hg7\ndone', 'Mn2Bv3Cx4Zl5Kj6Hg7', 'Authorization =\n\n  <credential>\ndone'],
    ['x-api-key header', '< x-api-key: f3a91c07d2b84e65a0c9', 'f3a91c07d2b84e65a0c9', '< x-api-key: <credential>'],
    ['api-key in a form body', 'body was api-key=7d1e4b9a2c6f8035e1d7 and nothing else', '7d1e4b9a2c6f8035e1d7', 'body was api-key=<credential> and nothing else'],
  ];
  it('fixtures are distinct', () => {
    expect(new Set(cases.map((c) => c[2])).size).toBe(cases.length);
  });
  for (const [name, input, secret, want] of cases) {
    it(name, () => {
      const r = newTestRedactor();
      const got = r.apply(input);
      expect(got).not.toContain(secret);
      expect(got).toBe(want);
      expectCounts(r.countsList(), [[KIND_CREDENTIAL, 1]]);
    });
  }
  it('leaves header words in prose alone', () => {
    for (const s of [
      'the x-api-key header is required but the docs never say so',
      'api-key: required',
      'Authorization is checked before the scope',
      'Authorization\n=====\nSome text',
      'needs authorization\n\n: definition text',
    ]) {
      const r = newTestRedactor();
      expect(r.apply(s)).toBe(s);
      expect(r.countsList()).toEqual([]);
    }
  });
});

describe('applyClipped counts only what survives the cut', () => {
  it('cuts the redacted text and counts what is kept', () => {
    const head = `${testHome}/a ${testHome}/b ${testHome}/c\n`;
    const tail = `mail audit-log@quietharbor.org about ${testHome}/z\n`.repeat(300);
    const r = newTestRedactor();
    const { text, clipped } = r.applyClipped(head + tail, 40);
    expect(clipped).toBe(true);
    expect(text).toBe('~/a ~/b ~/c\nmail <email> about ~/z\nmail');
    expectCounts(r.countsList(), [[KIND_EMAIL, 1], [KIND_HOME_PATH, 4]]);
  });
  it('backs a cut inside a placeholder up to its start', () => {
    const r = newTestRedactor();
    expect(r.applyClipped(`ab ${testToken} cd`, 6)).toEqual({ text: 'ab', clipped: true });
    expect(r.countsList()).toEqual([]);
  });
  it('control: with room for everything nothing is cut', () => {
    const r = newTestRedactor();
    expect(r.applyClipped(`ab ${testToken} cd`, 500)).toEqual({ text: 'ab <token> cd', clipped: false });
    expectCounts(r.countsList(), [[KIND_TOKEN, 1]]);
  });
});

it('a non-breaking space does not end a URL token or a value (RE2 \\s is ASCII; CLI parity)', () => {
  const r = newTestRedactor();
  expect(r.apply('GET https://h.fieldstone.dev/p?sig=Ab3\u00A0Cd4Ef5Gh6 done')).toBe('GET https://h.fieldstone.dev/p done');
  expectCounts(r.countsList(), [[KIND_URL_QUERY, 1]]);
});

it('internal markers never reach the output', () => {
  const r = newTestRedactor();
  const got = r.apply(`x \uFDD0\uFDD4 ${testHome}/p y`);
  expect(/[\uFDD0-\uFDEF]/.test(got)).toBe(false);
  expect(got).toBe('x  ~/p y');
  expectCounts(r.countsList(), [[KIND_HOME_PATH, 1]]);
});

// --- property: a secret inside a URL token never survives (redact_property_test.go)

/** Seeded PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

it('property: a secret inside a URL userinfo, query or fragment never survives, and is counted', () => {
  const urlPunct = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
  const urlAlnum = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const rand = rng(8302);
  const intn = (n: number) => Math.floor(rand() * n);
  const from = (alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[intn(alphabet.length)]).join('');
  const schemes = ['https', 'http', 'postgres', 'redis', 's3', 'git+ssh', 'amqp'];
  const n = 3000;
  let leaks = 0;
  let uncounted = 0;
  let outside = 0;
  const perMode: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const secret = `Zq7S3cr3t${from(urlAlnum, 10)}`;
    const pre = from(urlPunct + urlAlnum, intn(7));
    const post = from(urlPunct + urlAlnum, intn(7));
    const host = `${from('abcdefghijklmnop', 6)}.fieldstone.dev`;
    const scheme = schemes[intn(schemes.length)]!;
    const mode = ['userinfo', 'query', 'fragment'][i % 3]!;
    const wantKind = mode === 'userinfo' ? KIND_CREDENTIAL : KIND_URL_QUERY;
    const url =
      mode === 'userinfo'
        ? `${scheme}://${pre}${secret}${post}@${host}/v1/x`
        : `${scheme}://${host}/v1/x${mode === 'query' ? '?' : '#'}${pre}${secret}${post}`;
    const input = `request to ${url} failed with 500`;
    const r = new Redactor();
    const out = r.apply(input);
    perMode[mode] = (perMode[mode] ?? 0) + 1;
    if (out.includes(secret)) {
      leaks++;
      continue;
    }
    if (!r.countsList().some((c) => c.kind === wantKind && c.count > 0)) uncounted++;
    if (!out.startsWith(`request to ${scheme}://`) || !out.endsWith(' failed with 500')) outside++;
  }
  expect({ leaks, uncounted, outside }).toEqual({ leaks: 0, uncounted: 0, outside: 0 });
  for (const mode of ['userinfo', 'query', 'fragment']) expect(perMode[mode]).toBeGreaterThanOrEqual(n / 4);
});

// --- credscan spans (spans_test.go) -------------------------------------------

describe('credentialSpans', () => {
  const cases: Array<[string, string, string[]]> = [
    ['a known format mid-sentence', 'push failed for ghp_2Xc8Vb4Nm6Lk0Jh3Gf7Ds1Ap5Qw9Er2Ty6Ui today', ['ghp_2Xc8Vb4Nm6Lk0Jh3Gf7Ds1Ap5Qw9Er2Ty6Ui']],
    ['an unquoted assignment value', 'SERVICE_TOKEN=Jk4Wq9Zx2Lm7Rb5Tn8Vc and more', ['Jk4Wq9Zx2Lm7Rb5Tn8Vc']],
    ['a quoted assignment value keeps its quotes outside the span', '{"apiSecret": "Yh6Tg3Rf9Ed2Ws5Qa8Zx1Cv"}', ['Yh6Tg3Rf9Ed2Ws5Qa8Zx1Cv']],
    ['two credentials on one line are both located', 'A=npm_3Df7Gh1Jk5Lz9Xc2Vb6Nm0Qw4Er8Ty2Ui6Op and DEPLOY_PASSWORD=Mn5Bv9Cx3Zl7Kj1Hg4Fd', ['npm_3Df7Gh1Jk5Lz9Xc2Vb6Nm0Qw4Er8Ty2Ui6Op', 'Mn5Bv9Cx3Zl7Kj1Hg4Fd']],
    ['a URL with a password spans scheme through host', 'dial redis://cache_rw:Vb7Nm2Xc9Zl4Kj@cache-3.prod-internal.net:6379/0 timed out', ['redis://cache_rw:Vb7Nm2Xc9Zl4Kj@cache-3.prod-internal.net:6379']],
    ['an assignment whose value is itself a known format is one span', 'GITHUB_TOKEN=ghp_8Qw2Er6Ty0Ui4Op7As1Df5Gh9Jk3Lz6Xc0Vb', ['ghp_8Qw2Er6Ty0Ui4Op7As1Df5Gh9Jk3Lz6Xc0Vb']],
  ];
  for (const [name, line, want] of cases) {
    it(name, () => {
      expect(credentialSpans(line).map((s) => line.slice(s.start, s.end))).toEqual(want);
    });
  }

  it('stays quiet on the shapes the CLI is deliberately quiet about', () => {
    for (const line of [
      'API_TOKEN=your-token-goes-here-123',
      'token: ${CIVITAI_TOKEN}',
      'const token = opts.credentials.token',
      'postgres://user:password@localhost:5432/mydb',
      'VITE_FIREBASE_API_KEY=AIzaSyB4Xk9Qm2Lz7Rv3Tn8Wc1Yd6Hf0Pg5Sj2U',
      'nothing here but prose about a token',
      // Low entropy (a repeated alphabet) — the entropy gate's own case.
      'SESSION_SECRET=aaaaaaaaaaaaaaaaaa1b',
      '',
    ]) {
      expect(credentialSpans(line), line).toEqual([]);
    }
  });

  it('covers a value longer than the 512-character capture bound', () => {
    let s = '';
    for (let i = 0; s.length < 700; i++) s += 'Kq9Zx2Lm7Rb5Tn8Vc4Hd6Yw1Pf3Sg0Uj'.slice(i % 7);
    const secret = s.slice(0, 700);
    for (const line of [`SESSION_SECRET=${secret} trailing words`, `{"sessionSecret": "${secret}", "other": 1}`]) {
      const spans = credentialSpans(line);
      expect(spans).toHaveLength(1);
      expect(line.slice(spans[0]!.start, spans[0]!.end)).toBe(secret);
    }
    const at = secret.slice(0, 512);
    const spans = credentialSpans(`SESSION_SECRET=${at} x`);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.end - spans[0]!.start).toBe(512);
  });
});
