import * as core from '@actions/core';
import * as github from '@actions/github';
import OpenAI from 'openai';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

type Format = 'rap' | 'haiku' | 'roast';
type ProfanityFilterMode = 'on' | 'off';

interface PRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface PRSummary {
  title: string;
  body: string;
  files: PRFile[];
  filesText: string;
  diffPayload: string;
}

const MAX_PROMPT_DIFF_CHARS = 30000;
const DEFAULT_TOP_FILES = 6;
const DEFAULT_MAX_PATCH_LINES = 60;

const TEMPLATE_BY_FORMAT: Record<Format, string> = {
  rap: 'rap.txt',
  haiku: 'haiku.txt',
  roast: 'roast.txt',
};

const MAX_LINES_BY_FORMAT: Record<Format, number> = {
  rap: 8,
  haiku: 3,
  roast: 6,
};
const COMMENT_MARKER_KEY = 'spit-the-diff';
const COMMENT_MARKER_REGEX = /<!--\s*spit-the-diff(?::hash=([a-f0-9]+))?\s*-->/i;
const VALID_FORMATS: readonly Format[] = ['rap', 'haiku', 'roast'];

const COMMENT_HEADERS: Record<Format, string> = {
  rap: '🎤 **Diff Cypher**',
  haiku: '🌸 **Diff Haiku**',
  roast: '🔥 **Code Roast**',
};
const VALID_PROFANITY_MODES: readonly ProfanityFilterMode[] = ['on', 'off'];

interface ExistingBotComment {
  id: number;
  hash?: string;
}

function parseFormat(input: string, fallback: Format = 'rap'): Format {
  if (VALID_FORMATS.includes(input as Format)) {
    return input as Format;
  }

  core.warning(`Invalid format "${input}" supplied. Falling back to "${fallback}".`);
  return fallback;
}

function parseProfanityFilterMode(input: string, fallback: ProfanityFilterMode = 'on'): ProfanityFilterMode {
  if (VALID_PROFANITY_MODES.includes(input as ProfanityFilterMode)) {
    return input as ProfanityFilterMode;
  }

  core.warning(`Invalid profanity_filter value "${input}" supplied. Falling back to "${fallback}".`);
  return fallback;
}

function loadPromptTemplate(format: Format): string {
  const templatePath = path.resolve(__dirname, '..', 'prompts', TEMPLATE_BY_FORMAT[format]);
  try {
    return fs.readFileSync(templatePath, 'utf8').trim();
  } catch {
    throw new Error(
      `Could not load prompt template for format "${format}" at ${templatePath}. ` +
        `Ensure the prompts/ directory is present alongside dist/.`
    );
  }
}

function formatFilesList(files: PRFile[]): string {
  if (files.length === 0) {
    return '(no changed files found)';
  }

  return files
    .map(file => `${file.filename} | ${file.status} | +${file.additions}/-${file.deletions}`)
    .join('\n');
}

function truncatePatchLines(patch: string, maxLines: number): string {
  const lines = patch.split('\n');
  if (lines.length <= maxLines) {
    return patch;
  }

  return `${lines.slice(0, maxLines).join('\n')}\n...[truncated ${lines.length - maxLines} more lines]`;
}

function buildCompressedDiff(files: PRFile[], topN = DEFAULT_TOP_FILES, maxPatchLines = DEFAULT_MAX_PATCH_LINES): string {
  const ranked = [...files]
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
  if (fullPayload.length > MAX_PROMPT_DIFF_CHARS) {
    return summarySection;
  }

  return fullPayload;
}

function buildPrompt(format: Format, summary: PRSummary): string {
  const template = loadPromptTemplate(format);

  return template
    .replace('{title}', summary.title)
    .replace('{body}', summary.body || '(none)')
    .replace('{files}', summary.filesText)
    .replace('{diff}', summary.diffPayload);
}

