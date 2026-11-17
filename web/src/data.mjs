import { createMailClient } from '../../client/mail-client.mjs';

export function safeLink(value, repo) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && u.hostname === 'github.com' &&
      u.pathname.startsWith(`/${repo}/`) ? u.href : null;
  } catch { return null; }
}
export function projectItem(m, map) {
  let e = {};
  try { e = JSON.parse(m.body_md); } catch {}
  if (!e || typeof e !== 'object' || Array.isArray(e)) e = {};
  const w = e.work_context && typeof e.work_context === 'object' ? e.work_context : {};
  const paths = Array.isArray(w.paths) ? w.paths.filter(p => typeof p === 'string' && !p.startsWith('/') && !p.includes('..')).slice(0, 40) : [];
  const componentIds = map.nodes.filter(n => (Array.isArray(w.components) && w.components.includes(n.id)) || paths.some(p => n.paths.some(prefix => p.startsWith(prefix)))).map(n => n.id);
  const links = [...new Set([...(Array.isArray(e.links) ? e.links : []), w.issue].map(v => safeLink(v, map.repo)).filter(Boolean))];
  return { id: String(m.id), subject: m.subject ?? '未命名紀錄', author: m.from ?? m.sender_name ?? '未知',
    createdAt: m.created_ts, kind: e.kind ?? 'legacy', summary: e.summary ?? '舊格式紀錄，請查看原文。', text: e.text ?? m.body_md ?? '',
    unfinished: Array.isArray(e.unfinished) ? e.unfinished : [],
    stage: ['in_progress','blocked','handoff','completed'].includes(w.stage) ? w.stage : 'unreported',
    components: componentIds, paths, links, symbols: Array.isArray(w.symbols)?w.symbols.filter(s=>Object.hasOwn(map.symbols??{},s)):[],
    hasCommit: links.some(l => /\/(commit|pull)\//.test(l)),
    verification: w.test_result ? `AI 回報：${String(w.test_result).slice(0, 500)}` : '尚無測試結果',
  };
}
export function createData({ pool, map, mailConfig, githubToken, fetchImpl = fetch, now = () => Date.now() }) {
  let cached = null;
  let pending = null;
  async function refresh() {
    const source = { mail: { ok: true }, github: { ok: true } };
    let items = cached?.items ?? [];
    let issues = cached?.issues ?? [];
    try {
      const client = createMailClient(mailConfig);
      const found = [];
      // Read-only topic retrieval never changes inbox or notification cursors.
      for (const topic of ['handoff','task','help','decision']) {
        const result = await client.callTool('fetch_topic', { project_key: mailConfig.projectKey, topic_name: topic, limit: 30, include_bodies: true });
        const messages = Array.isArray(result) ? result : result.messages;
        if (!Array.isArray(messages)) throw new Error('unexpected topic response');
        for (const m of messages) found.push(projectItem(m, map));
      }
      items = [...new Map(found.map(i => [i.id, i])).values()].sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 100);
      source.mail.updatedAt = new Date(now()).toISOString();
    } catch { source.mail = { ok: false, message: '訊息來源暫時無法讀取', updatedAt: cached?.sources.mail.updatedAt ?? null }; }
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${map.repo}/issues?state=all&sort=updated&per_page=50`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hub-project-guide', ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}) },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error('github unavailable');
      const rows = await res.json();
      if (!Array.isArray(rows)) throw new Error('github format');
      issues = rows.filter(i => !i.pull_request).map(i => ({ number: i.number, title: i.title, state: i.state, url: safeLink(i.html_url, map.repo), assignees: i.assignees?.map(a => a.login) ?? [] }));
      source.github.updatedAt = new Date(now()).toISOString();
    } catch { source.github = { ok: false, message: 'GitHub 暫時無法讀取', updatedAt: cached?.sources.github.updatedAt ?? null }; }
    cached = { items, issues, sources: source, fetchedAt: new Date(now()).toISOString(), expires: now() + 30_000 };
    return cached;
  }
  return {
    async member(discordId) {
      const r = await pool.query(`select m.id, m.group_id, m.display_name from public.members m join public.discord_links l on l.member_id=m.id where l.discord_user_id=$1 and l.guild_id=$2 and l.status='active' and m.status='active' and m.group_id=$3`, [discordId, mailConfig.guildId, mailConfig.groupId]);
      return r.rows[0] ?? null;
    },
    async snapshot(groupId) {
      if (groupId !== mailConfig.groupId) throw new Error('group denied');
      if (cached && cached.expires > now()) return cached;
      if (!pending) pending = refresh().finally(() => { pending = null; });
      return pending;
    },
  };
}
