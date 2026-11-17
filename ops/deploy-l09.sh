#!/usr/bin/env bash
# Root-only launch driver. No shell sourcing, xtrace, or secret-bearing output.
set -euo pipefail
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/l09_launch.py" "$@"
