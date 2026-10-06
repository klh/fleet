#!/usr/bin/env bash
# suspenders installer — copies the harness into ~/.claude/hooks/suspenders and
# optionally: --wire merges the hook registrations into ~/.claude/settings.json
# (per-event concat, never clobbers), --with-launchd installs the macOS agents.
# Idempotent: re-running just refreshes the files.
#   ./install.sh [--wire] [--with-launchd] [--dry-run] [--skip-models] [--no-llm]
# Default (owner law 2026-10-01): ALWAYS sets up the local-llm swarm and
# downloads the smallest-fit models (BELT_TIER=minimal residents).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${SUSPENDERS_PREFIX:-$HOME/.claude/hooks/suspenders}"

# flags (order-independent) — replaces the old positional $1/$2 checks
WIRE=0 WITH_LAUNCHD=0 DRY_RUN=0 SKIP_MODELS=0 NO_LLM=0 REFRESH_SUPERVISOR=0
REFRESH_DASHBOARDS=0
for arg in "$@"; do
  case "$arg" in
    --wire) WIRE=1 ;;
    --with-launchd) WITH_LAUNCHD=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --skip-models) SKIP_MODELS=1 ;;
    --no-llm) NO_LLM=1 ;;
    --refresh-supervisor) REFRESH_SUPERVISOR=1 ;;
    --refresh-dashboards) REFRESH_DASHBOARDS=1 ;;
    *) echo "unknown flag: $arg"; exit 2 ;;
  esac
done

LLM_HOME="$HOME/.claude/local-llm"
# kit source: packages/local-llm (W422.4) — a sibling package, not hooks/
KIT_DIR="$(cd "$REPO_DIR/.." && pwd)/local-llm"

