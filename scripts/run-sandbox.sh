#!/bin/bash
# Launch the private coding agent inside an OpenShell sandbox
set -euo pipefail

export PATH="/root/.local/bin:$PATH"

SANDBOX_NAME="${1:-openagent}"

echo "=== Launching OpenAgent in sandbox: ${SANDBOX_NAME} ==="

# Check gateway is running
if ! openshell gateway info &>/dev/null; then
    echo "Starting gateway..."
    openshell gateway start --name nemoclaw
fi

# Check if sandbox already exists
if openshell sandbox list 2>/dev/null | grep -q "${SANDBOX_NAME}"; then
    echo "Sandbox '${SANDBOX_NAME}' already exists. Connecting..."
    openshell sandbox connect "${SANDBOX_NAME}"
    exit 0
fi

# Create sandbox from base template (faster than python, includes Claude/OpenCode/Codex agents)
echo "Creating sandbox '${SANDBOX_NAME}'..."
openshell sandbox create --name "${SANDBOX_NAME}" --from base

echo ""
echo "Agent sandbox ready: ${SANDBOX_NAME}"
echo "To connect: openshell sandbox connect ${SANDBOX_NAME}"
echo "To list:    openshell sandbox list"
echo "To delete:  openshell sandbox delete ${SANDBOX_NAME}"
