// connect.mjs — /connect and /revoke (US-12, SR-ID-05, SDS API-05, docs/08 §5).
//
// /connect issues a NEW per-device token every time (old ones stay valid). The raw token exists
// only in (a) this ephemeral reply and (b) the TokenApplier credential file the host helper turns
// into the Caddy allowlist; the DB keeps sha256 + prefix. The reply is sent only after the
// applier confirms Caddy validate+reload; otherwise the row is moved to revocation_pending
// (fail closed — it can never come back as active).
//
// /revoke: active → revocation_pending (bank-proxy rejects immediately) → applier → revoked only
// after the applier reports the reload AND a 401 probe with the old token. Anything else stays
// pending and is reported as not finished.

import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';

export const PLATFORMS = Object.freeze(['macos', 'windows', 'linux']);
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

export function createConnect({ store, applier, hubUrl, randomBytes = nodeRandomBytes, log = () => {} }) {
  const onboarding = new URL('/install.sh', hubUrl).origin;

  function newToken() {
    const token = `mph_${randomBytes(32).toString('base64url')}`; // 256-bit
    return { token, tokenId: `tok_${randomBytes(8).toString('hex')}`, tokenPrefix: token.slice(0, 8), tokenHash: sha256(token) };
  }

  async function connect({ member, label, platform, requestId, actorId }) {
    if (!PLATFORMS.includes(platform)) return { ok: false, text: `平台只能是 ${PLATFORMS.join('／')}。` };
    const cleanLabel = String(label ?? '').replace(/[\r\n]/g, ' ').trim().slice(0, 40) || platform;
    const t = newToken();
    const agents = await store.issueDevice({
      memberId: member.memberId, groupId: member.groupId, label: `${member.displayName} / ${cleanLabel}`, platform,
      tokenId: t.tokenId, tokenPrefix: t.tokenPrefix, tokenHash: t.tokenHash, actorId, requestId,
    });
    let res;
    try {
      res = await applier.issue({ requestId, groupId: member.groupId, tokenId: t.tokenId, token: t.token });
    } catch (e) {
      res = { status: 'unknown', error: e.message };
    }
    if (res.status !== 'applied') {
      // Independent durable cancellation also survives an outage of the bot's DB connection.
      try { await applier.cancelIssue?.({ requestId, groupId: member.groupId, tokenId: t.tokenId }); }
      catch { log({ ev: 'connect.cancel_queue_failed', tokenId: t.tokenId }); }
      await store.requestRevocation({ tokenId: t.tokenId, memberId: member.memberId, actorId: 'bot', reason: `issue_${res.status}`, requestId });
      log({ ev: 'connect.failed', tokenId: t.tokenId, status: res.status });
      return { ok: false, text: '發放失敗：Hub 沒有確認套用這把 token，已標記待撤銷，背景會持續核對直到確認拒絕；目前不能宣稱入口已撤銷。請稍後再試；持續失敗請找 operator。' };
    }
    await store.audit({ groupId: member.groupId, actorType: 'bot', actorId, action: 'device.issue.applied', targetTable: 'devices', targetId: t.tokenId, requestId, details: { config_revision: res.configRevision ?? null } });
    return { ok: true, tokenId: t.tokenId, text: renderConnect({ onboarding, token: t.token, tokenId: t.tokenId, label: cleanLabel, platform, groupId: member.groupId, agents }) };
  }

  async function revoke({ member, tokenId, requestId, actorId }) {
    const ok = await store.requestRevocation({ tokenId, memberId: member.memberId, actorId, reason: 'member_request', requestId });
    if (!ok) return { ok: false, text: `找不到你名下仍有效的 ${tokenId}。` };
    let res;
    try {
      res = await applier.revoke({ requestId, groupId: member.groupId, tokenId });
    } catch (e) {
      res = { status: 'unknown', error: e.message };
    }
    if (res.status === 'applied' && res.probe === 401) {
      await store.completeRevocation({ tokenId, actorId: 'bot', requestId, configRevision: res.configRevision ?? null });
      return { ok: true, text: `已撤銷 ${tokenId}：舊設定的下一個請求會被拒（已用舊 token 實測 401）。其他裝置不受影響；要重新接上請再打 /connect。` };
    }
    log({ ev: 'revoke.pending', tokenId, status: res.status, probe: res.probe });
    return { ok: false, text: `${tokenId} 已停用申請，但 Hub 還沒確認完成（狀態：待撤銷）。它不會再被重新開放；operator 會處理，完成前請不要當作已撤銷。` };
  }

  return { connect, revoke };
}

export function renderConnect({ onboarding, token, tokenId, label, platform, groupId, agents = [] }) {
  const names = agents.filter((name) => /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name));
  const agentLine = names.length === 1 ? `Agent：\`${names[0]}\``
    : names.length ? `Agent：${names.map((name) => `\`${name}\``).join('、')}（選這台裝置使用的名稱）`
      : 'Agent 尚未配發，請向 PM 取得這台裝置的 canonical agent 名稱。';
  const installer = platform === 'windows'
    ? `& ([scriptblock]::Create((Invoke-RestMethod '${onboarding}/install.ps1')))`
    : `curl -fsS '${onboarding}/install.sh' | sh`;
  return [
    `**${label} 的接入設定**（只有你看得到；這把 token 只顯示這一次）`,
    `平台：\`${platform}\`　組別：\`${groupId}\``,
    agentLine,
    '在專案資料夾開啟終端機，執行下方安裝指令。',
    '```',
    installer,
    '```',
    `Token：\`${token}\`（只貼到安裝器的隱藏提示）`,
    `Token ID：\`${tokenId}\`（撤銷時用 \`/revoke ${tokenId}\`）`,
    '保存與刪除：這把 token 等同你這台裝置的密碼，請勿貼到聊天或文件。遺失無法重看，請撤銷後重新 /connect。專案資料保存到 2027-03-31 後刪除。',
  ].join('\n');
}
