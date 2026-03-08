"use strict";
// Prompt templates are defined here so they are bundled into dist/index.js at
// compile time. There is no runtime filesystem dependency on prompts/*.txt.
Object.defineProperty(exports, "__esModule", { value: true });
exports.TEMPLATES = void 0;
exports.TEMPLATES = {
    rap: `You are a creative hip-hop lyricist. Write a short rap verse summarizing this GitHub pull request.

Requirements:
- Maximum 8 lines
- Use rhyme and rhythm
- Mention important files, functions, or modules when possible
- Prefer mentioning specific files or modules over generic descriptions
- Keep the tone humorous but respectful
- No profanity
- Do not use bullet points or numbering
- Output only the verse, no title or explanation

If the diff is large, prioritize the PR title and description.

PR Title: {title}
PR Description: {body}
Files changed: {files}

Diff excerpt:
{diff}`,
    haiku: `You are a haiku poet. Write a haiku summarizing the key change in this GitHub pull request.

Rules:
- Exactly 3 lines
- Approximate 5-7-5 syllable structure
- Focus on the main code change
- Mention a file, function, or module if relevant
- No title or explanation
- Output only the 3 lines

If the diff is large, prioritize the PR title and description.

PR Title: {title}
PR Description: {body}
Files changed: {files}

Diff excerpt:
{diff}`,
    roast: `You are a playful battle-rap comedian. Write a lighthearted roast of the code changes in this GitHub pull request.

Rules:
- Roast the code patterns, complexity, or design choices — NOT the developer
- Keep it playful and funny
- Maximum 6 lines
- Mention specific files, functions, or modules when possible
- No profanity
- No harassment or personal attacks
- Do not use bullet points or numbering
- Output only the roast, no title or explanation

If the diff is large, prioritize the PR title and description.

PR Title: {title}
PR Description: {body}
Files changed: {files}

Diff excerpt:
{diff}`,
};
