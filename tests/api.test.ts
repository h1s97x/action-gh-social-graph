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

  it('star 媒体类型被 403 拒绝时回退默认 Accept，返回纯用户数组映射', async () => {
    // 第 1 次：star+json 被集成令牌拒绝（Actions 默认 GITHUB_TOKEN 的真实行为）
    // 第 2 次：默认媒体类型返回纯用户数组
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), {
          status: 403,
          headers: RATE_LIMIT_HEADERS,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ login: 'bob' }, { login: 'carol' }]), {
          status: 200,
          headers: RATE_LIMIT_HEADERS,
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const api = new GitHubAPIService('test-token');

    const stars = await api.getStargazers('alice', 'repo-a');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init1] = fetchMock.mock.calls[0];
    expect((init1.headers as Record<string, string>).Accept).toBe(
      'application/vnd.github.v3.star+json'
    );
    const [, init2] = fetchMock.mock.calls[1];
    expect((init2.headers as Record<string, string>).Accept).toBe(
      'application/vnd.github.v3+json'
    );
    expect(stars.map((s) => s.user.login)).toEqual(['bob', 'carol']);
    expect(stars[0].starred_at).toBe(''); // 回退路径无标星时间
  });

  it('带令牌两次均 403 时匿名重试（Actions 集成令牌的真实行为）', async () => {
    const forbidden = () =>
      new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), {
        status: 403,
        headers: RATE_LIMIT_HEADERS,
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(forbidden()) // star + token
      .mockResolvedValueOnce(forbidden()) // 默认 accept + token
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ login: 'bob' }]), {
          status: 200,
          headers: RATE_LIMIT_HEADERS,
        })
      ); // 默认 accept + 匿名
    vi.stubGlobal('fetch', fetchMock);
    const api = new GitHubAPIService('test-token');

    const stars = await api.getStargazers('alice', 'repo-a');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [, init3] = fetchMock.mock.calls[2];
    expect(init3.headers as Record<string, string>).not.toHaveProperty('Authorization');
    expect(stars.map((s) => s.user.login)).toEqual(['bob']);
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
