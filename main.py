"""OpenAgent — Private Coding Agent.

Stack: Nemotron 3 Super + OpenShell + DeepAgents

Usage:
    python main.py                         # Interactive REPL
    python main.py --task "Create X"       # Single task
    python main.py --config path.yaml      # Custom config
"""

from openagent.cli import main

if __name__ == "__main__":
    main()
