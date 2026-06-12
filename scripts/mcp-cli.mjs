#!/usr/bin/env node
// @ts-check
/**
 * Civitai MCP CLI — a zero-dependency, single-file client for the Civitai MCP
 * server.
 *
 * WHY THIS EXISTS
 * ---------------
 * Some agent runtimes can load a skill but cannot edit their MCP client config
 * (no way to add an HTTP MCP server). This script lets such an agent drive the
 * hosted Civitai MCP server straight from the shell — no MCP client needed.
 *
 *   curl -fsSL https://mcp.civitai.com/cli -o mcp-cli.mjs
 *   node mcp-cli.mjs list
 *   node mcp-cli.mjs call search_models '{"query":"anime","type":"Checkpoint"}'
 *
 * HOW IT TALKS TO THE SERVER
 * --------------------------
 * The Civitai MCP server is a STATELESS Streamable HTTP endpoint
 * (`sessionIdGenerator: undefined`, `enableJsonResponse: true`). That means a
 * bare JSON-RPC `tools/list` / `tools/call` POST works on its own — no
 * `initialize` handshake, no session id. We send
 * `Accept: application/json, text/event-stream` and handle BOTH shapes the
 * server may return: a plain JSON body, or an SSE (`text/event-stream`) body
 * whose `data:` line carries the JSON-RPC envelope.
 *
 * AUTH
 * ----
 * Browse/read tools work with no key. User-action tools need one: set
 * `CIVITAI_API_KEY` in the environment and it is sent as
 * `Authorization: Bearer <key>`. Without it, auth-required tools return a clear
 * "set CIVITAI_API_KEY" error, which this CLI surfaces verbatim.
 *
 * CONFIG
 * ------
 *   MCP_URL          override the MCP endpoint (default: baked in at serve time)
 *   CIVITAI_API_KEY  bearer token for authenticated tools
 *   --url <url>      per-invocation override of the MCP endpoint
 *   --json           print the raw JSON-RPC result instead of the text blocks
 *
 * Requires Node >= 18 (uses the built-in global `fetch`).
 */

import { promises as fs } from 'node:fs';

// The server substitutes this placeholder with its own resolved /mcp endpoint
// when it serves the script at GET /cli, so a pulled copy defaults to the very
// server it came from. If the placeholder was NOT substituted (e.g. you copied
// the file out of the repo), we fall back to the canonical hosted endpoint.
const BAKED_MCP_URL = '__MCP_URL__';
const DEFAULT_MCP_URL = BAKED_MCP_URL.startsWith('http')
  ? BAKED_MCP_URL
  : 'https://mcp.civitai.com/mcp';

/**
 * Parse a Streamable HTTP response into a JSON-RPC envelope.
 *
 * Pure + exported so it can be unit-tested without a network. Handles the two
 * shapes the stateless server may emit:
 *   - `application/json`      → the body IS the JSON-RPC envelope.
 *   - `text/event-stream`     → one or more `data:` lines; we take the last
 *                                non-empty `data:` payload and JSON.parse it
 *                                (the final message carries the result).
 *
 * @param {string} contentType  the response Content-Type header (may be '')
 * @param {string} body         the raw response body text
 * @returns {any}               the parsed JSON-RPC envelope object
 */
export function parseRpcResponse(contentType, body) {
  const isEventStream = (contentType || '').toLowerCase().includes('text/event-stream');
  if (!isEventStream) {
    return JSON.parse(body);
  }
  // SSE: collect `data:` lines, join multi-line data per the SSE spec, and use
  // the last complete event's payload.
  const dataChunks = [];
  let current = null;
  for (const rawLine of body.split(/\r?\n/)) {
    if (rawLine.startsWith('data:')) {
      const piece = rawLine.slice(5).replace(/^ /, '');
      current = current === null ? piece : `${current}\n${piece}`;
    } else if (rawLine === '') {
      // blank line terminates an event
      if (current !== null) {
        dataChunks.push(current);
        current = null;
      }
    }
  }
  if (current !== null) dataChunks.push(current);
  const payload = dataChunks.filter((c) => c.trim().length > 0).pop();
  if (payload === undefined) {
    throw new Error('event-stream response contained no data: payload');
  }
  return JSON.parse(payload);
}