function removeLeadingMetaLine(line: string): string {
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

function normalizeUnicode(text: string): string {
  // Replace runs of non-ASCII, non-emoji punctuation/symbols with an em dash
  return text.replace(/[^\x00-\x7F\u2000-\u206F\u2600-\u27BF\uFE00-\uFEFF\u{1F000}-\u{1FFFF}]+/gu, '—');
}

function sanitizeOutput(format: Format, rawText: string): { text: string; needsHaikuRetry: boolean } {
  const cleanedLines = normalizeUnicode(rawText)
    .split('\n')
    .map(removeLeadingMetaLine)
    .filter(Boolean);

  const maxLines = MAX_LINES_BY_FORMAT[format];
  let lines = cleanedLines;

  if (format === 'haiku') {
    lines = lines.slice(0, 3);
    if (lines.length < 3) {
      return { text: lines.join('\n'), needsHaikuRetry: true };
    }
  } else {
    lines = lines.slice(0, maxLines);
  }

  return { text: lines.join('\n').trim(), needsHaikuRetry: false };
}

function buildInputHash(format: Format, model: string, summary: PRSummary): string {
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

function buildCommentBody(format: Format, content: string, inputHash: string): string {
  const marker = `<!-- ${COMMENT_MARKER_KEY}:hash=${inputHash} -->`;
  const header = COMMENT_HEADERS[format];
  return `${marker}\n${header}\n\n${content}\n\n---\n*Generated by [spit-the-diff](https://github.com/ssfinney/spit-the-diff)*`;
}

async function findExistingBotComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number
): Promise<ExistingBotComment | null> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });

  for (const comment of comments) {
    const body = comment.body ?? '';
    const markerMatch = body.match(COMMENT_MARKER_REGEX);
    if (!markerMatch) {
      continue;
    }

    return {
      id: comment.id,
      hash: markerMatch[1],
    };
  }

  return null;
}

