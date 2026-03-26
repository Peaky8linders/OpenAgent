# Roadmap — GTM & ROI Features

## Phase 1: Quick-Start Installer (Wave 1 — independent)
**ROI**: Removes #1 adoption friction. Every NemoClaw/OpenClaw user who can't figure out setup is a lost user.
- `scripts/quickstart.sh` — detect OS, install deps, configure, launch
- Generates NVIDIA_API_KEY placeholder, creates config, starts services
- Prints ClawGuard connection instructions

## Phase 2: Compliance Report Export (Wave 1 — independent, parallel with Phase 1)
**ROI**: Enterprise sales enabler. SOC 2 auditors need evidence they can download.
- New endpoints in `openharness-swift/app/main.py`
- `GET /api/compliance/report` — full audit + sentinel + chain verification
- `GET /api/compliance/report?format=summary` — exec summary
- Pydantic response models per api-rules.md

## Phase 3: GTM Product API (Wave 2 — depends on Phase 2 health-score)
**ROI**: Enables landing page, status page, sales materials from live data.
- `openharness-swift/app/gtm/` — isolated module per gtm-rules.md
- `GET /api/gtm/product` — feature matrix + pricing tiers
- `GET /api/gtm/health-score` — live compliance health

## Execution Plan
- Phases 1 and 2 run in parallel (Wave 1) — no dependencies
- Phase 3 runs after Phase 2 (Wave 2) — references health-score pattern
- Each phase gets atomic git commit
- Tests run after all phases before PR
