import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseFormat,
  formatFilesList,
  truncatePatchLines,
  buildCompressedDiff,
  buildPrompt,
  removeLeadingMetaLine,
  normalizeUnicode,
  sanitizeOutput,
  buildInputHash,
  buildCommentBody,
  MODERATION_FALLBACK,
  COMMENT_MARKER_REGEX,
  type PRFile,
  type PRSummary,
} from './lib';

vi.mock('@actions/core', () => ({
  warning: vi.fn(),
  info: vi.fn(),
}));

import * as core from '@actions/core';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeFile(overrides: Partial<PRFile> = {}): PRFile {
  return {
    filename: 'src/index.ts',
    status: 'modified',
    additions: 10,
    deletions: 5,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<PRSummary> = {}): PRSummary {
  return {
    title: 'Add feature X',
    body: 'This PR adds feature X',
    files: [],
    filesText: 'src/index.ts | modified | +10/-5',
    diffPayload: 'Change Summary:\nsrc/index.ts | status=modified | +10/-5',
    ...overrides,
  };
}

// ─── parseFormat ─────────────────────────────────────────────────────────────

describe('parseFormat', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns rap for "rap"', () => {
    expect(parseFormat('rap')).toBe('rap');
  });

  it('returns haiku for "haiku"', () => {
    expect(parseFormat('haiku')).toBe('haiku');
  });

  it('returns roast for "roast"', () => {
    expect(parseFormat('roast')).toBe('roast');
  });

  it('falls back to rap and warns on invalid input', () => {
    expect(parseFormat('limerick')).toBe('rap');
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('"limerick"'));
  });

  it('uses custom fallback', () => {
    expect(parseFormat('bad', 'haiku')).toBe('haiku');
  });
});

// ─── formatFilesList ──────────────────────────────────────────────────────────

describe('formatFilesList', () => {
  it('returns placeholder for empty array', () => {
    expect(formatFilesList([])).toBe('(no changed files found)');
  });

  it('formats a single file', () => {
    const result = formatFilesList([makeFile()]);
    expect(result).toBe('src/index.ts | modified | +10/-5');
  });

  it('formats multiple files separated by newlines', () => {
    const files = [
      makeFile({ filename: 'a.ts', additions: 1, deletions: 0 }),
      makeFile({ filename: 'b.ts', additions: 2, deletions: 1 }),
    ];
    const result = formatFilesList(files);
    expect(result).toBe('a.ts | modified | +1/-0\nb.ts | modified | +2/-1');
  });
});

// ─── truncatePatchLines ───────────────────────────────────────────────────────

describe('truncatePatchLines', () => {
  it('returns patch unchanged when under limit', () => {
    const patch = 'line1\nline2\nline3';
    expect(truncatePatchLines(patch, 5)).toBe(patch);
  });

  it('returns patch unchanged when exactly at limit', () => {
    const patch = 'line1\nline2\nline3';
    expect(truncatePatchLines(patch, 3)).toBe(patch);
  });

  it('truncates and appends count message when over limit', () => {
    const patch = 'line1\nline2\nline3\nline4\nline5';
    const result = truncatePatchLines(patch, 3);
    expect(result).toBe('line1\nline2\nline3\n...[truncated 2 more lines]');
  });
});

// ─── buildCompressedDiff ─────────────────────────────────────────────────────

describe('buildCompressedDiff', () => {
  it('returns summary-only when no patches present', () => {
    const files = [makeFile({ patch: undefined })];
    const result = buildCompressedDiff(files);
    expect(result).toContain('Change Summary:');
    expect(result).not.toContain('Selected Diff Hunks');
  });

  it('includes diff hunks when patches present', () => {
    const files = [makeFile({ patch: '@@ -1 +1 @@\n-old\n+new' })];
    const result = buildCompressedDiff(files);
    expect(result).toContain('Selected Diff Hunks');
    expect(result).toContain('@@ -1 +1 @@');
  });

  it('ranks files by total churn descending', () => {
    const files = [
      makeFile({ filename: 'low.ts', additions: 1, deletions: 0 }),
      makeFile({ filename: 'high.ts', additions: 50, deletions: 50 }),
    ];
    const result = buildCompressedDiff(files);
    const highPos = result.indexOf('high.ts');
    const lowPos = result.indexOf('low.ts');
    expect(highPos).toBeLessThan(lowPos);
  });

  it('breaks churn ties alphabetically', () => {
    const files = [
      makeFile({ filename: 'z.ts', additions: 10, deletions: 0 }),
      makeFile({ filename: 'a.ts', additions: 10, deletions: 0 }),
    ];
    const result = buildCompressedDiff(files);
    expect(result.indexOf('a.ts')).toBeLessThan(result.indexOf('z.ts'));
  });

  it('slices to topN files', () => {
    const files = Array.from({ length: 10 }, (_, i) =>
      makeFile({ filename: `file${i}.ts`, additions: i, deletions: 0 })
    );
    const result = buildCompressedDiff(files, 3);
    const fileMatches = result.match(/file\d+\.ts/g) ?? [];
    expect(new Set(fileMatches).size).toBeLessThanOrEqual(3);
  });

  it('falls back to summary-only when payload exceeds MAX_PROMPT_DIFF_CHARS', () => {
    const bigPatch = 'x'.repeat(31000);
    const files = [makeFile({ patch: bigPatch })];
    const result = buildCompressedDiff(files);
    expect(result).toContain('Change Summary:');
    expect(result).not.toContain('Selected Diff Hunks');
  });
});

