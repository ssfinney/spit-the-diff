import * as core from '@actions/core';
import * as github from '@actions/github';
import OpenAI from 'openai';
import {
  type Format,
  type PRSummary,
  type ExistingBotComment,
  DEFAULT_TOP_FILES,
  COMMENT_MARKER_REGEX,
  MODERATION_FALLBACK,
  parseFormat,
  buildPrompt,
  sanitizeOutput,
  buildInputHash,
  buildCommentBody,
  formatFilesList,
  buildCompressedDiff,
} from './lib';

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

async function moderateText(client: OpenAI, text: string): Promise<boolean> {
  const result = await client.moderations.create({ input: text });
  return result.results[0]?.flagged ?? false;
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

  const normalizedFiles = files.map(file => ({
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

async function callLLM(client: OpenAI, model: string, prompt: string): Promise<string> {
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
  const model = core.getInput('model') || 'gpt-4.1-mini';
  const openaiApiKey = core.getInput('openai_api_key');
  const githubToken = core.getInput('github_token') || process.env.GITHUB_TOKEN;
  const roastLabel = core.getInput('roast_label') || 'roast-me';
  const enableModeration = core.getInput('enable_moderation') !== 'false';

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
  const client = new OpenAI({ apiKey: openaiApiKey });
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
  const maxFilesRaw = parseInt(core.getInput('max_files') || String(DEFAULT_TOP_FILES), 10);
  const maxFiles = Number.isFinite(maxFilesRaw) && maxFilesRaw > 0 ? maxFilesRaw : DEFAULT_TOP_FILES;
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
  let creative = await callLLM(client, model, prompt);
  let sanitized = sanitizeOutput(effectiveFormat, creative);

  if (effectiveFormat === 'haiku' && sanitized.needsHaikuRetry) {
    core.info('Haiku output had fewer than 3 lines. Retrying once with strict reminder.');
    const retryPrompt = `${prompt}\n\nReminder: Output exactly 3 lines. No preface.`;
    creative = await callLLM(client, model, retryPrompt);
    sanitized = sanitizeOutput(effectiveFormat, creative);
    if (sanitized.needsHaikuRetry) {
      sanitized = { text: sanitized.text, needsHaikuRetry: false };
    }
  }

  let finalText = sanitized.text;

  if (enableModeration) {
    core.info('Running moderation check...');
    const flagged = await moderateText(client, finalText);
    if (flagged) {
      core.warning('First attempt flagged by moderation. Retrying...');
      creative = await callLLM(client, model, prompt);
      sanitized = sanitizeOutput(effectiveFormat, creative);
      const flaggedAgain = await moderateText(client, sanitized.text);
      if (flaggedAgain) {
        core.warning('Second attempt also flagged by moderation. Using fallback message.');
        finalText = MODERATION_FALLBACK;
      } else {
        finalText = sanitized.text;
      }
    }
  }

  core.info(existingComment ? 'Updating existing bot comment on PR...' : 'Creating bot comment on PR...');
  await upsertComment(octokit, owner, repo, prNumber, effectiveFormat, finalText, inputHash, existingComment);

  core.setOutput('content', finalText);
  core.info('Done!');
}

run().catch(err => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
