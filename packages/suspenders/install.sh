#!/usr/bin/env bash
# suspenders installer — THIN WRAPPER (W490.2): the installer core is now
#   bun scripts/install.ts "$@"
# and this file keeps only the legacy blocks that have no native install.ts
# step yet (each marked TODO(install.ts) inline). Flags unchanged:
#   ./install.sh [--wire] [--with-launchd] [--dry-run] [--skip-models]
#                [--no-llm] [--refresh-supervisor] [--refresh-dashboards]
#                [--prune] [--hub <name>] [--wire-repo <path>] [--yes]
#                [--json] [--verbose] [--step <name>]
#                [--re-bless-activation [--confirm <manifest-sha-prefix>]]
#                [--profile hub|spoke]
# --profile (W165 capability split): hub (default) = full (identity,
#   issuance, admin); spoke ships no auth-issuance/identity/key-custody
#   code — the hub-only modules are excluded from $PREFIX and
#   capabilities.json records the flags (rides the federation pull).
# SUSPENDERS_PREFIX / SUSPENDERS_SHIM_BIN pass through to both surfaces.
# Idempotent: re-running just refreshes the files. Default (owner law
# 2026-10-01): ALWAYS sets up the local-llm swarm and downloads the
# smallest-fit models (BELT_TIER=minimal residents) unless --no-llm.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${SUSPENDERS_PREFIX:-$HOME/.claude/hooks/suspenders}"
LLM_HOME="$HOME/.claude/local-llm"

