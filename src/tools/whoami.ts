import type { ToolModule } from '../server.js';
import { ok } from './helpers.js';

interface SelfStatus {
  id?: number;
  username?: string;
  onboarding?: { raw?: number; completedSteps?: string[]; isOnboarded?: boolean };
  muted?: boolean;
  isModerator?: boolean;
  bannedAt?: string | null;
  deletedAt?: string | null;
  tier?: string | null;
  subscriptionId?: string | null;
}

export const whoamiTools: ToolModule = (reg) => {
  reg(
    'whoami',
    {
      title: 'Who am I',
      description:
        'Resolve the current user from the active API key (id, username) and report authoritative account status via ' +
        'user.getSelfStatus (UserRead scope). Good smoke test for deployments and for confirming which account will perform ' +
        'user actions. ' +
        'Reports REAL onboarding state (isOnboarded + completedSteps), muted state, and an authoritative isModerator flag, ' +
        'plus subscription tier. An un-onboarded account fails every verified/guarded social write (post, react, review, ' +
        'follow) and a muted account fails guarded writes — so check this first if writes are 500ing, then call ' +
        'complete_onboarding_step.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (_args, services) => {
      services.auth.requireKey();
      const status = await services.trpc.call<SelfStatus | null>(
        'user.getSelfStatus',
        undefined,
        'GET'
      );

      const id = status?.id ?? (await services.trpc.getSelfUserId());
      const username = status?.username ?? '(unknown)';
      const completedSteps = status?.onboarding?.completedSteps ?? [];
      const isOnboarded = status?.onboarding?.isOnboarded;
      const muted = status?.muted;
      const isModerator = status?.isModerator;
      const tier = status?.tier ?? null;

      const notes: string[] = [];
      if (isModerator === true) notes.push('moderator');
      if (isOnboarded === false)
        notes.push('ONBOARDING INCOMPLETE — verified/guarded writes will fail; call complete_onboarding_step');
      if (muted === true) notes.push('account is MUTED — guarded social writes will be blocked');
      if (status?.bannedAt) notes.push('account is BANNED');

      return ok(
        `You are ${username} (id ${id})${notes.length ? ` [${notes.join('; ')}]` : ''}.`,
        {
          id,
          username,
          isModerator: isModerator ?? null,
          isOnboarded: isOnboarded ?? null,
          completedSteps,
          onboarding: status?.onboarding?.raw,
          muted: muted ?? null,
          tier,
          subscriptionId: status?.subscriptionId ?? null,
          bannedAt: status?.bannedAt ?? null,
          deletedAt: status?.deletedAt ?? null,
          apiUrl: services.config.apiUrl,
        }
      );
    }
  );
};
