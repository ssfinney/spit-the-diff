# Code Coverage Audit — 2026-03-08

## Scope
- Pulled baseline attempt: `git pull origin main` (failed because this local checkout has no `origin` remote configured).
- Test + coverage command: `npm test -- --coverage`.

## Coverage snapshot

| File | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| `src/index.ts` | 80.39% | 60.86% | 70.00% | 82.00% |
| `src/lib.ts` | 100.00% | 100.00% | 100.00% | 100.00% |
| `src/prompts.ts` | 100.00% | 100.00% | 100.00% | 100.00% |
| **Total** | **87.80%** | **74.28%** | **86.95%** | **88.88%** |

## What was added

Added a new `src/index.test.ts` suite to cover high-value workflow behavior in the action entrypoint:
- Required input validation path for missing `openai_api_key`.
- Label-gated early return for non-matching `labeled` events.
- Synchronize fast-path that skips LLM calls when input hash is unchanged.
- Moderation fallback path when two moderation attempts are flagged.

## Remaining high-value gaps in `src/index.ts`

The biggest remaining uncovered areas are mostly alternate control-flow branches:
- Missing GitHub token path. (`src/index.ts`, github token guard)
- Non-PR event path (`pull_request` missing). (`src/index.ts`, PR event guard)
- Roast-label auto-switch informational branch. (`src/index.ts`, roast mode log)
- Moderation branch where second attempt passes and replaces `finalText` with retry text. (`src/index.ts`, retry success branch)
- Error catch path when LLM returns empty content or API call throws. (`src/index.ts`, `run().catch(...)`)
- Existing comment update path vs create path. (`src/index.ts`, `upsertComment` update branch)

## Recommended next tests (if we continue)
1. Add a test for missing `github_token` / `GITHUB_TOKEN`.
2. Add a test for non-PR event (`ctx.payload.pull_request = undefined`).
3. Add a test with roast label present on PR labels to assert roast mode is selected.
4. Add a moderation case where first attempt is flagged and second attempt is clean.
5. Add a test where `findExistingBotComment` returns a prior comment and verify `updateComment` is called.
6. Add a failure-path test where `callLLM` gets empty content and `core.setFailed` is called via the top-level catch.