# ─── legacy body (W771.1/.2/.3 retired every block that has a native step;
# install.ts's delegation runs THIS function, never the wrapper front, which
# would re-enter install.ts) ───
legacy_full() {
command -v bun >/dev/null || { echo "suspenders needs bun — https://bun.sh first"; exit 1; }

echo "→ installing to $PREFIX"
# Native staged sync is shared by full installs and --step syncHarness.
# It preserves runtime config and publishes only a validated committed payload.
# --prune rides the env knob exported by the front (SUSPENDERS_LEGACY_PRUNE):
# mirror mode drops unmanaged prefix entries outside the generated-files
# allowlist (governor.db, bun.lock, node_modules, .fleet) instead of
# preserving them — W420.
PRUNE_ARGS=()
if [[ "${SUSPENDERS_LEGACY_PRUNE:-0}" -eq 1 ]]; then
  PRUNE_ARGS+=(--prune)
fi
# Legacy step outcome reporter (SUSPENDERS_LEGACY_REPORT ndjson, consumed by
# install-run.ts delegateBash) — defined before any block that reports.
report_step() {
  if [[ -n "${SUSPENDERS_LEGACY_REPORT:-}" ]]; then
    printf '{"name":"%s","status":"%s","note":"%s"}\n' "$1" "$2" "$3" >> "$SUSPENDERS_LEGACY_REPORT"
  fi
}
# W771.1: the TS plan runs syncHarness natively (SUSPENDERS_LEGACY_SYNC=0 tells
# this body to skip the re-sync); direct __legacy full callers still sync here.
if [[ "${SUSPENDERS_LEGACY_SYNC:-1}" -eq 1 ]]; then
  bun "$SCRIPT_DIR/scripts/sync-harness.ts" --repo "$SCRIPT_DIR" --prefix "$PREFIX" --shim-bin "${SUSPENDERS_SHIM_BIN:-$HOME/.local/bin}" ${PRUNE_ARGS[@]+"${PRUNE_ARGS[@]}"}
fi

# registerGitHooks (W650): repo-level scrub-gate enforcement — the committed
# .githooks stubs (W236) exec hooks/bin/scrub-gate.ts from the prefix
# (fallback: repo-local packages/suspenders) and fail inert when bun or the
# stack is absent, so bare-git commits outside the harness run the
# staged/push-range scrub check.
if [ -f "$SCRIPT_DIR/.githooks/pre-commit" ] && [ -f "$SCRIPT_DIR/.githooks/pre-push" ]; then
  git -C "$SCRIPT_DIR" config core.hooksPath .githooks
  echo "→ .githooks registered (core.hooksPath=.githooks) — bare-git commits run the scrub gate"
  report_step registerGitHooks ok "core.hooksPath=.githooks (W236 scrub stubs active)"
else
  echo "→ degraded install: committed .githooks stubs missing — scrub gate stays harness-only (manual: git config core.hooksPath .githooks)"
  report_step registerGitHooks failed "committed .githooks stubs missing; scrub gate stays harness-only"
fi

# PATH shims are published transactionally by sync-harness.ts above.

# --with-launchd is native since W490.2: install.ts --step registerLaunchd
# renders deploy/services.yaml via install-services.ts (see install-launchd.ts)

# registerCaddy + registerSkills (W771.3): native — install.ts --step
# registerCaddy (W631 posture guard, W549 truthful outcome) and --step
# registerSkills (bunx skills add, best-effort). The sync + hooks blocks
# stay bash until W771.1's port folds them into the native plan run.

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
LEG_DASHBOARDS=0 LEG_DRY_RUN=0 LEG_GATEWAY=0 LEG_PRUNE=0
LEG_WIRE_REPO="" wire_repo_pending=0 LEG_CONFIRM="" confirm_pending=0 LEG_REBLESS=0
NATIVE=()
prev_step=0
prev_review=0
LEG_HUB=""
hub_seen=0
hub_pending=0
for arg in "$@"; do
  if [[ $prev_step -eq 1 ]]; then NATIVE+=("$arg"); prev_step=0; continue; fi
  if [[ $prev_review -eq 1 ]]; then
    if [[ "$arg" == --* ]]; then echo "--gateway-review needs a review SHA256" >&2; exit 2; fi
    NATIVE+=("$arg"); prev_review=0; continue
  fi
  if [[ $hub_pending -eq 1 ]]; then LEG_HUB="$arg"; hub_pending=0; continue; fi
  if [[ $wire_repo_pending -eq 1 ]]; then LEG_WIRE_REPO="$arg"; wire_repo_pending=0; continue; fi
  if [[ $confirm_pending -eq 1 ]]; then
    if [[ "$arg" == --* ]]; then echo "--confirm needs a manifest sha prefix" >&2; exit 2; fi
    LEG_CONFIRM="$arg"; confirm_pending=0; continue
  fi
  case "$arg" in
    --hub) hub_seen=1; hub_pending=1 ;;
    --wire-repo) wire_repo_pending=1 ;;
    --re-bless-activation) LEG_REBLESS=1 ;;
    --confirm) confirm_pending=1 ;;
    --confirm=*) LEG_CONFIRM="${arg#--confirm=}" ;;
    --wire) LEG_WIRE=1 ;;
    --with-launchd) LEG_WITH_LAUNCHD=1 ;;
    --skip-models) LEG_SKIP_MODELS=1 ;;
    --no-llm) LEG_NO_LLM=1 ;;
    --refresh-supervisor) LEG_SUPERVISOR=1 ;;
    --refresh-dashboards) LEG_DASHBOARDS=1 ;;
    --prune) LEG_PRUNE=1 ;;
    --refresh-gateway) LEG_GATEWAY=1 ;;
    --dry-run) LEG_DRY_RUN=1; NATIVE+=("$arg") ;;
    --yes|--json|--verbose) NATIVE+=("$arg") ;;
    --step) NATIVE+=("$arg"); prev_step=1 ;;
    --gateway-review) NATIVE+=("$arg"); prev_review=1 ;;
    --gateway-review=*) NATIVE+=("$arg") ;;
    *) echo "unknown flag: $arg"; exit 2 ;;
  esac
done

if [[ $prev_review -eq 1 ]]; then
  echo "--gateway-review needs a review SHA256" >&2
  exit 2
fi

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