// ─── buildPrompt ─────────────────────────────────────────────────────────────

describe('buildPrompt', () => {
  const summary = makeSummary();

  it('substitutes {title}', () => {
    expect(buildPrompt('rap', summary)).toContain(summary.title);
  });

  it('substitutes {body}', () => {
    expect(buildPrompt('rap', summary)).toContain(summary.body);
  });

  it('substitutes {files}', () => {
    expect(buildPrompt('rap', summary)).toContain(summary.filesText);
  });

  it('substitutes {diff}', () => {
    expect(buildPrompt('rap', summary)).toContain(summary.diffPayload);
  });

  it('uses "(none)" when body is empty', () => {
    expect(buildPrompt('rap', makeSummary({ body: '' }))).toContain('(none)');
  });

  it('uses the haiku template for haiku format', () => {
    expect(buildPrompt('haiku', summary)).toContain('5-7-5');
  });

  it('uses the roast template for roast format', () => {
    expect(buildPrompt('roast', summary)).toContain('roast');
  });
});

// ─── removeLeadingMetaLine ────────────────────────────────────────────────────

describe('removeLeadingMetaLine', () => {
  it('returns empty string for blank line', () => {
    expect(removeLeadingMetaLine('')).toBe('');
    expect(removeLeadingMetaLine('   ')).toBe('');
  });

  it('strips "Here\'s your ..." preamble', () => {
    expect(removeLeadingMetaLine("Here's your rap:")).toBe('');
  });

  it('strips "heres ..." preamble', () => {
    expect(removeLeadingMetaLine('Heres your roast:')).toBe('');
  });

  it('strips lines containing "your rap"', () => {
    expect(removeLeadingMetaLine('Check out your rap summary')).toBe('');
  });

  it('strips lines containing "your haiku"', () => {
    expect(removeLeadingMetaLine('Enjoy your haiku')).toBe('');
  });

  it('strips lines containing "your roast"', () => {
    expect(removeLeadingMetaLine('Here is your roast')).toBe('');
  });

  it('strips "title:" prefix', () => {
    expect(removeLeadingMetaLine('Title: Something')).toBe('');
  });

  it('strips "rap:" prefix', () => {
    expect(removeLeadingMetaLine('rap: something')).toBe('');
  });

  it('strips leading dash bullet', () => {
    expect(removeLeadingMetaLine('- some line')).toBe('some line');
  });

  it('strips leading asterisk bullet', () => {
    expect(removeLeadingMetaLine('* some line')).toBe('some line');
  });

  it('strips multiple leading dashes', () => {
    expect(removeLeadingMetaLine('--- some line')).toBe('some line');
  });

  it('passes through a normal line unchanged', () => {
    expect(removeLeadingMetaLine('Code drops at midnight')).toBe('Code drops at midnight');
  });

  it('trims surrounding whitespace', () => {
    expect(removeLeadingMetaLine('  hello world  ')).toBe('hello world');
  });
});

// ─── normalizeUnicode ─────────────────────────────────────────────────────────

describe('normalizeUnicode', () => {
  it('leaves ASCII text unchanged', () => {
    expect(normalizeUnicode('hello world')).toBe('hello world');
  });

  it('preserves curly apostrophe (U+2019, in General Punctuation block)', () => {
    expect(normalizeUnicode("it\u2019s")).toBe("it\u2019s");
  });

  it('preserves emoji', () => {
    expect(normalizeUnicode('🎤 bars')).toBe('🎤 bars');
  });

  it('replaces CJK characters with em dash', () => {
    const result = normalizeUnicode('hello \u4e2d\u6587 world');
    expect(result).toBe('hello — world');
  });

  it('collapses consecutive non-Latin runs into a single em dash', () => {
    const result = normalizeUnicode('\u4e2d\u6587\u65e5\u672c\u8a9e');
    expect(result).toBe('—');
  });
});

// ─── sanitizeOutput ───────────────────────────────────────────────────────────

