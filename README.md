# spit-the-diff 🎤

> Where your diffs drop bars.

A GitHub Action that turns pull request diffs into rap verses, haiku, or code roasts using AI.

---

## Example Output

**Rap mode (default):**

> 🎤 **Rap**
>
> Serializer twisted, cookies lost the fight,
> Passport guards clashing in the middle of the night.
> Hotfix dropped clean and the sessions run tight,
> Ship the patch forward — auth back in sight.

**Haiku mode:**

> 🌸 **Haiku**
>
> Old serializer
> Cookies crumble into dust
> Auth returns to life

**Roast mode** (triggered by the `roast-me` label):

> 🔥 **Code Roast**
>
> Nested loops deeper than a dungeon crawl,
> Helper functions hiding state from us all.
> Refactor this beast before deploy day,
> Or production logs gonna make you pay.

---

## Installation (GitHub Action)

### 1) Add the workflow

Add a workflow file to your repository at `.github/workflows/spit-the-diff.yml`:

```yaml
name: spit-the-diff

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  rap-summary:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write

    steps:
      - uses: actions/checkout@v4

      - name: Generate PR summary
        uses: ssfinney/spit-the-diff@v1
        with:
          format: rap
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
```

### 2) Add your OpenAI API key as a secret

Create an encrypted secret named `OPENAI_API_KEY` in your repository settings:

- **GitHub → Repository → Settings → Secrets and variables → Actions → New repository secret**
- Name: `OPENAI_API_KEY`
- Value: your OpenAI API key

Then reference it exactly like this in the workflow:

```yaml
openai_api_key: ${{ secrets.OPENAI_API_KEY }}
```

### 3) Open a PR

When a pull request is opened or updated, the action maintains one persistent bot comment and edits it in place on subsequent runs.

---

## Safe API Key Integration

Use these practices to keep your key secure:

- **Always use GitHub Secrets** (`secrets.OPENAI_API_KEY`) instead of hardcoding keys.
- **Never commit `.env` files** or keys to source control.
- **Prefer least privilege:** use a dedicated OpenAI key for this action with usage limits/monitoring.
- **Use organization secrets** if multiple repos share this action.
- **Rotate keys immediately** if exposed in logs, commits, or screenshots.

For local testing, export the key in your shell session (not in tracked files):

```bash
export OPENAI_API_KEY="your-key-here"
```

Do not print the key in logs or echo commands in CI.

---

## Inputs

| Input | Description | Default |
|-------|-------------|---------|
| `format` | Output format: `rap` or `haiku` | `rap` |
| `model` | OpenAI model to use | `gpt-4o-mini` |
| `roast_label` | PR label that enables roast mode | `roast-me` |
| `openai_api_key` | Your OpenAI API key (**required**) | — |
| `github_token` | GitHub token for posting comments | `${{ github.token }}` |
| `profanity_filter` | `off` or `on` (uses PurgoMalum API) | `on` |
| `profanity_api_base_url` | Base URL for PurgoMalum-compatible service | `https://www.purgomalum.com` |

---

## Roast Mode

Add the label **`roast-me`** to any PR and the action will automatically switch to roast mode, regardless of the `format` input.

> Note: if your workflow only listens to `opened`, `synchronize`, and `reopened`, roast mode takes effect on the next run (for example after the next push to the PR branch).

Roasts target code quality and patterns — never the developer.

---

## Formats

| Format | Trigger | Description |
|--------|---------|-------------|
| `rap` | `format: rap` | 6–8 line hip-hop verse |
| `haiku` | `format: haiku` | 3-line 5-7-5 poetic summary |
| `roast` | `roast-me` label | Playful battle-rap code roast |

---

## Diff Compression + Guardrails

The action builds prompts in a deterministic order to reduce token usage:

1. PR title + description
2. Structured file list (`filename | status | +additions/-deletions`)
3. Compressed diff payload:
   - `Change Summary` for top churn files
   - `Selected Diff Hunks (truncated)` for top files, capped per file
   - For very large PRs, only `Change Summary` is sent

Output cleanup guardrails are applied before commenting:

- Removes prefacing lines (e.g. “Here’s your …”)
- Strips accidental headers/titles and bullet prefixes
- Enforces line limits (`rap <= 8`, `roast <= 6`)
- Enforces `haiku` as exactly 3 lines (one retry, then padded if needed)
- External profanity filtering via PurgoMalum API is enabled by default (`profanity_filter: on`) and can be disabled with `profanity_filter: off`

---


## Event + Cost Guardrails

The action includes built-in protections to reduce noisy runs and comment spam:

- **Single comment strategy:** it writes a stable marker (`<!-- spit-the-diff:hash=... -->`) and updates that same comment on later runs.
- **Hash skip on synchronize:** for `synchronize` events, if the input hash (title/body + file summary + compressed diff + mode) is unchanged, it skips the LLM call and comment update.

## Cost

Uses `gpt-4o-mini` by default. Estimated cost: **fractions of a cent per PR**.

---

## Contributing

See [SPEC.md](./SPEC.md) for the full project specification and architecture overview.

Install dependencies and build locally:

```
npm install
npm run build
```

---

## License

MIT
