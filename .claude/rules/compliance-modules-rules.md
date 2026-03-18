---
globs: compliance_modules/**/*.py
---

# Compliance Module Rules

- Each article module (art09–art15) must be independently importable. No cross-module imports.
- Shared utilities go in `compliance_modules/shared/` only.
- Module `__init__.py` must export all public functions/classes.
- Follow the existing pattern: each module maps to a specific EU AI Act article.
- Tests for each module live in the module's own `tests/` directory.
