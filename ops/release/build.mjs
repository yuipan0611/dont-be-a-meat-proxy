#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

import { runtimeFiles, installerFiles, releaseManifest } from '../../client/hub-release.mjs';

const files = [...runtimeFiles].sort();
const git = (...args) => execFileSync('git', args, { maxBuffer: 10 * 1024 * 1024 });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const dump = (value) => JSON.stringify(value, null, 2) + '\n';

try {
  const { values: { ref, version, out } } = parseArgs({ options: {
    ref: { type: 'string', default: 'master' }, version: { type: 'string' }, out: { type: 'string' },
  } });
  if (!out || (version?.length ?? 0) > 64 || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/.test(version ?? '')) {
    throw new Error('Usage: node ops/release/build.mjs --version X.Y.Z --out DIRECTORY [--ref master]');
  }
  const commit = git('rev-parse', '--verify', '--end-of-options', ref + '^{commit}').toString().trim();
  const manifest = { version, commit, archives: {}, files: {}, bootstrap_sha256: '' };
  // Read committed blobs only, with a fixed runtime allowlist and no working-tree input.
  for (const file of [...files, ...installerFiles]) {
    const entry = git('ls-tree', commit, '--', file).toString();
    if (!/^100(?:644|755) blob /.test(entry)) throw new Error('Expected a committed regular file: ' + file);
    manifest.files[file] = sha256(git('show', commit + ':' + file));
  }
  mkdirSync(out, { recursive: true });
  for (const format of ['tar.gz', 'zip']) {
    const name = `hub-client-${version}-${commit}.${format}`;
    // Store ZIP entries and gzip the uncompressed tar with Node. Older Git uses an
    // external gzip that rejects level zero. Commit time fixes archive entry timestamps.
    const args = ['-c', 'tar.umask=0022', 'archive',
      ...(format === 'zip' ? ['--format=zip', '-0'] : ['--format=tar']), commit, '--', ...files];
    const archive = execFileSync('git', args, { env: { ...process.env, TZ: 'UTC' }, maxBuffer: 10 * 1024 * 1024 });
    const bytes = format === 'zip' ? archive : gzipSync(archive, { level: 0 });
    if (format === 'tar.gz') bytes[9] = 255; // Gzip OS field: independent of the builder host.
    writeFileSync(join(out, name), bytes);
    manifest.archives[format] = { name, sha256: sha256(bytes) };
  }
  const bootstrap = git('show', commit + ':client/hub-release.mjs');
  manifest.bootstrap_sha256 = sha256(bootstrap);
  writeFileSync(join(out, 'bootstrap.mjs'), bootstrap);
  for (const script of ['install.sh', 'install.ps1']) {
    writeFileSync(join(out, script), git('show', commit + ':install/' + script));
  }
  releaseManifest(manifest);
  writeFileSync(join(out, 'manifest.json'), dump(manifest));
  console.log(`Built Hub ${version} from ${commit}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