# Safe GUI-only activation path; never runs registration, model or key setup.
if [[ $REFRESH_DASHBOARDS -eq 1 ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then
    bun "$REPO_DIR/scripts/refresh-dashboards.ts" --dry-run
  else
    bun "$REPO_DIR/scripts/refresh-dashboards.ts"
  fi
  exit 0
fi

# --dry-run: print the plan, touch nothing (bun read-only for the tier list)
if [[ $DRY_RUN -eq 1 ]]; then
  echo "dry-run — would:"
  echo "  install harness → $PREFIX (+ bun install)"
  if [[ $REFRESH_SUPERVISOR -eq 1 ]]; then
    echo "  refresh belt supervisor.ts only (backup previous code; preserve runtime config)"
  fi
  echo "  local-llm baseline → $LLM_HOME:"
  echo "    kit: swarm.ts (serve supervisor), spawner.ts, router-shim.ts,"
  echo "         registry.ts, belt.env + routing-policy.yaml stubs"
  echo "    registry/belt.env/routing-policy.yaml: only when absent"
  echo "    swarm.ts: refreshed when the copy lacks serve (revival fix)"
  echo "    models (BELT_TIER=minimal residents, resumable download):"
  BELT_TIER=minimal LOCAL_LLM_HOME="$KIT_DIR" bun -e '
const { residentSet } = await import(process.env.LOCAL_LLM_HOME + "/registry.ts");
for (const s of residentSet()) console.log("      " + s.model + " → :" + s.port);
' 2>/dev/null || echo "      (bun import failed — kit registry unreadable)"
  echo "    launchd: com.suspenders.local-llm (swarm.ts serve, KeepAlive)"
  exit 0
fi

command -v bun >/dev/null || { echo "suspenders needs bun — https://bun.sh first"; exit 1; }

echo "→ installing to $PREFIX"
mkdir -p "$PREFIX"
# W183.1 follow-up (W300) — local-llm rides along as a harness-relative copy
# too: hooks/board/local-swarm.ts imports registry.ts via a repo-relative
# path (../local-llm/registry.ts), which only resolves if $PREFIX has its
# own local-llm/ sibling to board/. This is separate from $LLM_HOME below
# (the swarm's runtime home, user-customizable, never clobbered) — this
# copy is pure harness code, refreshed every install like bin/lib/board.
for item in bin lib board-html coord board gates launchd rules gate.ts session-start.ts session-end.ts knowledgeworker.md; do
  cp -R "$REPO_DIR/hooks/$item" "$PREFIX/"
done
# the kit itself lives in packages/local-llm (W422.4) — harness copy sourced
# from there ($PREFIX/local-llm/, sibling of board/, feeds local-swarm.ts)
cp -R "$KIT_DIR" "$PREFIX/"
cp "$KIT_DIR/observation.ts" "$PREFIX/lib/observation.ts"
cp "$REPO_DIR/../belt/bin/inventory-probe.ts" "$PREFIX/lib/inventory-probe.ts"
# W422.5 — blam ships whole (manifest included): suspenders' manifest declares
# "blam": "workspace:*" + workspaces ["*"], so the bun install at $PREFIX
# (below) symlinks node_modules/blam -> blam/ and board's package-name import
# (blam/src/condense) resolves. Retires the W422.14 sed-on-copies hack.
rm -rf "$PREFIX/blam"
cp -R "$REPO_DIR/../blam" "$PREFIX/blam"
rm -rf "$PREFIX/blam/node_modules"
# authoring-time devDeps (belt/suspenders workspace:*) don't ship — bun
# --production still resolves member devDeps, so strip them from the copy
bun -e 'const p=process.argv[1];const j=JSON.parse(await Bun.file(p).text());delete j.devDependencies;await Bun.write(p,JSON.stringify(j,null,"\t")+"\n")' "$PREFIX/blam/package.json"
# W422.5: the manifest copies, the repo lockfile does NOT — its
# blam@workspace:packages/blam entry references repo paths that do not exist
# at $PREFIX, which hard-fails install. $PREFIX re-resolves from the ranges,
# so any stale PREFIX lockfile from earlier installs goes first.
rm -f "$PREFIX/bun.lock"
cp "$REPO_DIR/package.json" "$PREFIX/"
(cd "$PREFIX" && bun install --production) # --production: skip devDeps — blam's authoring-time belt/suspenders devDeps don't ship; shell-quote, for the bash gate
# Catch broken workspace links/imports before restarting the live services.
bun -e 'await import(process.argv[1])' "$PREFIX/board/prompt-transform.ts"
echo "→ harness in place"

# Targeted code upgrade for the advanced installed belt supervisor. The kit's
# older swarm implementation and operator-owned config must remain untouched.
if [[ $REFRESH_SUPERVISOR -eq 1 ]]; then
  SUPERVISOR_SOURCE="$REPO_DIR/../belt/bin/supervisor.ts"
  SUPERVISOR_TARGET="$LLM_HOME/supervisor.ts"
  if [[ ! -f "$SUPERVISOR_TARGET" ]] || ! grep -q './supervisor.ts' "$LLM_HOME/swarm.ts"; then
    echo "→ --refresh-supervisor requires an existing belt supervisor runtime" >&2
    exit 1
  fi
  cp -p "$SUPERVISOR_TARGET" "$SUPERVISOR_TARGET.before-refresh"
  cp "$SUPERVISOR_SOURCE" "$SUPERVISOR_TARGET"
  if ! bun -e 'await import(process.argv[1])' "$SUPERVISOR_TARGET"; then
    cp -p "$SUPERVISOR_TARGET.before-refresh" "$SUPERVISOR_TARGET"
    echo "→ supervisor import failed; previous code restored" >&2
    exit 1
  fi
  echo "→ refreshed supervisor code (restart com.suspenders.local-llm to activate)"
fi

# ─── PATH shims (owner law 2026-10-03): bare `coord` / `work` / `dispatch` ───
# One-line exec wrappers; every session and lane calls the control plane
# without inlining bun + full .ts paths. Idempotent: refreshed every install.
SHIM_BIN="${SUSPENDERS_SHIM_BIN:-$HOME/.local/bin}"
mkdir -p "$SHIM_BIN"
for shim in coord work; do
  printf '#!/bin/sh\nexec bun %s/bin/%s.ts "$@"\n' "$PREFIX" "$shim" > "$SHIM_BIN/$shim"
  chmod +x "$SHIM_BIN/$shim"
done
printf '#!/bin/sh\nexec bun %s/scripts/dispatch-next.ts "$@"\n' "$REPO_DIR" > "$SHIM_BIN/dispatch"
chmod +x "$SHIM_BIN/dispatch"
echo "→ shims in $SHIM_BIN (coord, work, dispatch)"

# ─── local-llm baseline (owner law 2026-10-01) ───
# Installing suspenders ALWAYS installs the local-llm swarm — smallest models
# that fit the bill (registry BELT_TIER=minimal residents). The kit lands in
# $LLM_HOME; copies never clobber the runtime home (it is the live fleet's
# possibly-customized source of truth). --no-llm skips for CI/containers.
if [[ $NO_LLM -eq 0 ]]; then
  mkdir -p "$LLM_HOME"
  for f in registry.ts spawner.ts router-shim.ts; do
    if [ -f "$LLM_HOME/$f" ]; then
      echo "= $LLM_HOME/$f kept (runtime copy is source of truth)"
    else
      cp "$KIT_DIR/$f" "$LLM_HOME/$f"
      echo "+ $LLM_HOME/$f"
    fi
  done
  # swarm.ts is the one kit file that MAY refresh a present copy: an older
  # installed swarm.ts lacks the serve supervisor, and a serve-less swarm.ts
  # under launchd KeepAlive is exactly the busy-loop flaw this fixes.
  if [ ! -f "$LLM_HOME/swarm.ts" ] || ! grep -q 'case "serve"' "$LLM_HOME/swarm.ts" 2>/dev/null; then
    cp "$KIT_DIR/swarm.ts" "$LLM_HOME/swarm.ts"
    echo "+ $LLM_HOME/swarm.ts (serve supervisor)"
  else
    echo "= $LLM_HOME/swarm.ts kept (serve already present)"
  fi
  # config stubs — belt.env + routing-policy.yaml, only when absent
  for f in belt.env routing-policy.yaml; do
    if [ -f "$LLM_HOME/$f" ]; then
      echo "= $LLM_HOME/$f kept (operator-owned runtime copy)"
    else
      cp "$KIT_DIR/$f" "$LLM_HOME/$f"
      echo "+ $LLM_HOME/$f (stub — fill/verify at activation)"
    fi
  done
  # smallest-fit models: derived FROM the registry (same source of truth the
  # swarm reads) — BELT_TIER=minimal residents. huggingface_hub snapshot_
  # download resumes partial downloads; --skip-models skips for offline boxes.
  if [[ $SKIP_MODELS -eq 0 ]]; then
    MLX_PYTHON="$HOME/.local/share/uv/tools/mlx-lm/bin/python"
    if [ ! -x "$MLX_PYTHON" ] && command -v uv >/dev/null 2>&1; then
      uv tool install mlx-lm >/dev/null 2>&1 || true
    fi
    if [ -x "$MLX_PYTHON" ]; then
      MODELS="$(BELT_TIER=minimal LOCAL_LLM_HOME="$LLM_HOME" bun -e '
const { residentSet } = await import(process.env.LOCAL_LLM_HOME + "/registry.ts");
process.stdout.write(residentSet().map((s) => s.model).join("\n"));
')"
      printf '%s\n' "$MODELS" | while IFS= read -r model; do
        [ -z "$model" ] && continue
        echo "→ downloading $model (resumes if partial)"
        "$MLX_PYTHON" -c 'from huggingface_hub import snapshot_download; import sys; snapshot_download(sys.argv[1])' "$model" \
          || echo "  ✗ $model failed — re-run install to resume"
      done
    else
      echo "→ mlx-lm missing — skipping model download (re-run install to fetch)"
    fi
  else
    echo "→ --skip-models: skipping model download (offline install)"
  fi
fi

# --wire: merge the example hooks block into ~/.claude/settings.json — per-event
# array concat, existing entries untouched; paths rewritten to the real prefix
if [[ $WIRE -eq 1 ]]; then
  SETTINGS="$HOME/.claude/settings.json"
  [ -f "$SETTINGS" ] || echo "{}" >"$SETTINGS"
  # The $HOME string below is a literal hook placeholder, expanded by JS.
  # shellcheck disable=SC2016
  SUSPENDERS_EXAMPLE="$REPO_DIR/settings.example.json" SUSPENDERS_PREFIX="$PREFIX" bun -e '
    const fs = require("node:fs");
    const settingsPath = process.env.HOME + "/.claude/settings.json";
    const prefix = process.env.SUSPENDERS_PREFIX;
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const ex = JSON.parse(fs.readFileSync(process.env.SUSPENDERS_EXAMPLE, "utf8")).hooks;
    settings.hooks ??= {};
    for (const [event, entries] of Object.entries(ex)) {
      const rewritten = JSON.parse(JSON.stringify(entries).replaceAll("$HOME/.claude/hooks/suspenders", prefix));
      const cur = (settings.hooks[event] ??= []);
      const seen = new Set(cur.map((m) => JSON.stringify(m)));
      for (const e of rewritten) if (!seen.has(JSON.stringify(e))) cur.push(e);
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.log("→ wired " + settingsPath);
  '
fi

# --with-launchd: template-substitute and load the macOS agents
if [[ $WITH_LAUNCHD -eq 1 ]]; then
  if [[ "$(uname)" != "Darwin" ]]; then
    echo "→ --with-launchd skipped (not macOS)"
  else
    BUN_BIN="$(command -v bun)"
    # W264: agent logs live in the private insights dir, never world-readable /tmp
    mkdir -p "$HOME/.claude-insights" && chmod 700 "$HOME/.claude-insights"
    mkdir -p "$HOME/Library/LaunchAgents"
    failed_agents=()
    for f in "$REPO_DIR"/hooks/launchd/*.plist; do
      name="$(basename "$f")"
      out="$HOME/Library/LaunchAgents/$name"
      sed -e "s|__BUN__|$BUN_BIN|" -e "s|__HOME__|$HOME|g" -e "s|__PREFIX__|$PREFIX|" -e "s|__REPO__|$REPO_DIR|" \
        -e "s|__BELT_URL__|${BELT_URL:-http://127.0.0.1:4100}|" -e "s|__BELT_TOKEN__|${BELT_TOKEN:-}|" "$f" >"$out"
      if ! bash "$REPO_DIR/scripts/load-launchd.sh" "$out" \
        "$HOME/.claude-insights/launchd-${name%.plist}.log"; then
        failed_agents+=("${name%.plist}")
      fi
    done
    # supersede the pre-namespacing agent labels so old and new never run side
    # by side (same jobs, stale script paths, double keepwarm/monitor pings)
    for legacy in com.klh.llm-keepwarm com.klh.fleet-monitor com.klh.local-llm; do
      launchctl bootout "gui/$(id -u)/$legacy" 2>/dev/null || true
      if [ -f "$HOME/Library/LaunchAgents/$legacy.plist" ]; then
        rm "$HOME/Library/LaunchAgents/$legacy.plist"
        echo "→ superseded legacy agent $legacy"
      fi
    done
    if [[ ${#failed_agents[@]} -gt 0 ]]; then
      echo "→ install incomplete: launchd jobs failed: ${failed_agents[*]}" >&2
      exit 1
    fi
  fi
fi

# optional: register the board with klh-local's user-level Caddy so the LAN
# gets http://suspenders.local:7799. Idempotent (converges on re-run) and
# never fatal — the loopback board works without it.
KLH_LOCAL_BIN="$HOME/.local/bin/klh-local"
if [[ -x "$KLH_LOCAL_BIN" ]] && command -v caddy >/dev/null 2>&1; then
  if "$KLH_LOCAL_BIN" register suspenders --port 7799 --health /; then
    echo "→ suspenders.local → 127.0.0.1:7799 (klh-local / Caddy)"
  else
    echo "→ klh-local register failed (non-fatal) — board stays on http://127.0.0.1:7799"
  fi
else
  echo "optional: install klh-local + caddy to also serve this board at http://suspenders.local:7799"
fi

echo
echo "done. restart Claude Code so the hooks register, then:"
echo "  bun $PREFIX/bin/fleet-board.ts        # live fleet board (+ decision forks)"
echo "  bun $PREFIX/bin/work.ts ready         # what the fleet can pick up"
echo "  bun $PREFIX/bin/monitor.ts            # control-plane health"
echo "env knobs: SUSPENDERS_LLM_URL / SUSPENDERS_LLM_MODEL / SUSPENDERS_LLM_KEY (advice worker)"
echo "local-llm: $LLM_HOME (swarm serve supervisor; BELT_TIER=minimal residents + :4000 router)"
echo "  bun $LLM_HOME/swarm.ts status   # swarm health"
echo "  bun $LLM_HOME/swarm.ts serve    # resident supervisor (launchd label com.suspenders.local-llm)"

# ─── release notify: the distributed changelog (2026-09-30) ───
# every deploy announces the live version on the coord bus; every session
# sees it at next poll or SessionStart. Fresh machines (no coord) skip.
COORD="$HOME/.claude/hooks/suspenders/bin/coord.ts"
if [ -f "$COORD" ]; then
  REL_VER=$(git -C "$(cd "$(dirname "$0")" && pwd)" describe --tags --abbrev=0 2>/dev/null || echo unknown)
  REL_NOTE=$(git -C "$(cd "$(dirname "$0")" && pwd)" tag -l --format='%(contents:subject)' "$REL_VER" 2>/dev/null | head -1)
  bun "$COORD" emit RELEASE --scope suspenders --version "$REL_VER" \
    --note "${REL_NOTE:-deployed}" --as installer >/dev/null 2>&1 || true
fi
