# Requirements — GTM & ROI Features

## Market Signal Analysis (March 2026)

### Demand Signals (from /last30days research + competitive analysis)
1. **One-command private deployment** — 42K+ exposed OpenClaw gateways, NemoClaw's #1 pitch is "single command install". Users on r/LocalLLaMA and HN consistently ask for easy self-hosted setup.
2. **Compliance evidence export** — Enterprise buyers (healthcare, finance, defense) need exportable audit trails for SOC 2/HIPAA auditors. IronCore Labs drew a hard line on data sovereignty.
3. **App Store distribution** — ClawGuard iOS MVP exists but has no distribution path. Rork Max proved the "describe → App Store" pipeline has demand.
4. **GTM product positioning** — No programmatic way to serve feature matrix, pricing tiers, or competitive differentiation to a landing page or sales deck.

### Competitive Gap
| Capability | Us (VaultClaw) | Rork Max | Cursor | Windsurf |
|------------|---------------|----------|--------|----------|
| Compliance-grade security | Yes | No | No | Partial |
| One-command private deploy | **Missing** | N/A | N/A | On-prem option |
| Exportable audit evidence | **Missing** | No | No | No |
| iOS client | Yes (ClawGuard) | No | No | No |
| GTM API | **Missing** | No | No | No |

## V1 Requirements (Ship This Sprint)

### R1: Quick-Start Installer
- Single `curl | bash` script that sets up OpenAgent locally
- Detects OS, installs dependencies (uv, Docker), configures env
- Generates secure API key, starts LCM server + agent
- Works on macOS, Linux, WSL
- Outputs connection details for ClawGuard iOS app

### R2: Compliance Report Export
- `GET /api/compliance/report` endpoint
- Returns structured JSON with: audit chain summary, sentinel stats, policy compliance scores, findings timeline
- `GET /api/compliance/report?format=summary` for executive summary
- Includes chain integrity verification result
- Filterable by date range and compliance framework

### R3: GTM Product API
- `GET /api/gtm/product` — Feature matrix, pricing tiers, positioning
- `GET /api/gtm/health-score` — System compliance health for status pages
- Fully isolated from compliance engine (per gtm-rules.md)
- Serves data a landing page or sales deck can consume

## V2 (Deferred)
- PDF export for compliance reports
- App Store submission pipeline
- Multi-tenant SaaS deployment
- Stripe billing integration
