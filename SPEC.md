# spit-the-diff — Project Specification

> **Tagline:** Where your diffs drop bars.

`spit-the-diff` is a GitHub Action that analyzes pull request diffs and generates creative summaries such as rap verses, haiku, or playful code roasts using AI models.

The goal is to make pull requests more engaging and easier to skim by turning code changes into short, readable creative summaries.

---

## Goals

### Primary Goals
- Summarize pull requests in an entertaining and readable format.
- Improve developer engagement with PR changes.
- Provide a simple GitHub Action that works with minimal configuration.
- Keep the output short enough to read quickly in PR comments.

### Non-Goals (v1)
- Full AI code review
- Static analysis or security scanning
- Large-scale multi-model orchestration
- Audio/music generation

---

## Core Features (v1)

### 1. Rap Summary
Default mode. Generates a short rap verse summarizing the PR changes.

**Example output:**

> 🎤 Diff Cypher
>
> Serializer twisted, cookies lost the fight,
> Passport guards clashing in the middle of the night.
> Hotfix dropped clean and the sessions run tight,
> Ship the patch forward — auth back in sight.

**Constraints:**
- 6–8 lines
- rhyme encouraged
- humorous but respectful
- mention major code changes

---

### 2. Haiku Summary
Alternative format for minimal poetic summaries.

**Example:**

> 🌸 Diff Haiku
>
> Old serializer
> Cookies crumble into dust
> Auth returns to life

**Constraints:**
- 3 lines
- approximate 5-7-5 structure
- highlight main PR change

---

### 3. Roast Mode (Label Triggered)
When a PR contains the label `roast-me`, the bot switches to playful roast mode.

**Example:**

> 🔥 Code Roast
>
> Nested loops deeper than a dungeon crawl,
> Helper functions hiding state from us all.
> Refactor this beast before deploy day,
> Or production logs gonna make you pay.

**Constraints:**
- roast the **code**, not the developer
- no harassment or slurs
- playful tone only

---

## Supported Formats

| Format | Description |
|--------|-------------|
| `rap`  | default rap summary |
| `haiku` | short poetic summary |
| `roast` | battle-rap style roast triggered via label |

---

## GitHub Action Interface

### Inputs

| Input | Description | Default |
|-------|-------------|---------|
| `format` | Output format (`rap`, `haiku`) | `rap` |
| `model` | AI model to use | `gpt-4o-mini` |
| `max_lines` | Maximum output length | `8` |
| `tone` | Output tone (`friendly`, `playful`) | `friendly` |
| `openai_api_key` | OpenAI API key | required |
| `github_token` | GitHub token for posting comments | `${{ github.token }}` |

**Example usage:**

```yaml
uses: ssfinney/spit-the-diff@v1
with:
  format: rap
  model: gpt-4o-mini
  openai_api_key: ${{ secrets.OPENAI_API_KEY }}
```

---

## GitHub Workflow Example

```yaml
name: spit-the-diff

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  rap-summary:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Generate PR rap
        uses: ssfinney/spit-the-diff@v1
        with:
          format: rap
          model: gpt-4o-mini
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
```

---

## Label Integration

If the PR contains the label `roast-me`, the action switches to roast mode automatically, regardless of the `format` input.

---

## Architecture Overview

```
GitHub PR Event
      │
      ▼
Fetch PR Metadata
(title, description, diff, labels)
      │
      ▼
Diff Summarizer
(reduce token size)
      │
      ▼
Prompt Generator
(format-specific prompt)
      │
      ▼
LLM API Call
(e.g. GPT-4o-mini)
      │
      ▼
GitHub Comment
(post summary to PR)
```

---

## Prompt Strategy

Each format uses a dedicated prompt template located in `prompts/`.

### Rap Prompt
```
Write an 8-line hip-hop verse summarizing this pull request.

Requirements:
- Mention the main code changes
- Use rhyme
- Be humorous but respectful
- Maximum 8 lines
```

### Haiku Prompt
```
Write a haiku summarizing the key change in this pull request.

Format:
- 3 lines
- 5-7-5 syllable structure
- Focus on the main change
```

### Roast Prompt
```
Write a playful battle-rap roast about this code change.

Rules:
- Roast the code quality, not the developer
- Keep it lighthearted
- 4-6 lines
```

---

## Cost Considerations

The action minimizes token usage by:
- sending summarized diffs (not raw diffs)
- limiting response length
- using small efficient models (e.g., `gpt-4o-mini`)

Estimated cost per PR: fractions of a cent.

---

## Safety Guidelines

The system:
- avoids harassment
- avoids profanity by default
- avoids personal attacks

Roasts must target code quality only.

---

## Repository Structure

```
spit-the-diff/
│
├─ action.yml
├─ package.json
├─ tsconfig.json
├─ SPEC.md
├─ src/
│   └─ index.ts
│
├─ dist/
│   └─ index.js        (built output, committed)
│
├─ prompts/
│   ├─ rap.txt
│   ├─ haiku.txt
│   └─ roast.txt
│
├─ examples/
│   └─ workflow.yml
│
├─ README.md
└─ LICENSE
```

---

## Future Features (Post v1)

- AI panel review (multiple model opinions)
- incident postmortem rap summaries
- release notes cypher
- Suno-generated rap songs
- Slack / Discord integrations
- comment-triggered commands (`/rap`, `/haiku`, `/roast`)

---

## Success Criteria

v1 is successful if:
- developers can install the action in <2 minutes
- PR comments generate correctly
- outputs are short, readable, and funny
- cost per PR remains negligible
