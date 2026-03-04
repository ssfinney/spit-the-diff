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

## Quick Start

Add a workflow file to your repository at `.github/workflows/spit-the-diff.yml`:

```yaml
name: spit-the-diff

on:
  pull_request:
    types: [opened, synchronize, labeled]

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

Then add your `OPENAI_API_KEY` as a [repository secret](https://docs.github.com/en/actions/security-guides/encrypted-secrets). That's it.

---

## Inputs

| Input | Description | Default |
|-------|-------------|---------|
| `format` | Output format: `rap` or `haiku` | `rap` |
| `model` | OpenAI model to use | `gpt-4o-mini` |
| `max_lines` | Maximum lines in the output | `8` |
| `tone` | Output tone: `friendly` or `playful` | `friendly` |
| `openai_api_key` | Your OpenAI API key (**required**) | — |
| `github_token` | GitHub token for posting comments | `${{ github.token }}` |

---

## Roast Mode

Add the label **`roast-me`** to any PR and the action will automatically switch to roast mode, regardless of the `format` input.

Roasts target code quality and patterns — never the developer.

---

## Formats

| Format | Trigger | Description |
|--------|---------|-------------|
| `rap` | `format: rap` | 6–8 line hip-hop verse |
| `haiku` | `format: haiku` | 3-line 5-7-5 poetic summary |
| `roast` | `roast-me` label | Playful battle-rap code roast |

---

## Cost

Uses `gpt-4o-mini` by default. Estimated cost: **fractions of a cent per PR**.

---

## Contributing

See [SPEC.md](./SPEC.md) for the full project specification and architecture overview.

```
npm install
npm run build
```

---

## License

MIT
