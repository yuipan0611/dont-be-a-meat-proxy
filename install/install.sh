#!/bin/sh
set -eu
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 22 ? 1 : 0)'; then
  printf '%s\n' 'Hub requires Node.js 22 or newer. Download: https://nodejs.org/en/download' >&2
  exit 1
fi
umask 077
work=$(mktemp -d "${TMPDIR:-/tmp}/hub-install.XXXXXXXX")
trap 'rm -rf "$work"' 0
trap 'exit 1' HUP INT TERM
url=${HUB_DIST_URL:-https://hub.example.invalid/dist/}
# Node validates the origin before downloading the shared bootstrap.
node --input-type=module -e '
  import { writeFileSync } from "node:fs";
  const base = process.argv[1];
  if (base !== "https://hub.example.invalid/dist/" && !/^http:\/\/127\.0\.0\.1:\d+\/dist\/$/.test(base)) {
    throw new Error("Invalid Hub distribution URL");
  }
  const r = await fetch(base + "bootstrap.mjs", { redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("Hub bootstrap download failed (HTTP " + r.status + ")");
  writeFileSync(process.argv[2], new Uint8Array(await r.arrayBuffer()), { flag: "wx", mode: 0o600 });
' "$url" "$work/bootstrap.mjs"
if [ -t 0 ]; then
  node "$work/bootstrap.mjs" install tar.gz
else
  # curl | sh owns stdin. Ask for credentials on the controlling terminal.
  node "$work/bootstrap.mjs" install tar.gz </dev/tty
fi
