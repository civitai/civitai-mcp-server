import type { ToolModule } from '../server.js';
import { ok } from './helpers.js';

export const whoamiTools: ToolModule = (reg) => {
  reg(
    'whoami',
    {
      title: 'Who am I',
      description:
        'Resolve the current user from the active API key (id, username, moderator flag). Good smoke test for deployments and for confirming which account will perform user actions.',
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

      // Civitai has no public isModerator flag; sniff the Moderator Nameplate cosmetic.
      const isModerator = (user?.cosmetics ?? []).some(
        (c) => c?.cosmetic?.name === 'Moderator Nameplate'
      );
      const username = user?.username ?? '(unknown)';
      return ok(`You are ${username} (id ${selfId})${isModerator ? ' [moderator]' : ''}.`, {
        id: selfId,
        username,
        moderator: isModerator,
        apiUrl: services.config.apiUrl,
      });
    }
  );
};
