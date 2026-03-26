#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# OpenAgent / VaultClaw — Quick Start Installer
# One command to deploy a private, compliance-grade coding agent
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Peaky8linders/OpenAgent/main/scripts/quickstart.sh | bash
#   # or
#   bash scripts/quickstart.sh
# ──────────────────────────────────────────────────────────────
set -euo pipefail

VERSION="1.0.0"
REPO="https://github.com/Peaky8linders/OpenAgent.git"
INSTALL_DIR="${OPENAGENT_HOME:-$HOME/.openagent}"
CONFIG_DIR="$INSTALL_DIR/config"
LOG_FILE="$INSTALL_DIR/install.log"

# ─── Colors ──────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
step()  { echo -e "\n${BOLD}${CYAN}▸ $*${NC}"; }

# ─── Banner ──────────────────────────────────────────────────
echo -e "${BOLD}${CYAN}"
cat << 'BANNER'
  ╔═══════════════════════════════════════════════╗
  ║  OpenAgent / VaultClaw Quick Start v1.0.0     ║
  ║  Private, compliance-grade coding agent       ║
  ║                                               ║
  ║  Security: Sentinel + Audit Chain + RBAC      ║
  ║  Compliance: HIPAA | SOC 2 | PCI-DSS | GDPR  ║
  ╚═══════════════════════════════════════════════╝
BANNER
echo -e "${NC}"

# ─── OS Detection ────────────────────────────────────────────
step "Detecting environment"

OS="unknown"
ARCH="$(uname -m)"
case "$(uname -s)" in
    Linux*)  OS="linux";;
    Darwin*) OS="macos";;
    MINGW*|MSYS*|CYGWIN*) OS="windows-wsl";;
esac

if [[ "$OS" == "unknown" ]]; then
    err "Unsupported OS. OpenAgent requires macOS, Linux, or WSL."
    exit 1
fi

ok "OS: $OS ($ARCH)"

# ─── Dependency Checks ──────────────────────────────────────
step "Checking dependencies"

check_cmd() {
    if command -v "$1" &>/dev/null; then
        ok "$1 found: $(command -v "$1")"
        return 0
    else
        return 1
    fi
}

# Python 3.12+
PYTHON=""
for py in python3.14 python3.13 python3.12 python3; do
    if check_cmd "$py"; then
        PY_VER=$("$py" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null || echo "0.0")
        PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
        PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
        if [[ "$PY_MAJOR" -ge 3 && "$PY_MINOR" -ge 12 ]]; then
            PYTHON="$py"
            ok "Python $PY_VER ✓"
            break
        fi
    fi
done

if [[ -z "$PYTHON" ]]; then
    warn "Python 3.12+ not found. Installing..."
    if [[ "$OS" == "macos" ]]; then
        if check_cmd brew; then
            brew install python@3.13
            PYTHON="python3.13"
        else
            err "Install Homebrew first: https://brew.sh"
            exit 1
        fi
    elif [[ "$OS" == "linux" || "$OS" == "windows-wsl" ]]; then
        if check_cmd apt-get; then
            sudo apt-get update -qq && sudo apt-get install -y python3.13 python3.13-venv
            PYTHON="python3.13"
        elif check_cmd dnf; then
            sudo dnf install -y python3.13
            PYTHON="python3.13"
        else
            err "Install Python 3.12+ manually: https://python.org"
            exit 1
        fi
    fi
fi

# uv (fast Python package manager)
if ! check_cmd uv; then
    info "Installing uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
    ok "uv installed"
fi

# Git
if ! check_cmd git; then
    err "Git is required. Install it: https://git-scm.com"
    exit 1
fi

# Docker (optional, for LCM + sandboxes)
DOCKER_AVAILABLE=false
if check_cmd docker; then
    if docker info &>/dev/null 2>&1; then
        DOCKER_AVAILABLE=true
        ok "Docker daemon running ✓"
    else
        warn "Docker installed but daemon not running — LCM memory will use SQLite fallback"
    fi
else
    warn "Docker not found — LCM memory will use SQLite fallback (install Docker for PostgreSQL)"
fi

# Node.js (for LCM server)
NODE_AVAILABLE=false
if check_cmd node; then
    NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
    if [[ "$NODE_VER" -ge 22 ]]; then
        NODE_AVAILABLE=true
        ok "Node.js v$(node -v | sed 's/v//') ✓"
    else
        warn "Node.js 22+ required for LCM server (found v$NODE_VER)"
    fi
else
    warn "Node.js not found — LCM encrypted memory won't start (install: https://nodejs.org)"
fi

# ─── Clone / Update Repository ──────────────────────────────
step "Setting up OpenAgent"

if [[ -d "$INSTALL_DIR/.git" ]]; then
    info "Existing installation found, updating..."
    cd "$INSTALL_DIR"
    git pull --ff-only origin main 2>/dev/null || true
else
    info "Cloning repository..."
    git clone --depth 1 "$REPO" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

ok "Source at $INSTALL_DIR"

# ─── Python Environment ─────────────────────────────────────
step "Creating Python environment"

cd "$INSTALL_DIR"
if [[ ! -d ".venv" ]]; then
    uv venv --python "$PYTHON"
fi
# shellcheck disable=SC1091
source .venv/bin/activate
uv pip install -e "." 2>&1 | tail -3
ok "Python environment ready"

# ─── Configuration ───────────────────────────────────────────
step "Configuring OpenAgent"

