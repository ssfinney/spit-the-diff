import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Provider } from './lib';

// Flush all microtasks + one macrotask so the fire-and-forget run() chain
// triggered by module import has time to settle.
function flushRun(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 50));
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeOctokit({
  existingComments = [] as Array<{ id: number; body: string }>,
  files = [] as Array<Record<string, unknown>>,
  createComment = vi.fn().mockResolvedValue({}),
  updateComment = vi.fn().mockResolvedValue({}),
  deleteComment = vi.fn().mockResolvedValue({}),
} = {}) {
  const rest = {
    pulls: {
      get: vi.fn().mockResolvedValue({ data: { title: 'Test PR', body: '' } }),
      listFiles: vi.fn(),
    },
    issues: {
      listComments: vi.fn(),
      createComment,
      updateComment,
      deleteComment,
    },
  };
  return {
    paginate: vi.fn().mockImplementation(async (endpoint: unknown) => {
      if (endpoint === rest.issues.listComments) return existingComments;
      return files; // listFiles
    }),
    rest,
  };
}

function makeCoreMock(overrides: Record<string, string> = {}) {
  const inputs: Record<string, string> = {
    openai_api_key: 'sk-test',
    github_token: 'gh-token',
    format: 'rap',
    model: 'gpt-4.1-mini',
    // Default off so tests that don't care about moderation don't need to
    // mock client.moderations.
    enable_moderation: 'false',
    roast_label: 'roast-me',
    ...overrides,
  };
  return {
    getInput: vi.fn((name: string) => inputs[name] ?? ''),
    setFailed: vi.fn(),
    setOutput: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  };
}

function makeLLMCreate(content = 'drop the beat now\nhitting every commit') {
  return vi.fn().mockResolvedValue({
    choices: [{ finish_reason: 'stop', message: { content } }],
  });
}

