// Exercise the production /task service with an explicitly absent credential.
// Never consult process.env, secret files, Discord, or GitHub; network is a tripwire.
export async function missingTokenTask({ createTaskService, createGitHubClient }) {
  let networkCalls = 0, hubWrites = 0, createdAudit = 0;
  const github = createGitHubClient({ token: async () => null, fetch: async () => { networkCalls++; throw new Error('NETWORK_FORBIDDEN'); } });
  const member = { memberId: 'acceptance-owner', groupId: 'grp-test' };
  const guildId = 'acceptance-guild';
  const service = createTaskService({ github, store: {
    audit: async () => { createdAudit++; },
    findMemberByDiscord: async (guild, user) => guild === guildId && user === 'owner' ? member : null,
  },
    mailClient: { sendItem: async () => { hubWrites++; } } });
  const stage = () => service.stageTask({ member, guildId, creatorDiscordId: 'owner', title: 'TC19 測試任務', repo: 'acceptance/no-write' });
  const first = stage();
  const refused = await service.confirmTask({ actionId: first.actionId, userId: 'owner', guildId });
  const duplicate = await service.confirmTask({ actionId: first.actionId, userId: 'owner', guildId });
  const cancel = stage();
  const cancelled = await service.cancelTask({ actionId: cancel.actionId, userId: 'owner' });
  const afterCancel = await service.confirmTask({ actionId: cancel.actionId, userId: 'owner', guildId });
  const other = stage();
  const stranger = await service.confirmTask({ actionId: other.actionId, userId: 'stranger', guildId });
  const empty = service.stageTask({ title: '   ' });
  return { error: refused.error, networkCalls, hubWrites, createdAudit,
    emptyTitle: empty.error === 'E-TITLE', cancel: cancelled.ok === true && afterCancel.ok === false,
    stranger: stranger.forbidden === true && !!service.getPending(other.actionId), doubleClick: duplicate.ok === false && !duplicate.error };
}
