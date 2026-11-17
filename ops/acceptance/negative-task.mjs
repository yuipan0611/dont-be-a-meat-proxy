// Exercise the production /task service with an explicitly absent credential.
// Never consult process.env, secret files, Discord, or GitHub; network is a tripwire.
export async function missingTokenTask({ createTaskService, createGitHubClient }) {
  let networkCalls = 0, hubWrites = 0, createdAudit = 0;
  const github = createGitHubClient({ token: async () => null, fetch: async () => { networkCalls++; throw new Error('NETWORK_FORBIDDEN'); } });
  const service = createTaskService({ github, store: { audit: async () => { createdAudit++; } },
    mailClient: { sendItem: async () => { hubWrites++; } } });
  const stage = () => service.stageTask({ member: { memberId: 'acceptance-owner', groupId: 'grp-test' }, creatorDiscordId: 'owner', title: 'TC19 測試任務', repo: 'acceptance/no-write' });
  const first = stage();
  const refused = await service.confirmTask({ actionId: first.actionId, userId: 'owner' });
  const duplicate = await service.confirmTask({ actionId: first.actionId, userId: 'owner' });
  const cancel = stage();
  const cancelled = await service.cancelTask({ actionId: cancel.actionId, userId: 'owner' });
  const afterCancel = await service.confirmTask({ actionId: cancel.actionId, userId: 'owner' });
  const other = stage();
  const stranger = await service.confirmTask({ actionId: other.actionId, userId: 'stranger' });
  const empty = service.stageTask({ title: '   ' });
  return { error: refused.error, networkCalls, hubWrites, createdAudit,
    emptyTitle: empty.error === 'E-TITLE', cancel: cancelled.ok === true && afterCancel.ok === false,
    stranger: stranger.forbidden === true && !!service.getPending(other.actionId), doubleClick: duplicate.ok === false && !duplicate.error };
}
