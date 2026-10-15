#!/usr/bin/env bash
# suspenders installer — one-line wrapper (W771.3 front-flip): every step and
# flag is native TS; execute the installer directly on any platform:
#   bun scripts/install.ts [--yes] [--json] [--dry-run] [--step <name>] ...
# This wrapper keeps the documented bash door working; it is a pure exec.
set -euo pipefail
exec bun "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/install.ts" "$@"
