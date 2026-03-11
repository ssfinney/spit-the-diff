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
    types: [opened, synchronize, reopened, labeled]

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
          # or use any other supported provider, e.g.:
          # anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          # groq_api_key: ${{ secrets.GROQ_API_KEY }}
```

### 2) Add your API key as a secret

The action supports **8 AI providers**. Pick one and add its API key as a repository secret:

- **GitHub → Repository → Settings → Secrets and variables → Actions → New repository secret**

Then supply the matching input in your workflow. Use **exactly one** — the action errors if none or multiple are provided.

| Provider | Input | Secret name (example) |
|----------|-------|----------------------|
| **OpenAI** (default) | `openai_api_key` | `OPENAI_API_KEY` |
| Anthropic (Claude) | `anthropic_api_key` | `ANTHROPIC_API_KEY` |
| Google (Gemini) | `google_api_key` | `GOOGLE_API_KEY` |
| OpenRouter | `openrouter_api_key` | `OPENROUTER_API_KEY` |
| HuggingFace | `huggingface_api_key` | `HUGGINGFACE_API_KEY` |
| Groq | `groq_api_key` | `GROQ_API_KEY` |
| Mistral | `mistral_api_key` | `MISTRAL_API_KEY` |
| Together AI | `together_api_key` | `TOGETHER_API_KEY` |

Example using Anthropic:

```yaml
      - name: Generate PR summary
        uses: ssfinney/spit-the-diff@v1
        with:
          format: rap
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          model: claude-haiku-4-5-20251001
```

### 3) Open a PR

When a pull request is opened or updated, the action maintains one persistent bot comment and edits it in place on subsequent runs.

> **Fork PRs:** GitHub does not make repository secrets available to workflows triggered by `pull_request` events from forks. If you want the action to run on fork PRs, use `pull_request_target` instead — but read [GitHub's security guidance](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#pull_request_target) carefully before doing so, as it runs in the context of the base branch with access to secrets.

---

## Safe API Key Integration

Use these practices to keep your key secure:

- **Always use GitHub Secrets** (e.g. `secrets.OPENAI_API_KEY`) instead of hardcoding keys.
- **Never commit `.env` files** or keys to source control.
- **Prefer least privilege:** use a dedicated key for this action with usage limits/monitoring.
- **Use organization secrets** if multiple repos share this action.
- **Rotate keys immediately** if exposed in logs, commits, or screenshots.

For local testing, export the key in your shell session (not in tracked files):

```bash
export OPENAI_API_KEY="your-key-here"
```

Do not print the key in logs or echo commands in CI.

---

## Inputs

### Provider API keys

Supply **exactly one** of the following:

| Input | Provider | Default model |
|-------|----------|---------------|
| `openai_api_key` | OpenAI | `gpt-4.1-mini` |
| `anthropic_api_key` | Anthropic (Claude) | `claude-haiku-4-5-20251001` |
| `google_api_key` | Google (Gemini) | `gemini-2.0-flash` |
| `openrouter_api_key` | OpenRouter | `openai/gpt-4.1-mini` |
| `huggingface_api_key` | HuggingFace | `Qwen/Qwen2.5-Coder-32B-Instruct` |
| `groq_api_key` | Groq | `llama-3.3-70b-versatile` |
| `mistral_api_key` | Mistral | `mistral-small-latest` |
| `together_api_key` | Together AI | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |

### Other inputs

| Input | Description | Default |
|-------|-------------|---------|
| `format` | Output format: `rap`, `haiku`, or `roast` | `rap` |
| `model` | Model to use for generation. Overrides the provider default. Must be a valid model ID for your chosen provider. | *(provider default)* |
| `max_files` | Max changed files included in the diff payload | `6` |
| `roast_label` | PR label that enables roast mode | `roast-me` |
| `enable_moderation` | Run OpenAI moderation on output before posting. Only applies when using the `openai` provider; silently skipped for all others. | `false` |
| `skip_drafts` | Skip draft PRs entirely | `true` |
| `min_diff_lines` | Skip if non-noise diff lines are below this threshold (`0` disables) | `0` |
| `mic_drop_threshold` | Use a 2-line mic-drop output below this diff-line threshold (`0` disables) | `0` |
| `max_patch_lines` | Max lines per file patch included in the diff payload | `60` |
| `max_prompt_chars` | Max diff payload characters before falling back to summary-only mode | `30000` |
| `github_token` | GitHub token for posting comments | `${{ github.token }}` |

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
- Enforces `haiku` as exactly 3 lines (one retry if output is short)
- Runs OpenAI moderation on output when `enable_moderation: true` and the `openai` provider is in use; retries once on a flag, then uses a safe fallback message

---


## Event + Cost Guardrails

The action includes built-in protections to reduce noisy runs and comment spam:

- **Single comment strategy:** it writes a stable marker (`<!-- spit-the-diff:hash=... -->`) and updates that same comment on later runs.
- **Hash skip on synchronize:** for `synchronize` events, if the input hash (title/body + file summary + compressed diff + mode) is unchanged, it skips the LLM call and comment update.

## Cost

Cost depends on your chosen provider and model. The OpenAI default (`gpt-4.1-mini`) typically costs **fractions of a cent per PR** given the small prompt sizes.

Several providers offer free tiers or lower per-token rates than OpenAI — for example:

- **Groq** (`llama-3.3-70b-versatile`) — fast inference, generous free tier
- **Google** (`gemini-2.0-flash`) — competitive rates, free tier available
- **HuggingFace** (`Qwen/Qwen2.5-Coder-32B-Instruct`) — free serverless inference for many models
- **OpenRouter** — aggregates many models; pay-per-token across providers
- **Together AI** — competitive open-model pricing

For any provider, prompt sizes here are small (typically under 2 000 tokens), so even paid tiers cost less than a cent per run. See your provider's pricing page for exact rates.

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
