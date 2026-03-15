import * as core from '@actions/core';
import { createHash } from 'crypto';
import { TEMPLATES } from './prompts';

export type Format = 'rap' | 'haiku' | 'roast';

export type Provider = 'openai' | 'anthropic' | 'google' | 'openrouter' | 'huggingface' | 'groq' | 'mistral' | 'together';

export interface ProviderConfig {
  baseURL?: string;
  defaultModel: string;
}

export const PROVIDER_CONFIGS: Record<Provider, ProviderConfig> = {
  openai:      { defaultModel: 'gpt-4.1-mini' },
  anthropic:   { baseURL: 'https://api.anthropic.com/v1',                              defaultModel: 'claude-haiku-4-5-20251001' },
  google:      { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',   defaultModel: 'gemini-2.0-flash' },
  openrouter:  { baseURL: 'https://openrouter.ai/api/v1',                              defaultModel: 'openai/gpt-4.1-mini' },
  huggingface: { baseURL: 'https://api-inference.huggingface.co/v1',                   defaultModel: 'Qwen/Qwen2.5-Coder-32B-Instruct' },
  groq:        { baseURL: 'https://api.groq.com/openai/v1',                            defaultModel: 'llama-3.3-70b-versatile' },
  mistral:     { baseURL: 'https://api.mistral.ai/v1',                                 defaultModel: 'mistral-small-latest' },
  together:    { baseURL: 'https://api.together.xyz/v1',                               defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
};

export interface PRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface PRSummary {
  title: string;
  body: string;
  files: PRFile[];
  filesText: string;
  diffPayload: string;
}

export interface ExistingBotComment {
  id: number;
  hash?: string;
}

export const MAX_PROMPT_DIFF_CHARS = 30000;
export const HAIKU_METER = [5, 7, 5] as const;

/** How many syllables a human speaks when reading a file extension aloud. */
export const EXTENSION_SYLLABLES: Record<string, number> = {
  ts: 2, js: 2, rs: 2, cs: 2, rb: 2, md: 2, py: 1, go: 1,
  tsx: 3, jsx: 3, css: 3, yml: 3, sql: 3,
  yaml: 2, json: 2, html: 2, toml: 2, lock: 1, txt: 1,
};

export const DEFAULT_TOP_FILES = 6;
export const DEFAULT_MAX_PATCH_LINES = 60;
export const MIC_DROP_MAX_LINES = 2;

export const MAX_LINES_BY_FORMAT: Record<Format, number> = {
  rap: 8,
  haiku: 3,
  roast: 6,
};

export const COMMENT_MARKER_KEY = 'spit-the-diff';
export const COMMENT_MARKER_REGEX = /<!--\s*spit-the-diff(?::hash=([a-f0-9]+))?\s*-->/i;
export const VALID_FORMATS: readonly Format[] = ['rap', 'haiku', 'roast'];

export const COMMENT_HEADERS: Record<Format, string> = {
  rap: '🎤 **Diff Rap**',
  haiku: '🌸 **Diff Haiku**',
  roast: '🔥 **Code Roast**',
};

export const MODERATION_FALLBACK = '_The generated content did not pass moderation. Try again._';

// Files matching these patterns are excluded from diff ranking to avoid
// generated/vendored files (lockfiles, build artifacts) dominating the prompt.
export const NOISE_FILE_PATTERNS: readonly RegExp[] = [
  /^.*\.lock$/,           // yarn.lock, Gemfile.lock, poetry.lock, etc.
  /^package-lock\.json$/, // npm lockfile
  /^pnpm-lock\.yaml$/,    // pnpm lockfile
  /^npm-shrinkwrap\.json$/,
  /^dist\//,              // compiled output
  /^build\//,
  /^out\//,
  /^\.next\//,
  /^.*\.min\.(js|css)$/,  // minified assets
  /^.*\.map$/,            // sourcemaps
];

export function parseFormat(input: string, fallback: Format = 'rap'): Format {
  if (VALID_FORMATS.includes(input as Format)) {
    return input as Format;
  }

  core.warning(`Invalid format "${input}" supplied. Falling back to "${fallback}".`);
  return fallback;
}

export function formatFilesList(files: PRFile[]): string {
  if (files.length === 0) {
    return '(no changed files found)';
  }

  return files
    .map(file => `${file.filename} | ${file.status} | +${file.additions}/-${file.deletions}`)
    .join('\n');
}

export function truncatePatchLines(patch: string, maxLines: number): string {
  const lines = patch.split('\n');
  if (lines.length <= maxLines) {
    return patch;
  }

  return `${lines.slice(0, maxLines).join('\n')}\n...[truncated ${lines.length - maxLines} more lines]`;
}

export function buildCompressedDiff(
  files: PRFile[],
  topN = DEFAULT_TOP_FILES,
  maxPatchLines = DEFAULT_MAX_PATCH_LINES,
  maxPromptChars = MAX_PROMPT_DIFF_CHARS
): string {
  const signal = files.filter(f => !NOISE_FILE_PATTERNS.some(p => p.test(f.filename)));
  const ranked = [...signal]
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions) || a.filename.localeCompare(b.filename))
    .slice(0, topN);

  const changeSummaryLines = ranked.map(
    file => `${file.filename} | status=${file.status} | +${file.additions}/-${file.deletions}`
  );

  const summarySection = ['Change Summary:', ...changeSummaryLines].join('\n');

  const hunks: string[] = [];
  for (const file of ranked) {
    if (!file.patch) {
      continue;
    }

    hunks.push(`File: ${file.filename}`);
    hunks.push(truncatePatchLines(file.patch, maxPatchLines));
  }

  if (hunks.length === 0) {
    return summarySection;
  }

  const fullPayload = `${summarySection}\n\nSelected Diff Hunks (truncated):\n${hunks.join('\n\n')}`;
  if (fullPayload.length > maxPromptChars) {
    return summarySection;
  }

  return fullPayload;
}