async function applyProfanityFilter(
  text: string,
  baseUrl: string
): Promise<{ text: string; detected: boolean; skipped: boolean }> {
  const endpoint = new URL('/service/json', baseUrl);
  endpoint.searchParams.set('text', text);
  endpoint.searchParams.set('fill_char', '*');

  const response = await fetch(endpoint, {
    method: 'GET',
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`PurgoMalum request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as { result?: string };
  if (typeof payload.result !== 'string') {
    throw new Error('PurgoMalum response missing result field');
  }

  return {
    text: payload.result,
    detected: payload.result !== text,
    skipped: false,
  };
}

async function fetchPRData(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  maxFiles: number = DEFAULT_TOP_FILES
): Promise<PRSummary> {
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });

  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const normalizedFiles: PRFile[] = files.map(file => ({
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch,
  }));

  return {
    title: pr.title,
    body: pr.body ?? '',
    files: normalizedFiles,
    filesText: formatFilesList(normalizedFiles),
    diffPayload: buildCompressedDiff(normalizedFiles, maxFiles),
  };
}

async function callLLM(apiKey: string, model: string, prompt: string): Promise<string> {
  const client = new OpenAI({ apiKey });

  const response = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
  });

  const choice = response.choices[0];
  core.info(`LLM finish_reason: ${choice?.finish_reason ?? 'unknown'}`);
  const text = choice?.message?.content?.trim();
  if (!text) {
    throw new Error('LLM returned an empty response');
  }
  return text;
}

async function upsertComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  format: Format,
  content: string,
  inputHash: string,
  existingComment: ExistingBotComment | null
): Promise<void> {
  const body = buildCommentBody(format, content, inputHash);

  if (existingComment) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingComment.id,
      body,
    });
    return;
  }

  await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
}

async function run(): Promise<void> {
  const format = parseFormat(core.getInput('format') || 'rap');
  const model = core.getInput('model') || 'gpt-4o-mini';
  const openaiApiKey = core.getInput('openai_api_key');
  const githubToken = core.getInput('github_token') || process.env.GITHUB_TOKEN;
  const roastLabel = core.getInput('roast_label') || 'roast-me';
  const profanityFilterMode = parseProfanityFilterMode(core.getInput('profanity_filter') || 'on');
  const profanityApiBaseUrl = core.getInput('profanity_api_base_url') || 'https://www.purgomalum.com';

  if (!openaiApiKey) {
    core.setFailed('openai_api_key input is required');
    return;
  }

  if (!githubToken) {
    core.setFailed('github_token is required (or GITHUB_TOKEN env var)');
    return;
  }

  const ctx = github.context;
  const pr = ctx.payload.pull_request;

  if (!pr) {
    core.setFailed('This action only runs on pull_request events');
    return;
  }

  const octokit = github.getOctokit(githubToken);
  const { owner, repo } = ctx.repo;
  const prNumber = pr.number as number;
  const action = ctx.payload.action;

  if (action === 'labeled') {
    const appliedLabel = ctx.payload.label?.name;
    if (appliedLabel !== roastLabel) {
      core.info(`Label event for "${appliedLabel ?? 'unknown'}" does not match roast label "${roastLabel}". Skipping.`);
      return;
    }
  }

  core.info(`Analyzing PR #${prNumber}: ${pr.title}`);

  const labels: string[] = (pr.labels ?? []).map((l: { name?: string }) => l.name ?? '');
  const effectiveFormat: Format = labels.includes(roastLabel) ? 'roast' : format;

  if (effectiveFormat === 'roast') {
    core.info(`${roastLabel} label detected — switching to roast mode`);
  }

  core.info('Fetching PR metadata and file patches...');
  const maxFiles = parseInt(core.getInput('max_files') || String(DEFAULT_TOP_FILES), 10);
  const summary = await fetchPRData(octokit, owner, repo, prNumber, maxFiles);
  const inputHash = buildInputHash(effectiveFormat, model, summary);
  const existingComment = await findExistingBotComment(octokit, owner, repo, prNumber);

  if (action === 'synchronize' && existingComment?.hash === inputHash) {
    core.info('Input hash unchanged on synchronize event. Skipping LLM call and comment update.');
    return;
  }

  core.info(`Building ${effectiveFormat} prompt...`);
  const prompt = buildPrompt(effectiveFormat, summary);

  core.info(`Calling ${model}...`);
  let creative = await callLLM(openaiApiKey, model, prompt);
  let sanitized = sanitizeOutput(effectiveFormat, creative);

  if (effectiveFormat === 'haiku' && sanitized.needsHaikuRetry) {
    core.info('Haiku output had fewer than 3 lines. Retrying once with strict reminder.');
    const retryPrompt = `${prompt}\n\nReminder: Output exactly 3 lines. No preface.`;
    creative = await callLLM(openaiApiKey, model, retryPrompt);
    sanitized = sanitizeOutput(effectiveFormat, creative);
    if (sanitized.needsHaikuRetry) {
      const padded = sanitized.text ? `${sanitized.text}\n\n` : '\n\n';
      sanitized = { text: padded.split('\n').slice(0, 3).join('\n'), needsHaikuRetry: false };
    }
  }

  if (profanityFilterMode === 'on') {
    try {
      const filtered = await applyProfanityFilter(sanitized.text, profanityApiBaseUrl);
      if (filtered.detected) {
        core.info('Profanity detected by PurgoMalum; applying censored output.');
      }
      sanitized = sanitizeOutput(effectiveFormat, filtered.text);
    } catch (error) {
      core.warning(
        `profanity_filter=on but PurgoMalum check failed (${error instanceof Error ? error.message : String(error)}). Posting uncensored output.`
      );
    }
  }

  core.info(existingComment ? 'Updating existing bot comment on PR...' : 'Creating bot comment on PR...');
  await upsertComment(octokit, owner, repo, prNumber, effectiveFormat, sanitized.text, inputHash, existingComment);

  core.info('Done!');
}

run().catch(err => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
