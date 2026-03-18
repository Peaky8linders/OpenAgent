---
globs: app/main.py
---

# API Route Rules

- All state passed in request/response bodies. No server-side session state.
- Every endpoint must use Pydantic models for request validation and response serialization.
- Error responses must not leak internal details (stack traces, file paths, config values).
- New endpoints must have corresponding test cases in `TestAPI` class.