/** Small helper: read named flag value (e.g. --url X) out of an argv array,
 *  removing it (and its value) so positional parsing is unaffected. Returns the
 *  value or undefined. Boolean flags (no value) use `hasFlag`. */
function takeFlagValue(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, value === undefined ? 1 : 2);
  return value;
}

function hasFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

/** POST a JSON-RPC request and return the parsed envelope. Throws a clear,
 *  human-readable Error on network/HTTP failure (status + body snippet). */
async function rpc(mcpUrl, apiKey, method, params) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const requestBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

  let res;
  try {
    res = await fetch(mcpUrl, { method: 'POST', headers, body: requestBody });
  } catch (err) {
    throw new Error(
      `Network error reaching ${mcpUrl}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const text = await res.text();
  if (!res.ok) {
    const snippet = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${mcpUrl}\n${snippet}`);
  }

  let envelope;
  try {
    envelope = parseRpcResponse(res.headers.get('content-type') || '', text);
  } catch (err) {
    const snippet = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    throw new Error(
      `Could not parse server response: ${err instanceof Error ? err.message : String(err)}\n${snippet}`
    );
  }

  if (envelope && envelope.error) {
    const e = envelope.error;
    throw new Error(`Server error ${e.code ?? ''}: ${e.message ?? JSON.stringify(e)}`.trim());
  }
  return envelope;
}

/** Pull the array of tools out of a tools/list result. */
async function listTools(mcpUrl, apiKey) {
  const env = await rpc(mcpUrl, apiKey, 'tools/list', {});
  return (env.result && env.result.tools) || [];
}

/** Call a tool (tools/call) and return its result object ({ content, structuredContent, isError }).
 *  Throws a clear Error if the tool reported isError (using its text block). */
async function callTool(mcpUrl, apiKey, name, toolArgs) {
  const env = await rpc(mcpUrl, apiKey, 'tools/call', { name, arguments: toolArgs });
  const result = env.result || {};
  if (result.isError) {
    const blocks = Array.isArray(result.content) ? result.content : [];
    const text = blocks
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    throw new Error(text || `Tool ${name} reported an error`);
  }
  return result;
}

/** First text content block of a tool result (or ''). */
function firstText(result) {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const b = blocks.find((x) => x && x.type === 'text');
  return b ? b.text : '';
}

/** Map a file extension to an image MIME type for the upload content-type. */
export function contentTypeForFile(filePath) {
  const m = /\.([A-Za-z0-9]+)$/.exec(filePath);
  const ext = m ? m[1].toLowerCase() : '';
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'avif':
      return 'image/avif';
    default:
      return undefined; // let the server probe/default
  }
}

/** Derive a human-ish default post title from a filename (no dir, no extension). */
export function defaultTitleFromFile(filePath) {
  const base = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
  return base.replace(/\.[A-Za-z0-9]+$/, '') || base;
}

/**
 * One-shot: read a LOCAL image file, upload it (base64 in the JSON-RPC BODY —
 * never argv), then create a post attaching it. Returns the create_post result.
 *
 * Exported + parameterized on `rpcImpl` so tests can inject a fake transport and
 * assert the upload→create_post chaining without a network.
 *
 * @param {object} opts
 * @param {string} opts.mcpUrl
 * @param {string|undefined} opts.apiKey
 * @param {Buffer} opts.fileBytes   raw image bytes
 * @param {string} opts.fileName    original filename (for title + content-type)
 * @param {string} [opts.title]
 * @param {string} [opts.detail]
 * @param {number} [opts.nsfwLevel]
 * @param {boolean} [opts.publish]   default true
 * @param {(name: string, args: any) => Promise<any>} opts.callToolImpl
 * @returns {Promise<{post: any, uuid: string}>}
 */
