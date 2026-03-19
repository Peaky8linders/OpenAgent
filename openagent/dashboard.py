"""Compliance dashboard API — REST endpoints for monitoring and audit export.

Provides real-time visibility into:
- Compliance scoring history
- Policy enforcement status
- Audit trail export (JSONL, CEF formats)
- Agent health and memory status

Runs as a lightweight HTTP server alongside the agent.
"""

from __future__ import annotations

import json
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from openagent.compliance import (
    ComplianceScore,
    get_policy,
)

# ─── In-memory scoring history ────────────────────────────────

_scoring_history: list[dict[str, Any]] = []
_max_history = 1000


def record_score(score: ComplianceScore, context: str = "") -> None:
    """Record a compliance score to the dashboard history."""
    entry = {
        "timestamp": datetime.now().isoformat(),
        "framework": score.framework.value,
        "action": score.action,
        "score": score.score,
        "blocked": score.blocked,
        "findings": score.findings,
        "context": context,
    }
    _scoring_history.append(entry)
    if len(_scoring_history) > _max_history:
        _scoring_history.pop(0)


def get_scoring_history(
    limit: int = 50,
    framework: str | None = None,
    blocked_only: bool = False,
) -> list[dict[str, Any]]:
    """Get compliance scoring history with optional filters."""
    results = _scoring_history
    if framework:
        results = [s for s in results if s["framework"] == framework]
    if blocked_only:
        results = [s for s in results if s["blocked"]]
    return results[-limit:]


def get_compliance_summary() -> dict[str, Any]:
    """Get aggregate compliance metrics."""
    if not _scoring_history:
        return {
            "total_actions": 0,
            "avg_score": 0.0,
            "blocked_count": 0,
            "blocked_rate": 0.0,
            "by_framework": {},
        }

    total = len(_scoring_history)
    blocked = sum(1 for s in _scoring_history if s["blocked"])
    avg = sum(s["score"] for s in _scoring_history) / total

    by_framework: dict[str, dict[str, Any]] = {}
    for s in _scoring_history:
        fw = s["framework"]
        if fw not in by_framework:
            by_framework[fw] = {"count": 0, "blocked": 0, "total_score": 0.0}
        by_framework[fw]["count"] += 1
        by_framework[fw]["total_score"] += s["score"]
        if s["blocked"]:
            by_framework[fw]["blocked"] += 1

    for _fw, data in by_framework.items():
        data["avg_score"] = round(data["total_score"] / data["count"], 3)
        del data["total_score"]

    return {
        "total_actions": total,
        "avg_score": round(avg, 3),
        "blocked_count": blocked,
        "blocked_rate": round(blocked / total, 3) if total else 0.0,
        "by_framework": by_framework,
    }


def export_audit_jsonl(entries: list[dict[str, Any]]) -> str:
    """Export audit entries as JSONL (one JSON object per line)."""
    return "\n".join(json.dumps(e) for e in entries)


def export_audit_cef(entries: list[dict[str, Any]]) -> str:
    """Export audit entries in CEF (Common Event Format) for SIEM integration."""
    lines = []
    for e in entries:
        severity = 10 if e.get("blocked") else 5 if e.get("score", 1.0) < 0.5 else 1
        cef = (
            f"CEF:0|VaultClaw|OpenAgent|1.0|{e.get('action', 'unknown')}|"
            f"Compliance Score|{severity}|"
            f"score={e.get('score', 0)} "
            f"framework={e.get('framework', 'none')} "
            f"blocked={e.get('blocked', False)} "
            f"ts={e.get('timestamp', '')}"
        )
        lines.append(cef)
    return "\n".join(lines)


# ─── Dashboard HTTP Handler ───────────────────────────────────


class DashboardHandler(BaseHTTPRequestHandler):
    """HTTP request handler for compliance dashboard."""

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path == "/dashboard/health":
            self._json(200, {"status": "ok", "timestamp": datetime.now().isoformat()})

        elif path == "/dashboard/summary":
            self._json(200, get_compliance_summary())

        elif path == "/dashboard/history":
            limit = int(params.get("limit", ["50"])[0])
            framework = params.get("framework", [None])[0]
            blocked = params.get("blocked", ["false"])[0] == "true"
            history = get_scoring_history(limit, framework, blocked)
            self._json(200, {"entries": history, "count": len(history)})

        elif path == "/dashboard/export/jsonl":
            limit = int(params.get("limit", ["100"])[0])
            data = export_audit_jsonl(get_scoring_history(limit))
            self._text(200, data, "application/x-ndjson")

        elif path == "/dashboard/export/cef":
            limit = int(params.get("limit", ["100"])[0])
            data = export_audit_cef(get_scoring_history(limit))
            self._text(200, data, "text/plain")

        elif path == "/dashboard/policy":
            fw = params.get("framework", ["none"])[0]
            try:
                policy = get_policy(fw)
                self._json(200, policy.model_dump())
            except ValueError as e:
                self._json(400, {"error": str(e)})

        else:
            self._json(404, {"error": "Not found", "path": path})

    def _json(self, status: int, data: Any) -> None:
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _text(self, status: int, data: str, content_type: str) -> None:
        body = data.encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        pass  # Suppress default logging


def start_dashboard(port: int = 3200) -> HTTPServer:
    """Start the compliance dashboard HTTP server.

    Returns the server instance (call serve_forever() or use in a thread).
    """
    server = HTTPServer(("127.0.0.1", port), DashboardHandler)
    return server
