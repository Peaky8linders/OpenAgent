# LCM v2 + VaultClaw Integration Plan

## Goal
Make LCM v2 the encrypted, compliance-ready memory and context engine for VaultClaw.
LCM handles memory storage, topic segmentation, PII detection, summarization DAG, and search.
VaultClaw provides the encryption envelope, RBAC, audit chain, and sentinel inspection around it.

## Phase 1: Encrypted Store Adapter
- [x] Create `SecureStore` wrapper that adds encryption + RBAC + audit + sentinel to any LcmStore
- [x] Bridge LCM's audit_log to VaultClaw's tamper-proof hash-chained audit ledger
- [x] Intercept all write operations through sentinel pipeline (block injection before persistence)
- [x] RBAC enforcement on every store method
- [x] Tests: roundtrip, sentinel blocking, RBAC denial, audit chain

## Phase 2: Sentinel-Protected Ingestion
- [x] Create `SecureIngestionPipeline` that wraps LCM pipeline with sentinel pre-check
- [x] Block prompt injection and data exfiltration before content reaches the store
- [x] Dual PII detection: LCM's regex detector + VaultClaw's PHI detector
- [x] Tests: injection blocked, PHI detected, clean content passes

## Phase 3: Compliance Features
- [ ] GDPR right-to-erasure pipeline
- [ ] Cryptographic deletion
- [ ] HIPAA-format audit export

## Phase 4: Local Embedding Bridge
- [ ] Ollama embedding integration via VaultClaw's LocalLLMBridge
- [ ] Token budget enforcement
