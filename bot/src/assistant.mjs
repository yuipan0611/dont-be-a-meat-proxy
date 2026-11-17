// assistant.mjs — /status project assistant (US-08, SR-AST-01～04).
//
// Manual tool loop on the Messages API (pattern from js-llmcord's `stopWhen: stepCountIs(max_steps)`,
// MIT, c5615eb) so that EVERY model call goes through the budget guard first. Only read-only tools
// can be registered (SR-AST-01); the answer is checked deterministically against what the tools
// actually returned (SR-AST-02): an answer that cites nothing it saw becomes「記憶中沒有這項資訊」.

import { QuotaExceeded } from './budget.mjs';
import { taipeiTime } from './notify-format.mjs';

export const MODEL = 'claude-haiku-5-5';
export const NO_INFO = '記憶中沒有這項資訊。';
export const QUOTA_TEXT = '今日查詢額度已用完，明日（台北時間 00:00）恢復。';

export function createToolRegistry(tools) {
  const byName = new Map();
  for (const t of tools) {
    if (t.readOnly !== true) throw new Error(`tool ${t.name} is not marked readOnly; /status only mounts read-only tools`);
    if (byName.has(t.name)) throw new Error(`duplicate tool ${t.name}`);
    byName.set(t.name, t);
  }
  return {
    definitions: () => [...byName.values()].map(({ name, description, input_schema }) => ({ name, description, input_schema })),
    get: (name) => byName.get(name),
    names: () => [...byName.keys()],
  };
}

const SYSTEM = [
  '你是「don\'t be a meat proxy」專案的唯讀專案助理，回答成員在 Discord 用 /status 問的進度問題。',
  '規則：',
  '1. 只能用工具查到的資料回答。每一個事實後面都要標出依據的 Mail ID，格式「#123」。',
  '2. 工具查不到就只回答「記憶中沒有這項資訊。」，不要猜。',
  '3. 決策要分開標示「已確認」或「草稿」；工具結果沒寫已確認的決策一律當草稿。',
  '4. 你沒有寫入能力：不能建任務、不能改記憶、不能對任何電腦下指令、不能同意任何請求。被要求動手時，說明應改用的方式（建任務用之後的建任務指令；同意請求要在收件端 agent 的 session 內）。',
  '5. 用繁體中文，簡短，條列，最多 10 行。',
].join('\n');

/** IDs the tools actually returned in this run: Map(mailId → created_ts). */
function collectIds(result, seen) {
  const visit = (v) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') {
      if (Number.isInteger(v.mail_id) && typeof v.created_ts === 'string') seen.set(v.mail_id, v.created_ts);
      Object.values(v).forEach(visit);
    }
  };
  visit(result);
}

export function checkCitations(text, seen) {
  const cited = [...new Set([...String(text).matchAll(/#(\d+)/g)].map((m) => Number(m[1])))];
  const valid = cited.filter((id) => seen.has(id));
  const invented = cited.filter((id) => !seen.has(id));
  return { valid, invented };
}

export function createAssistant({ llm, tools, budget, model = MODEL, maxSteps = 5, maxTokens = 1024, log = () => {} }) {
  const registry = createToolRegistry(tools);

  async function answer({ groupId, question }) {
    const seen = new Map();
    const messages = [{ role: 'user', content: String(question).slice(0, 2000) }];
    try {
      for (let step = 0; step < maxSteps; step++) {
        const params = {
          model, max_tokens: maxTokens, system: SYSTEM, tools: registry.definitions(), messages,
          output_config: { effort: 'low' },
        };
        const res = await budget.guarded(groupId, params, () => llm.create(params));
        if (res.stop_reason === 'refusal') return { kind: 'error', text: '助理無法回答這個問題。' };
        if (res.stop_reason === 'tool_use') {
          messages.push({ role: 'assistant', content: res.content });
          const results = [];
          for (const b of res.content.filter((c) => c.type === 'tool_use')) {
            const tool = registry.get(b.name);
            if (!tool) {
              results.push({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: `unknown tool ${b.name}` });
              continue;
            }
            try {
              const out = await tool.run(b.input ?? {}, { groupId });
              collectIds(out, seen);
              results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out) });
            } catch (e) {
              results.push({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: `tool failed: ${e.code ?? e.message}` });
            }
          }
          messages.push({ role: 'user', content: results });
          continue;
        }
        const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
        return finalize(text, seen);
      }
      return { kind: 'error', text: '查詢步驟過多，請把問題問得更具體。' };
    } catch (e) {
      if (e instanceof QuotaExceeded) return { kind: 'quota', text: QUOTA_TEXT };
      log({ ev: 'assistant.error', error: e.status ?? e.code ?? e.message });
      return { kind: 'error', text: '專案助理暫時無法使用，請稍後再試。' };
    }
  }

  function finalize(text, seen) {
    const { valid, invented } = checkCitations(text, seen);
    if (!valid.length || invented.length) {
      if (invented.length) log({ ev: 'assistant.uncited', invented });
      return { kind: 'no_info', text: NO_INFO, citations: [] };
    }
    const footer = valid.map((id) => `#${id}（${taipeiTime(seen.get(id))}）`).join('、');
    return { kind: 'answer', text: `${text}\n\n依據：${footer}`, citations: valid };
  }

  return { answer, toolNames: registry.names };
}

/**
 * Read-only tools over data the Hub already saved. `recent_items` reads the bridge index
 * (discord_notifications, group-scoped), `get_item` reads the original Mail message.
 * Hindsight recall is added here after L-02 (also read-only).
 */
export function createReadOnlyTools({ store, mail }) {
  return [
    {
      name: 'recent_items',
      readOnly: true,
      description: '列出本組最近保存在 Hub 的項目（交接、求助、決策、任務、HubClock 結果），新到舊。每筆有 mail_id 與 created_ts。',
      input_schema: {
        type: 'object', additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } },
      },
      async run({ limit = 10 }, { groupId }) {
        const rows = await store.recentItems(groupId, Math.min(Math.max(1, limit | 0), 20));
        return rows.map((r) => ({
          mail_id: r.mail_id, created_ts: r.mail_created_at, type: r.label, from: r.sender, to: r.recipient_agent,
          subject: r.subject, summary: r.summary,
          ...(r.decision_status ? { decision_status: r.decision_status } : r.label.startsWith('決策') ? { decision_status: '草稿' } : {}),
        }));
      },
    },
    {
      name: 'get_item',
      readOnly: true,
      description: '用 mail_id 讀一則 Hub 項目的原文（唯讀，不會標為已讀）。',
      input_schema: {
        type: 'object', additionalProperties: false, required: ['mail_id'],
        properties: { mail_id: { type: 'integer', minimum: 1 } },
      },
      async run({ mail_id }, { groupId }) {
        if (!(await store.itemBelongsToGroup(groupId, mail_id))) return { error: 'not found in this group' };
        const { message } = await mail.readMessage(mail_id);
        let body = message.body_md;
        try {
          const e = JSON.parse(body);
          body = { kind: e.kind, intent: e.intent, summary: e.summary, text: String(e.text ?? '').slice(0, 4000), links: e.links, unfinished: e.unfinished, status: e.status };
        } catch {
          body = String(body).slice(0, 4000);
        }
        return { mail_id: message.id, created_ts: message.created_ts, from: message.from, to: message.to, subject: message.subject, body };
      },
    },
  ];
}