# --wire-repo <path> (W637): native repo wiring — merge-not-clobber the hooks
# block into <path>/.claude/settings.json via the TS installer's wireSettings
# step. Early-exit like the other targeted flags; --dry-run rides the plan.
if [[ -n "$LEG_WIRE_REPO" ]]; then
  exec bun "$SCRIPT_DIR/scripts/install.ts" --step wireSettings --yes --wire-repo "$LEG_WIRE_REPO" ${NATIVE[@]+"${NATIVE[@]}"}
fi

# --wire (W771.3): the user-level wire is native — the TS step merges hooks
# into ~/.claude/settings.json, then runs policy adapters + gate wires.
if [[ $LEG_WIRE -eq 1 ]]; then
  exec bun "$SCRIPT_DIR/scripts/install.ts" --step wireSettings --yes ${NATIVE[@]+"${NATIVE[@]}"}
fi

# --re-bless-activation (W640): owner-gated activation-receipt re-bless — the
# W639 hand-run bun script as a supported verb. Requires BOTH the intent flag
# and --confirm <manifest-sha-prefix> (>=12 hex of the NEW candidate sha; a
# confirm-less run dry-renders, prints the old-intent vs candidate diff and
# names the sha — writes nothing). Corrects the receipt BEFORE install
# --with-launchd: the render fence compares receipt.manifestSha256 against
# the ACTIVE GENERATION's services.yaml. No launchd mutation; the write goes
# through service-drift writeActivation only.
if [[ $LEG_REBLESS -eq 1 ]]; then
  CONFIRM_ARGS=()
  if [[ -n "$LEG_CONFIRM" ]]; then CONFIRM_ARGS+=(--confirm "$LEG_CONFIRM"); fi
  exec bun "$SCRIPT_DIR/scripts/rebless-activation.ts" --re-bless-activation ${CONFIRM_ARGS[@]+"${CONFIRM_ARGS[@]}"}
fi

# --refresh-supervisor is native since W771.2: the step detects the installed
# family itself (kit serve → refresh-swarm; advanced Belt → backup + import-
# validated refresh), so the front routes it unconditionally to install.ts.
if [[ $LEG_SUPERVISOR -eq 1 ]]; then
  exec bun "$SCRIPT_DIR/scripts/install.ts" --step refreshSupervisor --yes ${NATIVE[@]+"${NATIVE[@]}"}
fi

# --refresh-dashboards: safe GUI-only early exit (native step; --dry-run plans)
if [[ $LEG_DASHBOARDS -eq 1 ]]; then
  exec bun "$SCRIPT_DIR/scripts/install.ts" --step refreshDashboards ${NATIVE[@]+"${NATIVE[@]}"}
fi

# dry-run + legacy flags: name the gap (the native plan shows native steps only)
if [[ $LEG_DRY_RUN -eq 1 && $((LEG_WITH_LAUNCHD + LEG_SKIP_MODELS + LEG_NO_LLM + LEG_SUPERVISOR)) -gt 0 ]]; then
  echo "note: legacy flags gate the legacy blocks — the dry-run plan shows native steps only"
fi

# legacy-only flags ride env knobs into the delegated legacy body
# (TODO(install.ts): no native flags yet — contract.bashFlags documents these)
export SUSPENDERS_LEGACY_PRUNE="$LEG_PRUNE"
export SUSPENDERS_LEGACY_SKIP_MODELS="$LEG_SKIP_MODELS"
export SUSPENDERS_LEGACY_NO_LLM="$LEG_NO_LLM"

rc=0
bun "$SCRIPT_DIR/scripts/install.ts" --yes ${NATIVE[@]+"${NATIVE[@]}"} || rc=$?
if [[ $LEG_WITH_LAUNCHD -eq 1 && $rc -eq 0 ]]; then
  # native since W490.2 — the sed-pass substitutions via install-services.ts
  bun "$SCRIPT_DIR/scripts/install.ts" --step registerLaunchd --yes ${NATIVE[@]+"${NATIVE[@]}"} || rc=$?
fi
exit $rc
