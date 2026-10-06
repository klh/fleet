#!/usr/bin/env bash
# suspenders installer — THIN WRAPPER (W490.2): the installer core is now
#   bun scripts/install.ts "$@"
# and this file keeps only the legacy blocks that have no native install.ts
# step yet (each marked TODO(install.ts) inline). Flags unchanged:
#   ./install.sh [--wire] [--with-launchd] [--dry-run] [--skip-models]
#                [--no-llm] [--refresh-supervisor] [--refresh-dashboards]
#                [--yes] [--json] [--verbose] [--step <name>]
# SUSPENDERS_PREFIX / SUSPENDERS_SHIM_BIN pass through to both surfaces.
# Idempotent: re-running just refreshes the files. Default (owner law
# 2026-10-01): ALWAYS sets up the local-llm swarm and downloads the
# smallest-fit models (BELT_TIER=minimal residents) unless --no-llm.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${SUSPENDERS_PREFIX:-$HOME/.claude/hooks/suspenders}"
LLM_HOME="$HOME/.claude/local-llm"
# kit source: packages/local-llm (W422.4) — a sibling package, not hooks/
KIT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/local-llm"

# ─── legacy body (TODO(install.ts): syncHarness, ensureShims, seedLocalLlm,
# downloadModels, wireSettings, refreshSupervisor, registerCaddy and
# releaseNotify still live here — install.ts's delegation runs THIS function,
# never the wrapper front, which would re-enter install.ts) ───
legacy_full() {
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
  cp -R "$SCRIPT_DIR/hooks/$item" "$PREFIX/"
done
# the kit itself lives in packages/local-llm (W422.4) — harness copy sourced
# from there ($PREFIX/local-llm/, sibling of board/, feeds local-swarm.ts)
cp -R "$KIT_DIR" "$PREFIX/"
cp "$KIT_DIR/observation.ts" "$PREFIX/lib/observation.ts"
cp "$SCRIPT_DIR/../belt/bin/inventory-probe.ts" "$PREFIX/lib/inventory-probe.ts"
# W463 install gap (closed W490.2): prefix bin/* (worktree.ts, fleet-loop.ts,
# copilot-usage.ts) import ../../scripts/lib/*.ts — from $PREFIX/bin that depth
# is the PREFIX PARENT (~/.claude/hooks/scripts/lib), so materialize the shared
# lib there; $PREFIX/scripts/lib mirrors it for prefix-relative imports.
mkdir -p "$PREFIX/../scripts/lib" "$PREFIX/scripts/lib"
cp "$SCRIPT_DIR"/scripts/lib/*.ts "$PREFIX/../scripts/lib/"
cp "$SCRIPT_DIR"/scripts/lib/*.ts "$PREFIX/scripts/lib/"
# W494: manifest services run __PREFIX__/scripts/*.ts — the top-level scripts
# dir syncs like hooks/ does (lib/* materialized separately, above).
mkdir -p "$PREFIX/scripts"
cp "$SCRIPT_DIR"/scripts/*.ts "$PREFIX/scripts/"
cp "$SCRIPT_DIR"/scripts/*.sh "$PREFIX/scripts/" 2>/dev/null || true
# W422.5 — blam ships whole (manifest included): suspenders' manifest declares
# "blam": "workspace:*" + workspaces ["*"], so the bun install at $PREFIX
# (below) symlinks node_modules/blam -> blam/ and board's package-name import
# (blam/src/condense) resolves. Retires the W422.14 sed-on-copies hack.
rm -rf "$PREFIX/blam"
cp -R "$SCRIPT_DIR/../blam" "$PREFIX/blam"
rm -rf "$PREFIX/blam/node_modules"
# authoring-time devDeps (belt/suspenders workspace:*) don't ship — bun
# --production still resolves member devDeps, so strip them from the copy
bun -e 'const p=process.argv[1];const j=JSON.parse(await Bun.file(p).text());delete j.devDependencies;await Bun.write(p,JSON.stringify(j,null,"\t")+"\n")' "$PREFIX/blam/package.json"
# W422.5: the manifest copies, the repo lockfile does NOT — its
# blam@workspace:packages/blam entry references repo paths that do not exist
# at $PREFIX, which hard-fails install. $PREFIX re-resolves from the ranges,
# so any stale PREFIX lockfile from earlier installs goes first.
rm -f "$PREFIX/bun.lock"
cp "$SCRIPT_DIR/package.json" "$PREFIX/"
(cd "$PREFIX" && bun install --production) # --production: skip devDeps — blam's authoring-time belt/suspenders devDeps don't ship; shell-quote, for the bash gate
# Catch broken workspace links/imports before restarting the live services.
bun -e 'await import(process.argv[1])' "$PREFIX/board/prompt-transform.ts"
echo "→ harness in place"

# Targeted code upgrade for the advanced installed belt supervisor. The kit's
# older swarm implementation and operator-owned config must remain untouched.
if [[ "${SUSPENDERS_LEGACY_SUPERVISOR:-0}" -eq 1 ]]; then
  SUPERVISOR_SOURCE="$SCRIPT_DIR/../belt/bin/supervisor.ts"
  SUPERVISOR_TARGET="$LLM_HOME/supervisor.ts"
  if [[ ! -f "$SUPERVISOR_TARGET" ]] || ! grep -q './supervisor.ts' "$LLM_HOME/swarm.ts"; then
    echo "→ --refresh-supervisor requires an existing belt supervisor runtime" >&2
    exit 1
  fi
  cp -p "$SUPERVISOR_TARGET" "$SUPERVISOR_TARGET.before-refresh"
  cp "$SUPERVISOR_SOURCE" "$SUPERVISOR_TARGET"
  cp "$SCRIPT_DIR/../belt/bin/health.ts" "$LLM_HOME/health.ts"
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
printf '#!/bin/sh\nexec bun %s/scripts/dispatch-next.ts "$@"\n' "$SCRIPT_DIR" > "$SHIM_BIN/dispatch"
chmod +x "$SHIM_BIN/dispatch"
echo "→ shims in $SHIM_BIN (coord, work, dispatch)"

# ─── local-llm baseline (owner law 2026-10-01) ───
# Installing suspenders ALWAYS installs the local-llm swarm — smallest models
# that fit the bill (registry BELT_TIER=minimal residents). The kit lands in
# $LLM_HOME; copies never clobber the runtime home (it is the live fleet's
# possibly-customized source of truth). --no-llm skips for CI/containers.
if [[ "${SUSPENDERS_LEGACY_NO_LLM:-0}" -eq 0 ]]; then
  mkdir -p "$LLM_HOME"
  # W465 one-source: the registry and the :4000 router are BELT-owned now —
  # registry.ts and router-shim.ts (+ router-shim's same-dir deps) come from
  # belt/bin; local-llm/registry.ts is a re-export and its router-shim twin
  # is retired. spawner/health stay kit-local. Runtime copies are never
  # clobbered (kept = the live fleet's possibly-customized source of truth).
  for f in registry.ts router-shim.ts router-core.ts admission.ts prompt-fingerprint.ts registry-emit.ts router-condense.ts; do
    if [ -f "$LLM_HOME/$f" ]; then
      echo "= $LLM_HOME/$f kept (runtime copy is source of truth)"
    else
      cp "$SCRIPT_DIR/../belt/bin/$f" "$LLM_HOME/$f"
      echo "+ $LLM_HOME/$f (from belt/bin)"
    fi
  done
  for f in spawner.ts health.ts; do
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
  if [[ "${SUSPENDERS_LEGACY_SKIP_MODELS:-0}" -eq 0 ]]; then
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
if [[ "${SUSPENDERS_LEGACY_WIRE:-0}" -eq 1 ]]; then
  SETTINGS="$HOME/.claude/settings.json"
  [ -f "$SETTINGS" ] || echo "{}" >"$SETTINGS"
  # The $HOME string below is a literal hook placeholder, expanded by JS.
  # shellcheck disable=SC2016
  SUSPENDERS_EXAMPLE="$SCRIPT_DIR/settings.example.json" SUSPENDERS_PREFIX="$PREFIX" bun -e '
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

# --with-launchd is native since W490.2: install.ts --step registerLaunchd
# renders deploy/services.yaml via install-services.ts (see install-launchd.ts)

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
}

# ─── internal: install.ts's v1 delegation entry (W490.2). The body's flag
# knobs ride SUSPENDERS_LEGACY_* env (exported by the front below); a bare
# __legacy call runs with historical defaults. Never call by hand. ───
if [[ "${1:-}" == "__legacy" ]]; then
  shift
  if [[ "${1:-}" != "full" ]]; then
    echo "install.sh: __legacy needs 'full'" >&2
    exit 2
  fi
  legacy_full
  exit 0
fi

# ─── public front: legacy flags → env knobs, then the installer core ───
LEG_WIRE=0 LEG_WITH_LAUNCHD=0 LEG_SKIP_MODELS=0 LEG_NO_LLM=0 LEG_SUPERVISOR=0
LEG_DASHBOARDS=0 LEG_DRY_RUN=0
NATIVE=()
prev_step=0
for arg in "$@"; do
  if [[ $prev_step -eq 1 ]]; then NATIVE+=("$arg"); prev_step=0; continue; fi
  case "$arg" in
    --wire) LEG_WIRE=1 ;;
    --with-launchd) LEG_WITH_LAUNCHD=1 ;;
    --skip-models) LEG_SKIP_MODELS=1 ;;
    --no-llm) LEG_NO_LLM=1 ;;
    --refresh-supervisor) LEG_SUPERVISOR=1 ;;
    --refresh-dashboards) LEG_DASHBOARDS=1 ;;
    --dry-run) LEG_DRY_RUN=1; NATIVE+=("$arg") ;;
    --yes|--json|--verbose) NATIVE+=("$arg") ;;
    --step) NATIVE+=("$arg"); prev_step=1 ;;
    *) echo "unknown flag: $arg"; exit 2 ;;
  esac
done

# --refresh-dashboards: safe GUI-only early exit (native step; --dry-run plans)
if [[ $LEG_DASHBOARDS -eq 1 ]]; then
  exec bun "$SCRIPT_DIR/scripts/install.ts" --step refreshDashboards ${NATIVE[@]+"${NATIVE[@]}"}
fi

# dry-run + legacy flags: name the gap (the native plan shows native steps only)
if [[ $LEG_DRY_RUN -eq 1 && $((LEG_WIRE + LEG_WITH_LAUNCHD + LEG_SKIP_MODELS + LEG_NO_LLM + LEG_SUPERVISOR)) -gt 0 ]]; then
  echo "note: legacy flags gate the legacy blocks — the dry-run plan shows native steps only"
fi

# legacy-only flags ride env knobs into the delegated legacy body
# (TODO(install.ts): no native flags yet — contract.bashFlags documents these)
export SUSPENDERS_LEGACY_WIRE="$LEG_WIRE"
export SUSPENDERS_LEGACY_SKIP_MODELS="$LEG_SKIP_MODELS"
export SUSPENDERS_LEGACY_NO_LLM="$LEG_NO_LLM"
export SUSPENDERS_LEGACY_SUPERVISOR="$LEG_SUPERVISOR"

rc=0
bun "$SCRIPT_DIR/scripts/install.ts" --yes ${NATIVE[@]+"${NATIVE[@]}"} || rc=$?
if [[ $LEG_WITH_LAUNCHD -eq 1 && $rc -eq 0 ]]; then
  # native since W490.2 — the sed-pass substitutions via install-services.ts
  bun "$SCRIPT_DIR/scripts/install.ts" --step registerLaunchd --yes ${NATIVE[@]+"${NATIVE[@]}"} || rc=$?
fi
exit $rc
