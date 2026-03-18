---
globs: app/engines/**/*.py
---

# Engine Rules

- KB (`app/data/kb.py`) is the single source of truth. Never hardcode dimensions, questions, or risk levels in engines.
- All engines are stateless — no module-level mutable state except singleton services (metrics, logging, drift).
- Use Pydantic v2 patterns: `model_validator`, `field_validator`, `model_dump()`. Never use deprecated v1 APIs.
- Unanswered questions count as gaps in scoring. Do not change this behavior.
- Every new engine function must have corresponding test coverage in `tests/test_all.py`.
