#!/usr/bin/env bash
set -euo pipefail

# speedy — Make Claude Code 10-1400x faster at file operations
# https://github.com/klh/speedy

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BOLD='\033[1m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
RESET='\033[0m'

info()  { echo -e "${BOLD}${GREEN}[INFO]${RESET} $*"; }
warn()  { echo -e "${BOLD}${YELLOW}[WARN]${RESET} $*"; }
error() { echo -e "${BOLD}${RED}[ERROR]${RESET} $*"; }

# ─── Flags ───────────────────────────────────────────────
# --llm=off      cloud-only — no belt, no swarm (explicit opt-out)
# --llm=minimal  smallest-fit law: BELT_TIER=minimal residents only (≤4GB)
# --llm=full     the full specialist fleet
# --skip-models  no model downloads anywhere in the chain (offline install)
# --dry-run      print the install plan and exit — touch nothing, prompt nothing
# Upgrades over an install that already has the fleet deployed keep it.
# Fresh installs default to --llm=minimal (spoke install baseline law,
# 2026-10-01): the chain ALWAYS brings up the local-llm swarm.
LLM_FLAG=""
SKIP_MODELS=0
DRY_RUN=0
BUCKLE_REPO_URL="${BUCKLE_REPO_URL:-https://github.com/klh/buckle.git}"
for ARG in "$@"; do
  case "$ARG" in
    --llm=off | --llm=minimal | --llm=full) LLM_FLAG="${ARG#--llm=}" ;;
    --skip-models) SKIP_MODELS=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *) warn "unknown flag ignored: $ARG" ;;
  esac
done
if [ -z "$LLM_FLAG" ]; then
  if [ -f "$HOME/.claude/local-llm/registry.ts" ] && grep -q 'case "serve"' "$HOME/.claude/local-llm/swarm.ts" 2>/dev/null; then
    LLM_FLAG="full" # upgrade over a deployed fleet — keep it
  else
    LLM_FLAG="minimal" # fresh install — smallest-fit law (BELT_TIER=minimal)
  fi
fi
info "LLM tier: $LLM_FLAG"

# ─── Preflight ───────────────────────────────────────────

command -v brew >/dev/null 2>&1 || { error "Homebrew not found. Install: https://brew.sh"; exit 1; }
command -v cargo >/dev/null 2>&1 || { warn "cargo not found. Installing rust via rustup..."; curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y; source "$HOME/.cargo/env"; }

OS="$(uname -s)"
ARCH="$(uname -m)"
info "Detected: $OS $ARCH"
# ─── Dry run: print the plan, touch nothing ──────────────
if [ "$DRY_RUN" -eq 1 ]; then
  info "--dry-run — the chain, in order (nothing executed):"
  echo "  1. klh/local (.local services)     $([ -x "$HOME/.local/bin/klh-local" ] && echo "present — skip" || echo "clone + install")"
  echo "  2. klh/suspenders (control plane)  $([ -f "$HOME/.claude/hooks/suspenders/bin/work.ts" ] && echo "present — skip" || echo "clone + install") — install.sh --wire --with-launchd; local-llm baseline (BELT_TIER=minimal swarm$( [ "$SKIP_MODELS" -eq 1 ] && echo " + --skip-models" ))"
  echo "  3. klh/buckle (router plane)       clone via BUCKLE_REPO_URL (default $BUCKLE_REPO_URL; override env) + bun install"
  echo "  4. klh/belt (LLM fleet)            deploy, tier: $LLM_FLAG$( [ "$SKIP_MODELS" -eq 1 ] && echo " (--skip-download)" )"
  echo "  5. .local registration             suspenders.local, belt.local (when klh-local present)"
  echo "  6. toolchain                       brew/cargo/qlty/npm packages"
  case "$LLM_FLAG" in
    minimal) PLAN_MODELS="BELT_TIER=minimal residents (≤4GB)" ;;
    full) PLAN_MODELS="the full specialist set" ;;
    *) PLAN_MODELS="none (cloud-only)" ;;
  esac
  [ "$SKIP_MODELS" -eq 1 ] && PLAN_MODELS="$PLAN_MODELS — skipped (--skip-models)"
  echo "  7. model downloads                 $PLAN_MODELS"
  echo "  8. hub ask                         \"Do you want to buckle up and connect to a belt hub? [y/N]\" — default standalone"
  exit 0
