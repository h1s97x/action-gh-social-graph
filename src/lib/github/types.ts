// GitHub API 响应类型定义

export interface GitHubUser {
  login: string;
  id: number;
  avatar_url: string;
  html_url: string;
  name: string | null;
  company: string | null;
  blog: string | null;
  location: string | null;
  email: string | null;
  bio: string | null;
  public_repos: number;
  public_gists: number;
  followers: number;
  following: number;
  created_at: string;
  updated_at: string;
  // GitHub API 在用户对象上返回账号类型：User | Bot | Organization 等（可选字段）
  type?: string;
}

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  owner: GitHubUser;
  private: boolean;
  html_url: string;
  description: string | null;
  fork: boolean;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  stargazers_count: number;
  watchers_count: number;
  language: string | null;
  forks_count: number;
  open_issues_count: number;
  topics: string[];
  visibility: string;
}

export interface GitHubStargazer {
  user: GitHubUser;
  starred_at: string;
}

export interface GitHubContributor {
  login: string;
  id: number;
  avatar_url: string;
  html_url: string;
  contributions: number;
  // GitHub API 返回账号类型：User | Bot | Mannequin | Organization 等
  // （contributors 接口实测会带该字段；缺省视为普通用户）
  type?: string;
}

export interface GitHubFollower {
  login: string;
  id: number;
  avatar_url: string;
  html_url: string;
}

export interface GraphNode {
  id: string;
  label: string;
  type: 'user' | 'repo';
  avatar?: string;
  data: GitHubUser | GitHubRepository;
  connections: number;
  color: string;
}

export interface GraphLink {
  source: string;
  target: string;
  type: 'follows' | 'collaborates' | 'stars';
  weight: number;
}

export interface SocialGraph {
  nodes: GraphNode[];
  links: GraphLink[];
  stats: {
    totalNodes: number;
    totalLinks: number;
    userNodes: number;
    repoNodes: number;
  };
}

export interface DeveloperRecommendation {
  user: GitHubUser;
  score: number;
  reasons: string[];
}

export interface AnalysisResult {
  graph: SocialGraph;
  recommendations: DeveloperRecommendation[];
  insights: {
    topCollaborators: Array<{ user: GitHubUser; collaborations: number }>;
    topStarredRepos: Array<{ repo: GitHubRepository; stargazers: number }>;
    languageDistribution: Record<string, number>;
  };
  rateLimit?: {
    limit: number;
    remaining: number;
    reset: Date;
  };
}
