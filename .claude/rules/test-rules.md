---
globs: tests/**/*.py, compliance_modules/**/tests/**/*.py
---

# Test Rules

- Run the full suite before and after any code change.
- Tests derive from KB — if KB changes, update test assertions.
- Use `-k` flag for targeted runs: `TestClassifier`, `TestAssessor`, `TestRoadmap`, `TestExtractor`, `TestAPI`, `TestHRAutopilot`, `TestReports`, `TestIntegrity`.
- Integrity tests (duplicate IDs, broken deps, KB↔roadmap consistency) must always pass.
- No mocking of core compliance logic — test real behavior.
