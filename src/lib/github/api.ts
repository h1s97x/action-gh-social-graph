import { GitHubUser, GitHubRepository, GitHubContributor, GitHubFollower } from './types';

const GITHUB_API_BASE = 'https://api.github.com';

const DEFAULT_ACCEPT = 'application/vnd.github.v3+json';
// stargazers 接口默认只返回用户数组；要拿到 { user, starred_at } 结构
// （含标星时间），必须使用 star 媒体类型，否则下游读 item.user 会得到 undefined
const STAR_ACCEPT = 'application/vnd.github.v3.star+json';

export class GitHubAPIError extends Error {
  constructor(
    message: string,
    public status: number,
    public rateLimit?: {
      limit: number;
      remaining: number;
      reset: Date;
    }
  ) {
    super(message);
    this.name = 'GitHubAPIError';
  }
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: Date;
}

// 429 限流：始终可重试；5xx 服务器错误：可重试
// 403 仅在确为限流（remaining === 0）时重试，避免认证/权限错误的无效重试
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 5; // 最大重试次数（不含初始请求）
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

export class GitHubAPIService {
  private token?: string;
  private baseUrl: string;
  private lastRateLimit?: RateLimitInfo;

  constructor(token?: string) {
    this.token = token;
    this.baseUrl = GITHUB_API_BASE;
  }

  /** 获取最近一次 API 调用的限流信息 */
  getRateLimit(): RateLimitInfo | undefined {
    return this.lastRateLimit;
  }