fi

# ─── .local services first (klh-local) ───────────────────
# Installed FIRST so every later layer (suspenders, belt) can register its
# dashboard as <name>.local as it goes — same optional-layer pattern as belt.
if [ ! -x "$HOME/.local/bin/klh-local" ]; then
  T="$(mktemp -d)"
  info "installing .local services (klh/local)..."
  if git clone --depth 1 https://github.com/klh/local "$T/local" 2>/dev/null; then
    (cd "$T/local" && ./install.sh) || warn "klh-local install failed (optional) — continuing without it"
  else
    warn "klh/local clone failed (optional) — continuing without .local services"
  fi
fi

# ─── Control plane: suspenders (dependency, not vendored) ──
# speedy is a config layer on top of klh/suspenders (control-plane CLIs,
# hook gates, fleet board, monitor). Install it first.
if [ ! -f "$HOME/.claude/hooks/suspenders/bin/work.ts" ]; then
  info "installing the suspenders control plane (klh/suspenders)..."
  T=$(mktemp -d)
  git clone --depth 1 https://github.com/klh/suspenders "$T/suspenders"
  SUS_FLAGS=(--wire --with-launchd)
  [ "$SKIP_MODELS" -eq 1 ] && SUS_FLAGS+=(--skip-models)
  [ "$LLM_FLAG" = "off" ] && SUS_FLAGS+=(--no-llm)
  (cd "$T/suspenders" && ./install.sh "${SUS_FLAGS[@]}")
  rm -rf "$T"
else
  info "suspenders control plane already installed"
fi

# ─── Router plane: buckle (optional layer, not vendored) ─────
# LLM transport + governance router (design: suspenders docs/design/buckle/).
# Shadow-port phase 1: binds 127.0.0.1:4101, never :4100. No public repo yet —
# BUCKLE_REPO_URL overrides; the default is a harmless guess until the clone
# succeeds (optional-layer pattern: clone failure = warn + continue).
if [ -d "$HOME/.claude/buckle" ]; then
  info "buckle router plane already deployed"
elif command -v bun >/dev/null 2>&1; then
  info "deploying the buckle router plane..."
  T=$(mktemp -d)
  if git clone --depth 1 "$BUCKLE_REPO_URL" "$T/buckle" 2>/dev/null; then
    (cd "$T/buckle" && bun install) || warn "buckle bun install failed (optional) — continuing"
    mkdir -p "$HOME/.claude/buckle"
    cp -R "$T/buckle/." "$HOME/.claude/buckle/" || warn "buckle deploy failed (optional) — continuing without it"
    echo "  ✓ buckle in ~/.claude/buckle — start with: bun ~/.claude/buckle/src/server.ts (shadow :4101)"
  else
    warn "buckle clone failed (no public repo yet — set BUCKLE_REPO_URL) — continuing without it"
  fi
  rm -rf "$T"
else
  warn "bun not found yet — buckle deploy skipped (re-run to add it)"
fi
# ─── Local LLM fleet: belt (optional layer, not vendored) ────
# klh/belt serves the MLX specialist swarm on localhost (:8901+) — the
# endpoints suspenders' advice worker and keepwarm talk to. Deploying the
# code is cheap; models (~40-60GB) and launchd agents are opt-in inside belt.
if [ "$LLM_FLAG" != "off" ]; then
  if [ ! -f "$HOME/.claude/local-llm/registry.ts" ]; then
    info "deploying the local LLM fleet (klh/belt, tier: $LLM_FLAG)..."
    T=$(mktemp -d)
    if git clone --depth 1 https://github.com/klh/belt "$T/belt" 2>/dev/null; then
      BELT_FLAGS=(--tier "$LLM_FLAG")
      [ "$SKIP_MODELS" -eq 1 ] && BELT_FLAGS+=(--skip-download)
      (cd "$T/belt" && ./install.sh "${BELT_FLAGS[@]}") || warn "belt install failed (optional) — continuing without it"
    else
      warn "belt clone failed (optional) — continuing without the fleet"
    fi
    rm -rf "$T"
  else
    info "belt (local LLM fleet) already deployed"
  fi
