import * as core from '@actions/core';
import { GitHubAPIService, createGitHubAPI } from './api';
import {
  GitHubUser,
  GitHubRepository,
  SocialGraph,
  GraphNode,
  GraphLink,
  AnalysisResult,
  DeveloperRecommendation,
} from './types';

const NODE_COLORS = {
  mainUser: '#00d4ff',
  collaborator: '#9f7aea',
  follower: '#4299e1',
  repo: '#48bb78',
};

/** 并发池大小限制 */
const CONCURRENCY_LIMIT = 5;

/**
 * 判断是否为机器人账号（github-actions[bot]、dependabot[bot]、renovate[bot] 等）。
 *
 * GitHub contributors 接口会返回 ``type: 'Bot'``；部分历史/边缘响应缺该字段，
 * 但机器人 login 一律以 ``[bot]`` 结尾，作为兜底判断。
 * 机器人不是"社交网络"的一部分：不应进入协作者榜单或推荐关注。
 */
function isBotAccount(account: { type?: string; login: string }): boolean {
  return account.type === 'Bot' || account.login.endsWith('[bot]');
}

export class SocialGraphAnalyzer {
  private api: GitHubAPIService;

  constructor(api?: GitHubAPIService) {
    this.api = api ?? createGitHubAPI();
  }

  async analyzeUser(
    username: string,
    options: { maxFollowers?: number; maxRepos?: number } = {}
  ): Promise<AnalysisResult> {
    const { maxFollowers = 50, maxRepos = 15 } = options;

    const mainUser = await this.api.getUser(username);

    const [followers, following] = await Promise.all([
      this.api.getAllFollowers(username, Math.ceil(maxFollowers / 100)),
      this.api.getAllFollowing(username, Math.ceil(maxFollowers / 100)),
    ]);

    const repos = await this.api.getAllRepositories(username, Math.ceil(maxRepos / 100));
    const mutualFollowers = this.findMutualFollowers(followers, following);
    const repoData = await this.analyzeRepositories(repos, maxRepos);
    const graph = this.buildGraph(mainUser, followers, following, mutualFollowers, repos, repoData);
    const recommendations = this.generateRecommendations(mainUser, following, repoData);
    const insights = this.generateInsights(mainUser, repos, repoData);

    // 收集限流信息用于日志/报告输出
    const rateLimit = this.api.getRateLimit();

    if (rateLimit && rateLimit.remaining !== undefined && rateLimit.limit > 0) {
      const pct = Math.round((rateLimit.remaining / rateLimit.limit) * 100);
      core.info(
        `⏳ GitHub API rate limit: ${rateLimit.remaining}/${rateLimit.limit} remaining (${pct}%), ` +
        `resets at ${rateLimit.reset.toISOString()}`
      );
      if (pct < 20) {
        core.warning(
          `⚠️ Low GitHub API rate limit remaining: ${rateLimit.remaining}/${rateLimit.limit} (${pct}%). ` +
          `Consider using a Personal Access Token with higher quota.`
        );
      }
    }

    return { graph, recommendations, insights, rateLimit };
  }

  private findMutualFollowers(
    followers: Array<{ login: string }>,
    following: Array<{ login: string }>
  ): Set<string> {
    const followerSet = new Set(followers.map((f) => f.login));
    return new Set(following.filter((f) => followerSet.has(f.login)).map((f) => f.login));
  }

