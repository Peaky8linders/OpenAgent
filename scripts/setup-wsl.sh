#!/bin/bash
# Setup script for OpenShell + NemoClaw on WSL/Linux
# Run this inside WSL Ubuntu 24.04: wsl -d Ubuntu-24.04 -- bash scripts/setup-wsl.sh
set -euo pipefail

export PATH="/root/.local/bin:$PATH"

echo "=== OpenAgent: Setting up OpenShell + NemoClaw ==="

# 1. Install Node.js 22+ (required by NemoClaw/OpenClaw)
echo "[1/5] Checking Node.js..."
NODE_VERSION=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1 || echo "0")
if [ "$NODE_VERSION" -lt 22 ]; then
    echo "  Installing Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - 2>/dev/null
    apt-get install -y nodejs 2>/dev/null
fi
echo "  Node.js $(node --version) / npm $(npm --version)"

# 2. Install OpenShell
echo "[2/5] Installing OpenShell..."
if command -v openshell &>/dev/null; then
    echo "  OpenShell already installed: $(openshell --version)"
else
    curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh
    export PATH="/root/.local/bin:$PATH"
    echo "  OpenShell $(openshell --version) installed."
fi

# 3. Install NemoClaw (via official installer, NOT PyPI)
echo "[3/5] Installing NemoClaw..."
if command -v nemoclaw &>/dev/null; then
    echo "  NemoClaw already installed."
else
    curl -fsSL https://nvidia.com/nemoclaw.sh | bash
    echo "  NemoClaw installed."
fi

# 4. Verify Docker is available
echo "[4/5] Checking Docker..."
if ! docker info &>/dev/null; then
    echo "  ERROR: Docker is not running."
    echo "  On Windows: Start Docker Desktop, then enable WSL integration:"
    echo "    Settings > Resources > WSL Integration > Ubuntu-24.04"
    exit 1
fi
echo "  Docker is running."

# 5. Run NemoClaw onboard (if not already set up)
echo "[5/5] Running NemoClaw onboard wizard..."
echo "  This will prompt for your NVIDIA API key."
echo "  Get one free at https://build.nvidia.com"
echo ""
nemoclaw onboard

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Connect to your agent:"
echo "  nemoclaw my-assistant connect"
echo ""
echo "Or run inside the sandbox:"
echo "  openclaw tui"
