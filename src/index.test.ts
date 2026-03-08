import { describe, it, expect, vi, beforeEach } from 'vitest';

function makeCoreMock(inputs: Record<string, string> = {}) {
  return {
    getInput: vi.fn((name: string) => inputs[name] ?? ''),
    setFailed: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    setOutput: vi.fn(),
  };
}

function makeOctokitMock(overrides: Partial<any> = {}) {
  const octokit = {
    rest: {
      pulls: {
        get: vi.fn().mockResolvedValue({ data: { title: 'PR title', body: 'PR body' } }),
        listFiles: vi.fn(),
      },
      issues: {
        listComments: vi.fn(),
        createComment: vi.fn().mockResolvedValue({}),
        updateComment: vi.fn().mockResolvedValue({}),
      },
    },
    paginate: vi.fn(async (endpoint: unknown) => {
      if (endpoint === octokit.rest.pulls.listFiles) {
        return [];
      }
      if (endpoint === octokit.rest.issues.listComments) {
        return [];
      }
      return [];
    }),
    ...overrides,
  };

  return octokit;
}

function makeOpenAIClass(args: {
  completionCreate?: ReturnType<typeof vi.fn>;
  moderationCreate?: ReturnType<typeof vi.fn>;
}) {
  const completionCreate =
    args.completionCreate ??
    vi.fn().mockResolvedValue({ choices: [{ finish_reason: 'stop', message: { content: 'line one\nline two' } }] });
  const moderationCreate = args.moderationCreate ?? vi.fn().mockResolvedValue({ results: [{ flagged: false }] });

  return {
    default: vi.fn(function OpenAI(this: unknown) {
      return {
        chat: { completions: { create: completionCreate } },
        moderations: { create: moderationCreate },
      };
    }),
  };
}

async function loadIndexModule() {
  await import('./index');
}

