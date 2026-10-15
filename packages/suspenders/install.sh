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
# kit source: packages/local-llm (W422.4) — a sibling package, not hooks/
KIT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/local-llm"

# ─── legacy body (TODO(install.ts): syncHarness/ensureShims + seedLocalLlm/
# downloadModels/refreshSupervisor still live here (W771.1/W771.2 scopes) —
# install.ts's delegation runs THIS function, never the wrapper front, which
# would re-enter install.ts. W771.3 retired the wire/caddy/skills/release
# blocks; their native steps live in scripts/install-wire-steps.ts) ───
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
  for f in gateway-supervision.ts memory-policy.ts serve-observation.ts observation.ts models.catalog.ts models.catalog.json; do
    if [[ ! -f "$LLM_HOME/$f" ]]; then
      cp "$KIT_DIR/$f" "$LLM_HOME/$f"
    fi
  done
  if [[ ! -f "$LLM_HOME/litellm-target.ts" ]]; then
    cp "$SCRIPT_DIR/../belt/bin/litellm-target.ts" "$LLM_HOME/litellm-target.ts"
  fi
  # W465 one-source: the registry and the :4000 router are BELT-owned now —
  # registry.ts and router-shim.ts come from belt/bin, and since W661 the
  # overlay ships router-shim's FULL import closure (the old hardcoded list
  # shipped router-shim.ts without ./audio.ts + ./escalate.ts — :4000 died on
  # every spawn, ~95 launchd revives over 4h). Since W741 the install runs the
  # refresh verb: missing AND diverged closure files heal from the repo (the
  # W741 drift tripwire's sanctioned remediation), re-export shims install
  # their real module (lesson.flat-home-overlay-hazard), and the flattened
  # import graph is resolution-proved (bun build) before the lock releases.
  bun "$SCRIPT_DIR/scripts/belt-bin-overlay.ts" refresh \
    --runtime "$LLM_HOME" --entry "$SCRIPT_DIR/../belt/bin/router-shim.ts"
  # W661 self-check: the flattened runtime must actually serve. A spawn that
  # dies on a missing module fails the install loudly here instead of looping
  # the launchd revive on :4000 (the smoke rides a scratch port).
  bun "$SCRIPT_DIR/scripts/belt-bin-overlay.ts" smoke --runtime "$LLM_HOME"
  if [ ! -f "$LLM_HOME/health.ts" ]; then
    cp "$KIT_DIR/health.ts" "$LLM_HOME/health.ts"
  fi
  # W507: the tier choice is machine config, not launchd env — every install
  # re-emits the tier manifest the swarm supervisor and llm-keepwarm both
  # read (smallest-fit law = minimal). A stale kit copy (no `tier` kind)
  # degrades to a note, never a failed install.
  if [ -f "$LLM_HOME/registry-emit.ts" ]; then
    BELT_TIER=minimal bun "$LLM_HOME/registry-emit.ts" tier --out "$LLM_HOME/tier.json" \
      || echo "→ tier manifest emission skipped (stale kit registry-emit.ts)"
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
if [[ $LEG_DRY_RUN -eq 1 && $((LEG_WITH_LAUNCHD + LEG_SKIP_MODELS + LEG_NO_LLM + LEG_SUPERVISOR)) -gt 0 ]]; then
  echo "note: legacy flags gate the legacy blocks — the dry-run plan shows native steps only"
fi

# legacy-only flags ride env knobs into the delegated legacy body
# (TODO(install.ts): no native flags yet — contract.bashFlags documents these)
export SUSPENDERS_LEGACY_PRUNE="$LEG_PRUNE"
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
