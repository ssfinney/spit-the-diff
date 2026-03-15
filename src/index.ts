import * as core from '@actions/core';
import * as github from '@actions/github';
import OpenAI from 'openai';
import {
  type Format,
  type Provider,
  type PRSummary,
  type ExistingBotComment,
  type PRFile,
  DEFAULT_TOP_FILES,
  DEFAULT_MAX_PATCH_LINES,
  MAX_PROMPT_DIFF_CHARS,
  COMMENT_MARKER_REGEX,
  MODERATION_FALLBACK,
  MIC_DROP_MAX_LINES,
  PROVIDER_CONFIGS,
  parseFormat,
  buildPrompt,
  buildMicDropPrompt,
  sanitizeOutput,
  buildInputHash,
  buildCommentBody,
  formatFilesList,
  buildCompressedDiff,
  countDiffLines,
  validateHaikuMeter,
  outputReferencesFiles,
} from './lib';

// Maximum number of retries for haiku generation (initial call + MAX_HAIKU_RETRIES).
const MAX_HAIKU_RETRIES = 2;
const MAX_SPECIFICITY_RETRIES = 1;

const PROVIDER_KEY_INPUTS: Record<Provider, string> = {
  openai:      'openai_api_key',
  anthropic:   'anthropic_api_key',
  google:      'google_api_key',
  openrouter:  'openrouter_api_key',
  huggingface: 'huggingface_api_key',
  groq:        'groq_api_key',
  mistral:     'mistral_api_key',
  together:    'together_api_key',
};

export function resolveProvider(): { provider: Provider; apiKey: string; baseURL?: string; defaultModel: string } {
  const found: Array<{ provider: Provider; apiKey: string }> = [];

  for (const [provider, inputName] of Object.entries(PROVIDER_KEY_INPUTS) as Array<[Provider, string]>) {
    const key = core.getInput(inputName);
    if (key) {
      found.push({ provider, apiKey: key });
    }
  }

  if (found.length === 0) {
    throw new Error(
      'No API key provided. Supply exactly one of: openai_api_key, anthropic_api_key, google_api_key, ' +
      'openrouter_api_key, huggingface_api_key, groq_api_key, mistral_api_key, or together_api_key.'
    );
  }

  if (found.length > 1) {
    const names = found.map(f => PROVIDER_KEY_INPUTS[f.provider]).join(', ');
    throw new Error(`Multiple API keys provided (${names}). Supply exactly one.`);
  }

  const { provider, apiKey } = found[0];
  const config = PROVIDER_CONFIGS[provider];
  return { provider, apiKey, baseURL: config.baseURL, defaultModel: config.defaultModel };
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

async function moderateText(client: OpenAI, text: string): Promise<boolean> {
  const result = await client.moderations.create({ input: text });
  return result.results[0]?.flagged ?? false;
}

async function fetchPRData(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  maxFiles: number = DEFAULT_TOP_FILES,
  maxPatchLines: number = DEFAULT_MAX_PATCH_LINES,
  maxPromptChars: number = MAX_PROMPT_DIFF_CHARS
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
    diffPayload: buildCompressedDiff(normalizedFiles, maxFiles, maxPatchLines, maxPromptChars),
  };
}

