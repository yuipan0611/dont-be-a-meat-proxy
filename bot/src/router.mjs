// router.mjs — slash command handling (API-05, SR-AST-03/05, FR-22).
//
// Every command defers EPHEMERALLY first (Discord's 3-second limit), then checks membership.
// Non-members get one fixed refusal and nothing else (no project content, no hint of data).
// The interaction object only needs: commandName, user.id, guildId, id, options.get*(),
// deferReply(), editReply(), followUp() — discord.js ChatInputCommandInteraction satisfies it.

export const EPHEMERAL = 64; // MessageFlags.Ephemeral
export const NOT_MEMBER = '你不是這個專案的成員，無法使用這個指令。';
const NO_MENTIONS = { parse: [] };

export const COMMANDS = Object.freeze([
  {
    name: 'connect', description: '取得這台裝置接上 Hub 的設定（只有你看得到）',
    options: [
      { type: 3, name: 'platform', description: '裝置平台', required: true, choices: [
        { name: 'Mac', value: 'macos' }, { name: 'Windows', value: 'windows' }, { name: 'Linux', value: 'linux' }] },
      { type: 3, name: 'device', description: '裝置名稱，例：Windows 桌機', required: false, max_length: 40 },
    ],
  },
  {
    name: 'revoke', description: '撤銷一把裝置 token（其他裝置不受影響）',
    options: [{ type: 3, name: 'token_id', description: '例：tok_0123abcd…', required: true, max_length: 40 }],
  },
  {
    name: 'status', description: '問專案助理進度（預設只有你看得到）',
    options: [
      { type: 3, name: 'question', description: '例：現在做到哪', required: true, max_length: 500 },
      { type: 5, name: 'public', description: '把回答公開到這個頻道（預設否）', required: false },
    ],
  },
]);

export function createRouter({ store, connect, assistant, decisions = null, log = () => {} }) {
  async function handleButton(ix) {
    if (decisions) return decisions.handleButton(ix);
  }

  async function handle(ix) {
    if (!['connect', 'revoke', 'status'].includes(ix.commandName)) return;
    await ix.deferReply({ flags: EPHEMERAL });
    const reply = (content) => ix.editReply({ content, allowedMentions: NO_MENTIONS });
    try {
      const member = ix.guildId ? await store.findMemberByDiscord(String(ix.guildId), String(ix.user.id)) : null;
      if (!member) {
        await store.audit({ groupId: null, actorType: 'member', actorId: String(ix.user.id), action: `discord.${ix.commandName}.denied`, requestId: String(ix.id), details: { reason: 'not_member' } });
        return reply(NOT_MEMBER);
      }
      const actorId = String(ix.user.id);
      const requestId = String(ix.id);
      if (ix.commandName === 'connect') {
        const r = await connect.connect({ member, platform: ix.options.getString('platform'), label: ix.options.getString('device'), requestId, actorId });
        return reply(r.text);
      }
      if (ix.commandName === 'revoke') {
        const tokenId = String(ix.options.getString('token_id') ?? '').trim();
        if (!/^tok_[a-z0-9]{8,32}$/.test(tokenId)) return reply('token ID 格式不對（例：tok_0123abcd…）。');
        const r = await connect.revoke({ member, tokenId, requestId, actorId });
        return reply(r.text);
      }
      // status
      const r = await assistant.answer({ groupId: member.groupId, question: ix.options.getString('question') ?? '' });
      await store.audit({ groupId: member.groupId, actorType: 'member', actorId, action: 'discord.status', requestId, details: { kind: r.kind, citations: r.citations ?? [] } });
      await reply(r.text);
      if (ix.options.getBoolean('public') === true && r.kind === 'answer') {
        await ix.followUp({ content: `<@${actorId}> 選擇公開的 /status 回答：\n${r.text}`, allowedMentions: NO_MENTIONS });
      }
    } catch (e) {
      log({ ev: 'router.error', cmd: ix.commandName, error: e.code ?? e.message });
      return reply('處理失敗，請稍後再試；持續失敗請找 operator。');
    }
  }
  return { handle, handleButton };
}