  private async fetchWithRetry<T>(endpoint: string, headers: Record<string, string>): Promise<T> {
    let attempt = 0;

    while (true) {
      attempt++;
      const response = await fetch(`${this.baseUrl}${endpoint}`, { headers });

      const rateLimit = this.parseRateLimit(response);
      this.lastRateLimit = rateLimit;

      // 读取响应体（可能为 JSON 或为空）
      const body = (await response.json().catch(() => ({}))) as { message?: string };

      if (response.ok) {
        return body as T;
      }

      // 检查是否应重试。
      // 403 特殊处理：仅当确为限流（X-RateLimit-Remaining === 0）时才重试，
      // 否则（认证/权限不足等）重试无济于事，直接抛出。
      const isRetryable =
        RETRYABLE_STATUS_CODES.has(response.status) ||
        (response.status === 403 && rateLimit.remaining === 0);
      const retryAfter = response.headers.get('Retry-After');

      // attempt 从 1 开始计初始请求，故仅当已重试次数 < MAX_RETRIES 时继续
      if (isRetryable && attempt <= MAX_RETRIES) {
        const delayMs = this.computeBackoffMs(rateLimit, retryAfter, attempt);

        // 等待时输出日志
        console.warn(
          `[GitHub API] Rate limit / error ${response.status} on ${endpoint}, ` +
          `retrying in ${Math.ceil(delayMs / 1000)}s (attempt ${attempt}/${MAX_RETRIES})`
        );

        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      // 如果重试耗尽或不可重试，抛出错误
      const errorMsg =
        body.message ||
        (isRetryable && attempt > MAX_RETRIES
          ? `GitHub API rate limit exceeded on ${endpoint} after ${MAX_RETRIES} retries`
          : `GitHub API error: ${response.status}`);

      throw new GitHubAPIError(errorMsg, response.status, rateLimit);
    }
  }

  /** 计算下一次重试前的等待时长 */
  private computeBackoffMs(
    rateLimit: RateLimitInfo,
    retryAfter: string | null,
    attempt: number
  ): number {
    // 优先使用 Retry-After 头（秒数）。
    // 若该头为 HTTP-date 或其他非数字格式，parseInt 会得到 NaN，
    // 需校验有效性并回退到其他计算方式，避免 setTimeout(NaN) 引发的快速重试风暴。
    if (retryAfter) {
      const secs = parseInt(retryAfter, 10);
      if (Number.isFinite(secs) && secs > 0) {
        return secs * 1000;
      }
    }

    // 其次用 X-RateLimit-Reset 计算距重置的时间
    if (rateLimit.reset.getTime() > Date.now()) {
      return Math.min(rateLimit.reset.getTime() - Date.now() + 1000, MAX_DELAY_MS);
    }

    // 兜底：指数退避，2s → 4s → 8s → 16s → 30s（封顶），保证重试序列能覆盖到上限
    return Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
  }

  private parseRateLimit(response: Response): RateLimitInfo {
    return {
      limit: parseInt(response.headers.get('X-RateLimit-Limit') || '0'),
      remaining: parseInt(response.headers.get('X-RateLimit-Remaining') || '0'),
      reset: new Date(parseInt(response.headers.get('X-RateLimit-Reset') || '0') * 1000),
    };
  }

  private async fetch<T>(
    endpoint: string,
    accept = DEFAULT_ACCEPT,
    opts: { withAuth?: boolean } = {}
  ): Promise<T> {
    const { withAuth = true } = opts;
    const headers: Record<string, string> = {
      Accept: accept,
      'User-Agent': 'GitHub-Social-Graph-Action',
    };

    // stargazers 等社交类接口不接受 Actions 的集成 GITHUB_TOKEN（403），
    // 需要时以匿名身份请求公开仓库，因此允许调用方显式去掉认证头
    if (this.token && withAuth) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    return this.fetchWithRetry<T>(endpoint, headers);
  }

  async getUser(username: string): Promise<GitHubUser> {
    return this.fetch<GitHubUser>(`/users/${username}`);
  }

  async getFollowers(username: string, page = 1, perPage = 100): Promise<GitHubFollower[]> {
    return this.fetch<GitHubFollower[]>(
      `/users/${username}/followers?page=${page}&per_page=${perPage}`
    );
  }

  async getFollowing(username: string, page = 1, perPage = 100): Promise<GitHubFollower[]> {
    return this.fetch<GitHubFollower[]>(
      `/users/${username}/following?page=${page}&per_page=${perPage}`
    );
  }

  async getRepositories(
    username: string,
    page = 1,
    perPage = 100,
    type: 'all' | 'owner' | 'member' = 'owner'
  ): Promise<GitHubRepository[]> {
    return this.fetch<GitHubRepository[]>(
      `/users/${username}/repos?page=${page}&per_page=${perPage}&type=${type}&sort=updated`
    );
  }

  async getContributors(
    owner: string,
    repo: string,
    page = 1,
    perPage = 100
  ): Promise<GitHubContributor[]> {
    return this.fetch<GitHubContributor[]>(
      `/repos/${owner}/${repo}/contributors?page=${page}&per_page=${perPage}`
    );
  }

  async getStargazers(
    owner: string,
    repo: string,
    page = 1,
    perPage = 100
  ): Promise<Array<{ user: GitHubUser; starred_at: string }>> {
    const endpoint = `/repos/${owner}/${repo}/stargazers?page=${page}&per_page=${perPage}`;
    const isAuthErr = (err: unknown): boolean =>
      err instanceof GitHubAPIError && (err.status === 401 || err.status === 403);
    const normalize = (data: unknown, starred: boolean) => {
      if (!Array.isArray(data)) return [];
      if (starred) {
        return data as Array<{ user: GitHubUser; starred_at: string }>;
      }
      // 默认媒体类型返回纯用户数组
      return (data as GitHubUser[]).map((user) => ({ user, starred_at: '' }));
    };

    // 第一选择：star 媒体类型（带 starred_at），PAT 可用
    try {
      return normalize(await this.fetch<unknown>(endpoint, STAR_ACCEPT), true);
    } catch (err) {
      if (!isAuthErr(err)) throw err;
    }
    // 回退 1：Actions 集成令牌对 star 媒体类型 403，试默认媒体类型（仍带令牌）
    try {
      return normalize(await this.fetch<unknown>(endpoint, DEFAULT_ACCEPT), false);
    } catch (err) {
      if (!isAuthErr(err)) throw err;
    }
    // 回退 2：集成令牌对整个 stargazers 接口均 403；匿名访问公开仓库可用
    // （私有仓库此时 404，star 信号自然为空，不影响其余分析）
    return normalize(
      await this.fetch<unknown>(endpoint, DEFAULT_ACCEPT, { withAuth: false }),
      false
    );
  }

  async getAllFollowers(username: string, maxPages = 5): Promise<GitHubFollower[]> {
    const all: GitHubFollower[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.getFollowers(username, page);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  async getAllFollowing(username: string, maxPages = 5): Promise<GitHubFollower[]> {
    const all: GitHubFollower[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.getFollowing(username, page);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  async getAllRepositories(username: string, maxPages = 5): Promise<GitHubRepository[]> {
    const all: GitHubRepository[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.getRepositories(username, page);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }
}

export function createGitHubAPI(token?: string): GitHubAPIService {
  return new GitHubAPIService(token ?? process.env['GITHUB_TOKEN']);
}
