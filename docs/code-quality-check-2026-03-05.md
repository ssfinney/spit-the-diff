# Code Quality Check (2026-03-05)

## Scope
- TypeScript lint/check run for this repository.
- Best-practice review for GitHub Actions and TypeScript setup.

## Commands run
1. `npm run lint`
   - **Result:** failed (`missing script: lint`).
   - **Reason:** No `lint` script exists in `package.json` and ESLint is not installed. Adding linting requires installing ESLint from scratch, not adding a config file to an existing setup.

2. `npx tsc --noEmit`
   - **Result:** passed.
   - **Observation:** TypeScript compiles cleanly under strict mode.

3. `actionlint -version`
   - **Result:** failed (`command not found`).

4. `npx --yes actionlint`
   - **Result:** failed (`could not determine executable to run`).

## Findings

### TypeScript / linting
- ESLint is not installed and there is no `lint` script in `package.json`. Adding linting is a net-new addition requiring `eslint`, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, an `eslint.config.mjs`, and a `lint` script entry.
- The TypeScript compiler check (`tsc --noEmit`) passes, indicating no immediate type errors.

### GitHub Actions best-practice review
Based on static review of `examples/workflow.yml` and `action.yml`:

- ✅ Workflow explicitly sets job permissions to least privilege (`contents: read`, `pull-requests: write`).
- ⚠️ Example workflow pins actions by mutable tags rather than full commit SHAs: `actions/checkout@v4` and `ssfinney/spit-the-diff@v1` (the latter is the more sensitive case as it executes the action's business logic).
  - Best practice for supply-chain hardening is to pin both to immutable SHAs.
- ⚠️ Example workflow has no `concurrency` group to prevent duplicated comments when multiple PR events fire quickly.
  - Typical pattern: `concurrency: { group: spit-the-diff-${{ github.event.pull_request.number }}, cancel-in-progress: true }`.
- ⚠️ The action requires an OpenAI API key input and posts PR comments. For users, guidance should clearly call out fork/secret behavior and expected permissions.

## GitHub issue triage recommendations

Unable to query live GitHub Issues API from this environment due outbound proxy restrictions (`curl` to external hosts receives HTTP 403 at CONNECT). Because of that, no open issue can be confirmed as closable from here.

### Suggested new issues to create
1. **Add ESLint with TypeScript support**
   - Install `eslint`, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`.
   - Add `eslint.config.mjs` and a `lint` script to `package.json`.
   - Note: ESLint is not currently installed at all — this is a new addition, not a config fix.

2. **Harden example workflow by pinning actions to SHAs**
   - Replace `actions/checkout@v4` and `ssfinney/spit-the-diff@v1` in `examples/workflow.yml` with immutable SHA references.

3. **Add concurrency control to example workflow**
   - Prevent duplicate/competing comments on rapid PR updates.

4. **Document security/permissions behavior for forks and secrets**
   - Expand README with expected token/secret availability and safe event choices.
