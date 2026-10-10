import { describe, it, expect } from 'vitest';
import { SocialGraphAnalyzer } from '../src/lib/github/analyzer';
import {
  GitHubUser,
  GitHubFollower,
  GitHubRepository,
  GitHubContributor,
} from '../src/lib/github/types';

// ── 测试数据 ─────────────────────────────────────────────

function makeUser(login: string, extra: Partial<GitHubUser> = {}): GitHubUser {
  return {
    login,
    id: 1,
    avatar_url: `https://avatars.githubusercontent.com/${login}`,
    html_url: `https://github.com/${login}`,
    name: login,
    company: null,
    blog: null,
    location: null,
    email: null,
    bio: null,
    public_repos: 0,
    public_gists: 0,
    followers: 0,
    following: 0,
    created_at: '',
    updated_at: '',
    ...extra,
  };
}

function makeFollower(login: string): GitHubFollower {
  return {
    login,
    id: 1,
    avatar_url: `https://avatars.githubusercontent.com/${login}`,
    html_url: `https://github.com/${login}`,
  };
}

function makeRepo(fullName: string, stargazers = 10, fork = false): GitHubRepository {
  const [owner, name] = fullName.split('/');
  return {
    id: 1,
    name,
    full_name: fullName,
    owner: makeUser(owner),
    private: false,
    html_url: `https://github.com/${fullName}`,
    description: null,
    fork,
    created_at: '',
    updated_at: '',
    pushed_at: '',
    stargazers_count: stargazers,
    watchers_count: stargazers,
    language: 'TypeScript',
    forks_count: 0,
    open_issues_count: 0,
    topics: [],
    visibility: 'public',
  };
}

function makeContributor(
  login: string,
  contributions: number,
  type?: string
): GitHubContributor {
  return {
    login,
    id: 1,
    avatar_url: `https://avatars.githubusercontent.com/${login}`,
    html_url: `https://github.com/${login}`,
    contributions,
    ...(type ? { type } : {}),
  };
}

// ── Mock GitHubAPIService ───────────────────────────────

class MockGitHubAPI {
  user: GitHubUser;
  followers: GitHubFollower[];
  following: GitHubFollower[];
  repos: GitHubRepository[];
  contributorsByRepo: Record<string, GitHubContributor[]>;

  constructor(opts: {
    user: GitHubUser;
    followers?: GitHubFollower[];
    following?: GitHubFollower[];
    repos?: GitHubRepository[];
    contributorsByRepo?: Record<string, GitHubContributor[]>;
  }) {
    this.user = opts.user;
    this.followers = opts.followers ?? [];
    this.following = opts.following ?? [];
    this.repos = opts.repos ?? [];
    this.contributorsByRepo = opts.contributorsByRepo ?? {};
  }

  async getUser(): Promise<GitHubUser> {
    return this.user;
  }

  async getAllFollowers(): Promise<GitHubFollower[]> {
    return this.followers;
  }

  async getAllFollowing(): Promise<GitHubFollower[]> {
    return this.following;
  }

  async getAllRepositories(): Promise<GitHubRepository[]> {
    return this.repos;
  }

  async getContributors(owner: string, repo: string): Promise<GitHubContributor[]> {
    const full = `${owner}/${repo}`;
    return this.contributorsByRepo[full] ?? [];
  }

  async getStargazers(): Promise<Array<{ user: GitHubUser; starred_at: string }>> {
    return [];
  }

  getRateLimit() {
    return { limit: 5000, remaining: 5000, reset: new Date() };
  }
}

function createAnalyzer(mock: MockGitHubAPI): SocialGraphAnalyzer {
  // SocialGraphAnalyzer 接受一个 api 参数，这里用 mock 注入
  return new SocialGraphAnalyzer(mock as never);
}

// ── 测试用例 ─────────────────────────────────────────────

