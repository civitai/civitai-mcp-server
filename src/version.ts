/**
 * This server's name and version. The version is also sent as
 * `report.client.version` with platform feedback, where Civitai compares it
 * against a fix's `fixedIn.version` (component `mcp`) — so it must be the real
 * release version. test/platform-feedback.test.ts keeps it equal to package.json's
 * and matching the server's version pattern.
 */
export const SERVER_NAME = 'civitai-mcp-server';
export const SERVER_VERSION = '0.2.0';