fi

# ─── .local registration (klh-local) ─────────────────────
if [ -x "$HOME/.local/bin/klh-local" ]; then
  if "$HOME/.local/bin/klh-local" register suspenders --port 7799 --health /; then
    echo "  ✓ suspenders.local (:7799) registered"
  else
    warn "klh-local: suspenders registration failed (optional)"
  fi
  if [ "$LLM_FLAG" != "off" ]; then
    if "$HOME/.local/bin/klh-local" register belt --port 7791 --health /; then
      echo "  ✓ belt.local (:7791) registered"
    else
      warn "klh-local: belt registration failed (optional)"
    fi
  fi
else
  echo "  · klh-local not found — .local registration skipped (optional: https://github.com/klh/local)"
fi

if command -v bun >/dev/null 2>&1; then
  bun "$REPO_DIR/bin/install-policy-adapters.ts" || warn "session policy adapter wiring failed"
fi

# ─── Skills: speedy skills/ → ~/.claude/skills (idempotent copy), then
# ~/.agents/skills → ~/.claude/skills (zero-copy symlink, cross-CLI) ────
# Gap found 2026-10-0X: this step never existed, so a fresh install never
# populated either directory — Claude Code AND every non-Claude CLI
# (Copilot, cline, grok, Codex) started with zero awareness of the fleet
# (suspenders/buckle/belt/klh-local) regardless of how many of those repos
# install.sh had just deployed. install-codex.ts's own skills step assumes
# ~/.claude/skills already exists; this is where that assumption becomes
# true. Never clobbers a skill a user/another tool already placed there.
info "Installing skills (~/.claude/skills + ~/.agents/skills)..."
mkdir -p "$HOME/.claude/skills"
SKILLS_ADDED=0
for d in "$REPO_DIR"/skills/*/; do
  [ -f "$d/SKILL.md" ] || continue
  name="$(basename "$d")"
  if [ -d "$HOME/.claude/skills/$name" ]; then
    echo "  = $name (kept — already installed)"
  else
    cp -R "$d" "$HOME/.claude/skills/$name"
    SKILLS_ADDED=$((SKILLS_ADDED + 1))
    echo "  + $name"
  fi
done
info "$SKILLS_ADDED new skill(s) installed"
if [ ! -e "$HOME/.agents/skills" ]; then
  mkdir -p "$HOME/.agents"
  ln -s "$HOME/.claude/skills" "$HOME/.agents/skills"
  echo "  ✓ ~/.agents/skills → ~/.claude/skills (Copilot/cline/grok/Codex all read this path)"
elif [ -L "$HOME/.agents/skills" ]; then
  echo "  ✓ ~/.agents/skills already symlinked ($(readlink "$HOME/.agents/skills"))"
else
  warn "~/.agents/skills exists and is not a symlink — left untouched (non-Claude CLIs may miss new skills; remove it to adopt the zero-copy link)"
fi

# ─── Brew packages ───────────────────────────────────────

BREW_TOOLS=(
  # Core file ops (biggest speedup)
  fd              # find replacement — 64x faster
  ripgrep         # grep replacement — 6x faster
  bat             # cat replacement — syntax highlighting
  bat-extras      # batgrep, batdiff, batman, batwatch
  sd              # sed replacement — 12x faster at regex
  difftastic      # diff replacement — AST-aware structural diff
  tree            # directory listing with JSON output
  jq              # JSON processor — replaces python3 -c

  # Bulk operations
  git-delta       # git diff pager — syntax-highlighted
  hyperfine       # statistical benchmarking

  # Disk & navigation
  dust            # du replacement — visual treemap
  tokei           # cloc replacement — instant code stats
  eza             # ls replacement — icons, git, tree
  zoxide          # cd replacement — frecency jumping
  broot           # interactive directory tree

  # Process & system
  procs           # ps replacement — colored, searchable
  bottom          # htop replacement — cross-platform graphs

  # Network & HTTP
  xh              # curl replacement — HTTPie syntax
  hurl            # multi-request HTTP testing
  doggo           # dig replacement — colored, JSON
  aria2           # wget replacement — parallel downloads

  # Git & dev
  lazygit         # git TUI — interactive staging, rebase
  lazydocker      # docker TUI — containers, logs, stats
  fzf             # fuzzy finder — file pickers, preview patterns in CLAUDE.md
  uv              # fast Python packaging — pip/venv replacement
  act             # run GitHub Actions locally
  actionlint      # lint GitHub Actions YAML
  shellcheck      # lint shell scripts

  # File ops & monitoring
  fswatch         # file change watcher
  watchexec       # rerun commands on change
  xcp             # cp replacement — 10x faster on NFS

  # Utilities
  gum             # glamorous shell scripts
  micro           # terminal editor
  tldr            # simplified man pages
  serve           # instant static file server
  mkcert          # local TLS certificates

  # Structural editing & quality (2026-09)
  ast-grep        # AST-aware find/replace — won't touch strings/comments
  biome           # fast JS/TS lint+format inside configured projects
  yq              # jq for YAML/TOML/XML
  bun             # TS runtime for the unified bash-gate hook (brew: oven-sh/bun)
  gitleaks        # secrets scanner — commit/push gate
  ruff            # Python lint+format — syntax gate for the post-edit hook (9.6ms)
  taplo           # TOML checker/formatter — syntax gate (9.1ms)
)

info "Installing ${#BREW_TOOLS[@]} brew packages..."
for tool in "${BREW_TOOLS[@]}"; do
  if brew list "$tool" &>/dev/null; then
    echo "  ✓ $tool (already installed)"
  else
    echo "  → $tool..."
    brew install "$tool" 2>/dev/null || warn "Failed to install $tool via brew"
  fi
done

# ─── Cargo packages ──────────────────────────────────────

CARGO_TOOLS=(
  "amber"         # ambr/ambs — parallel codebase-wide search & replace
)

info "Installing cargo packages..."
for tool_spec in "${CARGO_TOOLS[@]}"; do
  read -r tool <<< "$tool_spec"
  if command -v "$tool" >/dev/null 2>&1 || cargo install --list | grep -q "^$tool "; then
    echo "  ✓ $tool (already installed)"
  else
    echo "  → $tool..."
    cargo install "$tool" 2>/dev/null || warn "Failed to install $tool via cargo"
  fi
done

# ─── qlty (goto linter — no brew formula, install release binary) ──

if command -v qlty >/dev/null 2>&1; then
  echo "  ✓ qlty $(qlty --version 2>/dev/null | head -1 | cut -d' ' -f2) (already installed)"
else
  QLTY_BIN_DIR="$HOME/.local/bin"
  mkdir -p "$QLTY_BIN_DIR"
  case "$(uname -m)" in
    arm64)  QLTY_ASSET="qlty-aarch64-apple-darwin.tar.xz" ;;
    x86_64) QLTY_ASSET="qlty-x86_64-apple-darwin.tar.xz" ;;
    *)      QLTY_ASSET="" ;;
  esac
  if [ -n "$QLTY_ASSET" ] && [ "$(uname -s)" = "Darwin" ]; then
    echo "  → qlty (from github.com/qltysh/qlty releases)..."
    QLTY_TMP="$(mktemp -d)"
    if curl -fsSL "https://github.com/qltysh/qlty/releases/latest/download/$QLTY_ASSET" -o "$QLTY_TMP/qlty.tar.xz" \
       && tar -xJf "$QLTY_TMP/qlty.tar.xz" -C "$QLTY_TMP" \
       && find "$QLTY_TMP" -name qlty -type f -exec /bin/cp -f {} "$QLTY_BIN_DIR/qlty" \; \
       && chmod +x "$QLTY_BIN_DIR/qlty"; then
      info "Installed qlty to $QLTY_BIN_DIR/qlty"
    else
      warn "qlty install failed — get it from https://github.com/qltysh/qlty/releases"
    fi
    rm -rf "$QLTY_TMP"
  else
    warn "Unsupported platform for qlty auto-install — see https://github.com/qltysh/qlty/releases"
  fi
fi

# ─── Optional MCP binaries (Claude Code extras) ──────────

if [ -d "$HOME/.claude/hooks" ] && command -v bun >/dev/null 2>&1; then
  (cd "$HOME/.claude/hooks" && bun install) 2>/dev/null || warn "bun install failed for hooks (shell-quote dep)"
fi
if command -v npm >/dev/null 2>&1; then
  if command -v chrome-devtools-mcp >/dev/null 2>&1; then
    echo "  ✓ chrome-devtools-mcp (already installed)"
  else
    echo "  → chrome-devtools-mcp (browser testing MCP)..."
    npm install -g chrome-devtools-mcp 2>/dev/null || warn "chrome-devtools-mcp install failed (npm)"
  fi
  if command -v prettier >/dev/null 2>&1; then
    echo "  ✓ prettier (already installed)"
  else
    echo "  → prettier (GFM markdown formatter — markdown-only, qlty biome owns code)..."
    npm install -g prettier 2>/dev/null || warn "prettier install failed (npm)"
  fi
  if command -v esbuild >/dev/null 2>&1; then
    echo "  ✓ esbuild (already installed)"
  else
    echo "  → esbuild (fastest TS/JSX parse gate, 6.8ms)..."
    npm install -g esbuild 2>/dev/null || warn "esbuild install failed (npm)"
  fi
else
  warn "npm not found — skipped chrome-devtools-mcp and esbuild"
fi

# ─── Git config ──────────────────────────────────────────

info "Configuring git..."
if git config --global core.pager &>/dev/null; then
  warn "git core.pager already set to '$(git config --global core.pager)'. Skipping."
else
  git config --global core.pager delta
  git config --global interactive.diffFilter "delta --color-only"
  info "Set delta as git diff pager"
fi

# ─── Shell integration ───────────────────────────────────

SHELL_RC=""
if [ -f "$HOME/.zshrc" ]; then SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then SHELL_RC="$HOME/.bashrc"
fi

if [ -n "$SHELL_RC" ]; then
  if grep -q "zoxide init" "$SHELL_RC" 2>/dev/null; then
    echo "  ✓ zoxide already in $SHELL_RC"
  else
    echo "" >> "$SHELL_RC"
    echo "# speedy-claude: zoxide smart cd" >> "$SHELL_RC"
    echo 'eval "$(zoxide init zsh)"' >> "$SHELL_RC"
    info "Added zoxide init to $SHELL_RC"
  fi
fi

# ─── LLM Specialist Swarm (MLX, Metal-native) ────────────

if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
  info "Setting up the Apple Silicon layer (LLM tier: $LLM_FLAG)..."

  if [ "$LLM_FLAG" != "off" ]; then
  # Install mlx-lm via uv (fastest Python package manager)
  if ! command -v mlx_lm.server >/dev/null 2>&1; then
    echo "  → installing mlx-lm via uv..."
    if command -v uv >/dev/null 2>&1; then
      uv tool install mlx-lm
    else
      curl -LsSf https://astral.sh/uv/install.sh | sh
      export PATH="$HOME/.local/bin:$PATH"
      uv tool install mlx-lm
    fi
  else
    echo "  ✓ mlx-lm already installed"
  fi
  fi # LLM_FLAG != off

  # Install playwright for browser automation (MJ/Dinero skills)
  if [ -d "$HOME/.claude/mcp-servers" ] && [ ! -d "$HOME/.claude/mcp-servers/node_modules/playwright" ]; then
    echo "  → installing playwright..."
    (cd "$HOME/.claude/mcp-servers" && bun add playwright 2>/dev/null) || warn "playwright install failed"
  fi

  if [ "$LLM_FLAG" = "full" ] && [ "$SKIP_MODELS" -eq 0 ]; then
  # Download the specialist models (61GB total, parallel; tier applies inside belt)
  MLX_PYTHON="$(command -v python3)"
  if [ -x "$HOME/.local/share/uv/tools/mlx-lm/bin/python" ]; then
    MLX_PYTHON="$HOME/.local/share/uv/tools/mlx-lm/bin/python"
  fi

  SWARM_MODELS=(
    "mlx-community/Qwen3-4B-Instruct-2507-4bit"       # menial (non-thinking, ~100 TPS)
    "mlx-community/Qwen3.5-9B-MLX-4bit"                # general/Danish (201 langs)
    "mlx-community/Qwen2.5-Coder-32B-Instruct-4bit"    # code specialist
    "mlx-community/Qwen3.5-27B-Claude-4.6-Opus-Distilled-MLX-4bit"  # reasoning
    "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ"      # embeddings
    "mlx-community/Qwen3-Reranker-0.6B-4bit"           # reranking
  )

  MODELS_NEEDED=0
  for MODEL in "${SWARM_MODELS[@]}"; do
    DIR="$HOME/.cache/huggingface/hub/models--$MODEL"
    if [ ! -d "$DIR" ] || [ "$(du -s "$DIR" 2>/dev/null | cut -f1)" -lt 100000 ]; then
      MODELS_NEEDED=$((MODELS_NEEDED + 1))
    fi
  done

  if [ "$MODELS_NEEDED" -gt 0 ]; then
    echo "  → downloading $MODELS_NEEDED specialist models (~61GB, runs in background)..."
    for MODEL in "${SWARM_MODELS[@]}"; do
      $MLX_PYTHON -c "from huggingface_hub import snapshot_download; snapshot_download('$MODEL')" 2>/dev/null &
    done
    # Don't wait — models download in background while other setup continues
    info "Model downloads started in background. Run 'bun ~/.claude/local-llm/swarm.ts start' after they complete."
  else
    echo "  ✓ all specialist models already cached"
  fi
  fi # LLM_FLAG != off
  if [ "$LLM_FLAG" = "minimal" ] && [ "$SKIP_MODELS" -eq 0 ]; then
    # smallest-fit law: minimal tier fetches ONLY the BELT_TIER=minimal
    # residents — derived from the installed registry (the swarm's own
    # source of truth), never a hand-list copied here.
    MODELS="$(BELT_TIER=minimal LOCAL_LLM_HOME="$HOME/.claude/local-llm" bun -e '
const { residentSet } = await import(process.env.LOCAL_LLM_HOME + "/registry.ts");
process.stdout.write(residentSet().map((s) => s.model).join("\n"));
')"
    MLX_PYTHON="$HOME/.local/share/uv/tools/mlx-lm/bin/python"
    if [ -x "$MLX_PYTHON" ]; then
      while IFS= read -r model; do
        [ -z "$model" ] && continue
        echo "  → downloading $model (BELT_TIER=minimal resident, resumes if partial)"
        "$MLX_PYTHON" -c 'from huggingface_hub import snapshot_download; import sys; snapshot_download(sys.argv[1])' "$model" \
          || warn "  ✗ $model failed — re-run install to resume"
      done <<<"$MODELS"
    else
      warn "mlx-lm missing — minimal residents not fetched (re-run install to resume)"
    fi
  fi

  # Copy swarm management scripts to PATH
  for SCRIPT in mlx-swarm mlx-swarm-download claude-fast local-llm-stack approve-skill; do
    if [ -f "$HOME/.claude/hooks/$SCRIPT" ]; then
      chmod +x "$HOME/.claude/hooks/$SCRIPT"
      ln -sf "$HOME/.claude/hooks/$SCRIPT" "$HOME/.local/bin/$SCRIPT" 2>/dev/null
      echo "  ✓ $SCRIPT → ~/.local/bin/"
    fi
  done

  # Generate HMAC secret for signed skill approvals
  if [ ! -f "$HOME/.claude/.skill-review-secret" ]; then
    head -c 32 /dev/urandom | xxd -p -c 32 > "$HOME/.claude/.skill-review-secret"
    chmod 600 "$HOME/.claude/.skill-review-secret"
    echo "  ✓ skill approval HMAC secret generated"
  fi

  # Install LaunchAgent for daily insights (headless analyst runs)
  if [ -f "$HOME/.claude/hooks/launchd/com.klh.claude-insights.plist" ]; then
    sed "s|__HOME__|$HOME|g" "$HOME/.claude/hooks/launchd/com.klh.claude-insights.plist" \
      > "$HOME/Library/LaunchAgents/com.klh.claude-insights.plist"
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.klh.claude-insights.plist" 2>/dev/null \
      || warn "LaunchAgent bootstrap failed"
    echo "  ✓ LaunchAgent com.klh.claude-insights installed (daily 06:43 analyst run)"
  fi
else
  warn "Not Apple Silicon (arm64) — local LLM layer skipped"
fi

# ─── Hub federation (W173 enroll; standalone default) ────
# The enrollment ask at install end. Default = standalone (empty hub roster);
# yes exchanges the admin-minted enrollment code for a hub-issued spoke token
# via /federation/enroll, stores the roster + DNS entries, pulls the first
# policy (heartbeat-on-the-pull) and echoes the menu. Standalone revisits via
# /console/settings. Re-runs never re-prompt and never wipe an enrollment.
HUB_CONFIG="$HOME/.claude/local-llm/hubs.json"

write_hub_config() {
  # $1=url $2=spoke_id $3=spoke_token $4=dns_entries JSON array (atomic, 0600).
  # W230-compatible shape: {hubs: [{name, url, token_env, dns_entries}]} — the
  # token NEVER lands in config: it goes to hub.env (0600), and the roster
  # references it by env name.
  local TMP ENVF
  ENVF="$(dirname "$HUB_CONFIG")/hub.env"
  printf 'KLH_HUB_SPOKE_TOKEN=%s\n' "$3" > "$ENVF"
  chmod 600 "$ENVF"
  TMP="$HUB_CONFIG.tmp.$$"
  jq -n --arg name "$(hostname -s)" --arg url "$1" --argjson dns "$4" \
    '{hubs: [{name: $name, url: $url, token_env: "KLH_HUB_SPOKE_TOKEN", dns_entries: $dns}]}' > "$TMP"
  chmod 600 "$TMP"
  mv "$TMP" "$HUB_CONFIG"
}

write_standalone_config() {
  # standalone = empty hub roster; never overwrites an existing enrollment
  [ -s "$HUB_CONFIG" ] && return 0
  printf '{\n  "hubs": []\n}\n' > "$HUB_CONFIG"
  chmod 600 "$HUB_CONFIG"
}
hub_enroll() {
  # $1 = hub base URL, $2 = enrollment code (admin-minted, W173)
  local HUB CODE RESP ID TOKEN DNS PULL BODY
  HUB="${1%/}"
  CODE="${2:-}"
  if [ -z "$HUB" ] || [ -z "$CODE" ] || ! command -v jq >/dev/null 2>&1; then
    echo "  [WARN] hub url, code and jq are required — staying standalone" >&2
    return 1
  fi
  BODY="$(jq -n --arg code "$CODE" --arg host "$(hostname -s)" '{code: $code, hostname: $host}')"
  RESP="$(curl -fsS --max-time 10 -H 'Content-Type: application/json' -d "$BODY" "$HUB/federation/enroll" 2>/dev/null)" \
    || { echo "  [WARN] enroll failed at $HUB — staying standalone (degradation law)" >&2; return 1; }
  ID="$(printf '%s' "$RESP" | jq -er '.spoke_id // empty' 2>/dev/null)" \
    || { echo "  [WARN] enroll response has no spoke_id — staying standalone" >&2; return 1; }
  TOKEN="$(printf '%s' "$RESP" | jq -er '.spoke_token // empty' 2>/dev/null)" \
    || { echo "  [WARN] enroll response has no spoke_token — staying standalone" >&2; return 1; }
  DNS="$(printf '%s' "$RESP" | jq -c '.dns_entries // []' 2>/dev/null)" || DNS="[]"
  write_hub_config "$HUB" "$ID" "$TOKEN" "$DNS" || { echo "  [WARN] could not write $HUB_CONFIG" >&2; return 1; }
  echo "  ✓ enrolled: spoke $ID at $HUB"
  # first policy pull (heartbeat-on-the-pull) — carries the echo menu
  if PULL="$(curl -fsS --max-time 10 -H "Authorization: Bearer $TOKEN" "$HUB/federation/policy" 2>/dev/null)"; then
    printf '%s' "$PULL" | jq . > "${HUB_CONFIG%/hubs.json}/last-policy-pull.json" 2>/dev/null || true
    echo "  hub menu (what the hub lets this spoke use):"
    printf '%s' "$PULL" | jq -r '(.menu // [])[] | if type == "string" then "    • " + . else "    • " + (.name // .id // tostring) end' 2>/dev/null
  else
    echo "  [WARN] first policy pull failed — hub config kept; retries at next belt start" >&2
  fi
}
hub_ask() {
  # ask only when no hub config exists — re-runs never re-prompt, never wipe
  mkdir -p "$HOME/.claude/local-llm"
  if [ -s "$HUB_CONFIG" ]; then
    jq -r 'if (.hubs // [] | length) > 0 then "  ✓ enrolled to \(.hubs[0].url)" else "  · standalone (no hub)" end' "$HUB_CONFIG" 2>/dev/null \
      || echo "  · hub config present — see /console/settings"
    return 0
  fi
  if [ ! -t 0 ]; then
    write_standalone_config
    echo "  · non-interactive — standalone (revisit via /console/settings)"
    return 0
  fi
  printf "%s" "Do you want to buckle up and connect to a belt hub? [y/N] "
  local ANSWER HUB_URL ENROLL_CODE
  read -r ANSWER
  case "$ANSWER" in
    y | Y | yes | Yes | YES)
      printf "%s" "Hub URL: "
      read -r HUB_URL
      printf "%s" "Enrollment code: "
      read -r ENROLL_CODE
      if hub_enroll "$HUB_URL" "$ENROLL_CODE"; then
        echo "  · connected — manage via /console/settings"
      else
        write_standalone_config
        echo "  · staying standalone — revisit via /console/settings"
      fi
      ;;
    *)
      write_standalone_config
      echo "  · standalone (default) — connect later via /console/settings"
      ;;
  esac
}
hub_ask
# ─── Summary ─────────────────────────────────────────────

echo ""
echo -e "${BOLD}══════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}${GREEN}  speedy installed!${RESET}"
echo -e "${BOLD}══════════════════════════════════════════════════${RESET}"
echo ""
echo "  What changed:"
echo "    • 35+ CLI tools installed via brew/cargo (+qlty release binary)"
echo "    • buckle router plane (optional layer) + hub federation ask (standalone default)"
echo "    • zoxide initialized in shell"
if [ "$LLM_FLAG" != "off" ]; then
  echo "    • belt fleet deployed (tier: $LLM_FLAG) + .local registration"
else
  echo "    • LLM tier: off — cloud-only (re-run with --llm=minimal|full to add the fleet)"
fi
echo "    • LaunchAgents: daily insights (+ local-LLM when deployed)"
echo "    • Skill approval HMAC secret generated"
echo ""
echo "  Next steps:"
echo "    1. Restart your shell (or source $SHELL_RC)"
echo "    2. Copy settings.example.json to ~/.claude/settings.json and fill token"
if [ "$LLM_FLAG" != "off" ]; then
  echo "    3. Wait for model downloads to finish, then run: bun ~/.claude/local-llm/swarm.ts start"
fi
echo "    4. Start a new Claude Code session"
echo "    5. Belt hub: standalone by default — connect via /console/settings"

if [ "$LLM_FLAG" != "off" ]; then
  echo "  Local LLM fleet (belt, tier: $LLM_FLAG):"
  echo "    bun ~/.claude/local-llm/swarm.ts status    — check what's running"
  echo "    claude-fast <prompt> — local inference (falls back to remote)"
  echo ""
fi
echo "  Daily Insights:"
echo "    LaunchAgent runs at 06:43 — findings in ~/.claude-insights/PENDING.md"
echo ""
echo "  Fleet laws (in-repo mirror): docs/laws.md"
echo "  Verify: fd --version && rg --version | head -1 && ast-grep --version && qlty --version"
if [ "$LLM_FLAG" != "off" ]; then
  echo "          bun ~/.claude/local-llm/swarm.ts status"
fi
echo ""
