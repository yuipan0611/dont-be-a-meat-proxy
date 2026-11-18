// Stable entry point. The state file atomically selects one verified release.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

try {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('Hub requires Node.js 22 or newer. Download: https://nodejs.org/en/download');
  }
  const root = dirname(fileURLToPath(import.meta.url));
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?-[a-f0-9]{40}$/.test(state.current)) {
    throw new Error('Invalid installed Hub release ID');
  }
  const { main } = await import(pathToFileURL(join(root, 'releases', state.current, 'client/hub.mjs')).href);
  await main(state, process.argv.slice(2));
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exitCode = 1;
}