describe('SocialGraphAnalyzer', () => {
  const mainUser = makeUser('alice');

  describe('互相关注识别 (findMutualFollowers)', () => {
    it('应正确识别同时存在于关注者与被关注列表中的用户', async () => {
      const mock = new MockGitHubAPI({
        user: mainUser,
        followers: [makeFollower('bob'), makeFollower('carol'), makeFollower('dave')],
        following: [makeFollower('bob'), makeFollower('eve'), makeFollower('carol')],
      });

      const analyzer = createAnalyzer(mock);
      const result = await analyzer.analyzeUser('alice', { maxFollowers: 50, maxRepos: 0 });

      // 互相关注：bob, carol（dave 只是关注者，eve 只是被关注者）
      // 在图中以粉色 #f687b3 区分互相关注用户
      const pinkNodes = result.graph.nodes.filter((n) => n.color === '#f687b3');
      const pinkLogins = pinkNodes.map((n) => n.id).sort();

      expect(pinkLogins).toEqual(['bob', 'carol']);
    });

    it('无互相关注时返回空', async () => {
      const mock = new MockGitHubAPI({
        user: mainUser,
        followers: [makeFollower('bob')],
        following: [makeFollower('eve')],
      });

      const analyzer = createAnalyzer(mock);
      const result = await analyzer.analyzeUser('alice', { maxFollowers: 50, maxRepos: 0 });

      const pinkNodes = result.graph.nodes.filter((n) => n.color === '#f687b3');
      expect(pinkNodes).toHaveLength(0);
    });
  });

  describe('图构建统计 (buildGraph)', () => {
    it('应正确统计节点数与连接数', async () => {
      const mock = new MockGitHubAPI({
        user: mainUser,
        followers: [makeFollower('bob'), makeFollower('carol')],
        following: [makeFollower('carol')],
        repos: [makeRepo('alice/repo-a', 100)],
      });

      const analyzer = createAnalyzer(mock);
      const result = await analyzer.analyzeUser('alice', { maxFollowers: 50, maxRepos: 15 });

      // 主用户 1 + 关注者 2 + 被关注 1(carol 已存在) + 仓库 1 = 4 节点
      expect(result.graph.stats.totalNodes).toBe(4);
      expect(result.graph.stats.userNodes).toBe(3);
      expect(result.graph.stats.repoNodes).toBe(1);
      // 主->bob, 主->carol(follower), 主->carol(following), 主->repo = 4 条连接
      expect(result.graph.stats.totalLinks).toBe(4);
    });
  });

  describe('推荐打分排序 (generateRecommendations)', () => {
    it('应排除主用户和已关注用户，并按贡献分数降序排序', async () => {
      const mock = new MockGitHubAPI({
        user: mainUser,
        // 已关注：bob
        following: [makeFollower('bob')],
        repos: [makeRepo('alice/repo-a', 10), makeRepo('alice/repo-b', 10)],
        contributorsByRepo: {
          'alice/repo-a': [
            makeContributor('bob', 5), // 已关注，应排除
            makeContributor('carol', 10),
            makeContributor('dave', 3),
          ],
          'alice/repo-b': [
            makeContributor('alice', 99), // 主用户，应排除
            makeContributor('carol', 7),
            makeContributor('eve', 2),
          ],
        },
      });

      const analyzer = createAnalyzer(mock);
      const result = await analyzer.analyzeUser('alice', { maxFollowers: 50, maxRepos: 15 });

      const recLogins = result.recommendations.map((r) => r.user.login);
      // carol 总分 17 最高，dave 3 次，eve 2 次；bob 与 alice 被排除
      expect(recLogins).toEqual(['carol', 'dave', 'eve']);

      // 验证分数
      const carol = result.recommendations.find((r) => r.user.login === 'carol');
      expect(carol?.score).toBe(17);
      expect(carol?.reasons.length).toBeGreaterThan(0);
    });
  });

  describe('机器人账号过滤 (isBotAccount)', () => {
    it('机器人不进入图谱节点、推荐与顶级协作者榜单', async () => {
      const mock = new MockGitHubAPI({
        user: mainUser,
        repos: [makeRepo('alice/repo-a', 10)],
        contributorsByRepo: {
          'alice/repo-a': [
            makeContributor('alice', 99), // 主用户
            makeContributor('github-actions[bot]', 12, 'Bot'), // type 标识
            makeContributor('dependabot[bot]', 5), // 缺 type，靠 [bot] 后缀兜底
            makeContributor('carol', 7), // 唯一真人
          ],
        },
      });

      const analyzer = createAnalyzer(mock);
      const result = await analyzer.analyzeUser('alice', { maxFollowers: 50, maxRepos: 15 });

      const userNodes = result.graph.nodes
        .filter((n) => n.type === 'user')
        .map((n) => n.id);
      expect(userNodes).not.toContain('github-actions[bot]');
      expect(userNodes).not.toContain('dependabot[bot]');
      expect(userNodes).toContain('carol');

      const recLogins = result.recommendations.map((r) => r.user.login);
      expect(recLogins).toEqual(['carol']); // 两个 bot 全被剔除，不是占据榜首

      const topLogins = result.insights.topCollaborators.map((c) => c.user.login);
      expect(topLogins).not.toContain('github-actions[bot]');
      expect(topLogins).not.toContain('dependabot[bot]');
    });

    it('顶级协作者榜单排除主用户自己', async () => {
      const mock = new MockGitHubAPI({
        user: mainUser,
        repos: [makeRepo('alice/repo-a', 10), makeRepo('alice/repo-b', 10)],
        contributorsByRepo: {
          'alice/repo-a': [
            makeContributor('alice', 400), // 自己，提交最多但不应上榜
            makeContributor('carol', 6),
          ],
          'alice/repo-b': [makeContributor('alice', 57), makeContributor('dave', 3)],
        },
      });

      const analyzer = createAnalyzer(mock);
      const result = await analyzer.analyzeUser('alice', { maxFollowers: 50, maxRepos: 15 });

      const topLogins = result.insights.topCollaborators.map((c) => c.user.login);
      expect(topLogins).not.toContain('alice');
      expect(topLogins).toEqual(['carol', 'dave']);
    });
  });
});
