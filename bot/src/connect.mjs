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
  const mcpUrl = new URL('/mcp/', hubUrl).href;

  function newToken() {
    const token = `mph_${randomBytes(32).toString('base64url')}`; // 256-bit
    return { token, tokenId: `tok_${randomBytes(8).toString('hex')}`, tokenPrefix: token.slice(0, 8), tokenHash: sha256(token) };
  }

  async function connect({ member, label, platform, requestId, actorId }) {
    if (!PLATFORMS.includes(platform)) return { ok: false, text: `平台只能是 ${PLATFORMS.join('／')}。` };
    const cleanLabel = String(label ?? '').replace(/[\r\n]/g, ' ').trim().slice(0, 40) || platform;
    const t = newToken();
    await store.issueDevice({
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
      await store.requestRevocation({ tokenId: t.tokenId, memberId: member.memberId, actorId: 'bot', reason: `issue_${res.status}`, requestId });
      log({ ev: 'connect.failed', tokenId: t.tokenId, status: res.status });
      return { ok: false, text: '發放失敗：Hub 沒有確認套用這把 token（已作廢，不能使用）。請稍後再試；持續失敗請找 operator。' };
    }
    await store.audit({ groupId: member.groupId, actorType: 'bot', actorId, action: 'device.issue.applied', targetTable: 'devices', targetId: t.tokenId, requestId, details: { config_revision: res.configRevision ?? null } });
    return { ok: true, tokenId: t.tokenId, text: renderConnect({ mcpUrl, token: t.token, tokenId: t.tokenId, label: cleanLabel }) };
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

export function renderConnect({ mcpUrl, token, tokenId, label }) {
  return [
    `**${label} 的接入設定**（只有你看得到；這把 token 只顯示這一次）`,
    'Claude Code（Mac／Windows 終端機貼上一行）：',
    '```',
    `claude mcp add --transport http hub ${mcpUrl} --header "Authorization: Bearer ${token}"`,
    '```',
    `Token ID：\`${tokenId}\`（撤銷時用 \`/revoke ${tokenId}\`）`,
    '保存與刪除：這把 token 等同你這台裝置的密碼，只存在你的工具設定裡，不要貼到聊天或文件。Hub 只保存它的雜湊；遺失無法重看，請撤銷後重新 /connect。專案資料保存到 2027-03-31 後刪除。',
  ].join('\n');
}
