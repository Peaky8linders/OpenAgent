Pre-deployment readiness checklist.

Run these checks in order and report pass/fail for each:

1. **Tests pass**: `python -m pytest tests/ compliance_modules/tests/ compliance_modules/art10_data_governance/tests/ -v --tb=short`
2. **No uncommitted changes**: `git status` shows clean working tree (or only expected changes)
3. **Python syntax valid**: `python -m py_compile app/main.py`
4. **Dependencies frozen**: `requirements.txt` exists and is not empty
5. **Docker builds**: `docker compose build` succeeds (skip if Docker not available)
6. **No secrets in code**: Check for hardcoded API keys, passwords, or tokens in tracked files

Report the overall deployment readiness: READY / NOT READY with reasons.
