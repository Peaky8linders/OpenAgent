"""LCM v2 Secure Memory client — talks to the LCM HTTP server.

Provides async methods for:
- Ingesting messages through the sentinel-protected pipeline
- Searching conversation history
- Querying the tamper-proof audit trail
- Running sentinel inspection on arbitrary content
"""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path
from typing import Any

import httpx

LCM_DEFAULT_PORT = 3100
LCM_SERVER_DIR = Path(__file__).parent.parent / "packages" / "lcm"


def _lcm_base_url() -> str:
    port = os.environ.get("LCM_PORT", str(LCM_DEFAULT_PORT))
    return f"http://127.0.0.1:{port}"


def _is_lcm_running() -> bool:
    """Check if LCM server is responding."""
    try:
        r = httpx.get(f"{_lcm_base_url()}/health", timeout=2.0)
        return r.status_code == 200
    except (httpx.ConnectError, httpx.TimeoutException):
        return False


def start_lcm_server() -> subprocess.Popen | None:
    """Start the LCM server as a background process if not running.

    Returns the Popen handle, or None if already running.
    """
    if _is_lcm_running():
        return None

    # Build first if needed
    dist_check = LCM_SERVER_DIR / "dist" / "server.js"
    if not dist_check.exists():
        subprocess.run(
            ["npx", "tsc"],
            cwd=str(LCM_SERVER_DIR),
            check=True,
            capture_output=True,
        )

    # Pass through store driver and database config
    lcm_env = {
        **os.environ,
        "LCM_STORE_DRIVER": os.environ.get("LCM_STORE_DRIVER", "sqlite"),
        "LCM_SQLITE_PATH": str(LCM_SERVER_DIR / "data" / "lcm.db"),
    }
    # Forward DATABASE_URL for PostgreSQL if set
    if "DATABASE_URL" in os.environ:
        lcm_env["DATABASE_URL"] = os.environ["DATABASE_URL"]

    proc = subprocess.Popen(
        ["node", "dist/server.js"],
        cwd=str(LCM_SERVER_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=lcm_env,
    )

    # Wait for server to start
    for _ in range(30):
        if _is_lcm_running():
            return proc
        time.sleep(0.2)

    proc.kill()
    raise RuntimeError("LCM server failed to start within 6 seconds")


class LcmClient:
    """Client for the LCM v2 HTTP API with optional Bearer auth."""

    def __init__(
        self,
        base_url: str | None = None,
        timeout: float = 10.0,
        api_key: str | None = None,
    ):
        self.base_url = base_url or _lcm_base_url()
        self.timeout = timeout
        headers = {}
        key = api_key or os.environ.get("LCM_API_KEY", "")
        if key:
            headers["Authorization"] = f"Bearer {key}"
        self._client = httpx.Client(
            base_url=self.base_url, timeout=timeout, headers=headers,
        )

    def health(self) -> dict[str, Any]:
        """Check server health and audit chain integrity."""
        r = self._client.get("/health")
        r.raise_for_status()
        return r.json()

    def ingest(
        self,
        content: str,
        *,
        role: str = "user",
        conversation_id: str = "default",
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Ingest a message through the sentinel-protected pipeline.

        Returns ingestion result including PII detection, topic assignment,
        and sentinel clearance status.

        Raises httpx.HTTPStatusError if sentinel blocks the content (403).
        """
        r = self._client.post(
            "/messages",
            json={
                "content": content,
                "role": role,
                "conversationId": conversation_id,
                "metadata": metadata or {},
            },
        )
        r.raise_for_status()
        return r.json()

    def get_messages(self, conversation_id: str = "default") -> list[dict[str, Any]]:
        """Get all messages for a conversation."""
        r = self._client.get(f"/messages/{conversation_id}")
        r.raise_for_status()
        return r.json().get("messages", [])

    def search(
        self,
        query: str,
        *,
        mode: str = "fts",
        conversation_id: str | None = None,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        """Search messages using full-text or regex search."""
        r = self._client.post(
            "/search",
            json={
                "pattern": query,
                "mode": mode,
                "conversationId": conversation_id,
                "limit": limit,
            },
        )
        r.raise_for_status()
        return r.json().get("results", [])

    def inspect(self, content: str) -> dict[str, Any]:
        """Run sentinel inspection on content."""
        r = self._client.post("/sentinel/inspect", json={"content": content})
        r.raise_for_status()
        return r.json()

    def audit(self, limit: int = 50) -> dict[str, Any]:
        """Query the tamper-proof audit trail."""
        r = self._client.get("/audit", params={"limit": limit})
        r.raise_for_status()
        return r.json()

    def close(self) -> None:
        """Close the HTTP client."""
        self._client.close()
