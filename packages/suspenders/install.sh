#!/usr/bin/env bash
# suspenders installer — THIN WRAPPER (W490.2): the installer core is now
#   bun scripts/install.ts "$@"
# and this file keeps only the legacy blocks that have no native install.ts
# step yet (each marked TODO(install.ts) inline). Flags unchanged:
#   ./install.sh [--wire] [--with-launchd] [--dry-run] [--skip-models]
#                [--no-llm] [--refresh-supervisor] [--refresh-dashboards]
#                [--hub <name>] [--yes] [--json] [--verbose] [--step <name>]
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
# downloadModels, wireSettings, refreshSupervisor, registerCaddy, registerSkills
# and releaseNotify still live here — install.ts's delegation runs THIS function,
# never the wrapper front, which would re-enter install.ts) ───
legacy_full() {
command -v bun >/dev/null || { echo "suspenders needs bun — https://bun.sh first"; exit 1; }

echo "→ installing to $PREFIX"
# Native staged sync is shared by full installs and --step syncHarness.
# It preserves runtime config and publishes only a validated committed payload.
bun "$SCRIPT_DIR/scripts/sync-harness.ts" --repo "$SCRIPT_DIR" --prefix "$PREFIX" --shim-bin "${SUSPENDERS_SHIM_BIN:-$HOME/.local/bin}"

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

# PATH shims are published transactionally by sync-harness.ts above.

# ─── local-llm baseline (owner law 2026-10-01) ───
# Installing suspenders ALWAYS installs the local-llm swarm — smallest models
# that fit the bill (registry BELT_TIER=minimal residents). The kit lands in
# $LLM_HOME; copies never clobber the runtime home (it is the live fleet's
# possibly-customized source of truth). --no-llm skips for CI/containers.
if [[ "${SUSPENDERS_LEGACY_NO_LLM:-0}" -eq 0 ]]; then
  mkdir -p "$LLM_HOME"
  for f in gateway-supervision.ts memory-policy.ts serve-observation.ts observation.ts; do
    if [[ ! -f "$LLM_HOME/$f" ]]; then
      cp "$KIT_DIR/$f" "$LLM_HOME/$f"
    fi
  done
  # W465 one-source: registry/router/admission/spawn kit + litellm-target.ts
  # are BELT-owned CODE — the seeder converges them on hash mismatch
  # (W422.6.1: a pre-W507 registry-emit.ts otherwise survives every install
  # and tier.json never emits; prior copy → .before-refresh). spawner/health
  # stay kit-local. Operator-owned config below is never clobbered (kept =
  # the live fleet's possibly-customized source of truth).
  bun "$SCRIPT_DIR/scripts/seed-local-llm.ts" --home "$LLM_HOME" --belt "$SCRIPT_DIR/../belt/bin"
  if [ ! -f "$LLM_HOME/health.ts" ]; then
    cp "$KIT_DIR/health.ts" "$LLM_HOME/health.ts"
  fi
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
  SUSPENDERS_PREFIX="$PREFIX" bun "$SCRIPT_DIR/scripts/install-policy-adapters.ts"
fi

# --with-launchd is native since W490.2: install.ts --step registerLaunchd
# renders deploy/services.yaml via install-services.ts (see install-launchd.ts)

# optional: register the board with klh-local's user-level Caddy so the LAN
# gets http://suspenders.local:7799. Idempotent (converges on re-run) and
# optional absence is skipped; attempted registration failure is reported as
# a degraded install without aborting the remaining harness/release work.
report_caddy() {
  if [[ -n "${SUSPENDERS_LEGACY_REPORT:-}" ]]; then
    printf '{"name":"registerCaddy","status":"%s","note":"%s"}\n' "$1" "$2" >> "$SUSPENDERS_LEGACY_REPORT"
  fi
}
KLH_LOCAL_BIN="$HOME/.local/bin/klh-local"
if [[ -x "$KLH_LOCAL_BIN" ]] && command -v caddy >/dev/null 2>&1; then
  if "$KLH_LOCAL_BIN" register suspenders --port 7799 --health /; then
    echo "→ suspenders.local → 127.0.0.1:7799 (klh-local / Caddy)"
    report_caddy ok "board registered with klh-local/Caddy"
  else
    echo "→ degraded install: klh-local register failed — loopback board URL: http://127.0.0.1:7799"
    report_caddy failed "optional Caddy registration failed; harness installed, use the loopback board URL and inspect Caddy reload/rollback"
  fi
else
  echo "optional: install klh-local + caddy to also serve this board at http://suspenders.local:7799"
  report_caddy skipped "optional klh-local/Caddy tools unavailable; registration was not attempted"
fi

# ─── agent skills (TODO(install.ts): registerSkills) — register every skill
# package under skills/ with the skills CLI (owner hard rule 2026-10-07:
# agent surfaces distribute as SKILL.md packages, never cp'd into one CLI's
# dir). Flags are load-bearing: -g global, -y unattended, -a explicit agent —
# a bare add hits the interactive agent-picker and exits 1 in a non-TTY. One
# parent-dir add discovers every skills/*/ subpackage (verified: "Found 10").
# Best-effort: failure prints the manual command, never aborts the install.
if [ -d "$SCRIPT_DIR/skills" ]; then
  if bunx skills add "$SCRIPT_DIR/skills" -g -y -a claude-code </dev/null; then
    echo "→ skills: registered all packages under $SCRIPT_DIR/skills"
  else
    echo "  (skills: registration failed — run manually: bunx skills add $SCRIPT_DIR/skills -g -y -a claude-code)"
  fi
fi

echo
echo "done. restart Claude Code so the hooks register, then:"
echo "  bun $PREFIX/bin/fleet-board.ts        # live fleet board (+ decision forks)"
echo "  bun $PREFIX/bin/fleet-tracker.ts      # tracker-style lane sidecar (read-only TUI)"
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
LEG_DASHBOARDS=0 LEG_DRY_RUN=0 LEG_GATEWAY=0
NATIVE=()
prev_step=0
LEG_HUB=""
hub_seen=0
hub_pending=0
for arg in "$@"; do
  if [[ $prev_step -eq 1 ]]; then NATIVE+=("$arg"); prev_step=0; continue; fi
  if [[ $hub_pending -eq 1 ]]; then LEG_HUB="$arg"; hub_pending=0; continue; fi
  case "$arg" in
    --hub) hub_seen=1; hub_pending=1 ;;
    --wire) LEG_WIRE=1 ;;
    --with-launchd) LEG_WITH_LAUNCHD=1 ;;
    --skip-models) LEG_SKIP_MODELS=1 ;;
    --no-llm) LEG_NO_LLM=1 ;;
    --refresh-supervisor) LEG_SUPERVISOR=1 ;;
    --refresh-dashboards) LEG_DASHBOARDS=1 ;;
    --refresh-gateway) LEG_GATEWAY=1 ;;
    --dry-run) LEG_DRY_RUN=1; NATIVE+=("$arg") ;;
    --yes|--json|--verbose) NATIVE+=("$arg") ;;
    --step) NATIVE+=("$arg"); prev_step=1 ;;
    *) echo "unknown flag: $arg"; exit 2 ;;
  esac
