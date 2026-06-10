import type { ToolModule } from '../server.js';
import { ok } from './helpers.js';

export const whoamiTools: ToolModule = (reg) => {
  reg(
    'whoami',
    {
      title: 'Who am I',
      description:
        'Resolve the current user from the active API key (id, username). Good smoke test for deployments and for confirming which account will perform user actions. ' +
        'Also reports onboarding / muted state WHEN the API surface exposes it: an un-onboarded account fails every verified/guarded social write (post, react, review, follow), and a muted account fails guarded writes — so check this first if writes are 500ing, then call complete_onboarding_step. ' +
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
        onboarding?: number;
        muted?: boolean;
        cosmetics?: Array<{ cosmetic?: { name?: string } }>;
      } | null>('user.getById', { id: selfId }, 'GET');

      // Civitai exposes no authoritative isModerator flag on this surface; the
      // "Moderator Nameplate" cosmetic is a heuristic only (a non-mod could in
      // principle wear it, and real perms are enforced server-side regardless).
      const moderatorCosmetic = (user?.cosmetics ?? []).some(
        (c) => c?.cosmetic?.name === 'Moderator Nameplate'
      );
      const username = user?.username ?? '(unknown)';

      // Onboarding is a bitflag (TOS=1, Profile=2, BrowsingLevels=4, Buzz=8;
      // complete = 1|2|4|8 = 15). The default getById selector usually does NOT
      // expose `onboarding`/`muted`, so these are best-effort: undefined means
      // "unknown from this surface", not "fine".
      const ONBOARDING_COMPLETE = 1 | 2 | 4 | 8;
      const onboardingFlag = user?.onboarding;
      const onboardingComplete =
        typeof onboardingFlag === 'number'
          ? (onboardingFlag & ONBOARDING_COMPLETE) === ONBOARDING_COMPLETE
          : undefined;
      const muted = typeof user?.muted === 'boolean' ? user.muted : undefined;

      const notes: string[] = [];
      if (moderatorCosmetic) notes.push('wears Moderator Nameplate cosmetic (not an authoritative mod check)');
      if (onboardingComplete === false)
        notes.push('ONBOARDING INCOMPLETE — verified/guarded writes will fail; call complete_onboarding_step');
      if (muted === true) notes.push('account is MUTED — guarded social writes will be blocked');

      return ok(
        `You are ${username} (id ${selfId})${notes.length ? ` [${notes.join('; ')}]` : ''}.`,
        {
          id: selfId,
          username,
          moderatorCosmetic,
          onboarding: onboardingFlag,
          onboardingComplete,
          muted,
          apiUrl: services.config.apiUrl,
        }
      );
    }
  );
};