export async function postImageFlow(opts) {
  const { fileBytes, fileName, title, detail, nsfwLevel, publish = true, callToolImpl } = opts;

  // 1. upload_image with base64 in the request BODY (no argv length limit).
  const uploadArgs = { data: fileBytes.toString('base64') };
  const ct = contentTypeForFile(fileName);
  if (ct) uploadArgs.contentType = ct;
  const uploadResult = await callToolImpl('upload_image', uploadArgs);

  // Prefer the reliable structuredContent.uuid; else parse the bare-UUID lead line.
  let uuid =
    uploadResult.structuredContent && uploadResult.structuredContent.uuid
      ? String(uploadResult.structuredContent.uuid)
      : '';
  if (!uuid) {
    const lead = firstText(uploadResult).split(/\r?\n/)[0].trim();
    uuid = lead;
  }
  if (!uuid) throw new Error('upload_image did not return a UUID');

  // 2. create_post attaching the uploaded image.
  const postArgs = {
    images: [{ uuid }],
    publish,
  };
  if (title) postArgs.title = title;
  if (detail) postArgs.detail = detail;
  if (nsfwLevel !== undefined) postArgs.nsfwLevel = nsfwLevel;
  const post = await callToolImpl('create_post', postArgs);
  return { post, uuid };
}

