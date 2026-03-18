Perform a compliance-aware code review of the current changes.

Steps:
1. Run `git diff` to see all uncommitted changes
2. Check each changed file against these project rules:
   - **KB consistency**: If `kb.py` was changed, verify `roadmap.py` tasks and `test_all.py` assertions were updated
   - **Pydantic v2 patterns**: Models use `model_validator`, `field_validator`, not deprecated v1 patterns
   - **Stateless API**: No hidden state — all data flows through request/response bodies
   - **GTM isolation**: `app/gtm/` imports nothing from `app/engines/` or `compliance_modules/`
   - **No dead imports**: All imports are used
   - **Type safety**: Proper use of Pydantic models, no raw dicts where models exist
3. Report findings grouped by severity: Critical / Warning / Info