describe('index run flow', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.GITHUB_TOKEN;
  });

  it('fails fast when openai_api_key input is missing', async () => {
    const coreMock = makeCoreMock({ github_token: 'gh-token' });

    vi.doMock('@actions/core', () => coreMock);
    vi.doMock('@actions/github', () => ({
      context: { payload: {}, repo: { owner: 'o', repo: 'r' } },
      getOctokit: vi.fn(),
    }));
    vi.doMock('openai', () => ({
      default: vi.fn(function OpenAI(this: unknown) {
        return {};
      }),
    }));

    await loadIndexModule();

    expect(coreMock.setFailed).toHaveBeenCalledWith('openai_api_key input is required');
  });

  it('fails fast when github token is missing from input and env', async () => {
    const coreMock = makeCoreMock({ openai_api_key: 'sk-test' });

    vi.doMock('@actions/core', () => coreMock);
    vi.doMock('@actions/github', () => ({
      context: { payload: {}, repo: { owner: 'o', repo: 'r' } },
      getOctokit: vi.fn(),
    }));
    vi.doMock('openai', () => ({
      default: vi.fn(function OpenAI(this: unknown) {
        return {};
      }),
    }));

    await loadIndexModule();

    expect(coreMock.setFailed).toHaveBeenCalledWith('github_token is required (or GITHUB_TOKEN env var)');
  });

  it('fails when event is not a pull_request event', async () => {
    const coreMock = makeCoreMock({ openai_api_key: 'sk-test', github_token: 'gh-token' });

    vi.doMock('@actions/core', () => coreMock);
    vi.doMock('@actions/github', () => ({
      context: { payload: {}, repo: { owner: 'o', repo: 'r' } },
      getOctokit: vi.fn(),
    }));
    vi.doMock('openai', () => makeOpenAIClass({}));

    await loadIndexModule();

    expect(coreMock.setFailed).toHaveBeenCalledWith('This action only runs on pull_request events');
  });

  it('skips labeled event when non-roast label is applied', async () => {
    const coreMock = makeCoreMock({
      format: 'rap',
      openai_api_key: 'sk-test',
      github_token: 'gh-token',
      roast_label: 'roast-me',
    });
    const octokit = makeOctokitMock();

    vi.doMock('@actions/core', () => coreMock);
    vi.doMock('@actions/github', () => ({
      context: {
        payload: {
          action: 'labeled',
          label: { name: 'docs' },
          pull_request: { number: 7, title: 'Title', labels: [] },
        },
        repo: { owner: 'o', repo: 'r' },
      },
      getOctokit: vi.fn(() => octokit),
    }));
    vi.doMock('openai', () => makeOpenAIClass({}));

    await loadIndexModule();

    await vi.waitFor(() => {
      expect(octokit.rest.pulls.get).not.toHaveBeenCalled();
      expect(coreMock.info).toHaveBeenCalledWith(expect.stringContaining('does not match roast label'));
    });
  });

  it('switches to roast mode when roast label is present and updates existing comment', async () => {
    const coreMock = makeCoreMock({
      format: 'rap',
      model: 'gpt-4.1-mini',
      openai_api_key: 'sk-test',
      github_token: 'gh-token',
      roast_label: 'roast-me',
    });

    const octokit = makeOctokitMock({
      paginate: vi.fn(async (endpoint: unknown) => {
        if (endpoint === octokit.rest.pulls.listFiles) {
          return [{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@\n-a\n+b' }];
        }
        if (endpoint === octokit.rest.issues.listComments) {
          return [{ id: 42, body: '<!-- spit-the-diff:hash=abc123 -->' }];
        }
        return [];
      }),
    });

    vi.doMock('@actions/core', () => coreMock);
    vi.doMock('@actions/github', () => ({
      context: {
        payload: {
          action: 'opened',
          pull_request: { number: 99, title: 'Title', labels: [{ name: 'roast-me' }] },
        },
        repo: { owner: 'o', repo: 'r' },
      },
      getOctokit: vi.fn(() => octokit),
    }));
    vi.doMock('openai', () => makeOpenAIClass({}));

    await loadIndexModule();

    await vi.waitFor(() => {
      expect(coreMock.info).toHaveBeenCalledWith('roast-me label detected — switching to roast mode');
      expect(octokit.rest.issues.updateComment).toHaveBeenCalledTimes(1);
      expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
      expect(coreMock.setOutput).toHaveBeenCalledWith('content', expect.any(String));
    });
  });

  it('skips LLM call on synchronize when input hash is unchanged', async () => {
    const coreMock = makeCoreMock({
      format: 'rap',
      model: 'gpt-4.1-mini',
      openai_api_key: 'sk-test',
      github_token: 'gh-token',
    });

    const octokit = makeOctokitMock({
      paginate: vi.fn(async (endpoint: unknown) => {
        if (endpoint === octokit.rest.pulls.listFiles) {
          return [];
        }
        if (endpoint === octokit.rest.issues.listComments) {
          return [{ id: 42, body: '<!-- spit-the-diff:hash=abc123 -->' }];
        }
        return [];
      }),
    });

    const createMock = vi.fn();

    vi.doMock('@actions/core', () => coreMock);
    vi.doMock('@actions/github', () => ({
      context: {
        payload: {
          action: 'synchronize',
          pull_request: { number: 5, title: 'Title', labels: [] },
        },
        repo: { owner: 'o', repo: 'r' },
      },
      getOctokit: vi.fn(() => octokit),
    }));
    vi.doMock('openai', () => ({
      default: vi.fn(function OpenAI(this: unknown) {
        return {
          chat: { completions: { create: createMock } },
          moderations: { create: vi.fn() },
        };
      }),
    }));
    vi.doMock('./lib', async importOriginal => {
      const actual = await importOriginal<typeof import('./lib')>();
      return {
        ...actual,
        buildInputHash: vi.fn(() => 'abc123'),
      };
    });

    await loadIndexModule();

    await vi.waitFor(() => {
      expect(createMock).not.toHaveBeenCalled();
      expect(coreMock.info).toHaveBeenCalledWith(
        'Input hash unchanged on synchronize event. Skipping LLM call and comment update.'
      );
    });
  });

  it('uses moderation fallback when two attempts are flagged', async () => {
    const coreMock = makeCoreMock({
      format: 'rap',
      model: 'gpt-4.1-mini',
      openai_api_key: 'sk-test',
      github_token: 'gh-token',
    });
    const octokit = makeOctokitMock();

    const completionCreate = vi.fn().mockResolvedValue({
      choices: [{ finish_reason: 'stop', message: { content: 'line one\nline two' } }],
    });

    const moderationCreate = vi
      .fn()
      .mockResolvedValueOnce({ results: [{ flagged: true }] })
      .mockResolvedValueOnce({ results: [{ flagged: true }] });

    vi.doMock('@actions/core', () => coreMock);
    vi.doMock('@actions/github', () => ({
      context: {
        payload: {
          action: 'opened',
          pull_request: { number: 11, title: 'Title', labels: [] },
        },
        repo: { owner: 'o', repo: 'r' },
      },
      getOctokit: vi.fn(() => octokit),
    }));
    vi.doMock('openai', () => makeOpenAIClass({ completionCreate, moderationCreate }));

    await loadIndexModule();

    await vi.waitFor(() => {
      expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      const bodyArg = octokit.rest.issues.createComment.mock.calls[0][0].body as string;
      expect(bodyArg).toContain('did not pass moderation');
      expect(coreMock.warning).toHaveBeenCalledWith(
        'Second attempt also flagged by moderation. Using fallback message.'
      );
    });
  });

  it('uses retry text when first moderation is flagged but second passes', async () => {
    const coreMock = makeCoreMock({
      format: 'rap',
      model: 'gpt-4.1-mini',
      openai_api_key: 'sk-test',
      github_token: 'gh-token',
    });
    const octokit = makeOctokitMock();

    const completionCreate = vi
      .fn()
      .mockResolvedValueOnce({ choices: [{ finish_reason: 'stop', message: { content: 'first output' } }] })
      .mockResolvedValueOnce({ choices: [{ finish_reason: 'stop', message: { content: 'second output' } }] });

    const moderationCreate = vi
      .fn()
      .mockResolvedValueOnce({ results: [{ flagged: true }] })
      .mockResolvedValueOnce({ results: [{ flagged: false }] });

    vi.doMock('@actions/core', () => coreMock);
    vi.doMock('@actions/github', () => ({
      context: {
        payload: {
          action: 'opened',
          pull_request: { number: 12, title: 'Title', labels: [] },
        },
        repo: { owner: 'o', repo: 'r' },
      },
      getOctokit: vi.fn(() => octokit),
    }));
    vi.doMock('openai', () => makeOpenAIClass({ completionCreate, moderationCreate }));

    await loadIndexModule();

    await vi.waitFor(() => {
      expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
      const bodyArg = octokit.rest.issues.createComment.mock.calls[0][0].body as string;
      expect(bodyArg).toContain('second output');
      expect(bodyArg).not.toContain('did not pass moderation');
    });
  });

  it('reports failure when LLM returns empty content', async () => {
    const coreMock = makeCoreMock({
      format: 'rap',
      model: 'gpt-4.1-mini',
      openai_api_key: 'sk-test',
      github_token: 'gh-token',
    });
    const octokit = makeOctokitMock();

    const completionCreate = vi.fn().mockResolvedValue({
      choices: [{ finish_reason: 'stop', message: { content: '   ' } }],
    });

    vi.doMock('@actions/core', () => coreMock);
    vi.doMock('@actions/github', () => ({
      context: {
        payload: {
          action: 'opened',
          pull_request: { number: 13, title: 'Title', labels: [] },
        },
        repo: { owner: 'o', repo: 'r' },
      },
      getOctokit: vi.fn(() => octokit),
    }));
    vi.doMock('openai', () => makeOpenAIClass({ completionCreate }));

    await loadIndexModule();

    await vi.waitFor(() => {
      expect(coreMock.setFailed).toHaveBeenCalledWith('LLM returned an empty response');
    });
  });
});
