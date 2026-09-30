#!/usr/bin/env bash
# klh-local installer — deploys bin/ to ~/.local/klh-local (the stable runtime
# path; ~/.local/bin/klh-local symlinks into it), bootstraps the bar dashboard
# LaunchAgent (com.klh-local.dashboard), and registers the dashboard itself as
# a klh-local service: bar → :7792, served by caddy at http://bar.local/.
# Idempotent: re-running converges (register converges by design; the agent is
# bootout+bootstrap'd; bin/ files are refreshed in place).
#   ./install.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${KLH_LOCAL_PREFIX:-$HOME/.local/klh-local}"

command -v bun >/dev/null || { echo "klh-local needs bun — https://bun.sh first"; exit 1; }

echo "→ deploying bin/ to $PREFIX"
mkdir -p "$PREFIX/bin"
for item in "$REPO_DIR"/bin/*; do
  cp -R "$item" "$PREFIX/bin/"
done
chmod +x "$PREFIX"/bin/*.ts
mkdir -p "$HOME/.local/bin"
ln -sfn "$PREFIX/bin/klh-local.ts" "$HOME/.local/bin/klh-local"
echo "→ bin/ in place (klh-local → $PREFIX/bin/klh-local.ts)"

echo "→ klh-local install (caddy + user LaunchAgent + Caddyfile — no-ops when already present)"
bun "$PREFIX/bin/klh-local.ts" install

# bar — the status dashboard, fronted by caddy at http://bar.local/
if [[ "$(uname)" == "Darwin" ]]; then
  echo "→ bar LaunchAgent (com.klh-local.dashboard)"
  uid="$(id -u)"
  out="$HOME/Library/LaunchAgents/com.klh-local.dashboard.plist"
  sed -e "s|__HOME__|$HOME|g" "$REPO_DIR/launchd/com.klh-local.dashboard.plist" >"$out"
  plutil -lint "$out" >/dev/null
  launchctl bootout "gui/$uid/com.klh-local.dashboard" 2>/dev/null || true
  if ! launchctl bootstrap "gui/$uid" "$out"; then
    sleep 1
    launchctl bootstrap "gui/$uid" "$out"
  fi
fi

echo "→ registering bar (bar.local → 127.0.0.1:7792)"
bun "$PREFIX/bin/klh-local.ts" register bar --port 7792 --health /

echo
echo "done. next:"
echo "  board    http://bar.local/            (json: /api/status · intro: /llms.txt)"
echo "  status   klh-local status"
echo "  agent    launchctl print gui/$(id -u)/com.klh-local.dashboard"

# ─── release notify: the distributed changelog (2026-09-30) ───
# every deploy announces the live version on the coord bus; every session
# sees it at next poll or SessionStart. Fresh machines (no coord) skip.
COORD="$HOME/.claude/hooks/suspenders/bin/coord.ts"
if [ -f "$COORD" ]; then
  REL_VER=$(git -C "$REPO_DIR" describe --tags --abbrev=0 2>/dev/null || echo unknown)
  REL_NOTE=$(git -C "$REPO_DIR" tag -l --format='%(contents:subject)' "$REL_VER" 2>/dev/null | head -1)
  bun "$COORD" emit RELEASE --scope klh-local --version "$REL_VER" \
    --note "${REL_NOTE:-deployed}" --as installer >/dev/null 2>&1 || true
fi
