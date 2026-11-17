// registry-pg.mjs — L-02 token registry backed by the L-01 hub database (docs/08 §devices).
//
// lookup(sha256 hex) → the active device of an active member whose group has a bank, or null.
// Queried on every request (no cache) so revocation_pending / revoked take effect immediately.
// Runs as hub_app (service_role, server-side only — docs/08 「最小版本先共用 hub_app」).

import pg from 'pg';

export const LOOKUP_SQL = `
select d.token_id, d.group_id, g.bank_id, m.display_name, d.label
from public.devices d
join public.members m on m.id = d.member_id and m.group_id = d.group_id
join public.groups g on g.id = d.group_id
where d.token_hash = $1 and d.status = 'active' and m.status = 'active' and g.bank_id is not null and d.group_id = $2`;

/**
 * @param {object} o
 * @param {string} o.host  db (on hub-db-net)
 * @param {string} o.password  hub_app password (secret file)
 */
export function createPgRegistry({ host, port = 5432, database = 'hub', user = 'hub_app', password, groupId = 'group-a', max = 3 }) {
  const pool = new pg.Pool({
    host, port, database, user, password, max,
    connectionTimeoutMillis: 3_000, idleTimeoutMillis: 30_000, statement_timeout: 3_000,
    application_name: 'bank-proxy',
  });
  pool.on('error', () => {}); // an idle client dropping must not crash the proxy; the next query reports it
  return {
    async lookup(tokenHash) {
      if (!/^[0-9a-f]{64}$/.test(tokenHash)) return null;
      const { rows } = await pool.query(LOOKUP_SQL, [tokenHash, groupId]);
      if (rows.length !== 1) return null;
      const r = rows[0];
      return { tokenId: r.token_id, groupId: r.group_id, bankId: r.bank_id, principal: `${r.display_name} / ${r.label}` };
    },
    end: () => pool.end(),
  };
}
