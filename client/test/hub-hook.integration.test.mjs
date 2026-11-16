// H-04 integration: real hub-hook.mjs processes (two "machines": BlueLake = Mac, RedStone = Windows)
// against a real local mcp_agent_mail_rust 0.3.40. Skipped (not passed) when the binary is absent.
// What this cannot cover: real Claude sessions and two physical machines (H-08).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMailClient } from '../mail-client.mjs';
import { startLocalMail, mailBinAvailable } from './helpers/local-mail-server.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hub-hook.mjs');
const PROJECT = '/data/projects/group-a';
const skip = !(await mailBinAvailable()) && 'mcp-agent-mail binary not found (set MAIL_BIN)';
const TEMPLATE = JSON.parse(await readFile(new URL('../templates/hub-client.json', import.meta.url), 'utf8'));

let hub, tmp, mac, win, clockAgent, clockName;

async function register(name) {
  // name undefined → Mail generates one (what H-02 does for HubClock, since 'HubClock' is rejected).
  const op = createMailClient({ url: hub.url, token: hub.token, projectKey: PROJECT, agentName: name ?? 'tmp' });
  await op.callTool('ensure_project', { human_key: PROJECT });
  const reg = await op.callTool('register_agent', { project_key: PROJECT, ...(name ? { name } : {}), program: 'h04-it', model: 'none' });
  const agentName = reg.name ?? reg.agent?.name ?? name;
  await op.callTool('set_contact_policy', { project_key: PROJECT, agent_name: agentName, policy: 'open' });
  return name ? reg.registration_token : { agentName, token: reg.registration_token };
}

async function machine(agent, senderToken, { url, tag = agent } = {}) {
  const projectDir = join(tmp, `proj-${tag}`);
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, 'hub-client.json'), JSON.stringify({ ...TEMPLATE, hub_mail_url: url ?? hub.url, clock_agent: clockName }));
  const env = {
    ...process.env, HUB_TOKEN: hub.token, HUB_AGENT: agent, HUB_SENDER_TOKEN: senderToken,
    HUB_DATA_DIR: join(tmp, `data-${tag}`), CLAUDE_PROJECT_DIR: projectDir,
  };
  delete env.HUB_MAIL_URL;
  /** Runs one hook/command as a real child process, like Claude Code does (exec form, JSON on stdin). */
  const run = (args, input = {}, extraEnv = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, ...args], { env: { ...env, ...extraEnv }, cwd: projectDir });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
    run.last = child;
  });
  return { agent, run, env };
}

before(async () => {
  if (skip) return;
  hub = await startLocalMail();
  tmp = await mkdtemp(join(tmpdir(), 'hubhook-it-'));
  const clock = await register(undefined);
  clockName = clock.agentName;
  clockAgent = createMailClient({ url: hub.url, token: hub.token, projectKey: PROJECT, agentName: clockName });
  mac = await machine('BlueLake', await register('BlueLake'));
  win = await machine('RedStone', await register('RedStone'));
});

