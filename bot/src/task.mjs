// task.mjs — Task creation service with two-step confirmation (SR-TASK-01~05, §4.5 #10, TC-19).
//
// Rules:
// 1. GitHub Issue is the single source of truth. The Issue must be created first to get its number;
//    only then is the task considered created.
// 2. Hub's task item MUST include the Issue URL in links and text.
// 3. Title is required: trimmed title empty -> E-TITLE ("標題必填"), no Issue created.
// 4. GitHub failure -> E-GITHUB with reason reported; no Hub item saved, no success reported.
// 5. Two-step confirmation: /task shows "將建立：標題／repo" with confirm/cancel buttons.
//    Only the initiator can click; others get an ephemeral refusal.
//    Cancel -> cancelled without side effects.

import { randomUUID } from 'node:crypto';

export const TASK_CONFIRM_PREFIX = 'task_confirm:';
export const TASK_CANCEL_PREFIX = 'task_cancel:';

export function renderTaskPrompt({ title, repo, body }) {
  const lines = [
    '將建立任務：',
    `- 標題：${title}`,
    `- Repo：${repo}`,
  ];
  if (body) lines.push(`- 內容：${body}`);
  return lines.join('\n');
}

export function createTaskComponents(actionId) {
  return [
    {
      type: 1, // ActionRow
      components: [
        {
          type: 2, // Button
          style: 3, // Success
          custom_id: `${TASK_CONFIRM_PREFIX}${actionId}`,
          label: '確認建立',
        },
        {
          type: 2, // Button
          style: 2, // Secondary
          custom_id: `${TASK_CANCEL_PREFIX}${actionId}`,
          label: '取消',
        },
      ],
    },
  ];
}

export function createTaskService({
  store,
  github,
  mailClient,
  defaultRepo = 'example-org/dont-be-a-meat-proxy',
  log = () => {},
}) {
  const pending = new Map();

  function stageTask({ member, creatorDiscordId, title, repo, body, assignee }) {
    const trimmedTitle = String(title ?? '').trim();
    if (!trimmedTitle) {
      return { ok: false, error: 'E-TITLE', message: '標題必填' };
    }
    const targetRepo = String(repo ?? '').trim() || defaultRepo;
    const actionId = randomUUID();
    const task = {
      actionId,
      member,
      creatorDiscordId: String(creatorDiscordId),
      title: trimmedTitle,
      repo: targetRepo,
      body: body ? String(body).trim() : '',
      assignee: assignee ? String(assignee).trim() : null,
      createdAt: Date.now(),
    };
    pending.set(actionId, task);

    return {
      ok: true,
      actionId,
      title: trimmedTitle,
      repo: targetRepo,
      body: task.body,
      assignee: task.assignee,
    };
  }

  async function cancelTask({ actionId, userId }) {
    const task = pending.get(actionId);
    if (!task) {
      return { ok: false, message: '此任務確認已過期或不存在。' };
    }
    if (task.creatorDiscordId !== String(userId)) {
      return { ok: false, forbidden: true, message: '只有發起人能取消此任務。' };
    }
    pending.delete(actionId);
    return { ok: true, message: '已取消建立任務。' };
  }

  async function confirmTask({ actionId, userId }) {
    const task = pending.get(actionId);
    if (!task) {
      return { ok: false, message: '此任務確認已過期或不存在。' };
    }
    if (task.creatorDiscordId !== String(userId)) {
      return { ok: false, forbidden: true, message: '只有發起人能確認此任務。' };
    }
    pending.delete(actionId);

    // 1. Call GitHub to create Issue (Single Source of Truth)
    let issue;
    try {
      issue = await github.createIssue({
        repo: task.repo,
        title: task.title,
        body: task.body || `由 Discord 使用者 <@${userId}> 建立`,
      });
    } catch (e) {
      log({ ev: 'task.github.error', error: e.message, code: e.code ?? 'E-GITHUB' });
      return {
        ok: false,
        error: e.code || 'E-GITHUB',
        message: `建立失敗（E-GITHUB）：${e.message || 'GitHub 建立失敗'}`,
      };
    }

    // 2. Hub sync: save item into Hub (Agent Mail) with kind: 'task' and issue URL in links
    let mailReceipt = null;
    if (mailClient) {
      try {
        let to = task.assignee ? [task.assignee] : null;
        if (!to) {
          const watched = typeof store?.watchedAgents === 'function' ? await store.watchedAgents() : [];
          const groupAgents = watched.filter((w) => w.groupId === task.member.groupId).map((w) => w.agentName);
          to = groupAgents.length > 0 ? [groupAgents[0]] : ['BlueLake'];
        }

        mailReceipt = await mailClient.sendItem({
          kind: 'task',
          intent: 'action',
          subject: `[任務 #${issue.number}] ${task.title}`,
          summary: task.title,
          text: `任務 #${issue.number}：${task.title}\nIssue URL: ${issue.url}${task.body ? `\n\n${task.body}` : ''}`,
          links: [issue.url],
          sourceSession: `discord:${userId}`,
          to,
        });
      } catch (e) {
        log({ ev: 'task.mail.error', error: e.message, code: e.code });
      }
    }

    if (typeof store?.audit === 'function') {
      await store.audit({
        groupId: task.member.groupId,
        actorType: 'member',
        actorId: String(userId),
        action: 'discord.task.created',
        requestId: actionId,
        details: {
          issueNumber: issue.number,
          issueUrl: issue.url,
          title: task.title,
          repo: task.repo,
          mailReceipt: mailReceipt?.messageId ?? null,
        },
      });
    }

    return {
      ok: true,
      issue,
      mailReceipt,
      message: `已建立任務 #${issue.number}：${issue.url}`,
    };
  }

  return {
    stageTask,
    cancelTask,
    confirmTask,
    getPending: (id) => pending.get(id),
  };
}
