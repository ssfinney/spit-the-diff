import { describe, it, expect, vi, beforeEach } from 'vitest';

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
});