  private async analyzeRepositories(repos: GitHubRepository[], maxRepos: number) {
    const contributors = new Map<string, Array<{ login: string; contributions: number }>>();
    const stargazers = new Map<string, string[]>();

    const sorted = repos
      .filter((r) => !r.fork && r.stargazers_count > 0)
      .sort((a, b) => b.stargazers_count - a.stargazers_count)
      .slice(0, maxRepos);

    // 带并发限制的批处理：避免串行 for 循环 + 硬编码 setTimeout
    let index = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY_LIMIT, sorted.length) }, async () => {
      while (index < sorted.length) {
        const repo = sorted[index++];
        try {
          const repoContributors = await this.api.getContributors(repo.owner.login, repo.name);
          contributors.set(
            repo.full_name,
            // 机器人提交（dependabot / github-actions 等）不计入社交关系，
            // 在聚合入口统一过滤 —— 图谱节点、推荐、洞察三处同时受益
            repoContributors
              .filter((c) => !isBotAccount(c))
              .slice(0, 20)
              .map((c) => ({
                login: c.login,
                contributions: c.contributions,
              }))
          );

          try {
            const stargazerList = await this.api.getStargazers(repo.owner.login, repo.name, 1, 50);
            stargazers.set(
              repo.full_name,
              stargazerList.map((s) => s.user.login)
            );
          } catch (stargazerErr) {
            // stargazers 需要认证，若失败输出告警而非静默忽略
            if (stargazerErr instanceof Error) {
              core.warning(
                `⚠️ Failed to fetch stargazers for ${repo.full_name}: ${stargazerErr.message}. ` +
                `Stargazers require authentication. Verify the github-token is valid and has sufficient scope.`
              );
            } else {
              core.warning(
                `⚠️ Failed to fetch stargazers for ${repo.full_name}. Stargazers require authentication.`
              );
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (
            err instanceof Error &&
            'status' in err &&
            (err as unknown as { status?: number }).status === 404
          ) {
            console.error(`Repo ${repo.full_name} not found or no contributors:`, msg);
          } else {
            console.error(`Error analyzing repo ${repo.full_name}:`, msg);
          }
        }
      }
    });

    await Promise.all(workers);

    return { contributors, stargazers };
  }

  private buildGraph(
    mainUser: GitHubUser,
    followers: Array<{ login: string; avatar_url: string; html_url: string }>,
    following: Array<{ login: string; avatar_url: string; html_url: string }>,
    mutualFollowers: Set<string>,
    repos: GitHubRepository[],
    repoData: {
      contributors: Map<string, Array<{ login: string; contributions: number }>>;
      stargazers: Map<string, string[]>;
    }
  ): SocialGraph {
    const nodes: GraphNode[] = [];
    const links: GraphLink[] = [];
    const nodeMap = new Map<string, GraphNode>();

    const mainNode: GraphNode = {
      id: mainUser.login,
      label: mainUser.name ?? mainUser.login,
      type: 'user',
      avatar: mainUser.avatar_url,
      data: mainUser,
      connections: 0,
      color: NODE_COLORS.mainUser,
    };
    nodes.push(mainNode);
    nodeMap.set(mainUser.login, mainNode);

    for (const follower of followers.slice(0, 50)) {
      if (!nodeMap.has(follower.login)) {
        nodes.push({
          id: follower.login,
          label: follower.login,
          type: 'user',
          avatar: follower.avatar_url,
          data: {
            login: follower.login,
            avatar_url: follower.avatar_url,
            html_url: follower.html_url,
          } as GitHubUser,
          connections: 1,
          color: mutualFollowers.has(follower.login) ? '#f687b3' : NODE_COLORS.follower,
        });
        nodeMap.set(follower.login, nodes[nodes.length - 1]);
      }
      links.push({ source: follower.login, target: mainUser.login, type: 'follows', weight: 1 });
      mainNode.connections++;
    }

    for (const followee of following.slice(0, 50)) {
      if (!nodeMap.has(followee.login)) {
        nodes.push({
          id: followee.login,
          label: followee.login,
          type: 'user',
          avatar: followee.avatar_url,
          data: {
            login: followee.login,
            avatar_url: followee.avatar_url,
            html_url: followee.html_url,
          } as GitHubUser,
          connections: 1,
          color: mutualFollowers.has(followee.login) ? '#f687b3' : NODE_COLORS.collaborator,
        });
        nodeMap.set(followee.login, nodes[nodes.length - 1]);
      }
      links.push({ source: mainUser.login, target: followee.login, type: 'follows', weight: 1 });
    }

    for (const repo of repos.slice(0, 10)) {
      const repoNodeId = `repo:${repo.full_name}`;
      const repoNode: GraphNode = {
        id: repoNodeId,
        label: repo.name,
        type: 'repo',
        data: repo,
        connections: 1,
        color: NODE_COLORS.repo,
      };
      nodes.push(repoNode);
      nodeMap.set(repoNodeId, repoNode);
      links.push({
        source: mainUser.login,
        target: repoNodeId,
        type: 'stars',
        weight: repo.stargazers_count / 100 || 1,
      });

      for (const contributor of (repoData.contributors.get(repo.full_name) ?? []).slice(0, 5)) {
        if (contributor.login === mainUser.login) continue;
        if (!nodeMap.has(contributor.login)) {
          nodes.push({
            id: contributor.login,
            label: contributor.login,
            type: 'user',
            data: { login: contributor.login } as GitHubUser,
            connections: 1,
            color: NODE_COLORS.collaborator,
          });
          nodeMap.set(contributor.login, nodes[nodes.length - 1]);
        }
        links.push({
          source: contributor.login,
          target: repoNodeId,
          type: 'collaborates',
          weight: contributor.contributions / 10 || 1,
        });
      }
    }

    return {
      nodes,
      links,
      stats: {
        totalNodes: nodes.length,
        totalLinks: links.length,
        userNodes: nodes.filter((n) => n.type === 'user').length,
        repoNodes: nodes.filter((n) => n.type === 'repo').length,
      },
    };
  }

  private generateRecommendations(
    mainUser: GitHubUser,
    following: Array<{ login: string }>,
    repoData: {
      contributors: Map<string, Array<{ login: string; contributions: number }>>;
      stargazers: Map<string, string[]>;
    }
  ): DeveloperRecommendation[] {
    const followingSet = new Set(following.map((f) => f.login));
    const scoreMap = new Map<string, { score: number; reasons: string[] }>();

    for (const [repo, contributors] of repoData.contributors) {
      for (const contributor of contributors) {
        if (contributor.login === mainUser.login || followingSet.has(contributor.login)) continue;
        const entry = scoreMap.get(contributor.login) ?? { score: 0, reasons: [] };
        entry.score += contributor.contributions;
        entry.reasons.push(`在 ${repo} 中有 ${contributor.contributions} 次贡献`);
        scoreMap.set(contributor.login, entry);
      }
    }

    return Array.from(scoreMap.entries())
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 10)
      .map(([login, data]) => ({
        user: {
          login,
          html_url: `https://github.com/${login}`,
          avatar_url: `https://avatars.githubusercontent.com/${login}`,
        } as GitHubUser,
        score: data.score,
        reasons: data.reasons.slice(0, 3),
      }));
  }

  private generateInsights(
    mainUser: GitHubUser,
    repos: GitHubRepository[],
    repoData: {
      contributors: Map<string, Array<{ login: string; contributions: number }>>;
      stargazers: Map<string, string[]>;
    }
  ): AnalysisResult['insights'] {
    const collaboratorMap = new Map<string, number>();
    for (const contributors of repoData.contributors.values()) {
      for (const c of contributors) {
        // 自己永远是自己仓库的第一贡献者，榜单展示"他人"才有意义
        if (c.login === mainUser.login) continue;
        collaboratorMap.set(c.login, (collaboratorMap.get(c.login) ?? 0) + c.contributions);
      }
    }

    const topCollaborators = Array.from(collaboratorMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([login, collaborations]) => ({
        user: {
          login,
          avatar_url: `https://avatars.githubusercontent.com/${login}`,
          html_url: `https://github.com/${login}`,
        } as GitHubUser,
        collaborations,
      }));

    const topStarredRepos = [...repos]
      .sort((a, b) => b.stargazers_count - a.stargazers_count)
      .slice(0, 5)
      .map((repo) => ({ repo, stargazers: repo.stargazers_count }));

    const languageDistribution: Record<string, number> = {};
    for (const repo of repos) {
      if (repo.language) {
        languageDistribution[repo.language] = (languageDistribution[repo.language] ?? 0) + 1;
      }
    }

    return { topCollaborators, topStarredRepos, languageDistribution };
  }
}

export function createSocialGraphAnalyzer(token?: string): SocialGraphAnalyzer {
  return new SocialGraphAnalyzer(createGitHubAPI(token));
}
