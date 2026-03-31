# Deep Code Review: OpenHarness v0.4.0

**Date:** 2026-03-26
**Files reviewed:** 22 source files, 8 test files
**Lines:** 7,065 source + 2,017 test
**Diff size:** Large

## Executive Summary

Four layers (LCM, Secure, Evals, Launch) with 135 passing tests. Found 2 Critical, 3 Important, and 2 Suggestion-level issues. The most severe is a Swift code injection vulnerability in the codegen module where unsanitized user-provided property names and default values are interpolated directly into generated Swift source code.

## Critical Issues

### [C1] Swift code injection via unsanitized property names in codegen
- **File:** `src/launch/codegen.ts:95,102-103,217-218`
- **Bug:** Entity property names (`prop.name`), entity names (`entity.name`), and default values (`prop.defaultValue`) from the LLM-generated AppSpec are interpolated directly into Swift source code with zero sanitization. A malicious or hallucinated LLM response could inject: `name: "title; import Foundation; system(\"rm -rf /\")//"` which becomes valid Swift that executes arbitrary code when compiled.
- **Impact:** Arbitrary code execution via generated Swift. The sentinel inspects the *output* code but only checks for known patterns (eval, credentials). A novel injection in a property name wouldn't trigger any sentinel rule.
- **Suggested fix:** Add a `sanitizeSwiftIdentifier()` function that strips non-alphanumeric characters and validates against Swift reserved words. Apply to all entity names, property names, and screen names before interpolation. Validate `defaultValue` only allows literal values (strings, numbers, booleans).
- **Confidence:** High
- **Found by:** Security

### [C2] LaunchPipeline sentinel stage mislabeled as 'build'
- **File:** `src/launch/pipeline.ts:89`
- **Bug:** The sentinel inspection stage is labeled `'build'` in the `runStage()` call, but it's actually the sentinel check. This means the `StageResult` array shows the sentinel step as "build", and if a real build stage were added later, there would be a collision. More critically, if consumers filter stages by name to find build failures, they'll get sentinel blocks instead.
- **Impact:** Misleading audit trail and stage reporting. Compliance teams reviewing pipeline logs would see "build failed" when sentinel actually blocked the code.
- **Suggested fix:** Rename to a new pipeline stage value or use an existing sentinel-related stage name. Add a `'sentinel_check'` value to the `PipelineStage` union type.
- **Confidence:** High
- **Found by:** Logic & Correctness

## Important Issues

### [I1] L1 `latencyGate` assertion measures its own overhead, not the target
- **File:** `src/evals/l1-assertions.ts:131-140`
- **Bug:** `latencyGate()` measures `performance.now()` around an empty function body. It's supposed to gate on the latency of the operation being tested, but it receives no timing information from the caller. The elapsed time will always be ~0ms, so the gate always passes.
- **Impact:** Latency gate is a no-op. Code that takes 10 seconds will still pass a 50ms latency gate.
- **Suggested fix:** Accept an `actualLatencyMs` field in `L1Context` or have the harness pass timing data from the experiment run. The assertion should check `ctx.latencyMs <= maxMs`, not measure its own overhead.
- **Confidence:** High
- **Found by:** Logic & Correctness

### [I2] `generateSpec` doesn't validate property types against the allowed enum
- **File:** `src/launch/spec-generator.ts:91-100`
- **Bug:** The `features`, `screens`, and `dataModel` fields from the LLM JSON response are cast directly to typed interfaces without validating that individual field values match the expected enums. An LLM could return `type: "dropdown"` for a property (not in the `PropertySpec.type` union), or `priority: "critical"` for a feature (not in the `FeatureSpec.priority` union). The TypeScript types provide compile-time safety but zero runtime validation.
- **Impact:** Invalid AppSpec propagates to codegen, which may produce incorrect Swift code (e.g., `mapType()` falls through to `'String'` for unknown types, silently hiding the error).
- **Suggested fix:** Add runtime validation for all enum-like fields against allowed value sets. Reject or coerce invalid values with a warning.
- **Confidence:** High
- **Found by:** Error Handling & Edge Cases

### [I3] `buildResult` in LaunchPipeline returns an empty dummy project on failure
- **File:** `src/launch/pipeline.ts:156-170`
- **Bug:** When the pipeline fails, `buildResult()` returns a `GeneratedProject` with all empty strings and empty arrays. This is technically correct (the pipeline failed, so there's no project), but consumers checking `result.project.spec.name` will get `''` with no indication that the project is invalid. A `null` return or an explicit `failed: true` flag would be safer.
- **Impact:** Consumers of the pipeline API may accidentally use the empty project object without checking `pipeline.success` first.
- **Suggested fix:** Return `project: null` when the pipeline fails, and change the return type to `{ project: GeneratedProject | null; pipeline: PipelineResult }`.
- **Confidence:** Medium
- **Found by:** Contract & Integration

## Suggestions

- **S1:** `src/launch/codegen.ts` `generateListView` accesses `spec.dataModel.entities[0]` without checking the array is non-empty first. If the spec has no entities, the `!` assertion on the result of `find()` could produce undefined behavior. Already partially handled by the fallback to `generateGenericView`, but the early `entity` access should use optional chaining.
- **S2:** `src/evals/l2-judges.ts` judge prompts contain `{{input}}`, `{{output}}`, `{{context}}` placeholders that are replaced with `.replace()`. If the actual content contains the literal string `{{input}}`, it will be double-replaced. Use a unique delimiter or single-pass replacement.

## Review Metadata
- **Agents dispatched:** Logic & Correctness, Error Handling & Edge Cases, Contract & Integration, Security, Concurrency & State
- **Scope:** 22 source files + 8 test files (focus on src/launch/, src/evals/, src/secure/)
- **Raw findings:** 9
- **Verified findings:** 7
- **Filtered out:** 2 (low confidence)
- **Steering files consulted:** CLAUDE.md
