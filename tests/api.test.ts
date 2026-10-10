import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubAPIService } from '../src/lib/github/api';
import { GitHubUser } from '../src/lib/github/types';

const RATE_LIMIT_HEADERS = {
  'X-RateLimit-Limit': '5000',
  'X-RateLimit-Remaining': '4999',
  'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3600),
};

function stubFetchJson(body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: RATE_LIMIT_HEADERS,
    })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GitHubAPIService', () => {
  it('普通接口使用默认 v3 Accept 头', async () => {
    const fetchMock = stubFetchJson({ login: 'alice' });
    const api = new GitHubAPIService('test-token');

    await api.getUser('alice');

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Accept).toBe(
      'application/vnd.github.v3+json'
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer test-token'
    );
  });

  it('stargazers 使用 v3.star 媒体类型并按 {user, starred_at} 解析', async () => {
    const starPayload = [
      {
        starred_at: '2026-01-01T00:00:00Z',
        user: { login: 'bob' } as GitHubUser,
      },
    ];
    const fetchMock = stubFetchJson(starPayload);
    const api = new GitHubAPIService('test-token');

    const stars = await api.getStargazers('alice', 'repo-a');

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Accept).toBe(
      'application/vnd.github.v3.star+json'
    );
    // 修复前默认 Accept 下返回纯用户数组，这里会是 undefined
    expect(stars).toHaveLength(1);
    expect(stars[0].user.login).toBe('bob');
    expect(stars[0].starred_at).toBe('2026-01-01T00:00:00Z');
  });

  it('无 token 时不发送 Authorization 头', async () => {
    const fetchMock = stubFetchJson([]);
    const api = new GitHubAPIService();

    await api.getFollowers('alice');

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers as Record<string, string>).not.toHaveProperty(
      'Authorization'
    );
  });
});
