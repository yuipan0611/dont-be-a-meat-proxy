#!/bin/sh
set -eu
# Copies a built release into Caddy's dedicated public root. No Caddy commands.
exec node "$(dirname "$0")/publish.mjs" "$@"