after(async () => {
  await hub?.stop();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

const ctxOf = (r) => JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
const TC02_TEXT = 'TC02 交接：登入頁 Figma 已完成，下一步實作 /login 路由，截止 11/20。PR：https://github.com/example-org/example-repo/pull/1';

test('TC-02 (simulated): Mac leaves a handoff and exits; a new Windows session gets it verbatim first, then not again', { skip }, async () => {
  await mac.run(['start'], { session_id: 'mac-s1', hook_event_name: 'SessionStart' });
  const sent = await mac.run(['send'], {
    to: ['RedStone'], subject: 'TC02 交接', kind: 'handoff', summary: '登入頁 Figma 完成；下一步 /login，截止 11/20',
    text: TC02_TEXT, links: ['https://github.com/example-org/example-repo/pull/1'], unfinished: ['/login 路由'],
  });
  assert.equal(sent.code, 0, sent.stderr);
  const id = Number(sent.stdout.match(/^已保存 #(\d+)/)[1]);
  const end = await mac.run(['end'], { session_id: 'mac-s1', reason: 'prompt_input_exit' });
  assert.equal(end.code, 0, end.stderr);

  const s1 = await win.run(['start'], { session_id: 'win-s1', hook_event_name: 'SessionStart' });
  assert.equal(s1.code, 0, s1.stderr);
  const c = ctxOf(s1);
  assert.match(c, new RegExp(`#${id}｜`));
  assert.ok(c.includes(TC02_TEXT), 'verbatim original');
  assert.match(c, /專案現況：最近 5 則交接/);

  const inbox = await win.run(['inbox']);
  assert.match(inbox.stdout, /沒有給你的新項目/);
  const s2 = await win.run(['start'], { session_id: 'win-s2' });
  assert.match(ctxOf(s2), /沒有給你的新項目/);
});

test('session end reports session.closed to the (generated-name) HubClock on the real Hub, in the H-05 shape', { skip }, async () => {
  assert.notEqual(clockName, 'HubClock');
  const { events } = await clockAgent.fetchEvents({});
  const closed = [];
  for (const e of events) closed.push(JSON.parse((await clockAgent.readMessage(e.message_id)).message.body_md));
  assert.ok(closed.some((b) => b.v === 1 && b.event_type === 'session.closed' && b.root_mail_id === null && b.recipient_session === 'mac-s1' && b.agent === 'BlueLake'));
});

test('question → reply with replyTo: HubClock gets the question (CC) and an answer control; the reply stays in the root thread', { skip }, async () => {
  await mac.run(['start'], { session_id: 'mac-q' });
  await win.run(['start'], { session_id: 'win-q' });
  const q = await mac.run(['send'], { to: ['RedStone'], subject: 'README 第一行？', kind: 'help', intent: 'question', summary: '問 README', text: 'README 第一行是什麼？' });
  assert.equal(q.code, 0, q.stderr);
  const qid = Number(q.stdout.match(/#(\d+)/)[1]);
  await win.run(['inbox']);
  const a = await win.run(['send'], { replyTo: qid, summary: '答', text: '# 燈塔專案' });
  assert.equal(a.code, 0, a.stderr);
  const aid = Number(a.stdout.match(/#(\d+)/)[1]);
  const { events } = await clockAgent.fetchEvents({});
  const got = [];
  for (const e of events) got.push((await clockAgent.readMessage(e.message_id)).message);
  assert.ok(got.some((m) => m.id === qid), 'question reaches HubClock');
  assert.ok(!got.some((m) => m.id === aid), 'the answer item itself is not CC to HubClock');
  const ans = got.map((m) => ({ m, c: JSON.parse(m.body_md) })).find(({ c }) => c.event_type === 'answer' && c.root_mail_id === qid);
  assert.ok(ans, 'answer control reached HubClock');
  const reply = (await win.run(['read', String(aid)])).stdout;
  assert.match(reply, /同一串裡的回覆/);
  await mac.run(['inbox']); await mac.run(['read', String(aid)]);
});

test('TC-04 (simulated): empty inbox is stated explicitly; an unreachable Hub is stated as "cannot fetch"', { skip }, async () => {
  await mac.run(['start'], { session_id: 'mac-s2a' }); // takes in anything still unread from earlier tests
  const r = await mac.run(['start'], { session_id: 'mac-s2' });
  assert.match(ctxOf(r), /沒有給你的新項目/);
  const offline = await machine('BlueLake', mac.env.HUB_SENDER_TOKEN, { url: 'http://127.0.0.1:9/mcp/', tag: 'BlueLake-offline' });
  const off = await offline.run(['start'], { session_id: 'mac-off' });
  assert.match(ctxOf(off), /無法取得交接與專案現況/);
  assert.doesNotMatch(ctxOf(off), /沒有給你的新項目/);
  const send = await offline.run(['send'], { to: ['RedStone'], subject: 'x', summary: 's', text: 't' });
  assert.equal(send.code, 1);
  assert.match(send.stderr, /未送達/);
  assert.doesNotMatch(send.stdout, /已保存/);
});

/**
 * TC-13 / NFR-01 (simulated on one machine, real 15 s polling): A starts a real `watch` process for B,
 * sends; B's watcher wakes (exit 2); B reads the original and sends a receipt; A's watcher wakes on it.
 * Round trip is measured on A's monotonic clock, as SDS CLI-02 prescribes. n = 5 per direction.
 */
test('TC-13 (simulated): send → wake → read → receipt round trip ≤ 60 s, n = 5 per direction', { skip, timeout: 900_000 }, async () => {
  const rows = [];
  for (const [a, b] of [[mac, win], [win, mac]]) {
    for (let i = 1; i <= 5; i++) {
      const sid = (m) => `${m.agent}-tc13`;
      await a.run(['start'], { session_id: sid(a) });
      await b.run(['start'], { session_id: sid(b) });
      const watchB = b.run(['watch'], { session_id: sid(b), hook_event_name: 'Stop' });
      const watchA = a.run(['watch'], { session_id: sid(a), hook_event_name: 'Stop' });
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 15_000)); // random phase against the poll
      const t0 = performance.now();
      const sent = await a.run(['send'], { to: [b.agent], subject: `TC13 ${a.agent}→${b.agent} #${i}`, kind: 'help', intent: 'question', summary: `ping ${i}`, text: `ping ${i}` });
      assert.equal(sent.code, 0, sent.stderr);
      const id = Number(sent.stdout.match(/#(\d+)/)[1]);
      const wb = await watchB;
      const tWakeB = performance.now();
      assert.equal(wb.code, 2, wb.stderr);
      assert.match(wb.stderr, new RegExp(`Hub 新訊息 #${id}（不是錯誤）`));
      const read = await b.run(['read', String(id)]);
      assert.ok(read.stdout.includes(`ping ${i}`));
      const receipt = await b.run(['send'], { to: [a.agent], subject: `receipt #${id}`, kind: 'help', intent: 'action', summary: `已讀 #${id}`, text: `已讀原文 #${id}` });
      assert.equal(receipt.code, 0, receipt.stderr);
      const wa = await watchA;
      const tRound = performance.now();
      assert.equal(wa.code, 2, wa.stderr);
      assert.match(wa.stderr, /receipt/);
      await a.run(['read', receipt.stdout.match(/#(\d+)/)[1]]);
      rows.push({ dir: `${a.agent}→${b.agent}`, i, wakeB: (tWakeB - t0) / 1000, roundTrip: (tRound - t0) / 1000 });
    }
  }
  console.log('TC-13 rows (seconds):\n' + rows.map((r) => `${r.dir} #${r.i}  send→B wake ${r.wakeB.toFixed(2)}  round trip ${r.roundTrip.toFixed(2)}`).join('\n'));
  for (const r of rows) assert.ok(r.roundTrip <= 60, `${r.dir} #${r.i} round trip ${r.roundTrip}s`);
});