describe('sanitizeOutput', () => {
  describe('rap', () => {
    it('returns up to 8 lines', () => {
      const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
      const { text, needsHaikuRetry } = sanitizeOutput('rap', lines);
      expect(text.split('\n')).toHaveLength(8);
      expect(needsHaikuRetry).toBe(false);
    });

    it('strips meta preamble lines', () => {
      const raw = "Here's your rap:\nline one\nline two";
      const { text } = sanitizeOutput('rap', raw);
      expect(text).not.toContain("Here's");
      expect(text).toContain('line one');
    });
  });

  describe('roast', () => {
    it('returns up to 6 lines', () => {
      const lines = Array.from({ length: 10 }, (_, i) => `roast ${i + 1}`).join('\n');
      const { text } = sanitizeOutput('roast', lines);
      expect(text.split('\n')).toHaveLength(6);
    });
  });

  describe('haiku', () => {
    it('returns 3 lines with needsHaikuRetry false when given exactly 3', () => {
      const raw = 'old code breaks free\nbytes cascade like autumn leaves\nship it anyway';
      const { text, needsHaikuRetry } = sanitizeOutput('haiku', raw);
      expect(text.split('\n')).toHaveLength(3);
      expect(needsHaikuRetry).toBe(false);
    });

    it('truncates to 3 lines when given more', () => {
      const raw = 'line one\nline two\nline three\nline four';
      const { text, needsHaikuRetry } = sanitizeOutput('haiku', raw);
      expect(text.split('\n')).toHaveLength(3);
      expect(needsHaikuRetry).toBe(false);
    });

    it('sets needsHaikuRetry true when fewer than 3 lines after cleanup', () => {
      const raw = 'only one line here';
      const { text, needsHaikuRetry } = sanitizeOutput('haiku', raw);
      expect(needsHaikuRetry).toBe(true);
      expect(text).toBe('only one line here');
    });

    it('sets needsHaikuRetry true for empty output', () => {
      const { needsHaikuRetry } = sanitizeOutput('haiku', '');
      expect(needsHaikuRetry).toBe(true);
    });
  });

  it('filters blank lines', () => {
    const raw = 'line one\n\n\nline two';
    const { text } = sanitizeOutput('rap', raw);
    expect(text.split('\n').every(l => l.length > 0)).toBe(true);
  });
});

// ─── buildInputHash ───────────────────────────────────────────────────────────

describe('buildInputHash', () => {
  const summary = makeSummary();

  it('returns a 64-character hex string', () => {
    const hash = buildInputHash('rap', 'gpt-4o-mini', summary);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic for the same inputs', () => {
    expect(buildInputHash('rap', 'gpt-4o-mini', summary)).toBe(
      buildInputHash('rap', 'gpt-4o-mini', summary)
    );
  });

  it('changes when format changes', () => {
    expect(buildInputHash('rap', 'gpt-4o-mini', summary)).not.toBe(
      buildInputHash('haiku', 'gpt-4o-mini', summary)
    );
  });

  it('changes when model changes', () => {
    expect(buildInputHash('rap', 'gpt-4o-mini', summary)).not.toBe(
      buildInputHash('rap', 'gpt-4.1-mini', summary)
    );
  });

  it('changes when title changes', () => {
    expect(buildInputHash('rap', 'gpt-4o-mini', summary)).not.toBe(
      buildInputHash('rap', 'gpt-4o-mini', makeSummary({ title: 'Different title' }))
    );
  });
});

// ─── buildCommentBody ─────────────────────────────────────────────────────────

describe('buildCommentBody', () => {
  const hash = 'abc123';
  const content = 'Merge conflict wars, the rebase felt the sting';

  it('includes the spit-the-diff marker with hash', () => {
    const body = buildCommentBody('rap', content, hash);
    expect(body).toContain(`<!-- spit-the-diff:hash=${hash} -->`);
  });

  it('marker is parseable by COMMENT_MARKER_REGEX', () => {
    const body = buildCommentBody('rap', content, hash);
    const match = body.match(COMMENT_MARKER_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(hash);
  });

  it('includes the correct header for rap', () => {
    expect(buildCommentBody('rap', content, hash)).toContain('🎤 **Diff Cypher**');
  });

  it('includes the correct header for haiku', () => {
    expect(buildCommentBody('haiku', content, hash)).toContain('🌸 **Diff Haiku**');
  });

  it('includes the correct header for roast', () => {
    expect(buildCommentBody('roast', content, hash)).toContain('🔥 **Code Roast**');
  });

  it('includes the content', () => {
    expect(buildCommentBody('rap', content, hash)).toContain(content);
  });

  it('includes the spit-the-diff attribution link', () => {
    expect(buildCommentBody('rap', content, hash)).toContain('spit-the-diff');
  });
});

// ─── MODERATION_FALLBACK ─────────────────────────────────────────────────────

describe('MODERATION_FALLBACK', () => {
  it('is a non-empty string', () => {
    expect(typeof MODERATION_FALLBACK).toBe('string');
    expect(MODERATION_FALLBACK.length).toBeGreaterThan(0);
  });
});
