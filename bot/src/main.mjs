// main.mjs — entry point. `run` | `once` | `register-commands` | `check-config`.
// Secrets are read from FILES (Compose secrets); none is accepted from argv or printed.

import { readFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { createMailClient } from '../../client/mail-client.mjs';
import { createPool, createPgStore } from './store-pg.mjs';
import { createBridge, createMailReader } from './bridge.mjs';
import { createDelivery } from './deliver.mjs';
import { createBudget } from './budget.mjs';
import { createAssistant, createReadOnlyTools, MODEL } from './assistant.mjs';
import { createConnect } from './connect.mjs';
import { createGitHubClient } from './github.mjs';
import { createTaskService } from './task.mjs';
import { createRouter } from './router.mjs';
import { createSpoolApplier } from './token-applier.mjs';
import { createDiscordClient, createDmSender, wireEvents, registerCommands } from './discord.mjs';

const log = (o) => process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ...o })}\n`);
const env = (k, d) => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === '') throw new Error(`missing env ${k}`);
  return v;
};
const secret = async (k) => (await readFile(env(k), 'utf8')).trim();

export async function loadConfig() {
  const capUsd = Number(env('BOT_DAILY_CAP_USD', '0.50'));
  if (!(capUsd >= 0)) throw new Error('BOT_DAILY_CAP_USD must be ≥ 0');
  return {
    groupId: env('HUB_GROUP_ID'),
    guildId: env('DISCORD_GUILD_ID'),
    applicationId: env('DISCORD_APPLICATION_ID'),
    discordTokenFile: env('DISCORD_TOKEN_FILE'),
    anthropicKeyFile: env('ANTHROPIC_API_KEY_FILE'),
    pg: { host: env('HUB_PG_HOST', 'db'), port: Number(env('HUB_PG_PORT', '5432')), database: env('HUB_PG_DATABASE', 'hub'), user: env('HUB_PG_USER', 'hub_app'), passwordFile: env('HUB_PG_PASSWORD_FILE') },
    mail: { url: env('MAIL_URL', 'http://mail-a:8765/mcp/'), tokenFile: env('MAIL_TOKEN_FILE'), projectKey: env('MAIL_PROJECT_KEY', '/data/projects/group-a'), agentName: env('MAIL_AGENT_NAME', 'HubBot') },
    hubUrl: env('HUB_PUBLIC_URL'),
    spoolDir: env('TOKEN_SPOOL_DIR', '/spool'),
    capUsd,
    presence: env('BOT_PRESENCE_DIGEST', '0') === '1',
    tickMs: Number(env('BOT_TICK_MS', '15000')),
    github: {
      tokenFile: process.env.GITHUB_TOKEN_FILE || null,
      token: process.env.GITHUB_TOKEN || process.env.GITHUB_PAT || null,
      defaultRepo: process.env.GITHUB_DEFAULT_REPO || 'example-org/dont-be-a-meat-proxy',
    },
  };
}

/** Accepts H-02's mail-a.env (HTTP_BEARER_TOKEN=…) or a bare token file. */
export function mailToken(text) {
  const t = text.match(/^HTTP_BEARER_TOKEN=([A-Za-z0-9_-]{32,128})$/m)?.[1] ?? text.trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(t)) throw new Error('MAIL_TOKEN_FILE has no valid upstream token');
  return t;
}

async function build(cfg) {
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(cfg.groupId) || cfg.mail.projectKey !== '/data/projects/' + cfg.groupId) throw new Error('Group / Mail project mismatch');
  const pool = await createPool(cfg.pg);
  const store = createPgStore({ pool, groupId: cfg.groupId });
  const mailClient = createMailClient({ url: cfg.mail.url, token: mailToken(await readFile(cfg.mail.tokenFile, 'utf8')), projectKey: cfg.mail.projectKey, agentName: cfg.mail.agentName });
  const mail = createMailReader({ client: mailClient, projectKey: cfg.mail.projectKey });
  const clock = { nowMs: () => Date.now() };
  return { pool, store, mailClient, mail, clock };
}

async function run(cfg, { once = false } = {}) {
  const { pool, store, mailClient, mail, clock } = await build(cfg);
  const discordToken = await secret('DISCORD_TOKEN_FILE');
  const client = createDiscordClient({ presence: cfg.presence });
  const dm = createDmSender(client);
  const llm = new Anthropic({ apiKey: await secret('ANTHROPIC_API_KEY_FILE'), maxRetries: 0, timeout: 30_000 });
  const budget = createBudget({
    store, clock, capUsd: cfg.capUsd, model: MODEL,
    onCapReached: async ({ groupId, day, capUsd }) => {
      for (const id of await store.ownerDiscordIds(groupId)) {
        await dm.sendDm(id, `/status 今日額度 ${capUsd} USD 已用完（${day}，台北日界），之後的查詢會直接拒絕，明日 00:00 恢復。`).catch(() => {});
      }
    },
  });
  const assistant = createAssistant({ llm: { create: (p) => llm.messages.create(p) }, tools: createReadOnlyTools({ store, mail }), budget, log });
  const connect = createConnect({ store, applier: createSpoolApplier({ dir: cfg.spoolDir, groupId: cfg.groupId }), hubUrl: cfg.hubUrl, log });
  const github = createGitHubClient({
    token: cfg.github?.token,
    tokenFile: cfg.github?.tokenFile,
    defaultRepo: cfg.github?.defaultRepo,
  });
  const taskService = createTaskService({
    store,
    github,
    mailClient,
    defaultRepo: cfg.github?.defaultRepo,
    log,
  });
  const router = createRouter({ store, connect, assistant, taskService, log });
  const bridge = createBridge({ mail, store, clock, log });
  const delivery = createDelivery({ store, discord: dm, clock, presenceEnabled: cfg.presence, log });
  wireEvents({ client, guildId: cfg.guildId, router, store, presence: cfg.presence, log });
  await client.login(discordToken);
  await new Promise((r) => client.once('ready', r));
  log({ ev: 'ready', guild: cfg.guildId, presence: cfg.presence, cap_usd: cfg.capUsd });

  let stopping = false;
  const tick = async () => {
    const b = await bridge.tick();
    const d = await delivery.tick();
    log({ ev: 'tick', ...b, ...d });
  };
  if (once) {
    await tick();
  } else {
    while (!stopping) {
      try { await tick(); } catch (e) { log({ ev: 'tick.error', error: e.code ?? e.message }); }
      await new Promise((r) => setTimeout(r, cfg.tickMs));
    }
  }
  const shutdown = async () => { stopping = true; await client.destroy(); await pool.end(); };
  if (once) return shutdown();
  for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => shutdown().then(() => process.exit(0)));
}

const cmd = process.argv[2] ?? 'run';
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const cfg = await loadConfig();
    if (cmd === 'check-config') log({ ev: 'config.ok', guild: cfg.guildId, presence: cfg.presence, cap_usd: cfg.capUsd });
    else if (cmd === 'register-commands') log({ ev: 'commands.registered', names: await registerCommands({ token: await secret('DISCORD_TOKEN_FILE'), applicationId: cfg.applicationId, guildId: cfg.guildId }) });
    else if (cmd === 'once') await run(cfg, { once: true });
    else if (cmd === 'run') await run(cfg);
    else throw new Error(`unknown command ${cmd}`);
  } catch (e) {
    log({ ev: 'fatal', error: e.message });
    process.exit(1);
  }
}