const USAGE = `Civitai MCP CLI — drive the Civitai MCP server from the shell (no MCP client needed).

Usage:
  node mcp-cli.mjs list [--json]
  node mcp-cli.mjs call <toolName> [jsonArgs] [--json]
  node mcp-cli.mjs schema <toolName>
  node mcp-cli.mjs post-image <file> [--title "..."] [--detail "..."] [--nsfw <level>] [--draft] [--json]
  node mcp-cli.mjs --help

Commands:
  list                 List available tools (name + one-line description).
  call <tool> [json]   Call a tool. jsonArgs is a JSON object of arguments,
                       e.g.  call search_models '{"query":"anime","type":"Checkpoint"}'
  schema <tool>        Print a tool's JSON input schema.
  post-image <file>    Post a LOCAL image file in one call. Reads <file> from
                       disk, uploads it (base64 in the request body — no fragile
                       remote URL, no argv length limit), then creates a post and
                       publishes it. Prints the public post URL + id.
                         e.g.  post-image step_0-0.png --title "My render"
                       Flags: --title, --detail, --nsfw <level>, --draft (leave
                       unpublished), --json (raw result). Title defaults to the
                       filename when omitted.

Options:
  --json               Print raw JSON (full result incl. structuredContent).
  --url <url>          Override the MCP endpoint for this call.
  --help               Show this help.

Config (env):
  MCP_URL              MCP endpoint (default: ${DEFAULT_MCP_URL})
  CIVITAI_API_KEY      Bearer token. Browse/read tools work without it;
                       user-action tools require it.

Get an API key at https://civitai.com/user/account`;

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || hasFlag(args, '--help') || hasFlag(args, '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const asJson = hasFlag(args, '--json');
  const urlOverride = takeFlagValue(args, '--url');
  const mcpUrl = urlOverride || process.env.MCP_URL || DEFAULT_MCP_URL;
  const apiKey = process.env.CIVITAI_API_KEY;

  const command = args.shift();

  if (command === 'list') {
    const tools = await listTools(mcpUrl, apiKey);
    if (asJson) {
      process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`);
      return 0;
    }
    for (const tool of tools) {
      const desc = (tool.description || '').replace(/\s+/g, ' ').trim();
      // The MCP tools/list payload carries no auth marker; annotations may hint
      // read-only. We print name + desc (+ [read-only] when annotated).
      const ro = tool.annotations && tool.annotations.readOnlyHint ? ' [read-only]' : '';
      process.stdout.write(`${tool.name}${ro}: ${desc}\n`);
    }
    return 0;
  }

  if (command === 'schema') {
    const toolName = args.shift();
    if (!toolName) {
      process.stderr.write('schema: missing <toolName>\n');
      return 2;
    }
    const tools = await listTools(mcpUrl, apiKey);
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
      process.stderr.write(`schema: no such tool "${toolName}"\n`);
      return 1;
    }
    process.stdout.write(`${JSON.stringify(tool.inputSchema ?? {}, null, 2)}\n`);
    return 0;
  }

  if (command === 'call') {
    const toolName = args.shift();
    if (!toolName) {
      process.stderr.write('call: missing <toolName>\n');
      return 2;
    }
    const jsonArgs = args.shift();
    let toolArgs = {};
    if (jsonArgs !== undefined) {
      try {
        toolArgs = JSON.parse(jsonArgs);
      } catch (err) {
        process.stderr.write(
          `call: jsonArgs is not valid JSON: ${err instanceof Error ? err.message : String(err)}\n`
        );
        return 2;
      }
    }

    const env = await rpc(mcpUrl, apiKey, 'tools/call', { name: toolName, arguments: toolArgs });
    const result = env.result || {};

    if (asJson) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      // Print the text content block(s); fall back to JSON if none.
      const blocks = Array.isArray(result.content) ? result.content : [];
      const texts = blocks.filter((b) => b && b.type === 'text').map((b) => b.text);
      if (texts.length > 0) {
        process.stdout.write(`${texts.join('\n')}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      }
    }
    // Non-zero exit when the tool reported an error (e.g. "set CIVITAI_API_KEY").
    return result.isError ? 1 : 0;
  }

  if (command === 'post-image') {
    const file = args.shift();
    if (!file) {
      process.stderr.write('post-image: missing <file>\n');
      return 2;
    }
    const title = takeFlagValue(args, '--title');
    const detail = takeFlagValue(args, '--detail');
    const nsfwRaw = takeFlagValue(args, '--nsfw');
    const draft = hasFlag(args, '--draft');

    let nsfwLevel;
    if (nsfwRaw !== undefined) {
      nsfwLevel = Number(nsfwRaw);
      if (!Number.isFinite(nsfwLevel)) {
        process.stderr.write(`post-image: --nsfw must be a number, got "${nsfwRaw}"\n`);
        return 2;
      }
    }

    let fileBytes;
    try {
      fileBytes = await fs.readFile(file);
    } catch (err) {
      process.stderr.write(
        `post-image: cannot read file "${file}": ${err instanceof Error ? err.message : String(err)}\n`
      );
      return 1;
    }

    if (!apiKey) {
      process.stderr.write(
        'post-image: CIVITAI_API_KEY is required to upload and post. Get one at https://civitai.com/user/account\n'
      );
      return 1;
    }

    const { post } = await postImageFlow({
      mcpUrl,
      apiKey,
      fileBytes,
      fileName: file,
      title: title ?? defaultTitleFromFile(file),
      detail,
      nsfwLevel,
      publish: !draft,
      callToolImpl: (name, toolArgs) => callTool(mcpUrl, apiKey, name, toolArgs),
    });

    if (asJson) {
      process.stdout.write(`${JSON.stringify(post, null, 2)}\n`);
      return 0;
    }
    const sc = post.structuredContent || {};
    const url = sc.url;
    const id = sc.id;
    if (url || id) {
      process.stdout.write(
        `${draft ? 'Post created (draft).' : 'Post published.'}\n` +
          (id ? `ID: ${id}\n` : '') +
          (url ? `URL: ${url}\n` : '')
      );
    } else {
      // Fall back to the tool's own text block.
      process.stdout.write(`${firstText(post)}\n`);
    }
    return 0;
  }

  process.stderr.write(`Unknown command "${command}".\n\n${USAGE}\n`);
  return 2;
}

// Only run when executed directly (not when imported by a test). Using
// import.meta.url vs argv[1] keeps the module importable for unit testing
// `parseRpcResponse` without triggering a network call.
import { pathToFileURL } from 'node:url';
const isEntry =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
