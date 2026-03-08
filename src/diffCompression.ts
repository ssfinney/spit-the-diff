export interface PRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface CompressionOptions {
  maxSelectedFiles?: number;
  maxHunksPerFile?: number;
  maxPatchLinesPerFile?: number;
  promptCharBudget?: number;
  tinyPrFileThreshold?: number;
  tinyPrChangeThreshold?: number;
}

export interface CompressedDiffPayload {
  filesSummary: string;
  symbolSummary: string;
  diffExcerpt: string;
  selectedFiles: PRFile[];
  ignoredFiles: string[];
  isTinyPullRequest: boolean;
}

const DEFAULT_MAX_SELECTED_FILES = 6;
const DEFAULT_MAX_HUNKS_PER_FILE = 2;
const DEFAULT_MAX_PATCH_LINES_PER_FILE = 40;
const DEFAULT_PROMPT_CHAR_BUDGET = 24000;
const DEFAULT_TINY_FILE_THRESHOLD = 2;
const DEFAULT_TINY_CHANGE_THRESHOLD = 50;

const NOISE_FILE_PATTERNS: RegExp[] = [
  /^package-lock\.json$/,
  /^yarn\.lock$/,
  /^pnpm-lock\.yaml$/,
  /^dist\//,
  /^coverage\//,
  /\.map$/,
  /\.min\.js$/,
];

const SYMBOL_PATTERNS: RegExp[] = [
  /(?:^|\s)function\s+([A-Za-z_$][\w$]*)\s*\(/,
  /(?:^|\s)(?:async\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/,
  /(?:^|\s)(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/,
  /(?:^|\s)(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/,
  /(?:^|\s)(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/,
  /(?:^|\s)export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)\b/,
  /(?:^|\s)([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?\([^)]*\)\s*=>/,
  /(?:^|\s)(?:it|test|describe)\s*\(\s*['"`]([^'"`]+)['"`]/,
  /(?:^|\s)([A-Za-z0-9_.-]+)\s*:/,
];

function isNoiseFile(filename: string): boolean {
  return NOISE_FILE_PATTERNS.some(pattern => pattern.test(filename));
}

function changeWeight(file: PRFile): number {
  return file.additions + file.deletions;
}

function normalizePatchLines(patch: string): string[] {
  return patch.split('\n').map(line => line.replace(/\r$/, ''));
}

function selectRepresentativeHunks(patch: string, maxHunks: number, maxLinesPerFile: number): string {
  const lines = normalizePatchLines(patch);
  const hunks: string[][] = [];
  let currentHunk: string[] = [];

  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (currentHunk.length > 0) {
        hunks.push(currentHunk);
      }
      currentHunk = [line];
      continue;
    }

    if (currentHunk.length > 0) {
      currentHunk.push(line);
    }
  }

  if (currentHunk.length > 0) {
    hunks.push(currentHunk);
  }

  const selected = hunks.slice(0, maxHunks);
  const flattened: string[] = [];

  for (const hunk of selected) {
    if (flattened.length >= maxLinesPerFile) {
      break;
    }

    const remaining = maxLinesPerFile - flattened.length;
    flattened.push(...hunk.slice(0, remaining));
  }

  if (flattened.length === 0) {
    return '';
  }

  const usedAllLines = selected.flat().length <= flattened.length;
  return usedAllLines ? flattened.join('\n') : `${flattened.join('\n')}\n...[truncated]`;
}

function extractSymbolsFromPatch(patch: string): string[] {
  const symbols = new Set<string>();
  const lines = normalizePatchLines(patch)
    .filter(line => (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---'))
    .map(line => line.slice(1).trim())
    .filter(Boolean);

  for (const line of lines) {
    for (const pattern of SYMBOL_PATTERNS) {
      const match = line.match(pattern);
      if (!match?.[1]) {
        continue;
      }

      const candidate = match[1].trim();
      if (candidate.length < 2 || candidate.length > 80) {
        continue;
      }

      symbols.add(candidate);
      if (symbols.size >= 20) {
        return [...symbols];
      }
    }
  }

  return [...symbols];
}

function formatFilesSummary(files: PRFile[]): string {
  if (files.length === 0) {
    return '(no changed files selected)';
  }

  return files
    .map(file => `${file.filename} (+${file.additions} / -${file.deletions}) ${file.status}`)
    .join('\n');
}

export function isTinyPullRequest(files: PRFile[], options: CompressionOptions = {}): boolean {
  const tinyFileThreshold = options.tinyPrFileThreshold ?? DEFAULT_TINY_FILE_THRESHOLD;
  const tinyChangeThreshold = options.tinyPrChangeThreshold ?? DEFAULT_TINY_CHANGE_THRESHOLD;
  const totalChanges = files.reduce((sum, file) => sum + changeWeight(file), 0);
  return files.length < tinyFileThreshold || totalChanges < tinyChangeThreshold;
}

export function buildCompressedDiffPayload(files: PRFile[], options: CompressionOptions = {}): CompressedDiffPayload {
  const maxSelectedFiles = options.maxSelectedFiles ?? DEFAULT_MAX_SELECTED_FILES;
  const maxHunksPerFile = options.maxHunksPerFile ?? DEFAULT_MAX_HUNKS_PER_FILE;
  const maxPatchLinesPerFile = options.maxPatchLinesPerFile ?? DEFAULT_MAX_PATCH_LINES_PER_FILE;
  const promptCharBudget = options.promptCharBudget ?? DEFAULT_PROMPT_CHAR_BUDGET;

  const ignoredFiles: string[] = [];
  const filteredFiles = files.filter(file => {
    const ignored = isNoiseFile(file.filename);
    if (ignored) {
      ignoredFiles.push(file.filename);
    }
    return !ignored;
  });

  const selectedFiles = [...filteredFiles]
    .sort((a, b) => changeWeight(b) - changeWeight(a) || a.filename.localeCompare(b.filename))
    .slice(0, maxSelectedFiles);

  const filesSummary = formatFilesSummary(selectedFiles);

  const symbolByFile: string[] = [];
  for (const file of selectedFiles) {
    if (!file.patch) {
      continue;
    }

    const symbols = extractSymbolsFromPatch(file.patch);
    if (symbols.length === 0) {
      continue;
    }

    symbolByFile.push(`${file.filename}: ${symbols.slice(0, 8).join(', ')}`);
  }

  const symbolSummary = symbolByFile.join('\n');

  const excerptChunks: string[] = [];
  for (const file of selectedFiles) {
    if (!file.patch) {
      continue;
    }

    const excerpt = selectRepresentativeHunks(file.patch, maxHunksPerFile, maxPatchLinesPerFile);
    if (!excerpt) {
      continue;
    }

    excerptChunks.push(`File: ${file.filename}\n${excerpt}`);
  }

  let diffExcerpt = excerptChunks.join('\n\n');

  const sizedPayload = [filesSummary, symbolSummary, diffExcerpt].join('\n\n');
  if (sizedPayload.length > promptCharBudget) {
    diffExcerpt = '';
  }

  return {
    filesSummary,
    symbolSummary,
    diffExcerpt,
    selectedFiles,
    ignoredFiles,
    isTinyPullRequest: isTinyPullRequest(filteredFiles, options),
  };
}
