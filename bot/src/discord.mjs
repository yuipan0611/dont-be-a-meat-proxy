// discord.mjs — thin discord.js adapter (Gateway; the bot needs no inbound port, SAD).
// Logic lives in router/bridge/deliver; this file only translates.

import { Client, GatewayIntentBits, Events, REST, Routes, DiscordAPIError } from 'discord.js';
import { DiscordSendError } from './deliver.mjs';
import { COMMANDS } from './router.mjs';
import { clip } from './notify-format.mjs';

const NO_MENTIONS = { parse: [] };

/** Definitely-not-delivered vs. maybe-delivered (SR-NTF-04: unknown is recorded, never resent). */
export function classifySendError(e) {
  if (e instanceof DiscordAPIError || (typeof e?.status === 'number' && e.status < 500)) {
    return new DiscordSendError(`discord ${e.status ?? ''} ${e.code ?? ''}`.trim(), { outcome: e.status >= 500 ? 'unknown' : 'failed', code: e.code ?? e.status });
  }
  if (typeof e?.status === 'number' && e.status >= 500) return new DiscordSendError('discord 5xx', { outcome: 'unknown', code: e.status });
  // Timeouts / dropped connections after the request left: the DM may exist.
  return new DiscordSendError(e?.name === 'AbortError' ? 'timeout' : 'network', { outcome: 'unknown', code: e?.code ?? e?.name });
}

export function createDiscordClient({ presence = false }) {
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
  // Privileged intents: only when the presence-based digest is turned on (runbook §權限).
  if (presence) intents.push(GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildMembers);
  return new Client({ intents, allowedMentions: NO_MENTIONS });
}

export function createDmSender(client) {
  return {
    async sendDm(userId, content) {
      try {
        const user = await client.users.fetch(userId);
        const msg = await user.send({ content: clip(content, 1900), allowedMentions: NO_MENTIONS });
        return { messageId: msg.id };
      } catch (e) {
        throw classifySendError(e);
      }
    },
  };
}

export function wireEvents({ client, guildId, router, store, presence, log }) {
  client.on(Events.InteractionCreate, (ix) => {
    if (!ix.isChatInputCommand()) return;
    router.handle(ix).catch((e) => log({ ev: 'interaction.error', error: e.code ?? e.message }));
  });
  // SDS API-05: a channel question addressed to the bot only gets a pointer to /status.
  client.on(Events.MessageCreate, (m) => {
    if (m.author.bot || !client.user || !m.mentions.users.has(client.user.id)) return;
    m.reply({ content: '查進度請用 `/status`（只有你看得到）。我不在公開頻道回答專案內容。', allowedMentions: NO_MENTIONS }).catch(() => {});
  });
  if (presence) {
    client.on(Events.PresenceUpdate, (_old, now) => {
      if (!now?.userId || String(now.guild?.id) !== String(guildId)) return;
      store.setPresenceByDiscord(String(guildId), String(now.userId), now.status ?? 'offline')
        .catch((e) => log({ ev: 'presence.error', error: e.message }));
    });
  }
}

/** Guild-scoped commands (instant update; global commands take up to an hour). */
export async function registerCommands({ token, applicationId, guildId }) {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: COMMANDS });
  return COMMANDS.map((c) => c.name);
}