done

if [[ $hub_seen -eq 1 && -z "$LEG_HUB" ]]; then
  echo "--hub needs a hub name from ~/.config/klh/stack.yaml" >&2
  exit 2
fi

# --hub <name>: install-grade hub deploy — materialize the hub from the
# machine-level stack.yaml (mint → push → up → status via deploy/hubctl.ts).
# Replaces the W310-era one-off docker-run/compose invocations. --dry-run
# renders the hub .env only (zero side effects).
if [[ $hub_seen -eq 1 ]]; then
  if [[ $LEG_DRY_RUN -eq 1 ]]; then
    exec bun "$SCRIPT_DIR/deploy/hubctl.ts" render "$LEG_HUB"
  fi
  exec bun "$SCRIPT_DIR/deploy/hubctl.ts" deploy "$LEG_HUB"
fi

if [[ $LEG_GATEWAY -eq 1 ]]; then
  exec bun "$SCRIPT_DIR/scripts/refresh-gateway.ts" ${NATIVE[@]+"${NATIVE[@]}"}
fi

# Upgrade the existing kit code explicitly, never switch supervisor families.
# Advanced Belt runtimes retain the legacy supervisor.ts refresh below.
if [[ $LEG_SUPERVISOR -eq 1 ]] && ! grep -q 'from "./supervisor.ts"' "$LLM_HOME/swarm.ts" 2>/dev/null; then
  exec bun "$SCRIPT_DIR/scripts/refresh-swarm.ts" ${NATIVE[@]+"${NATIVE[@]}"}
fi

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
