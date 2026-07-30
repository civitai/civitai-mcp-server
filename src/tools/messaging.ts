import { z } from 'zod';
import type { ToolModule } from '../server.js';
import { ok } from './helpers.js';

export const messagingTools: ToolModule = (reg) => {
  reg(
    'send_direct_message',
    {
      title: 'Send direct message',
      description:
        'Send a direct message to a Civitai user (by numeric id or username). Chains user lookup -> chat.createChat -> chat.createMessage. Message is sent as Markdown; the server sanitizes it.',
      inputSchema: {
        user: z.union([z.string(), z.number()]).describe('Target user: numeric id or username'),
        message: z.string().describe('Message body (Markdown)'),
        dryRun: z.boolean().optional().describe('Resolve the target and preview without sending'),
      },
      annotations: { readOnlyHint: false },
    },
    async (args, services) => {
      services.auth.requireKey();
      const user = await services.trpc.lookupUser(args.user);
      if (!user) throw new Error(`User '${args.user}' not found`);

      if (args.dryRun) {
        const preview = args.message.length > 400 ? args.message.slice(0, 400) + '…' : args.message;
        return ok(`DRY RUN — would DM ${user.username} (id ${user.id}):\n\n${preview}`, {
          ok: true,
          dryRun: true,
          to: { id: user.id, username: user.username },
        });
      }

      const selfId = await services.trpc.getSelfUserId();
      const chat = await services.trpc.call<{ id: number }>('chat.createChat', {
        userIds: [selfId, user.id],
      });
      // A null result means the chat was not created. Reporting success with
      // "chat undefined" would tell the caller their DM was sent when it wasn't.
      if (!chat?.id) throw new Error('chat.createChat returned no chat — the DM was not sent');

      const msg = await services.trpc.call<{ id: number }>('chat.createMessage', {
        chatId: chat.id,
        content: args.message,
        contentType: 'Markdown',
      });
      if (!msg?.id)
        throw new Error(`chat.createMessage returned nothing — chat ${chat.id} has no message`);
      return ok(`Sent DM to ${user.username} (id ${user.id}) — chat ${chat.id}, message ${msg.id}.`, {
        ok: true,
        to: { id: user.id, username: user.username },
        chatId: chat.id,
        messageId: msg.id,
      });
    }
  );
};