async function generateWithRetry(
  client: OpenAI,
  model: string,
  prompt: { system: string; user: string },
  effectiveFormat: Format,
  files: PRFile[],
  micDrop = false
): Promise<string> {
  let creative = await callLLM(client, model, prompt.user, prompt.system);
  let sanitized = sanitizeOutput(effectiveFormat, creative);
  let retries = 0;

  if (effectiveFormat === 'haiku') {
    const initialMeter = sanitized.needsHaikuRetry ? 'fewer than 3 lines' : (validateHaikuMeter(sanitized.text) ?? 'valid');
    core.info(`Haiku attempt 1: ${initialMeter}`);
  }

  // Retry 1 (of MAX_HAIKU_RETRIES): fix structural issues (wrong line count or empty).
  if (effectiveFormat === 'haiku' && (sanitized.needsHaikuRetry || !sanitized.text)) {
    retries++;
    core.info(`Haiku retry ${retries}/${MAX_HAIKU_RETRIES}: fewer than 3 lines or empty output.`);
    const retryUser = `${prompt.user}${creative ? `\n\nYour previous output:\n${creative}` : ''}\n\nReminder: Output exactly 3 lines. No preface.`;
    creative = await callLLM(client, model, retryUser, prompt.system);
    sanitized = sanitizeOutput(effectiveFormat, creative);
    const meterAfter = sanitized.needsHaikuRetry ? 'still fewer than 3 lines' : (validateHaikuMeter(sanitized.text) ?? 'valid');
    core.info(`Haiku retry ${retries} result: ${meterAfter}`);
  }

  // Retry 2 (of MAX_HAIKU_RETRIES): fix syllable counts if structure is now valid.
  if (effectiveFormat === 'haiku' && retries < MAX_HAIKU_RETRIES && !sanitized.needsHaikuRetry) {
    const meterFeedback = validateHaikuMeter(sanitized.text);
    if (meterFeedback) {
      retries++;
      core.info(`Haiku retry ${retries}/${MAX_HAIKU_RETRIES}: meter off — ${meterFeedback}`);
      const meterUser = `${prompt.user}\n\nYour previous haiku:\n${sanitized.text}\n\nThis had incorrect syllable counts: ${meterFeedback}. Revise it to hit 5-7-5 while keeping it natural and meaningful. Prefer common English words over spelled-out abbreviations or padding.`;
      creative = await callLLM(client, model, meterUser, prompt.system);
      sanitized = sanitizeOutput(effectiveFormat, creative);
      const meterAfter = sanitized.needsHaikuRetry ? 'fewer than 3 lines' : (validateHaikuMeter(sanitized.text) ?? 'valid');
      core.info(`Haiku retry ${retries} result: ${meterAfter}`);
    }
  }

  if (effectiveFormat === 'haiku') {
    const finalMeter = sanitized.needsHaikuRetry ? 'fewer than 3 lines' : validateHaikuMeter(sanitized.text);
    if (finalMeter) {
      core.warning(`Haiku published with meter violation after ${retries} retr${retries === 1 ? 'y' : 'ies'}: ${finalMeter}`);
    } else {
      core.info(`Haiku meter valid after ${retries} retr${retries === 1 ? 'y' : 'ies'}.`);
    }
  }

  // ── Specificity retry for non-haiku formats ──
  if (effectiveFormat !== 'haiku') {
    // For mic-drop mode the final output is the first MIC_DROP_MAX_LINES lines,
    // so check only those lines — a file reference on line 3+ will be truncated
    // away and doesn't make the published comment specific.
    const effectiveText = (micDrop
      ? sanitized.text.split('\n').slice(0, MIC_DROP_MAX_LINES).join('\n').trim()
      : sanitized.text);
    const isSpecific = outputReferencesFiles(effectiveText, files);
    if (!isSpecific) {
      const firstDraft = sanitized; // keep as fallback in case the retry errors
      core.info(`${effectiveFormat} output appears generic — retrying with specificity reminder.`);
      const specificityUser = `${prompt.user}\n\nYour previous attempt was too generic and did not mention any specific files, functions, or identifiers from the diff. Here are the key files changed: ${files.slice(0, 5).map(f => f.filename).join(', ')}. Rewrite and reference at least one of these by name — specificity is what makes this funny and useful.`;
      try {
        creative = await callLLM(client, model, specificityUser, prompt.system);
        sanitized = sanitizeOutput(effectiveFormat, creative);
        const retryEffectiveText = (micDrop
          ? sanitized.text.split('\n').slice(0, MIC_DROP_MAX_LINES).join('\n').trim()
          : sanitized.text);
        const stillGeneric = !outputReferencesFiles(retryEffectiveText, files);
        if (stillGeneric) {
          core.warning(`${effectiveFormat} output still generic after specificity retry — publishing anyway.`);
        } else {
          core.info(`${effectiveFormat} output now references specific files after retry.`);
        }
      } catch (err) {
        core.warning(`${effectiveFormat} specificity retry failed (${err instanceof Error ? err.message : String(err)}) — publishing first draft.`);
        sanitized = firstDraft;
      }
    }
  }

  return sanitized.text;
}

async function callLLM(client: OpenAI, model: string, prompt: string, systemPrompt?: string): Promise<string> {
  const messages: OpenAI.ChatCompletionMessageParam[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  const response = await client.chat.completions.create({
    model,
    messages,
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
  const githubToken = core.getInput('github_token') || process.env.GITHUB_TOKEN;
  const roastLabel = core.getInput('roast_label') || 'roast-me';
  const enableModeration = core.getInput('enable_moderation') !== 'false';
  const skipDrafts = core.getInput('skip_drafts') === 'true';

  let providerInfo: ReturnType<typeof resolveProvider>;
  try {
    providerInfo = resolveProvider();
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
    return;
  }

  const { provider, apiKey, baseURL, defaultModel } = providerInfo;
  const model = core.getInput('model') || defaultModel;

  if (enableModeration && provider !== 'openai') {
    core.warning(`enable_moderation is only supported with the openai provider. Skipping moderation for provider "${provider}".`);
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
  const clientOptions: ConstructorParameters<typeof OpenAI>[0] = { apiKey };
  if (baseURL) clientOptions.baseURL = baseURL;
  const client = new OpenAI(clientOptions);
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
  const maxPatchLinesRaw = parseInt(core.getInput('max_patch_lines') || String(DEFAULT_MAX_PATCH_LINES), 10);
  const maxPatchLines = Number.isFinite(maxPatchLinesRaw) && maxPatchLinesRaw > 0 ? maxPatchLinesRaw : DEFAULT_MAX_PATCH_LINES;
  const maxPromptCharsRaw = parseInt(core.getInput('max_prompt_chars') || String(MAX_PROMPT_DIFF_CHARS), 10);
  const maxPromptChars = Number.isFinite(maxPromptCharsRaw) && maxPromptCharsRaw > 0 ? maxPromptCharsRaw : MAX_PROMPT_DIFF_CHARS;
  const [summary, existingComment] = await Promise.all([
    fetchPRData(octokit, owner, repo, prNumber, maxFiles, maxPatchLines, maxPromptChars),
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
  let finalText = await generateWithRetry(client, model, prompt, effectiveFormat, summary.files, isMicDrop);

  if (enableModeration && provider === 'openai') {
    core.info('Running moderation check...');
    const flagged = await moderateText(client, finalText);
    if (flagged) {
      core.warning('First attempt flagged by moderation. Retrying...');
      const safeRetryPrompt = { system: prompt.system, user: `${prompt.user}\n\nImportant: Keep all content strictly workplace-safe. Avoid any slang, idioms, or references that could be considered offensive or inappropriate.` };
      const retryText = await generateWithRetry(client, model, safeRetryPrompt, effectiveFormat, summary.files, isMicDrop);
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
