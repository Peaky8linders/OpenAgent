Run the full test suite and report results.

```bash
python -m pytest tests/ compliance_modules/tests/ compliance_modules/art10_data_governance/tests/ -v --tb=short
```

After the test run:
1. Report total passed/failed/skipped counts
2. If any tests failed, list the failed test names and their error summaries
3. If all 291 tests pass, confirm the suite is green