// Build a vi.doMock factory for the openai module. Uses a regular function (not
// an arrow) so vitest accepts it as a constructor when index.ts calls new OpenAI().
function makeOpenAIMock(opts: {
  llmCreate: ReturnType<typeof vi.fn>;
  moderationsCreate?: ReturnType<typeof vi.fn>;
}) {
  const chatCreate = opts.llmCreate;
  const modCreate =
    opts.moderationsCreate ??
    vi.fn().mockResolvedValue({ results: [{ flagged: false }] });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function MockOpenAI(this: any) {
    this.chat = { completions: { create: chatCreate } };
    this.moderations = { create: modCreate };
  }
  return { default: MockOpenAI };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('run()', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.GITHUB_TOKEN;
  });

  it('calls setFailed when no API key is provided', async () => {
    vi.doMock('@actions/core', () => makeCoreMock({ openai_api_key: '' }));
    vi.doMock('@actions/github', () => ({
      getOctokit: vi.fn(),
      context: { payload: {}, repo: { owner: 'o', repo: 'r' } },
    }));
    vi.doMock('openai', () => ({ default: vi.fn() }));

    await import('./index');
    await flushRun();

    const { setFailed } = await import('@actions/core');
    expect(vi.mocked(setFailed)).toHaveBeenCalledWith(
      expect.stringContaining('No API key provided'),
    );
  });

  it('calls setFailed when multiple API keys are provided', async () => {
    vi.doMock('@actions/core', () => makeCoreMock({ openai_api_key: 'sk-test', anthropic_api_key: 'ant-test' }));
    vi.doMock('@actions/github', () => ({
      getOctokit: vi.fn(),
      context: { payload: {}, repo: { owner: 'o', repo: 'r' } },
    }));
    vi.doMock('openai', () => ({ default: vi.fn() }));

    await import('./index');
    await flushRun();

    const { setFailed } = await import('@actions/core');
    expect(vi.mocked(setFailed)).toHaveBeenCalledWith(
      expect.stringContaining('Multiple API keys provided'),
    );
  });

  it('calls setFailed when github_token is missing', async () => {
    vi.doMock('@actions/core', () => makeCoreMock({ github_token: '' }));
    vi.doMock('@actions/github', () => ({
      getOctokit: vi.fn(),
      context: { payload: {}, repo: { owner: 'o', repo: 'r' } },
    }));
    vi.doMock('openai', () => ({ default: vi.fn() }));

    await import('./index');
    await flushRun();

    const { setFailed } = await import('@actions/core');
    expect(vi.mocked(setFailed)).toHaveBeenCalledWith(
      expect.stringContaining('github_token'),
    );
  });

  it('calls setFailed when the event is not a pull_request', async () => {
    vi.doMock('@actions/core', () => makeCoreMock());
    vi.doMock('@actions/github', () => ({
      getOctokit: vi.fn(),
      context: { payload: {}, repo: { owner: 'o', repo: 'r' } }, // no pull_request key
    }));
    vi.doMock('openai', () => ({ default: vi.fn() }));

    await import('./index');
    await flushRun();

    const { setFailed } = await import('@actions/core');
    expect(vi.mocked(setFailed)).toHaveBeenCalledWith(
      'This action only runs on pull_request events',
    );
  });

  it('posts the retry text when first moderation attempt is flagged but the retry passes', async () => {
    const llmCreate = vi.fn()
      .mockResolvedValueOnce({ choices: [{ finish_reason: 'stop', message: { content: 'first output' } }] })
      .mockResolvedValueOnce({ choices: [{ finish_reason: 'stop', message: { content: 'clean retry output' } }] });

    const moderationsCreate = vi.fn()
      .mockResolvedValueOnce({ results: [{ flagged: true }] })
      .mockResolvedValueOnce({ results: [{ flagged: false }] });

    const mockCreateComment = vi.fn().mockResolvedValue({});
    const octokit = makeOctokit({ createComment: mockCreateComment });

    vi.doMock('openai', () => makeOpenAIMock({ llmCreate, moderationsCreate }));
    vi.doMock('@actions/core', () => makeCoreMock({ enable_moderation: 'true' }));
    vi.doMock('@actions/github', () => ({
      getOctokit: vi.fn().mockReturnValue(octokit),
      context: {
        payload: { pull_request: { number: 1, title: 'T', labels: [] }, action: 'opened' },
        repo: { owner: 'o', repo: 'r' },
      },
    }));

    await import('./index');
    await flushRun();

    const { setOutput } = await import('@actions/core');
    expect(vi.mocked(setOutput)).toHaveBeenCalledWith('content', 'clean retry output');
    expect(mockCreateComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('clean retry output') }),
    );
  });

  it('calls updateComment (not createComment) when a prior bot comment exists', async () => {
    const mockUpdateComment = vi.fn().mockResolvedValue({});
    const mockCreateComment = vi.fn().mockResolvedValue({});

    const octokit = makeOctokit({
      existingComments: [{ id: 42, body: '<!-- spit-the-diff:hash=000000 -->' }],
      updateComment: mockUpdateComment,
      createComment: mockCreateComment,
    });

    vi.doMock('openai', () => makeOpenAIMock({ llmCreate: makeLLMCreate() }));
    vi.doMock('@actions/core', () => makeCoreMock());
    vi.doMock('@actions/github', () => ({
      getOctokit: vi.fn().mockReturnValue(octokit),
      context: {
        payload: { pull_request: { number: 1, title: 'T', labels: [] }, action: 'opened' },
        repo: { owner: 'o', repo: 'r' },
      },
    }));

    await import('./index');
    await flushRun();

    expect(mockUpdateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 42 }),
    );
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it('skips draft PRs when skip_drafts is true', async () => {
    const llmCreate = makeLLMCreate();
    const mockCreateComment = vi.fn().mockResolvedValue({});
    const octokit = makeOctokit({ createComment: mockCreateComment });

    vi.doMock('openai', () => makeOpenAIMock({ llmCreate }));
    vi.doMock('@actions/core', () => makeCoreMock({ skip_drafts: 'true' }));
    vi.doMock('@actions/github', () => ({
      getOctokit: vi.fn().mockReturnValue(octokit),
      context: {
        payload: { pull_request: { number: 1, title: 'T', labels: [], draft: true }, action: 'opened' },
        repo: { owner: 'o', repo: 'r' },
      },
    }));

    await import('./index');
    await flushRun();

    expect(llmCreate).not.toHaveBeenCalled();
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it('does not skip non-draft PRs when skip_drafts is true', async () => {
    const llmCreate = makeLLMCreate('ready to ship');
    const mockCreateComment = vi.fn().mockResolvedValue({});
    const octokit = makeOctokit({ createComment: mockCreateComment });

    vi.doMock('openai', () => makeOpenAIMock({ llmCreate }));
    vi.doMock('@actions/core', () => makeCoreMock({ skip_drafts: 'true' }));
    vi.doMock('@actions/github', () => ({
      getOctokit: vi.fn().mockReturnValue(octokit),
      context: {
        payload: { pull_request: { number: 1, title: 'T', labels: [], draft: false }, action: 'ready_for_review' },
        repo: { owner: 'o', repo: 'r' },
      },
    }));

    await import('./index');
    await flushRun();

    expect(llmCreate).toHaveBeenCalled();
    expect(mockCreateComment).toHaveBeenCalled();
  });

  it('skips when min_diff_lines threshold is not met', async () => {
    const llmCreate = makeLLMCreate();
    const mockCreateComment = vi.fn().mockResolvedValue({});
    // 0 lines changed — below any positive threshold
    const files = [{ filename: 'README.md', status: 'modified', additions: 0, deletions: 0 }];
    const octokit = makeOctokit({ createComment: mockCreateComment, files });

    vi.doMock('openai', () => makeOpenAIMock({ llmCreate }));
    vi.doMock('@actions/core', () => makeCoreMock({ min_diff_lines: '5' }));
    vi.doMock('@actions/github', () => ({
      getOctokit: vi.fn().mockReturnValue(octokit),
      context: {
        payload: { pull_request: { number: 1, title: 'T', labels: [] }, action: 'opened' },
        repo: { owner: 'o', repo: 'r' },
      },
    }));

    await import('./index');
    await flushRun();

    expect(llmCreate).not.toHaveBeenCalled();
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it('deletes stale bot comment when diff falls below min_diff_lines', async () => {
    const llmCreate = makeLLMCreate();
    const mockDeleteComment = vi.fn().mockResolvedValue({});
    const staleComment = { id: 42, body: '<!-- spit-the-diff:hash=aabbccdd1122 -->\nold content' };
    const files = [{ filename: 'README.md', status: 'modified', additions: 0, deletions: 0 }];
    const octokit = makeOctokit({ existingComments: [staleComment], deleteComment: mockDeleteComment, files });

    vi.doMock('openai', () => makeOpenAIMock({ llmCreate }));
    vi.doMock('@actions/core', () => makeCoreMock({ min_diff_lines: '5' }));
    vi.doMock('@actions/github', () => ({
      getOctokit: vi.fn().mockReturnValue(octokit),
      context: {
        payload: { pull_request: { number: 1, title: 'T', labels: [] }, action: 'synchronize' },
        repo: { owner: 'o', repo: 'r' },
      },
    }));

    await import('./index');
    await flushRun();

    expect(llmCreate).not.toHaveBeenCalled();
    expect(mockDeleteComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: staleComment.id })
    );
  });

  it('does not skip when diff meets min_diff_lines threshold', async () => {
    const llmCreate = makeLLMCreate('passes threshold');
    const mockCreateComment = vi.fn().mockResolvedValue({});
    const files = [{ filename: 'src/index.ts', status: 'modified', additions: 10, deletions: 2 }];
    const octokit = makeOctokit({ createComment: mockCreateComment, files });

    vi.doMock('openai', () => makeOpenAIMock({ llmCreate }));
    vi.doMock('@actions/core', () => makeCoreMock({ min_diff_lines: '5' }));
    vi.doMock('@actions/github', () => ({
      getOctokit: vi.fn().mockReturnValue(octokit),
      context: {
        payload: { pull_request: { number: 1, title: 'T', labels: [] }, action: 'opened' },
        repo: { owner: 'o', repo: 'r' },
      },
    }));

    await import('./index');
    await flushRun();

    expect(llmCreate).toHaveBeenCalled();
  });

  it('uses mic drop mode and trims output to 2 lines', async () => {
    const llmCreate = makeLLMCreate('first line\nsecond line\nthird line should be cut');
    const mockCreateComment = vi.fn().mockResolvedValue({});
    const files = [{ filename: 'src/index.ts', status: 'modified', additions: 3, deletions: 1 }];
    const octokit = makeOctokit({ createComment: mockCreateComment, files });

    vi.doMock('openai', () => makeOpenAIMock({ llmCreate }));
    vi.doMock('@actions/core', () => makeCoreMock({ mic_drop_threshold: '20' }));
    vi.doMock('@actions/github', () => ({
      getOctokit: vi.fn().mockReturnValue(octokit),
      context: {
        payload: { pull_request: { number: 1, title: 'T', labels: [] }, action: 'opened' },
        repo: { owner: 'o', repo: 'r' },
      },
    }));

    await import('./index');
    await flushRun();

    const body: string = mockCreateComment.mock.calls[0][0].body;
    const contentLines = body
      .split('\n')
      .filter((l: string) => l && !l.startsWith('<!--') && !l.startsWith('🎤') && !l.startsWith('---') && !l.startsWith('*'));
    expect(contentLines.length).toBeLessThanOrEqual(2);
    expect(body).toContain('first line');
    expect(body).toContain('second line');
    expect(body).not.toContain('third line should be cut');
  });

  it('haiku format skips mic drop and generates a full haiku', async () => {
    // Haiku is already minimal — mic drop mode is bypassed entirely for haiku format.
    // The LLM returns a proper 3-line haiku; no 2-line truncation should occur.
    const llmCreate = makeLLMCreate('code lands on the branch\nlines shift and the diff grows small\nhaiku endures all');
    const mockCreateComment = vi.fn().mockResolvedValue({});
    const files = [{ filename: 'src/index.ts', status: 'modified', additions: 2, deletions: 1 }];
    const octokit = makeOctokit({ createComment: mockCreateComment, files });

    vi.doMock('openai', () => makeOpenAIMock({ llmCreate }));
    vi.doMock('@actions/core', () => makeCoreMock({ format: 'haiku', mic_drop_threshold: '20' }));
    vi.doMock('@actions/github', () => ({
      getOctokit: vi.fn().mockReturnValue(octokit),
      context: {
        payload: { pull_request: { number: 1, title: 'T', labels: [] }, action: 'opened' },
        repo: { owner: 'o', repo: 'r' },
      },
    }));

    await import('./index');
    await flushRun();

    const body: string = mockCreateComment.mock.calls[0][0].body;
    // All 3 haiku lines must be present — mic drop truncation did NOT fire
    expect(body).toContain('code lands on the branch');
    expect(body).toContain('lines shift and the diff grows small');
    expect(body).toContain('haiku endures all');

    // Verify the LLM call included a system message (haiku uses system/user split)
    const callArgs = llmCreate.mock.calls[0][0];
    expect(callArgs.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
      ])
    );
  });

  it.each([
    ['roast me', 'space variant'],
    ['roastme', 'no separator'],
    ['ROAST-ME', 'uppercase'],
    ['Roast_Me', 'underscore variant'],
  ])('triggers roast mode for label "%s" (%s)', async (labelName) => {
    const mockCreateComment = vi.fn().mockResolvedValue({});
    const octokit = makeOctokit({ createComment: mockCreateComment });

    vi.doMock('openai', () => makeOpenAIMock({ llmCreate: makeLLMCreate('roast content here') }));
    vi.doMock('@actions/core', () => makeCoreMock({ roast_label: 'roast-me' }));
    vi.doMock('@actions/github', () => ({
      getOctokit: vi.fn().mockReturnValue(octokit),
      context: {
        payload: {
          pull_request: { number: 1, title: 'T', labels: [{ name: labelName }] },
          action: 'opened',
        },
        repo: { owner: 'o', repo: 'r' },
      },
    }));

    await import('./index');
    await flushRun();

    expect(mockCreateComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('🔥 **Code Roast**') }),
    );
  });

  it('uses Anthropic provider and baseURL when anthropic_api_key is provided', async () => {
    let capturedOptions: ConstructorParameters<typeof import('openai').default>[0] | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function MockOpenAI(this: any, options: ConstructorParameters<typeof import('openai').default>[0]) {
      capturedOptions = options;
      this.chat = { completions: { create: makeLLMCreate('anthropic bars') } };
      this.moderations = { create: vi.fn() };
    }

    const mockCreateComment = vi.fn().mockResolvedValue({});
    const octokit = makeOctokit({ createComment: mockCreateComment });

    vi.doMock('openai', () => ({ default: MockOpenAI }));
    vi.doMock('@actions/core', () => makeCoreMock({ openai_api_key: '', anthropic_api_key: 'ant-key-123' }));
    vi.doMock('@actions/github', () => ({
      getOctokit: vi.fn().mockReturnValue(octokit),
      context: {
        payload: { pull_request: { number: 1, title: 'T', labels: [] }, action: 'opened' },
        repo: { owner: 'o', repo: 'r' },
      },
    }));

    await import('./index');
    await flushRun();

    expect(capturedOptions?.apiKey).toBe('ant-key-123');
    expect(capturedOptions?.baseURL).toBe('https://api.anthropic.com/v1');
    expect(mockCreateComment).toHaveBeenCalled();
  });

  it('skips moderation and logs a warning when provider is not openai', async () => {
    const moderationsCreate = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function MockOpenAI(this: any) {
      this.chat = { completions: { create: makeLLMCreate('groq bars') } };
      this.moderations = { create: moderationsCreate };
    }

    const mockCreateComment = vi.fn().mockResolvedValue({});
    const octokit = makeOctokit({ createComment: mockCreateComment });

    vi.doMock('openai', () => ({ default: MockOpenAI }));
    vi.doMock('@actions/core', () => makeCoreMock({ openai_api_key: '', groq_api_key: 'groq-key', enable_moderation: 'true' }));
    vi.doMock('@actions/github', () => ({
      getOctokit: vi.fn().mockReturnValue(octokit),
      context: {
        payload: { pull_request: { number: 1, title: 'T', labels: [] }, action: 'opened' },
        repo: { owner: 'o', repo: 'r' },
      },
    }));

    await import('./index');
    await flushRun();

    expect(moderationsCreate).not.toHaveBeenCalled();
    expect(mockCreateComment).toHaveBeenCalled();
    const { warning } = await import('@actions/core');
    expect(vi.mocked(warning)).toHaveBeenCalledWith(expect.stringContaining('enable_moderation'));
  });

  it('calls setFailed with the error message when run() throws', async () => {
    const llmCreate = vi.fn().mockRejectedValue(new Error('API exploded'));
    const octokit = makeOctokit();

    vi.doMock('openai', () => makeOpenAIMock({ llmCreate }));
    vi.doMock('@actions/core', () => makeCoreMock());
    vi.doMock('@actions/github', () => ({
      getOctokit: vi.fn().mockReturnValue(octokit),
      context: {
        payload: { pull_request: { number: 1, title: 'T', labels: [] }, action: 'opened' },
        repo: { owner: 'o', repo: 'r' },
      },
    }));

    await import('./index');
    await flushRun();

    const { setFailed } = await import('@actions/core');
    expect(vi.mocked(setFailed)).toHaveBeenCalledWith('API exploded');
  });

  it('retries once when rap output is generic and does not reference any files', async () => {
    // First call returns generic output, second call returns specific output
    const llmCreate = vi.fn()
      .mockResolvedValueOnce({ choices: [{ finish_reason: 'stop', message: { content: 'code was changed\nlines were shifted around' } }] })
      .mockResolvedValueOnce({ choices: [{ finish_reason: 'stop', message: { content: 'auth_handler got a rewrite\nnow the login flow is tight' } }] });

    const mockCreateComment = vi.fn().mockResolvedValue({});
    const files = [{ filename: 'src/auth_handler.ts', status: 'modified', additions: 10, deletions: 2 }];
    const octokit = makeOctokit({ createComment: mockCreateComment, files });

    vi.doMock('openai', () => makeOpenAIMock({ llmCreate }));
    vi.doMock('@actions/core', () => makeCoreMock({ format: 'rap' }));
    vi.doMock('@actions/github', () => ({
      getOctokit: vi.fn().mockReturnValue(octokit),
      context: {
        payload: { pull_request: { number: 1, title: 'T', labels: [] }, action: 'opened' },
        repo: { owner: 'o', repo: 'r' },
      },
    }));

    await import('./index');
    await flushRun();

    // Should have called LLM twice: initial + specificity retry
    expect(llmCreate).toHaveBeenCalledTimes(2);

    // Final output should reference the specific file
    const { setOutput } = await import('@actions/core');
    expect(vi.mocked(setOutput)).toHaveBeenCalledWith('content', expect.stringContaining('auth_handler'));

    // Should have logged the generic retry message
    const { info } = await import('@actions/core');
    expect(vi.mocked(info)).toHaveBeenCalledWith(expect.stringContaining('generic'));
  });

  it('does not trigger specificity retry for haiku format', async () => {
    // Generic haiku output (3 valid lines, no file references)
    const llmCreate = vi.fn().mockResolvedValue({
      choices: [{ finish_reason: 'stop', message: { content: 'code flows through the void\nchanges come and go each day\nmerged at last today' } }],
    });

    const mockCreateComment = vi.fn().mockResolvedValue({});
    const files = [{ filename: 'src/auth_handler.ts', status: 'modified', additions: 10, deletions: 2 }];
    const octokit = makeOctokit({ createComment: mockCreateComment, files });

    vi.doMock('openai', () => makeOpenAIMock({ llmCreate }));
    vi.doMock('@actions/core', () => makeCoreMock({ format: 'haiku' }));
    vi.doMock('@actions/github', () => ({
      getOctokit: vi.fn().mockReturnValue(octokit),
      context: {
        payload: { pull_request: { number: 1, title: 'T', labels: [] }, action: 'opened' },
        repo: { owner: 'o', repo: 'r' },
      },
    }));

    await import('./index');
    await flushRun();

    // Haiku with valid structure and meter — no retries at all
    expect(llmCreate).toHaveBeenCalledTimes(1);
    expect(mockCreateComment).toHaveBeenCalled();
  });
});

