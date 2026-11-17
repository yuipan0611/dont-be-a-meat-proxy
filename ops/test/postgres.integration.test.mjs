import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '../..');
const composeFile = join(root, 'deploy/postgres/compose.yaml');
const op = join(root, 'ops/postgres');
const migrationNames = [
  '20261117000000_compat_supabase_roles.sql',
  '20261117000100_hub_core_tables.sql',
  '20261117000200_hub_rls_and_grants.sql',
  '20261118000000_hub_clock_align_h05.sql',
  '20261119000000_l03_discord_bot.sql',
  '20261120000000_l05_decisions.sql',
  '20261121000000_l08_group_boundaries.sql',
  '20261122000000_l08_l05_decision_groups.sql',
  '20261123000000_decision_mail_delivery.sql',
];
assert.deepEqual(readdirSync(join(root, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort(), migrationNames);
const migrationManifest = migrationNames.map(filename => ({ filename,
  sha256: createHash('sha256').update(readFileSync(join(root, 'supabase/migrations', filename))).digest('hex') }));

test('L-01 isolated pgvector deployment, atomic migrations, access control and daily backup restore', { timeout: 180000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'l01-'));
  const project = `l01-test-${process.pid}`;
  const privateDir = join(dir, 'private');
  mkdirSync(privateDir, { mode: 0o700 });
  const adminPassword = randomBytes(32).toString('hex');
  const appPassword = randomBytes(32).toString('hex');
  writeFileSync(join(privateDir, 'postgres.password'), adminPassword, { mode: 0o600 });
  writeFileSync(join(privateDir, 'hub-app.password'), appPassword, { mode: 0o600 });
  cpSync(join(root, 'supabase'), join(dir, 'supabase'), { recursive: true });
  const env = { ...process.env, HUB_PG_PROJECT: project, HUB_PRIVATE_DIR: privateDir, HUB_PG_SQL_DIR: join(dir, 'supabase') };
  const run = (file, args, options = {}) => execFileSync(file, args, { cwd: root, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options });
  const compose = (...args) => run('docker', ['compose', '-p', project, '-f', composeFile, ...args]);
  const pg = (command, args = [], options = {}) => run('bash', [op, command, ...args], options);
  const sql = query => pg('psql', ['-Atqc', query]).trim();
  const assertLedger = (database = 'hub') => assert.deepEqual(JSON.parse(pg('psql', ['-d', database, '-Atqc',
    "select json_agg(json_build_object('filename',filename,'sha256',sha256) order by filename) from _hub_ops.migrations"]).trim()), migrationManifest);
  t.after(() => { try { compose('down', '-v', '--remove-orphans'); } finally { rmSync(dir, { recursive: true, force: true }); } });

  await t.test('database service has a memory ceiling and no published ports', () => {
    const config = JSON.parse(compose('config', '--format', 'json'));
    assert.deepEqual(Object.keys(config.services), ['db']);
    assert.match(config.services.db.image, /@sha256:[0-9a-f]{64}$/);
    assert.ok(config.services.db.mem_limit <= 512 * 1024 * 1024);
    assert.equal(config.services.db.ports?.length ?? 0, 0);
    assert.ok(Object.values(config.networks).every(n => n.internal));
    compose('up', '-d', '--wait', '--wait-timeout', '90', 'db');
    const state = JSON.parse(run('docker', ['inspect', compose('ps', '-q', 'db').trim()]))[0];
    assert.deepEqual(state.HostConfig.PortBindings, {});
    assert.equal(state.HostConfig.Memory, 512 * 1024 * 1024);
    const arch = compose('exec', '-T', 'db', 'uname', '-m').trim();
    assert.equal(arch, env.HUB_PG_PLATFORM === 'linux/arm64' ? 'aarch64' : 'x86_64');
    console.log(`ARCH=${arch}`);
  });
  await t.test('migrations are applied once, pgvector works, production remains unseeded', () => {
    const receipt = pg('migrate');
    assert.ok(!receipt.includes(appPassword) && !receipt.includes(adminPassword));
    assert.deepEqual([...receipt.matchAll(/^APPLY (.+)$/gm)].map(m => m[1]), migrationNames);
    assertLedger();
    assert.equal(sql('select count(*) from public.devices'), '0');
    assert.equal(sql("select '[1,2,3]'::extensions.vector OPERATOR(extensions.<->) '[1,2,3]'::extensions.vector"), '0');
    const repeated = pg('migrate');
    assert.deepEqual([...repeated.matchAll(/^SKIP (.+)$/gm)].map(m => m[1]), migrationNames);
    assertLedger();
    console.log(`MEMORY=${compose('stats', '--no-stream', '--format', '{{.MemUsage}}').trim()}`);
    console.log(`PG=${sql('show server_version')} vector=${sql("select extversion from pg_extension where extname='vector'")}`);
  });
  await t.test('malformed app secret is rejected before migration or credential changes', () => {
    const secret = join(privateDir, 'hub-app.password');
    writeFileSync(secret, 'invalid-local-test-value');
    try {
      assert.throws(() => pg('migrate'), /64 lowercase hex/);
      assertLedger();
    } finally {
      writeFileSync(secret, appPassword);
    }
  });
  await t.test('SQL failure rolls back the batch; edited applied migrations fail closed', () => {
    const bad = join(dir, 'supabase/migrations/20261119000000_failure.sql');
    writeFileSync(bad, 'create table public.must_rollback(id int); select 1/0;');
    try {
      assert.throws(() => pg('migrate'), /division by zero/);
      assert.equal(sql("select to_regclass('public.must_rollback') is null"), 't');
      assertLedger();
    } finally {
      rmSync(bad);
    }
    const first = join(dir, 'supabase/migrations/20261117000000_compat_supabase_roles.sql');
    writeFileSync(first, readFileSync(first, 'utf8') + '\n-- drift\n');
    try {
      assert.throws(() => pg('migrate'), /checksum|changed/i);
      assertLedger();
    } finally {
      cpSync(join(root, 'supabase/migrations/20261117000000_compat_supabase_roles.sql'), first);
    }
  });
  await t.test('existing Supabase SQL suite passes in a disposable database', () => {
    pg('psql', ['-c', 'create database hub_rls_test template hub']);
    pg('psql', ['-d', 'hub_rls_test', '-f', '/supabase/seed.sql']);
    const result = spawnSync('bash', [op, 'psql', '-d', 'hub_rls_test', '-f', '/supabase/tests/rls_test.sql'], { env, encoding: 'utf8' });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 0, output);
    assert.deepEqual([...output.matchAll(/\b(T\d+[a-z]?) PASS:/g)].map(m => m[1]),
      ['T1', 'T2', 'T3', 'T4', 'T5a', 'T5b', 'T6a', 'T6b', 'T7a', 'T7b', 'T7c', 'T7d', 'T8', 'T9', 'T10']);
    assert.match(output, /ALL RLS TESTS PASSED/);
    console.log(output.trim());
    pg('psql', ['-c', 'drop database hub_rls_test']);
    assert.equal(sql('select count(*) from devices'), '0');
  });
  await t.test('real TCP app login defaults to service_role and cannot connect to other databases', () => {
    const login = (database, query) => compose('exec', '-T', 'db', 'bash', '-ceu', 'export PGPASSWORD="$(cat /run/secrets/hub_app_password)"; exec psql -X -h 127.0.0.1 -U hub_app -d "$1" -Atqc "$2"', '--', database, query);
    assert.equal(login('hub', 'select session_user, current_user').trim(), 'hub_app|service_role');
    assert.equal(login('hub', 'select count(*) from devices').trim(), '0');
    assert.throws(() => login('hub', "update audit_log set action='tamper'"), /permission denied/);
    assert.throws(() => login('postgres', 'select 1'), /permission denied/);
    assert.throws(() => login('template1', 'select 1'), /permission denied/);
    sql('create database hindsight');
    sql('revoke connect on database hindsight from public');
    assert.throws(() => login('hindsight', 'select 1'), /permission denied/);
  });
  await t.test('restart preserves committed data and migration history', () => {
    sql("insert into groups(id,display_name,project_key,mail_hostname) values ('group-a','繁中備份 🚀','/data/projects/group-a','hub.local')");
    compose('restart', 'db');
    compose('up', '-d', '--wait', '--wait-timeout', '60', 'db');
    assert.equal(sql('select display_name from groups'), '繁中備份 🚀');
    assertLedger();
  });
  await t.test('daily archive includes a valid pg_dump; restore preserves data, ACL and ledger', () => {
    const data = join(dir, 'mail'); mkdirSync(data);
    run('sqlite3', [join(data, 'mail.sqlite3'), 'create table messages(id int); insert into messages values(1);']);
    const backups = join(dir, 'backups');
    const backupEnv = { ...env, HUB_PG_BACKUP: '1', HUB_DATA_DIR: data, HUB_STATE_DIR: privateDir, HUB_CLOCK_DIR: join(dir, 'clock'), CADDY_SNIPPET: join(dir, 'absent'), CADDY_PRIVATE_DIR: join(dir, 'absent'), BACKUP_DIR: backups };
    run('bash', [join(root, 'ops/backup'), '--quiet'], { env: backupEnv });
    const archive = join(backups, readdirSync(backups).find(f => f.endsWith('.tar.gz')));
    assert.equal(statSync(archive).mode & 0o777, 0o600);
    const extracted = join(dir, 'extracted'); mkdirSync(extracted); run('tar', ['-xzf', archive, '-C', extracted]);
    const dump = readFileSync(join(extracted, 'postgres/hub.dump'));
    const manifest = JSON.parse(readFileSync(join(extracted, 'manifest.json')));
    assert.equal(manifest.postgres.present, true);
    assert.equal(manifest.postgres.sha256, createHash('sha256').update(dump).digest('hex'));
    pg('verify-dump', [], { input: dump });
    sql('create database hub_restore');
    run('docker', ['compose', '-p', project, '-f', composeFile, 'exec', '-T', 'db', 'pg_restore', '-U', 'postgres', '-d', 'hub_restore', '--no-owner', '--exit-on-error'], { input: dump });
    assert.equal(pg('psql', ['-d', 'hub_restore', '-Atqc', 'select display_name from groups']).trim(), '繁中備份 🚀');
    assertLedger('hub_restore');
    assert.equal(pg('psql', ['-d', 'hub_restore', '-Atqc', "select has_table_privilege('anon','devices','SELECT'), has_table_privilege('service_role','audit_log','UPDATE'), count(*) filter(where relrowsecurity) from pg_class where relnamespace='public'::regnamespace and relkind='r'"]).trim(), 'f|f|14');
    // The original SQLite restore verification remains compatible with the extended manifest.
    run('bash', [join(root, 'ops/restore'), '--backup', archive, '--verify-only']);
  });
  await t.test('enabled Postgres backup fails without publishing an incomplete archive when DB is down', () => {
    compose('stop', 'db');
    const backups = join(dir, 'failed-backups');
    assert.throws(() => run('bash', [join(root, 'ops/backup'), '--quiet'], { env: { ...env, HUB_PG_BACKUP: '1', HUB_DATA_DIR: join(dir, 'mail'), HUB_STATE_DIR: privateDir, HUB_CLOCK_DIR: join(dir, 'clock'), CADDY_SNIPPET: join(dir, 'absent'), CADDY_PRIVATE_DIR: join(dir, 'absent'), BACKUP_DIR: backups } }));
    assert.equal(readdirSync(backups).length, 0);
  });
});
