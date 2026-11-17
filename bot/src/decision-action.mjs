import { randomUUID } from 'node:crypto';

// Persist once before network IO. The exact body, author, timestamp and key survive retries.
export function decisionAction(decision, { status, memberId, discordUserId, memberName, now }) {
  if (!['confirmed', 'rejected'].includes(status)) throw new Error('Invalid decision action');
  const key = randomUUID();
  return {
    key, status, memberId, discordUserId, memberName, now,
    message: {
      project_key: `/data/projects/${decision.group_id}`,
      to: [decision.author_agent],
      subject: `[決策${status === 'confirmed' ? '已確認' : '已駁回'}] #${decision.draft_mail_id}`,
      topic: 'decision', thread_id: `decision-${decision.draft_mail_id}`, idempotency_key: key,
      body_md: JSON.stringify({ v: 1, kind: 'decision_status', draft_mail_id: decision.draft_mail_id,
        status, decided_by: memberName, decided_at: now }),
      convert_images: false,
    },
  };
}
