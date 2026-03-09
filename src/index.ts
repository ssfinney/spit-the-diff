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
  MIC_DROP_MAX_LINES,
  parseFormat,
  buildPrompt,
  buildMicDropPrompt,
  sanitizeOutput,
  buildInputHash,
  buildCommentBody,
  formatFilesList,
  buildCompressedDiff,
  countDiffLines,
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
  const [{ data: pr }, files] = await Promise.all([
    octokit.rest.pulls.get({ owner, repo, pull_number: prNumber }),
    octokit.paginate(octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }),
  ]);

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

async function generateWithHaikuRetry(
  client: OpenAI,
  model: string,
  prompt: string,
  effectiveFormat: Format
): Promise<string> {
  let creative = await callLLM(client, model, prompt);
  let sanitized = sanitizeOutput(effectiveFormat, creative);

  if (effectiveFormat === 'haiku' && sanitized.needsHaikuRetry) {
    core.info('Haiku output had fewer than 3 lines. Retrying once with strict reminder.');
    const retryPrompt = `${prompt}\n\nReminder: Output exactly 3 lines. No preface.`;
    creative = await callLLM(client, model, retryPrompt);
    sanitized = sanitizeOutput(effectiveFormat, creative);
  } else if (!sanitized.text) {
    core.info('Sanitized output was empty. Retrying once.');
    const emptyRetryPrompt = `${prompt}\n\nReminder: Output only the creative content, no title or explanation.`;
    creative = await callLLM(client, model, emptyRetryPrompt);
    sanitized = sanitizeOutput(effectiveFormat, creative);
  }

  return sanitized.text;
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
  const skipDrafts = core.getInput('skip_drafts') === 'true';

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

  if (skipDrafts && pr.draft) {
    core.info('PR is in draft status. Skipping. Add "ready_for_review" to pull_request.types to trigger when the PR is marked ready.');
    return;
  }

  const octokit = github.getOctokit(githubToken);
  const client = new OpenAI({ apiKey: openaiApiKey });
  const { owner, repo } = ctx.repo;
  const prNumber = pr.number as number;
  const action = ctx.payload.action;

  // Normalize a label for comparison: lowercase and collapse hyphens/spaces/underscores.
  // This lets "roast-me", "roast me", and "roastme" all match each other.
  const normalizeLabel = (s: string) => s.toLowerCase().replace(/[\s\-_]+/g, '');
  const normalizedRoastLabel = normalizeLabel(roastLabel);

  if (action === 'labeled') {
    const appliedLabel = ctx.payload.label?.name;
    if (normalizeLabel(appliedLabel ?? '') !== normalizedRoastLabel) {
      core.info(`Label event for "${appliedLabel ?? 'unknown'}" does not match roast label "${roastLabel}". Skipping.`);
      return;
    }
  }

  core.info(`Analyzing PR #${prNumber}: ${pr.title}`);

  const labels: string[] = (pr.labels ?? []).map((l: { name?: string }) => normalizeLabel(l.name ?? ''));
  const effectiveFormat: Format = labels.includes(normalizedRoastLabel) ? 'roast' : format;

  if (effectiveFormat === 'roast') {
    core.info(`${roastLabel} label detected — switching to roast mode`);
  }

  core.info('Fetching PR metadata and file patches...');
  const maxFilesRaw = parseInt(core.getInput('max_files') || String(DEFAULT_TOP_FILES), 10);
  const maxFiles = Number.isFinite(maxFilesRaw) && maxFilesRaw > 0 ? maxFilesRaw : DEFAULT_TOP_FILES;
  const [summary, existingComment] = await Promise.all([
    fetchPRData(octokit, owner, repo, prNumber, maxFiles),
    findExistingBotComment(octokit, owner, repo, prNumber),
  ]);
  const inputHash = buildInputHash(effectiveFormat, model, summary);

  const totalLines = countDiffLines(summary.files);

  const minDiffLines = parseInt(core.getInput('min_diff_lines') || '0', 10);
  if (minDiffLines > 0 && totalLines < minDiffLines) {
    core.info(`Diff is only ${totalLines} non-noise lines (threshold: ${minDiffLines}). Skipping.`);
    if (existingComment) {
      core.info('Deleting stale bot comment (diff is now below min_diff_lines threshold).');
      await octokit.rest.issues.deleteComment({ owner, repo, comment_id: existingComment.id });
    }
    return;
  }

  const micDropThreshold = parseInt(core.getInput('mic_drop_threshold') || '0', 10);
  // Haiku is already a minimal 3-line format — mic drop (2 lines) would produce a non-haiku,
  // so we skip mic drop mode entirely when haiku is selected.
  const isMicDrop = micDropThreshold > 0 && totalLines < micDropThreshold && effectiveFormat !== 'haiku';
  if (isMicDrop) {
    core.info(`Small diff (${totalLines} non-noise lines). Using mic drop mode.`);
  } else if (micDropThreshold > 0 && totalLines < micDropThreshold && effectiveFormat === 'haiku') {
    core.info(`Small diff (${totalLines} non-noise lines) but haiku format selected — skipping mic drop.`);
  }

  if (action === 'synchronize' && existingComment?.hash === inputHash) {
    core.info('Input hash unchanged on synchronize event. Skipping LLM call and comment update.');
    return;
  }

  core.info(`Building ${effectiveFormat} prompt...`);
  const prompt = isMicDrop ? buildMicDropPrompt(summary) : buildPrompt(effectiveFormat, summary);

  core.info(`Calling ${model}...`);
  let finalText = await generateWithHaikuRetry(client, model, prompt, effectiveFormat);

  if (enableModeration) {
    core.info('Running moderation check...');
    const flagged = await moderateText(client, finalText);
    if (flagged) {
      core.warning('First attempt flagged by moderation. Retrying...');
      const safeRetryPrompt = `${prompt}\n\nImportant: Keep all content strictly workplace-safe. Avoid any slang, idioms, or references that could be considered offensive or inappropriate.`;
      const retryText = await generateWithHaikuRetry(client, model, safeRetryPrompt, effectiveFormat);
      const flaggedAgain = await moderateText(client, retryText);
      if (flaggedAgain) {
        core.warning('Second attempt also flagged by moderation. Using fallback message.');
        finalText = MODERATION_FALLBACK;
      } else {
        finalText = retryText;
      }
    }
  }

  if (isMicDrop) {
    finalText = finalText.split('\n').slice(0, MIC_DROP_MAX_LINES).join('\n').trim();
  }

  core.info(existingComment ? 'Updating existing bot comment on PR...' : 'Creating bot comment on PR...');
  await upsertComment(octokit, owner, repo, prNumber, effectiveFormat, finalText, inputHash, existingComment);

  core.setOutput('content', finalText);
  core.info('Done!');
}

run().catch(err => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