mkdir -p "$CONFIG_DIR"

# Generate config if it doesn't exist
if [[ ! -f "$CONFIG_DIR/agent-config.yaml" ]]; then
    cat > "$CONFIG_DIR/agent-config.yaml" << 'YAML'
# OpenAgent Configuration — Generated by quickstart.sh
agent:
  name: openagent
  version: "0.4.1"

model:
  provider: nvidia
  name: nvidia/llama-3.3-nemotron-super-49b-v1
  temperature: 0.1
  max_tokens: 8192

compliance:
  framework: none  # Options: hipaa, soc2, pci, gdpr, none
  audit_enabled: true
  sentinel_enabled: true
  phi_detection: true

memory:
  backend: sqlite  # Options: sqlite, postgresql
  encryption: true

server:
  host: 127.0.0.1
  port: 8080
  cors_origins:
    - "http://localhost:3000"
    - "http://localhost:5173"
YAML
    ok "Config created at $CONFIG_DIR/agent-config.yaml"
else
    ok "Config exists, keeping current settings"
fi

# ─── API Key Setup ───────────────────────────────────────────
step "API key configuration"

if [[ -z "${NVIDIA_API_KEY:-}" ]]; then
    echo ""
    echo -e "  ${BOLD}NVIDIA API Key required${NC} (free at https://build.nvidia.com)"
    echo ""
    echo "  Options:"
    echo "    1. Set it now:  export NVIDIA_API_KEY=nvapi-xxx"
    echo "    2. Add to shell: echo 'export NVIDIA_API_KEY=nvapi-xxx' >> ~/.bashrc"
    echo "    3. Skip for now (agent won't work without it)"
    echo ""

    if [[ -t 0 ]]; then
        read -rp "  Enter API key (or press Enter to skip): " API_KEY
        if [[ -n "$API_KEY" ]]; then
            export NVIDIA_API_KEY="$API_KEY"
            # Persist for future sessions
            SHELL_RC="$HOME/.bashrc"
            [[ "$OS" == "macos" ]] && SHELL_RC="$HOME/.zshrc"
            if ! grep -q "NVIDIA_API_KEY" "$SHELL_RC" 2>/dev/null; then
                echo "export NVIDIA_API_KEY=\"$API_KEY\"" >> "$SHELL_RC"
                ok "API key saved to $SHELL_RC"
            fi
        else
            warn "Skipped — set NVIDIA_API_KEY before running the agent"
        fi
    else
        warn "Non-interactive mode — set NVIDIA_API_KEY environment variable"
    fi
else
    ok "NVIDIA_API_KEY is set"
fi

# ─── Start LCM Server (if Docker available) ─────────────────
step "Starting services"

if [[ "$DOCKER_AVAILABLE" == true ]]; then
    info "Starting PostgreSQL + pgvector for LCM memory..."
    cd "$INSTALL_DIR/packages/lcm" 2>/dev/null && docker compose up -d 2>/dev/null && cd "$INSTALL_DIR" || warn "LCM Docker setup skipped"
fi

if [[ "$NODE_AVAILABLE" == true && -f "$INSTALL_DIR/packages/lcm/server.ts" ]]; then
    info "LCM server available — start with: cd packages/lcm && npm start"
fi

# ─── Verification ────────────────────────────────────────────
step "Verifying installation"

cd "$INSTALL_DIR"
# Quick smoke test
"$PYTHON" -c "
import sys
sys.path.insert(0, '.')
try:
    from openagent.compliance import get_policy_pack, FRAMEWORKS
    print(f'  Compliance frameworks: {", ".join(FRAMEWORKS)}')
    from openagent.config import load_config
    print(f'  Config loader: OK')
    print(f'  Python: {sys.version.split()[0]}')
except ImportError as e:
    print(f'  Warning: {e} (run: uv pip install -e .)')
" 2>/dev/null || warn "Some modules not importable — run: cd $INSTALL_DIR && uv pip install -e ."

ok "Installation verified"

# ─── Summary ─────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}${GREEN}  OpenAgent installed successfully!${NC}"
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${BOLD}Location:${NC}     $INSTALL_DIR"
echo -e "  ${BOLD}Config:${NC}       $CONFIG_DIR/agent-config.yaml"
echo -e "  ${BOLD}Python:${NC}       $PYTHON"
echo ""
echo -e "  ${BOLD}${CYAN}Quick start:${NC}"
echo -e "    cd $INSTALL_DIR"
echo -e "    ${BOLD}python main.py${NC}                          # Interactive REPL"
echo -e "    ${BOLD}python main.py --task \"Build a REST API\"${NC} # Single task"
echo -e "    ${BOLD}python main.py --compliance hipaa${NC}        # HIPAA mode"
echo ""
echo -e "  ${BOLD}${CYAN}ClawGuard iOS:${NC}"
echo -e "    Connect from your iPhone/iPad:"
echo -e "    Host: $(hostname -I 2>/dev/null | awk '{print $1}' || echo '127.0.0.1')  Port: 8080"
echo -e "    TLS: Enable for production"
echo ""
echo -e "  ${BOLD}${CYAN}Compliance:${NC}"
echo -e "    hipaa | soc2 | pci | gdpr | none"
echo -e "    Edit: $CONFIG_DIR/agent-config.yaml"
echo ""
echo -e "  ${BOLD}Docs:${NC} https://github.com/Peaky8linders/OpenAgent"
echo ""