export function buildPrompt(format: Format, summary: PRSummary): { system: string; user: string } {
  const template = TEMPLATES[format];
  return {
    system: template.system,
    user: template.user
      .replace(/\{title\}/g, summary.title)
      .replace(/\{body\}/g, summary.body || '(none)')
      .replace(/\{files\}/g, summary.filesText)
      .replace(/\{diff\}/g, summary.diffPayload),
  };
}

export function buildMicDropPrompt(summary: PRSummary): { system: string; user: string } {
  const template = TEMPLATES.mic_drop;
  return {
    system: template.system,
    user: template.user
      .replace(/\{title\}/g, summary.title)
      .replace(/\{body\}/g, summary.body || '(none)')
      .replace(/\{files\}/g, summary.filesText)
      .replace(/\{diff\}/g, summary.diffPayload),
  };
}

export function countDiffLines(files: PRFile[]): number {
  return files
    .filter(f => !NOISE_FILE_PATTERNS.some(p => p.test(f.filename)))
    .reduce((sum, f) => sum + f.additions + f.deletions, 0);
}

export function removeLeadingMetaLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) {
    return '';
  }

  const normalized = trimmed.toLowerCase();
  if (
    normalized.startsWith("here's") ||
    normalized.startsWith('heres') ||
    normalized.includes('your rap') ||
    normalized.includes('your haiku') ||
    normalized.includes('your roast') ||
    normalized.startsWith('title:') ||
    normalized.startsWith('rap:') ||
    normalized.startsWith('haiku:') ||
    normalized.startsWith('roast:')
  ) {
    return '';
  }

  return trimmed.replace(/^[-*]+\s*/, '');
}

export function normalizeUnicode(text: string): string {
  // Replace runs of characters outside Latin/punctuation/emoji with an em dash.
  // Allows U+0000-U+04FF (Latin through Cyrillic, including spacing modifier
  // letters like curly apostrophe U+02BC), General Punctuation (U+2000-U+206F),
  // Miscellaneous Symbols, and emoji.
  return text.replace(/[^\u0000-\u04FF\u2000-\u206F\u2600-\u27BF\uFE00-\uFEFF\u{1F000}-\u{1FFFF}]+/gu, '—');
}

