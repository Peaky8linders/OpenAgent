---
globs: app/gtm/**/*.py
---

# GTM Module Rules

- GTM is fully isolated from compliance. NEVER import from `app/engines/`, `app/data/kb.py`, or `compliance_modules/`.
- GTM can import from `app/models.py` for shared Pydantic types only.
- GTM workflows are a parallel concern — they sell/market the compliance product but don't implement compliance logic.
