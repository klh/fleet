#!/usr/bin/env bash
set -euo pipefail

# speedy — Make Claude Code 10-1400x faster at file operations
# Part of the klh fleet monorepo: https://github.com/klh/fleet (packages/speedy)

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

# ─── Fleet revision acquisition (W422.6: one revision, no legacy clones) ──
# Piped runs (curl | bash) have no checkout adjacent to this script: acquire
# the fleet monorepo (FLEET_REPO_URL override) and re-run THIS installer from
# that revision, so every step consumes one tree. A checkout run keeps
# REPO_DIR — bin/install-fleet.ts sits adjacent and resolves this tree itself.
FLEET_TS="$REPO_DIR/bin/install-fleet.ts"
if [ "$DRY_RUN" -eq 0 ] && [ ! -f "$FLEET_TS" ]; then
  FLEET_TMP="$(mktemp -d)"
  if git clone --depth 1 --single-branch "${FLEET_REPO_URL:-https://github.com/klh/fleet}" "$FLEET_TMP/fleet"; then
    info "fleet revision acquired — re-running this installer from it"
    if bash "$FLEET_TMP/fleet/packages/speedy/install.sh" "$@"; then rc=0; else rc=$?; fi
    rm -rf "$FLEET_TMP"
    exit $rc
  fi
  warn "fleet clone failed — klh layers will be skipped (FLEET_REPO_URL override)"
fi

# ─── Preflight ───────────────────────────────────────────

command -v brew >/dev/null 2>&1 || { error "Homebrew not found. Install: https://brew.sh"; exit 1; }
command -v cargo >/dev/null 2>&1 || { warn "cargo not found. Installing rust via rustup..."; curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y; source "$HOME/.cargo/env"; }

OS="$(uname -s)"
ARCH="$(uname -m)"
info "Detected: $OS $ARCH"
# ─── Dry run: print the plan, touch nothing ──────────────
if [ "$DRY_RUN" -eq 1 ]; then
  info "--dry-run — the chain, in order (nothing executed):"
  echo "  1. klh layers (klh-local, belt swarm, buckle, suspenders)  $([ -f "$HOME/.claude/hooks/suspenders/bin/work.ts" ] && echo "present — install-fleet.ts skips installed phases" || echo "install via bin/install-fleet.ts") — one fleet revision, tier: $LLM_FLAG$( [ "$SKIP_MODELS" -eq 1 ] && echo ", --skip-models" )"
  echo "  2. speedy layer        skills → ~/.claude/skills (+ ~/.agents/skills), hooks + statusline sync, policy adapters"
  echo "  3. toolchain           brew/cargo/qlty/npm packages"
  echo "  4. apple silicon       mlx-lm$( [ "$LLM_FLAG" != "off" ] && echo " + swarm model downloads (tier: $LLM_FLAG)" )"
  echo "  5. shell + git         zoxide init, delta pager — hub ask runs at fleet-chain end"
  exit 0
fi

# ─── Fleet layers: the klh chain from ONE fleet revision (W422.6) ────────
# klh-local, the belt swarm, buckle and suspenders install via the umbrella
# installer (bin/install-fleet.ts): one checkout acquisition — FLEET_CHECKOUT →
# this checkout → clone of FLEET_REPO_URL at FLEET_REF — every phase from
# packages/<name> in that same revision. --llm maps: off = suspenders
# --no-llm (cloud-only), minimal = BELT_TIER=minimal, full = + belt
# --tier full. Hub ask runs at fleet-chain end.
if ! command -v bun >/dev/null 2>&1; then
  brew install bun || warn "bun unavailable — klh layers will be skipped"
fi
if command -v bun >/dev/null 2>&1 && [ -f "$FLEET_TS" ]; then
  info "fleet layers (klh-local, belt swarm, buckle, suspenders) via bin/install-fleet.ts..."
  FLEET_FLAGS=(--llm="$LLM_FLAG")
  [ "$SKIP_MODELS" -eq 1 ] && FLEET_FLAGS+=(--skip-models)
  if ! bun "$FLEET_TS" "${FLEET_FLAGS[@]}"; then
    warn "fleet layers failed (optional) — continuing with speedy-only setup"
  fi
else
  warn "no fleet source for the klh layers (no bun or no install-fleet.ts) — skipped"
fi

# ─── Speedy-native steps (skills, tools, shell, models) ──
# .local registration, .local service front and the hub federation ask live
# in bin/install-fleet.ts (local + hub phases) — the umbrella runs them at
# fleet-chain end.

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

# ─── Speedy runtime files → ~/.claude (hooks + statusline, never clobber) ──
# settings.example.json references $HOME/.claude/hooks/*.ts + statusline.ts —
# the old clone-into-~/.claude flow put them there; the checkout-based install
# syncs them explicitly (keep-if-present, like the skills copy above).
mkdir -p "$HOME/.claude/hooks/lib"
for F in insight-recall.ts pa-prefix.ts subagent-statusline.ts; do
  [ -f "$REPO_DIR/hooks/$F" ] || continue
  if [ -e "$HOME/.claude/hooks/$F" ]; then
    echo "  = hooks/$F (kept — already installed)"
  else
    cp "$REPO_DIR/hooks/$F" "$HOME/.claude/hooks/$F" && echo "  + hooks/$F"
  fi
done
if [ -f "$REPO_DIR/hooks/lib/hookio.ts" ]; then
  if [ -e "$HOME/.claude/hooks/lib/hookio.ts" ]; then
    echo "  = hooks/lib/hookio.ts (kept — already installed)"
  else
    cp "$REPO_DIR/hooks/lib/hookio.ts" "$HOME/.claude/hooks/lib/hookio.ts" && echo "  + hooks/lib/hookio.ts"
  fi
fi
if [ -f "$REPO_DIR/statusline.ts" ]; then
  if [ -e "$HOME/.claude/statusline.ts" ]; then
    echo "  = statusline.ts (kept — already installed)"
  else
    cp "$REPO_DIR/statusline.ts" "$HOME/.claude/statusline.ts" && echo "  + statusline.ts"
  fi
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
  if [ -f "$REPO_DIR/hooks/launchd/com.klh.claude-insights.plist" ]; then
    sed "s|__HOME__|$HOME|g" "$REPO_DIR/hooks/launchd/com.klh.claude-insights.plist" \
      > "$HOME/Library/LaunchAgents/com.klh.claude-insights.plist"
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.klh.claude-insights.plist" 2>/dev/null \
      || warn "LaunchAgent bootstrap failed"
    echo "  ✓ LaunchAgent com.klh.claude-insights installed (daily 06:43 analyst run)"
  fi
else
  warn "Not Apple Silicon (arm64) — local LLM layer skipped"
fi

# ─── Summary ─────────────────────────────────────────────

echo ""
echo -e "${BOLD}══════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}${GREEN}  speedy installed!${RESET}"

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