// Counts the syllables in a single plain-English word using a heuristic:
// strips silent-e endings, common -ed/-es suffixes, then counts vowel groups.
// "i" or "u" before another vowel is split to handle words like "triage" (2 syl).
// Accurate enough to catch clear haiku meter violations; not a dictionary lookup.
function syllablesInWord(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;

  let s = w
    .replace(/[^laeiouy]es$/, '') // -nes/-tes/-mes/-ces etc: 'names' → 'na'
    .replace(/[^dt]ed$/, '')      // -ed suffix (not -ted/-ded): 'flagged' → 'flagg'
    .replace(/[^aeiouy]e$/, '');  // silent final e: 'case' → 'cas', 'file' → 'fi'

  if (!s) s = w;

  // Split 'i'/'u' before another vowel so 'triage' → 'tri ag' (2 groups not 1)
  const normalized = s.replace(/([iu])([aeiouy])/g, '$1 $2');
  const groups = normalized.match(/[aeiouy]{1,2}/g) ?? [];
  return Math.max(1, groups.length);
}

// Counts syllables in one line of a haiku, decomposing snake_case, camelCase,
// and file extensions before counting (e.g. outlook_triage.py → 2+2+1 = 5).
export function countLineSyllables(line: string): number {
  const tokens = line.replace(/[—–]/g, ' ').split(/\s+/).filter(Boolean);
  let total = 0;
  for (const token of tokens) {
    const clean = token.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
    const dotParts = clean.split(/\./);

    // Check if the last dot-segment is a known file extension
    let extensionSyllables = 0;
    if (dotParts.length > 1) {
      const ext = dotParts[dotParts.length - 1].toLowerCase();
      if (ext in EXTENSION_SYLLABLES) {
        extensionSyllables = EXTENSION_SYLLABLES[ext];
        dotParts.pop(); // remove extension; count the rest normally
      }
    }

    const parts = dotParts
      .flatMap(p => p.split(/_/))
      .flatMap(p => p.replace(/([a-z])([A-Z])/g, '$1 $2').split(' '))
      .filter(Boolean);
    for (const part of parts) {
      total += syllablesInWord(part);
    }
    total += extensionSyllables;
  }
  return total;
}

// Returns a human-readable description of meter violations, or null if valid.
// Used to build the retry prompt so the model knows exactly what to fix.
export function validateHaikuMeter(text: string): string | null {
  const lines = text.split('\n');
  if (lines.length !== 3) return null; // structural issues handled elsewhere

  const issues: string[] = [];
  for (let i = 0; i < 3; i++) {
    const count = countLineSyllables(lines[i]);
    const expected = HAIKU_METER[i];
    if (Math.abs(count - expected) > 1) {
      issues.push(`line ${i + 1} has ~${count} syllables (needs ${expected})`);
    }
  }
  return issues.length > 0 ? issues.join('; ') : null;
}

export function sanitizeOutput(format: Format, rawText: string): { text: string; needsHaikuRetry: boolean } {
  const cleanedLines = normalizeUnicode(rawText)
    .split('\n')
    .map(removeLeadingMetaLine)
    .filter(Boolean);

  const maxLines = MAX_LINES_BY_FORMAT[format];
  let lines = cleanedLines;

  if (format === 'haiku') {
    lines = lines.slice(0, maxLines);
    if (lines.length < maxLines) {
      return { text: lines.join('\n'), needsHaikuRetry: true };
    }
  } else {
    lines = lines.slice(0, maxLines);
  }

  return { text: lines.join('\n').trim(), needsHaikuRetry: false };
}

export function buildInputHash(format: Format, model: string, summary: PRSummary): string {
  const payload = JSON.stringify({
    format,
    model,
    title: summary.title,
    body: summary.body,
    filesText: summary.filesText,
    diffPayload: summary.diffPayload,
  });

  return createHash('sha256').update(payload).digest('hex');
}

export function buildCommentBody(format: Format, content: string, inputHash: string): string {
  const marker = `<!-- ${COMMENT_MARKER_KEY}:hash=${inputHash} -->`;
  const header = COMMENT_HEADERS[format];
  return `${marker}\n${header}\n\n${content}\n\n---\n*Generated by [spit-the-diff](https://github.com/ssfinney/spit-the-diff)*`;
}
