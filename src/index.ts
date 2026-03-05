import * as core from '@actions/core';
import * as github from '@actions/github';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';

type Format = 'rap' | 'haiku' | 'roast';

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

const PROFANITY_BLACKLIST = ['fuck', 'shit', 'bitch', 'asshole', 'bastard'];

function loadPromptTemplate(format: Format): string {
  const templatePath = path.resolve(__dirname, '..', 'prompts', TEMPLATE_BY_FORMAT[format]);
  return fs.readFileSync(templatePath, 'utf8').trim();
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

  return trimmed.replace(/^[-*\d.)\s]+/, '');
}

function hasProfanity(text: string): boolean {
  const normalized = text.toLowerCase();
  return PROFANITY_BLACKLIST.some(word => normalized.includes(word));
}

function sanitizeOutput(format: Format, rawText: string): { text: string; needsHaikuRetry: boolean } {
  const cleanedLines = rawText
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

  let text = lines.join('\n').trim();
  if (hasProfanity(text)) {
    for (const word of PROFANITY_BLACKLIST) {
      const re = new RegExp(word, 'gi');
      text = text.replace(re, '****');
    }
  }

  return { text, needsHaikuRetry: false };
}

async function fetchPRData(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number
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
    diffPayload: buildCompressedDiff(normalizedFiles),
  };
}

async function callLLM(apiKey: string, model: string, prompt: string): Promise<string> {
  const client = new OpenAI({ apiKey });

  const response = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 300,
    temperature: 0.85,
  });

  const text = response.choices[0]?.message?.content?.trim();
  if (!text) {
    throw new Error('LLM returned an empty response');
  }
  return text;
}

async function postComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  content: string
): Promise<void> {
  const body = `${content}\n\n---\n*Generated by [spit-the-diff](https://github.com/ssfinney/spit-the-diff)*`;

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}

async function run(): Promise<void> {
  const format = (core.getInput('format') || 'rap') as Format;
  const model = core.getInput('model') || 'gpt-4o-mini';
  const openaiApiKey = core.getInput('openai_api_key');
  const githubToken = core.getInput('github_token') || process.env.GITHUB_TOKEN;
  const roastLabel = core.getInput('roast_label') || 'roast-me';

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

  core.info(`Analyzing PR #${prNumber}: ${pr.title}`);

  const labels: string[] = (pr.labels ?? []).map((l: { name?: string }) => l.name ?? '');
  const effectiveFormat: Format = labels.includes(roastLabel) ? 'roast' : format;

  if (effectiveFormat === 'roast') {
    core.info(`${roastLabel} label detected — switching to roast mode`);
  }

  core.info('Fetching PR metadata and file patches...');
  const summary = await fetchPRData(octokit, owner, repo, prNumber);

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

  core.info('Posting comment to PR...');
  await postComment(octokit, owner, repo, prNumber, sanitized.text);

  core.info('Done!');
}

run().catch(err => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
