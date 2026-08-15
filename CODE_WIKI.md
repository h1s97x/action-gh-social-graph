# GitHub Social Graph Action — Code Wiki

## 1. 项目概述

| 项目 | 说明 |
|------|------|
| **名称** | GitHub Social Graph Action |
| **描述** | 一个 GitHub Action，用于分析 GitHub 用户的社交网络关系，生成可视化图谱报告，并自动发布为 PR 评论或 Job Summary |
| **技术栈** | TypeScript + Node.js 20 + GitHub Actions + Octokit REST API |
| **作者** | [H1S97X](https://github.com/h1s97x) |
| **许可证** | MIT |
| **运行环境** | Node.js 20 (GitHub Actions `node20` runtime) |
| **测试框架** | Vitest v4 |
| **代码规范** | ESLint v10 + Prettier v3 |
| **构建工具** | `@vercel/ncc` (TypeScript 单文件打包) |

### 核心功能

- 分析用户的关注者、关注列表及互相关注关系
- 识别跨仓库的顶级协作者
- 基于协作模式推荐开发者
- 展示编程语言分布
- 按星标数排序展示热门仓库
- 生成中英双语 Markdown 报告
- 自动发布/更新 PR 评论（同一次 PR 重新运行时自动更新）
- 写入 GitHub Actions Job Summary 页面
- 提供结构化输出（`report`、`total-nodes`、`recommendations` 等）
- 报告尾部展示 GitHub API 速率限制使用情况

---

## 2. 整体架构

```
action-gh-social-graph/
├── .github/
│   ├── workflows/
│   │   ├── build.yml              # CI：push 到 main 时自动构建 dist/
│   │   └── release.yml            # CD：打 tag 时自动发布 GitHub Release
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml         # Bug 报告模板
│   │   └── feature_request.yml    # 功能建议模板
│   ├── CODEOWNERS                 # 代码负责人配置
│   └── PULL_REQUEST_TEMPLATE.md   # PR 模板
├── .cnb.yml                       # CNB 流水线：自动同步到 GitHub
├── src/
│   ├── index.ts                   # 入口文件，Action 主逻辑（协调器）
│   ├── reporter.ts                # Markdown 报告生成器
│   └── lib/
│       └── github/
│           ├── analyzer.ts        # 社交图谱分析引擎（核心逻辑）
│           ├── api.ts             # GitHub REST API 封装层（含重试与退避）
│           └── types.ts           # 所有 TypeScript 类型/接口定义
├── tests/
│   ├── analyzer.test.ts           # 分析器单元测试
│   └── reporter.test.ts           # 报告生成器单元测试
├── dist/
│   ├── index.js                   # ncc 打包后的单文件产物（Action 实际运行入口）
│   ├── index.js.map               # Source Map（调试用）
│   ├── licenses.txt               # 第三方依赖许可证声明
│   └── sourcemap-register.js      # Source Map 运行时注册器
├── action.yml                     # GitHub Action 元数据定义
├── package.json                   # 项目依赖与脚本
├── tsconfig.json                  # TypeScript 编译配置
├── vitest.config.mts              # Vitest 测试配置
├── eslint.config.js               # ESLint flat config
├── .prettierrc.json               # Prettier 格式化配置
├── .prettierignore                # Prettier 忽略规则
├── README.md                      # 用户手册（中英双语）
├── CHANGELOG.md                   # 版本变更日志
├── CONTRIBUTING.md                # 贡献指南
├── CODE_WIKI.md                   # 本文件（代码 Wiki）
├── SECURITY.md                    # 安全策略
└── LICENSE                        # MIT 许可证
```

### 架构分层

```
┌─────────────────────────────────────────────────────────────────┐
│  action.yml                      GitHub Actions 引擎入口         │
│  (定义输入/输出/运行环境)         指向 dist/index.js              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  src/index.ts                  Action 协调层                      │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  1. 解析输入参数                                          │  │
│  │  2. 确定目标用户名（输入 > PR作者 > 事件触发者）             │  │
│  │  3. 调用分析器 → 生成报告 → 设置输出 → 写入 Summary        │  │
│  │  4. 发布/更新 PR 评论                                     │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
              │                        │
              ▼                        ▼
┌─────────────────────────┐  ┌───────────────────────────────┐
│  src/reporter.ts         │  │  src/lib/github/analyzer.ts   │
│  Markdown 报告生成器      │  │  社交图谱分析引擎              │
│  ┌───────────────────┐   │  │  ┌─────────────────────────┐ │
│  │ 概览表格           │   │  │  │ analyzeUser() 主入口    │ │
│  │ 语言分布           │   │  │  │ buildGraph() 图谱构建   │ │
│  │ 顶级协作者         │   │  │  │ generateRecommendations│ │
│  │ 推荐开发者         │   │  │  │ generateInsights()     │ │
│  │ 热门仓库           │   │  │  │ analyzeRepositories()  │ │
│  │ API 限流信息       │   │  │  └─────────────────────────┘ │
│  └───────────────────┘   │  └──────────────┬────────────────┘
└─────────────────────────┘                 │
                                            ▼
                                  ┌───────────────────────────────┐
                                  │  src/lib/github/api.ts         │
                                  │  GitHub REST API 封装层        │
                                  │  ┌─────────────────────────┐  │
                                  │  │ GitHubAPIService 类     │  │
                                  │  │ - fetchWithRetry<T>()   │  │
                                  │  │ - computeBackoffMs()    │  │
                                  │  │ - parseRateLimit()      │  │
                                  │  │ - getUser() / getFollowers()  │
                                  │  │ - getRepositories()     │  │
                                  │  │ - getContributors()     │  │
                                  │  │ - getStargazers()       │  │
                                  │  └─────────────────────────┘  │
                                  └──────────────┬────────────────┘
                                                 │
                                                 ▼
                                  ┌───────────────────────────────┐
                                  │  src/lib/github/types.ts       │
                                  │  所有类型/接口定义             │
                                  │  ┌─────────────────────────┐  │
                                  │  │ GitHubUser/Repository   │  │
                                  │  │ GraphNode/GraphLink     │  │
                                  │  │ SocialGraph             │  │
                                  │  │ AnalysisResult          │  │
                                  │  │ DeveloperRecommendation │  │
                                  │  │ RateLimitInfo           │  │
                                  │  └─────────────────────────┘  │
                                  └───────────────────────────────┘
```

---

## 3. 模块职责详解

### 3.1 入口模块 — `src/index.ts`

**职责**: Action 的协调器，编排整个分析流程的调用顺序。

**`run()` 函数执行流程**:

```
┌──────────────────────────────────────────────────────────────┐
│  run()                                                       │
│                                                              │
│  1. 解析输入参数                                              │
│     ├── github-token (必填, 默认 ${{ github.token }})         │
│     ├── username (可选, 为空则自动检测)                        │
│     ├── max-followers (默认 50)                               │
│     ├── max-repos (默认 15)                                   │
│     └── comment-on-pr (默认 true)                             │
│                                                              │
│  2. 确定目标用户名                                            │
│     ├── username 输入不为空 → 使用该值                         │
│     ├── 为空且是 PR 事件 → 取 PR 作者 (pull_request.user)     │
│     ├── 为空且有 sender  → 取事件触发者 (sender.login)         │
│     └── 都无法确定 → core.setFailed() 终止                    │
│                                                              │
│  3. 创建分析器 → 执行分析                                     │
│     analyzer.analyzeUser(targetUsername, {                    │
│       maxFollowers, maxRepos                                  │
│     })                                                        │
│                                                              │
│  4. 生成 Markdown 报告                                        │
│     generateMarkdownReport(targetUsername, result)            │
│                                                              │
│  5. 设置 Action 输出 (6 个 outputs)                           │
│     ├── report / total-nodes / total-links                   │
│     ├── user-nodes / repo-nodes / recommendations             │
│                                                              │
│  6. 写入 Job Summary (core.summary.addRaw)                   │
│                                                              │
│  7. PR 评论 (如果 comment-on-pr=true 且是 PR 事件)            │
│     ├── 列出已有评论 → 查找 Bot 评论中含 "GitHub Social Graph" │
│     ├── 找到 → octokit.issues.updateComment() 更新            │
│     └── 未找到 → octokit.issues.createComment() 创建          │
│                                                              │
│  8. 异常处理 → core.setFailed(error.message)                 │
└──────────────────────────────────────────────────────────────┘
```

**关键设计点**:
- 使用 `github.context.payload` 从 GitHub Actions 事件上下文中提取 PR 作者或事件触发者
- PR 评论采用"检测-更新/创建"策略，避免重复评论
- `@actions/core` 的 `setFailed()` 用于标记 Action 运行失败并终止

---

### 3.2 API 服务模块 — `src/lib/github/api.ts`

**职责**: 封装 GitHub REST API 调用，提供类型安全的数据获取、统一错误处理和**智能重试**机制。

#### `GitHubAPIService` 类

| 修饰符 | 方法 | 参数 | 返回类型 | 说明 |
|--------|------|------|----------|------|
| `public` | `constructor` | `token?: string` | — | 初始化服务，可选传入 GitHub Token |
| `public` | `getRateLimit` | — | `RateLimitInfo \| undefined` | 获取最近一次 API 调用的限流信息 |
| `private` | `fetchWithRetry<T>` | `endpoint, headers` | `Promise<T>` | 带重试和退避的底层 HTTP 请求 |
| `private` | `computeBackoffMs` | `rateLimit, retryAfter, attempt` | `number` | 计算下一次重试前的等待时长 |
| `private` | `parseRateLimit` | `response: Response` | `RateLimitInfo` | 从响应头解析速率限制信息 |
| `private` | `fetch<T>` | `endpoint: string` | `Promise<T>` | 构造请求头并调用 `fetchWithRetry` |
| `public` | `getUser` | `username: string` | `Promise<GitHubUser>` | `GET /users/{username}` |
| `public` | `getFollowers` | `username, page?, perPage?` | `Promise<GitHubFollower[]>` | `GET /users/{username}/followers` |
| `public` | `getFollowing` | `username, page?, perPage?` | `Promise<GitHubFollower[]>` | `GET /users/{username}/following` |
| `public` | `getRepositories` | `username, page?, perPage?, type?` | `Promise<GitHubRepository[]>` | `GET /users/{username}/repos` |
| `public` | `getContributors` | `owner, repo, page?, perPage?` | `Promise<GitHubContributor[]>` | `GET /repos/{owner}/{repo}/contributors` |
| `public` | `getStargazers` | `owner, repo, page?, perPage?` | `` Promise<Array<{user, starred_at}>> `` | `GET /repos/{owner}/{repo}/stargazers` |
| `public` | `getAllFollowers` | `username, maxPages?` | `Promise<GitHubFollower[]>` | 分页迭代获取所有关注者，每页 100 条 |
| `public` | `getAllFollowing` | `username, maxPages?` | `Promise<GitHubFollower[]>` | 分页迭代获取所有关注列表 |
| `public` | `getAllRepositories` | `username, maxPages?` | `Promise<GitHubRepository[]>` | 分页迭代获取所有仓库 |

#### 新增类型 - `RateLimitInfo`

```typescript
export interface RateLimitInfo {
  limit: number;       // 每小时请求限额
  remaining: number;   // 剩余请求数
  reset: Date;         // 限额重置时间
}
```

#### `GitHubAPIError` 类

```typescript
class GitHubAPIError extends Error {
  public status: number;           // HTTP 状态码（如 403, 404）
  public rateLimit?: RateLimitInfo; // 速率限制信息
}
```

#### 智能重试机制 (`fetchWithRetry`)

这是本次更新中最重要的改进。重试策略如下：

```
重试条件：
  ├── 429 (Too Many Requests)          → 始终可重试
  ├── 5xx (500/502/503/504)           → 始终可重试
  ├── 403 (Forbidden)                  → 仅当 remaining === 0 时重试
  │                                      （避免认证/权限错误的无效重试）
  └── 其他状态码                       → 不重试，直接抛出

最大重试次数：5 次（不含初始请求）
```

#### 退避算法 (`computeBackoffMs`)

```
computeBackoffMs(rateLimit, retryAfter, attempt)
  │
  ├─ 1. 优先使用 Retry-After 响应头（秒数）
  │     若为有效数字 → 直接返回 retryAfter * 1000
  │
  ├─ 2. 其次使用 X-RateLimit-Reset 头
  │     计算距重置时间的毫秒数 + 1s 缓冲，封顶 30s
  │
  └─ 3. 兜底：指数退避
        delay = 1s * 2^attempt, 封顶 30s
        (2s → 4s → 8s → 16s → 30s)
```

#### `fetch<T>()` 底层方法

```typescript
private async fetch<T>(endpoint: string): Promise<T>
```

**请求头**:
- `Accept: application/vnd.github.v3+json` — GitHub REST API v3
- `User-Agent: GitHub-Social-Graph-Action` — 自定义 User-Agent
- `Authorization: Bearer ${token}` — 仅当 token 存在时添加

#### 工厂函数

```typescript
function createGitHubAPI(token?: string): GitHubAPIService
```

**说明**: 快捷工厂函数，从 `token` 参数或 `process.env['GITHUB_TOKEN']` 环境变量创建 API 实例。

---

### 3.3 社交图谱分析模块 — `src/lib/github/analyzer.ts`

**职责**: 核心分析引擎，负责数据采集、图谱构建、推荐生成、洞察提取和速率限制监控。

#### `SocialGraphAnalyzer` 类

| 修饰符 | 方法 | 参数 | 返回值 | 说明 |
|--------|------|------|--------|------|
| `public` | `constructor` | `api?: GitHubAPIService` | — | 传入 API 服务实例，默认自动创建 |
| `public` | `analyzeUser` | `username, options?` | `Promise<AnalysisResult>` | **主入口**：执行完整分析流程 |
| `private` | `findMutualFollowers` | `followers, following` | `Set<string>` | 找出互相关注的用户集合 |
| `private` | `analyzeRepositories` | `repos, maxRepos` | `Promise<{contributors, stargazers}>` | **并发池**分析仓库的贡献者和星标者 |
| `private` | `buildGraph` | `mainUser, followers, following, ...` | `SocialGraph` | 构建完整社交图谱 |
| `private` | `generateRecommendations` | `mainUser, following, repoData` | `DeveloperRecommendation[]` | 生成开发者推荐列表 |
| `private` | `generateInsights` | `repos, repoData` | `AnalysisResult['insights']` | 提取洞察数据 |

#### `analyzeUser()` 完整流程

```
analyzeUser(username, {maxFollowers, maxRepos})
  │
  ├─ 1. getUser(username)                      → 获取主用户信息
  │
  ├─ 2. Promise.all([
  │      getAllFollowers(username),            → 获取关注者列表
  │      getAllFollowing(username),            → 获取关注列表
  │    ])
  │
  ├─ 3. getAllRepositories(username)           → 获取仓库列表
  │
  ├─ 4. findMutualFollowers(followers, following)  → 计算互相关注
  │
  ├─ 5. analyzeRepositories(repos, maxRepos)   → 并发分析每个仓库（并发池大小 5）
  │
  ├─ 6. buildGraph(...)                        → 构建图谱
  │
  ├─ 7. generateRecommendations(...)           → 生成推荐
  │
  ├─ 8. generateInsights(...)                  → 生成洞察
  │
  ├─ 9. 获取当前 API 限流状态
  │     ├─ 输出剩余额度到日志
  │     └─ 若剩余 < 20% → 输出警告
  │
  └─ 10. return { graph, recommendations, insights, rateLimit }
```

#### 新增：并发仓库分析 (`analyzeRepositories`)

```
analyzeRepositories(repos, maxRepos)
  │
  ├─ 1. 过滤：排除 fork 仓库，排除 0 星仓库
  ├─ 2. 排序：按 stargazers_count 降序
  ├─ 3. 截取：取前 maxRepos 个
  │
  └─ 4. 并发池（大小 CONCURRENCY_LIMIT = 5）：
        └─ 对每个仓库：
              ├─ 获取贡献者列表（前 20 名）
              │   ├─ 404 → 记录日志，跳过
              │   └─ 其他错误 → 记录错误信息，跳过
              ├─ 获取星标者列表（前 50 名）
              │   └─ 失败 → 输出警告（不再静默忽略）
              └─ 并发控制：worker pool 模式，无需延迟
```

**相比旧版的关键改进**:
- 旧版：串行 for 循环 + 100ms 硬编码延迟
- 新版：worker pool 并发池，最多 5 个仓库同时分析，无需人工延迟
- 星标者失败时输出 `core.warning()` 而非静默忽略
- 404 错误与其他错误分开处理

#### 速率限制监控

在 `analyzeUser()` 末尾，从 API 服务获取最近一次限流信息：

```typescript
const rateLimit = this.api.getRateLimit();
if (rateLimit && rateLimit.remaining !== undefined && rateLimit.limit > 0) {
  const pct = Math.round((rateLimit.remaining / rateLimit.limit) * 100);
  core.info(`⏳ GitHub API rate limit: ${rateLimit.remaining}/${rateLimit.limit} (${pct}%)`);
  if (pct < 20) {
    core.warning(`⚠️ Low rate limit remaining: ${pct}%`);
  }
}
```

#### 图谱节点颜色映射

```typescript
const NODE_COLORS = {
  mainUser:     '#00d4ff',   // 青色 — 被分析的主用户
  collaborator: '#9f7aea',   // 紫色 — 协作者（仓库贡献者）
  follower:     '#4299e1',   // 蓝色 — 普通关注者
  repo:         '#48bb78',   // 绿色 — 仓库节点
};
// 互相关注者：粉色 '#f687b3'（在 buildGraph 中通过条件判断赋值）
```

#### 图谱连接类型 (GraphLink.type)

| 类型 | 说明 | 方向 |
|------|------|------|
| `follows` | 关注关系 | 关注者 → 主用户 / 主用户 → 关注对象 |
| `collaborates` | 协作关系 | 贡献者 → 仓库 |
| `stars` | 星标关系 | 主用户 → 仓库 |

#### 推荐算法

```
generateRecommendations(mainUser, following, repoData)
  │
  ├─ 1. 构建 followingSet（已关注用户的索引集合）
  │
  ├─ 2. 遍历所有仓库的贡献者列表
  │     ├─ 跳过主用户自己
  │     └─ 跳过已在关注列表中的用户
  │
  ├─ 3. 累加贡献次数作为得分
  │     scoreMap.set(login, { score, reasons: [...] })
  │
  ├─ 4. 按得分降序排序，取前 10 名
  │
  └─ 5. 返回 DeveloperRecommendation[]（每个含 user、score、reasons）
```

**推荐原因格式**: `"在 {repo_full_name} 中有 {contributions} 次贡献"`

#### 洞察生成 (`generateInsights`)

```typescript
{
  topCollaborators: [             // 前 5 名跨仓库贡献最多的协作者
    { user: GitHubUser, collaborations: number }
  ],
  topStarredRepos: [             // 前 5 名星标最多的仓库
    { repo: GitHubRepository, stargazers: number }
  ],
  languageDistribution: {}       // 编程语言 → 出现次数
}
```

---

### 3.4 报告生成模块 — `src/reporter.ts`

**职责**: 将分析结果转换为格式化 Markdown 报告。

#### `generateMarkdownReport()`

```typescript
function generateMarkdownReport(username: string, result: AnalysisResult): string
```

**参数**:
- `username: string` — 被分析的用户名
- `result: AnalysisResult` — 分析结果对象

**返回值**: 格式化 Markdown 字符串（中英双语）

**报告结构**:

| 章节 | 标题 | 条件 | 内容 |
|------|------|------|------|
| 1 | Overview / 社交网络概览 | 始终 | 表格：开发者节点、仓库节点、连接数、总节点数 |
| 2 | Languages / 编程语言分布 | 有语言数据 | 前 8 种语言，格式 `` `语言` ×次数 `` |
| 3 | Top Collaborators / 顶级协作者 | 有协作者数据 | 前 5 名，含头像、用户名、贡献次数 |
| 4 | Recommended Developers / 推荐关注的开发者 | 有推荐数据 | 前 6 名，含头像、用户名、推荐理由 |
| 5 | Top Repositories / 最受欢迎的仓库 | 有仓库数据 | 前 5 名，含仓库名、星标数、描述 |
| 6 | API Rate Limit / API 限流信息 | 有 `rateLimit` 数据 | 剩余/总额度、百分比、重置时间 |

**新增 (v2)**：API 限流信息尾部展示

```
> ⏳ GitHub API rate limit: **4000/5000** remaining (80%), resets at 2026-01-01T00:00:00.000Z
```

**报告格式特点**:
- 中英双语标题（如 "Overview / 社交网络概览"）
- 用户头像使用 GitHub avatars API (`avatars.githubusercontent.com`)
- 所有用户/仓库链接到 GitHub 原文
- 尾部标注生成时间戳

---

### 3.5 类型定义模块 — `src/lib/github/types.ts`

**职责**: 集中定义所有 TypeScript 类型，供其他模块引用。

#### GitHub API 响应类型

| 接口 | 对应 API | 关键字段 |
|------|----------|----------|
| `GitHubUser` | User | `login`, `id`, `avatar_url`, `name`, `company`, `followers`, `following`, `public_repos` |
| `GitHubRepository` | Repository | `id`, `full_name`, `stargazers_count`, `language`, `fork`, `description`, `topics` |
| `GitHubContributor` | Contributor | `login`, `contributions` |
| `GitHubFollower` | Follower | `login`, `id`, `avatar_url`, `html_url` |
| `GitHubStargazer` | Stargazer | `user`, `starred_at` |

#### 图谱核心类型

```typescript
interface GraphNode {
  id: string;               // 唯一标识：用户为 login，仓库为 "repo:full_name"
  label: string;            // 显示标签：用户为 name ?? login，仓库为 name
  type: 'user' | 'repo';   // 节点类型
  avatar?: string;          // 头像 URL（仅用户节点有）
  data: GitHubUser | GitHubRepository;  // 原始数据
  connections: number;      // 连接数
  color: string;            // 可视化颜色代码
}

interface GraphLink {
  source: string;           // 源节点 id
  target: string;           // 目标节点 id
  type: 'follows' | 'collaborates' | 'stars';  // 连接类型
  weight: number;           // 权重
}

interface SocialGraph {
  nodes: GraphNode[];
  links: GraphLink[];
  stats: {
    totalNodes: number;     // 总节点数
    totalLinks: number;     // 总连接数
    userNodes: number;      // 用户节点数
    repoNodes: number;      // 仓库节点数
  };
}
```

#### 分析结果类型

```typescript
interface DeveloperRecommendation {
  user: GitHubUser;         // 推荐的用户信息
  score: number;            // 推荐分数（基于贡献次数累加）
  reasons: string[];        // 推荐原因列表（最多 3 条）
}

interface AnalysisResult {
  graph: SocialGraph;       // 社交图谱
  recommendations: DeveloperRecommendation[];  // 推荐列表（最多 10 条）
  insights: {
    topCollaborators: Array<{ user: GitHubUser; collaborations: number }>;
    topStarredRepos: Array<{ repo: GitHubRepository; stargazers: number }>;
    languageDistribution: Record<string, number>;  // 语言 → 仓库数
  };
  rateLimit?: RateLimitInfo;  // 新增：API 速率限制信息
}
```

---

## 4. 依赖关系

### 4.1 生产依赖

| 包名 | 版本 | 用途 |
|------|------|------|
| `@actions/core` | ^1.10.1 | GitHub Actions 核心 SDK：输入/输出、日志、Job Summary、setFailed |
| `@actions/github` | ^6.0.0 | GitHub Actions 上下文（context）、Octokit 客户端（PR 评论） |

### 4.2 开发依赖

| 包名 | 版本 | 用途 |
|------|------|------|
| `typescript` | ^5 | TypeScript 编译器 |
| `@types/node` | ^20 | Node.js 类型定义 |
| `@vercel/ncc` | ^0.38.1 | 将 TypeScript 源码 + 依赖打包为单文件 JS |
| `vitest` | ^4.1.10 | 单元测试框架 |
| `eslint` | ^10.8.1 | 代码静态分析 |
| `@typescript-eslint/eslint-plugin` | ^8.67.0 | TypeScript ESLint 规则 |
| `@typescript-eslint/parser` | ^8.67.0 | TypeScript ESLint 解析器 |
| `eslint-config-prettier` | ^10.1.8 | 关闭 ESLint 中与 Prettier 冲突的规则 |
| `prettier` | ^3.9.6 | 代码格式化 |

### 4.3 模块间依赖关系

```
src/index.ts
  ├── @actions/core          → getInput, setOutput, setFailed, summary
  ├── @actions/github        → context, getOctokit
  ├── ./lib/github/analyzer  → createSocialGraphAnalyzer
  └── ./reporter             → generateMarkdownReport

src/lib/github/analyzer.ts
  ├── @actions/core          → core.info, core.warning
  └── ./api                  → createGitHubAPI, GitHubAPIService

src/lib/github/api.ts
  └── ./types                → GitHubUser, GitHubRepository 等

src/reporter.ts
  └── ./lib/github/types     → AnalysisResult

src/lib/github/types.ts      ← 无外部依赖，纯类型定义
```

---

## 5. Action 配置说明

### 5.1 action.yml 元数据

```yaml
name: 'GitHub Social Graph'
description: 'Analyze a GitHub user...'
author: 'H1S97X'
branding:
  icon: 'users'
  color: 'blue'
runs:
  using: 'node20'
  main: 'dist/index.js'
```

### 5.2 输入参数

| 参数名 | 必填 | 默认值 | 类型 | 说明 |
|--------|------|--------|------|------|
| `github-token` | 是 | `${{ github.token }}` | string | GitHub API 调用和 PR 评论的 Token |
| `username` | 否 | `''` | string | 要分析的用户名，为空则自动检测 |
| `max-followers` | 否 | `50` | number | 最多分析的关注者/关注数量 |
| `max-repos` | 否 | `15` | number | 最多分析的仓库数量 |
| `comment-on-pr` | 否 | `true` | boolean | 是否将报告发布为 PR 评论 |

### 5.3 输出参数

| 参数名 | 类型 | 说明 |
|--------|------|------|
| `report` | string | 生成的 Markdown 报告全文 |
| `total-nodes` | string | 图谱总节点数 |
| `total-links` | string | 图谱总连接数 |
| `user-nodes` | string | 开发者节点数 |
| `repo-nodes` | string | 仓库节点数 |
| `recommendations` | string | 推荐开发者列表（JSON 数组，如 `["user1","user2"]`） |

### 5.4 所需权限

```yaml
permissions:
  pull-requests: write   # 发布/更新 PR 评论所需
  contents: read         # 默认包含，用于 API 调用
```

---

## 6. CI/CD 工作流

### 6.1 构建工作流 — `.github/workflows/build.yml`

| 触发条件 | `push` 到 `main` 分支，变更路径 `src/**`、`package.json` 或 `tsconfig.json` |
|----------|---------|
| 运行环境 | `ubuntu-latest`，Node.js 20 |

**流程**:
1. `actions/checkout@v4` — 检出代码（使用 `GITHUB_TOKEN` 以便后续提交）
2. `actions/setup-node@v4` — 配置 Node.js 20
3. `npm install` — 安装依赖
4. `npm run build` — 执行 `ncc build src/index.ts -o dist --source-map --license licenses.txt`
5. `stefanzweifel/git-auto-commit-action@v5` — 自动提交 `dist/` 目录变更

### 6.2 发布工作流 — `.github/workflows/release.yml`

| 触发条件 | 推送 tag 匹配 `v*`（如 `v1.0.0`） |
|----------|---------|
| 权限 | `contents: write` |
| 运行环境 | `ubuntu-latest`，Node.js 20 |

**流程**:
1. `actions/checkout@v4` — 检出代码（`fetch-depth: 0` 获取完整历史）
2. 从 tag 提取版本号（去掉 `v` 前缀）
3. `npm ci` + `npm run build` — 构建产物
4. `softprops/action-gh-release@v2` — 发布 GitHub Release
   - 从 `CHANGELOG.md` 读取发布说明
   - 自动生成 Release Notes
   - 包含 `dist/`、`LICENSE`、`README.md` 作为附件

### 6.3 CNB 流水线 — `.cnb.yml`

**CNB**（cnb.cool）平台的 CI/CD 配置，用于自动同步到 GitHub：

| 触发条件 | 说明 |
|----------|------|
| `push` 到 `main` | 自动同步到 GitHub 同名仓库的 `main` 分支 |
| `pull_request` | 执行 PR 门禁：`typecheck` → `test` → `lint` |
| `web_trigger` (手动) | 在 CNB 平台手动触发同步 |

**同步机制**:
- 通过密钥仓库 `h1s97x/secret-env` 注入 `GITHUB_TOKEN`
- 添加 GitHub 远程仓库并 push `HEAD:main`
- 完成后清理远程仓库引用

---

## 7. 运行方式

### 7.1 开发环境

```bash
# 克隆仓库
git clone https://github.com/h1s97x/action-gh-social-graph.git
cd action-gh-social-graph

# 安装依赖
npm install

# 类型检查（不生成文件）
npm run typecheck

# 运行单元测试
npm run test

# 代码检查
npm run lint

# 代码格式化
npm run format

# 构建发布产物（生成 dist/ 目录）
npm run build
```

### 7.2 TypeScript 编译配置

| 配置项 | 值 | 说明 |
|--------|-----|------|
| `target` | ES2020 | 编译目标 ECMAScript 版本 |
| `module` | commonjs | Node.js 模块系统 |
| `lib` | ES2020 | 运行时类型库 |
| `strict` | true | 严格类型检查模式 |
| `esModuleInterop` | true | ES 模块与 CommonJS 互操作 |
| `resolveJsonModule` | true | 允许导入 JSON 文件 |
| `rootDir` | ./src | 源码根目录 |
| `outDir` | ./dist | 输出目录 |

### 7.3 测试配置

```typescript
// vitest.config.mts
{
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      reporter: ['text', 'json-summary'],
    },
  },
}
```

### 7.4 代码规范配置

**ESLint** (eslint.config.js):
- 使用 TypeScript parser 和 plugin
- 规则继承 `recommended` 配置
- `@typescript-eslint/no-explicit-any` 为 warn 级别
- 集成 `eslint-config-prettier` 避免冲突

**Prettier** (.prettierrc.json):
```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "es5",
  "printWidth": 100,
  "tabWidth": 2
}
```

### 7.5 在 GitHub Actions 中使用

**自动分析 PR 作者**:
```yaml
on: pull_request
jobs:
  analyze:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - uses: h1s97x/action-gh-social-graph@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

**手动分析指定用户**:
```yaml
on: workflow_dispatch
jobs:
  analyze:
    steps:
      - uses: h1s97x/action-gh-social-graph@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          username: octocat
          comment-on-pr: 'false'
```

---

## 8. 测试

### 8.1 测试文件结构

| 文件 | 测试目标 | 测试用例数 |
|------|----------|-----------|
| `tests/analyzer.test.ts` | `SocialGraphAnalyzer` | 4 个 describe 块，覆盖互相关注、图统计、推荐排序 |
| `tests/reporter.test.ts` | `generateMarkdownReport` | 6 个 it 块，覆盖报告内容、条件渲染、rate limit |

### 8.2 测试策略

**Mock 设计**:
- `MockGitHubAPI` 类模拟 `GitHubAPIService` 接口
- 通过构造函数注入测试数据（用户、关注者、仓库、贡献者）
- `getRateLimit()` 返回固定值，无需真实 API 调用

**测试覆盖范围**:
- `findMutualFollowers` — 互相关注识别、空集边界
- `buildGraph` — 节点数、连接数统计
- `generateRecommendations` — 排除逻辑、排序、分数累计
- `generateMarkdownReport` — 标题、概览表格、语言分布、协作者、推荐、仓库、条件隐藏、rate limit 输出

---

## 9. 错误处理

| 错误场景 | 触发位置 | 处理方式 | 影响 |
|----------|----------|----------|------|
| 无法确定目标用户名 | `src/index.ts:25-28` | `core.setFailed()` 终止 | Action 标记为失败 |
| API 调用失败（可重试） | `src/lib/github/api.ts:48-96` | 指数退避重试，最多 5 次 | 重试成功则继续，失败则抛出 |
| API 调用失败（不可重试） | `src/lib/github/api.ts:87-94` | 抛出 `GitHubAPIError` | 由调用方捕获 |
| 单个仓库分析失败 (404) | `src/lib/github/analyzer.ts:122-128` | 记录日志，跳过该仓库 | 其他仓库继续分析 |
| 单个仓库分析失败 (其他) | `src/lib/github/analyzer.ts:129-131` | 记录错误信息，跳过该仓库 | 其他仓库继续分析 |
| Stargazers API 无权限 | `src/lib/github/analyzer.ts:108-119` | 输出 `core.warning()` 告警 | 该仓库无星标者数据 |
| 其他未预期异常 | `src/index.ts:92-94` | `core.setFailed()` 终止 | Action 标记为失败 |

---

## 10. 性能优化策略

| 优化点 | 实现方式 | 文件位置 |
|--------|----------|----------|
| 并行数据获取 | `Promise.all()` 并行获取 followers 和 following | `analyzer.ts:38-41` |
| 并发仓库分析 | Worker pool 并发池，大小 `CONCURRENCY_LIMIT = 5` | `analyzer.ts:88-136` |
| 分页数量限制 | `maxPages` 参数控制最大请求次数 | `api.ts:191-219` |
| 数据裁剪 | 贡献者取前 20 名，星标者取前 50 名 | `analyzer.ts:94-100` |
| 过滤无效数据 | 跳过 fork 仓库和 0 星仓库 | `analyzer.ts:82-83` |
| 智能重试退避 | 优先 `Retry-After` 头，其次 `X-RateLimit-Reset`，兜底指数退避 | `api.ts:99-121` |
| 单文件打包 | `@vercel/ncc` 将源码和依赖打包为单文件 | `package.json:7` |

---

## 11. 安全与合规

| 项目 | 说明 |
|------|------|
| Token 处理 | GitHub Token 通过 `@actions/core` 的 `getInput` 获取，不硬编码 |
| User-Agent | 自定义 `GitHub-Social-Graph-Action`，符合 GitHub API 最佳实践 |
| 速率限制 | 使用 `GITHUB_TOKEN` 默认 5000 次/小时，建议大型网络使用 PAT |
| 403 重试保护 | 仅当 `remaining === 0` 时重试 403，避免认证错误无效重试 |
| 依赖 | 仅 2 个生产依赖（`@actions/core`、`@actions/github`），攻击面小 |
| 构建产物 | `dist/` 由 CI/CD 自动构建并提交，确保发布物与源码一致 |
| 安全策略 | 见 `SECURITY.md`，含漏洞报告流程和响应时间线 |

---

## 12. 社区治理

| 文件 | 说明 |
|------|------|
| `.github/CODEOWNERS` | 代码负责人配置，所有路径默认负责人 `@h1s97x` |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR 模板，包含变更类型、检查清单、截图等 |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | Bug 报告结构化模板（含版本、工作流配置、复现步骤等） |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | 功能建议模板（含痛点、方案、备选方案、使用场景） |
| `CONTRIBUTING.md` | 贡献指南（含开发环境、代码规范、提交规范、PR 流程） |
| `SECURITY.md` | 安全策略（含支持的版本、漏洞报告流程、用户注意事项） |

---

*文档生成时间: 2026-08-15 · 对应版本: v1.0.0*