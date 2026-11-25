/**
 * Minimal structured logging: one JSON object per line on stderr.
 *
 * stderr, not stdout: in stdio mode stdout is the MCP protocol channel, so a
 * log line there would corrupt the JSON-RPC stream. In HTTP mode the container
 * runtime collects both streams.
 *
 * Callers pass only scalar, non-sensitive fields. Never pass tokens, full URLs
 * (query strings can carry credentials), request/response bodies or image data.
 */
export type LogValue = string | number | boolean | undefined;

export function logEvent(event: string, fields: Record<string, LogValue> = {}): void {
  try {
    process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
  } catch {
    // Logging must never break a request.
  }
}