// ─── resolveProvider() unit tests ────────────────────────────────────────────

describe('resolveProvider()', () => {
  // resolveProvider reads from @actions/core, which we swap per test.
  // We reset modules so each test gets a fresh import.
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.resetModules());

  async function getResolveProvider(inputs: Record<string, string>) {
    vi.doMock('@actions/core', () => ({
      getInput: vi.fn((name: string) => inputs[name] ?? ''),
      warning: vi.fn(),
      info: vi.fn(),
      setFailed: vi.fn(),
      setOutput: vi.fn(),
    }));
    const { resolveProvider } = await import('./index');
    return resolveProvider;
  }

  it.each([
    ['openai',      'openai_api_key',      undefined,                                              'gpt-4.1-mini'],
    ['anthropic',   'anthropic_api_key',   'https://api.anthropic.com/v1',                         'claude-haiku-4-5-20251001'],
    ['google',      'google_api_key',      'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.0-flash'],
    ['openrouter',  'openrouter_api_key',  'https://openrouter.ai/api/v1',                         'openai/gpt-4.1-mini'],
    ['huggingface', 'huggingface_api_key', 'https://api-inference.huggingface.co/v1',              'Qwen/Qwen2.5-Coder-32B-Instruct'],
    ['groq',        'groq_api_key',        'https://api.groq.com/openai/v1',                       'llama-3.3-70b-versatile'],
    ['mistral',     'mistral_api_key',     'https://api.mistral.ai/v1',                            'mistral-small-latest'],
    ['together',    'together_api_key',    'https://api.together.xyz/v1',                          'meta-llama/Llama-3.3-70B-Instruct-Turbo'],
  ] as Array<[Provider, string, string | undefined, string]>)(
    'resolves provider "%s" from input "%s"',
    async (provider, inputName, expectedBaseURL, expectedModel) => {
      const resolve = await getResolveProvider({ [inputName]: 'test-key' });
      const result = resolve();
      expect(result.provider).toBe(provider);
      expect(result.apiKey).toBe('test-key');
      expect(result.baseURL).toBe(expectedBaseURL);
      expect(result.defaultModel).toBe(expectedModel);
    }
  );

  it('throws when no API key is provided', async () => {
    const resolve = await getResolveProvider({});
    expect(() => resolve()).toThrow('No API key provided');
  });

  it('throws when multiple API keys are provided', async () => {
    const resolve = await getResolveProvider({ openai_api_key: 'sk-1', groq_api_key: 'gr-2' });
    expect(() => resolve()).toThrow('Multiple API keys provided');
  });
});
