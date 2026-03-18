---
name: kb-update
description: Safely add or modify knowledge base dimensions/questions with cascading updates to roadmap and tests
user_invocable: true
---

# Knowledge Base Update

Safely update the knowledge base with proper cascading to all dependent files.

## Arguments
- `$ARGUMENTS` — description of what to add/change (e.g., "add Art. 16 post-market monitoring dimension")

## Cascade Protocol

When modifying `app/data/kb.py`, you MUST also update these files:

### 1. Knowledge Base (`app/data/kb.py`)
- Add/modify dimension, questions, or risk level mappings
- Ensure no duplicate IDs across all dimensions
- Follow existing naming conventions (snake_case IDs, human-readable labels)

### 2. Roadmap Engine (`app/engines/roadmap.py`)
- Add corresponding compliance tasks for new dimensions
- Tasks must include `ClaudeCodeTask` with prompts and acceptance criteria
- Follow the existing phased task structure (Phase 1: Assess, Phase 2: Implement, Phase 3: Verify)

### 3. Test Suite (`tests/test_all.py`)
- Add assertions in `TestIntegrity` for new dimension coverage
- Add specific test cases in the appropriate test class
- Verify the expected test count is updated in CLAUDE.md if it changes

### 4. Verification
```bash
python -m pytest tests/test_all.py -k "TestIntegrity" -v
python -m pytest tests/ compliance_modules/tests/ compliance_modules/art10_data_governance/tests/ -v
```

## Rules
- NEVER modify KB without updating roadmap and tests
- NEVER change the scoring behavior (unanswered = gap)
- Maintain backward compatibility with existing API responses
