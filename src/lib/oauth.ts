/**
 * OAuth 2.0 resource-server support (RFC 9728 + RFC 6750) for the MCP server.
 *
 * MCP clients only begin an OAuth authorization-code flow when they receive an
 * HTTP `401 Unauthorized` carrying a `WWW-Authenticate: Bearer` challenge that
 * points at this server's Protected Resource Metadata. Two pieces make that work:
 *
 *  1. `GET /.well-known/oauth-protected-resource` advertises which authorization
 *     server(s) to use and which scopes exist (the metadata document).
 *  2. A `tools/call` for an auth-`required` tool with no bearer is short-circuited
 *     at the HTTP layer with a 401 + challenge, instead of failing deeper at the
 *     JSON-RPC layer (200 + isError) where the client can't see it.
 *
 * Token validation is intentionally NOT done here. Presence of a bearer is
 * enough to let the request through; the real validation happens upstream when a
 * tool calls Civitai (an invalid/expired token surfaces as a tool error).
 */

import type { ToolAuth } from './landing.js';

/**
 * Canonical OAuth scope names exposed by the Civitai authorization server. These
 * MUST match the app's OAuth server exactly — they are advertised verbatim in
 * the protected-resource metadata so clients can request the right scopes.
 */
export const SUPPORTED_SCOPES = [
  'user:read',
  'models:read',
  'media:read',
  'articles:read',
  'bounties:read',
  'buzz:read',
  'collections:read',
  'ai:read',
  'notifications:read',
  'vault:read',
  'media:write',
  'articles:write',
  'collections:write',
  'social:write',
  'notifications:write',
  'models:write',
] as const;

/** Path of the protected-resource metadata document (RFC 9728). */
export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
}

/**
 * Build the RFC 9728 Protected Resource Metadata document.
 * `baseUrl` is the externally-visible origin of this server (no trailing slash);
 * the advertised `resource` is the MCP endpoint (`<baseUrl>/mcp`). It must match
 * the URL clients actually POST to, so in prod `PUBLIC_BASE_URL` must be set.
 * `authorizationServer` is the Civitai origin (config.apiUrl, e.g. https://civitai.com).
 */
export function buildProtectedResourceMetadata(
  baseUrl: string,
  authorizationServer: string
): ProtectedResourceMetadata {
  return {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [authorizationServer],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ['header'],
  };
}

/** Build the `WWW-Authenticate` header value pointing at the metadata document. */
export function buildWwwAuthenticate(baseUrl: string): string {
  return `Bearer resource_metadata="${baseUrl}${PROTECTED_RESOURCE_PATH}"`;
}

/** A single JSON-RPC request shape (only the fields we inspect). */
interface JsonRpcLike {
  method?: unknown;
  id?: unknown;
  params?: { name?: unknown } | unknown;
}

/** Pull the tool name out of a `tools/call` request's params, if present. */
function toolName(req: JsonRpcLike): string | undefined {
  const params = req.params as { name?: unknown } | undefined;
  return typeof params?.name === 'string' ? params.name : undefined;
}

/** True when a JSON-RPC request is a `tools/call` for an auth-`required` tool. */
function callRequiresAuth(req: JsonRpcLike, authMap: Map<string, ToolAuth>): boolean {
  if (req.method !== 'tools/call') return false;
  const name = toolName(req);
  if (name === undefined) return false;
  // Unknown tool name -> not an auth problem; let the transport return a proper
  // JSON-RPC method/params error instead of an OAuth challenge.
  return authMap.get(name) === 'required';
}

export interface AuthChallengeDecision {
  /** Whether to short-circuit the request with a 401 OAuth challenge. */
  challenge: boolean;
  /** Echoes back the first offending request's id (or null) for the error body. */
  id: string | number | null;
}

/**
 * Decide whether a parsed MCP POST body should be challenged with a 401.
 *
 * Rules:
 *  - `initialize`, `tools/list`, `notifications/*`, `ping`, and `public`
 *    `tools/call`s proceed anonymously (never challenged).
 *  - A `tools/call` for a `required` tool with no bearer present is challenged.
 *  - Batch rule: if ANY call in a batch is `required` and no bearer is present,
 *    the WHOLE request is challenged (we cannot partially authorize a batch at
 *    the HTTP layer). The id of the first offending call is echoed back.
 *
 * Presence-only: a bearer that is present (even if invalid/expired) lets the
 * request through — real validation happens upstream in the tool call.
 */
export function decideAuthChallenge(
  body: unknown,
  hasBearer: boolean,
  authMap: Map<string, ToolAuth>
): AuthChallengeDecision {
  if (hasBearer) return { challenge: false, id: null };
  const requests: JsonRpcLike[] = Array.isArray(body)
    ? (body as JsonRpcLike[])
    : body && typeof body === 'object'
    ? [body as JsonRpcLike]
    : [];
  for (const req of requests) {
    if (callRequiresAuth(req, authMap)) {
      const id = req.id;
      return {
        challenge: true,
        id: typeof id === 'string' || typeof id === 'number' ? id : null,
      };
    }
  }
  return { challenge: false, id: null };
}
