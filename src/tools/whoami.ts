import type { ToolModule } from '../server.js';
import { ok } from './helpers.js';

export const whoamiTools: ToolModule = (reg) => {
  reg(
    'whoami',
    {
      title: 'Who am I',
      description:
        'Resolve the current user from the active API key (id, username). Good smoke test for deployments and for confirming which account will perform user actions. ' +
        'NOTE: the API-key surface exposes no authoritative moderator/role/tier field, so this returns `moderatorCosmetic` — a NON-AUTHORITATIVE heuristic that is true only when the account wears the "Moderator Nameplate" cosmetic. Do not treat it as proof of moderator privileges; the upstream API enforces the real check.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (_args, services) => {
      services.auth.requireKey();
      const selfId = await services.trpc.getSelfUserId();
      const user = await services.trpc.call<{
        id?: number;
        username?: string;
        cosmetics?: Array<{ cosmetic?: { name?: string } }>;
      } | null>('user.getById', { id: selfId }, 'GET');

      // Civitai exposes no authoritative isModerator flag on this surface; the
      // "Moderator Nameplate" cosmetic is a heuristic only (a non-mod could in
      // principle wear it, and real perms are enforced server-side regardless).
      const moderatorCosmetic = (user?.cosmetics ?? []).some(
        (c) => c?.cosmetic?.name === 'Moderator Nameplate'
      );
      const username = user?.username ?? '(unknown)';
      return ok(
        `You are ${username} (id ${selfId})${moderatorCosmetic ? ' [wears Moderator Nameplate cosmetic — not an authoritative mod check]' : ''}.`,
        {
          id: selfId,
          username,
          moderatorCosmetic,
          apiUrl: services.config.apiUrl,
        }
      );
    }
  );
};
