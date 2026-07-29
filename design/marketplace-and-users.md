# Synapse 用户与插件市场设计方案 (v0.1 draft)

> 目标:在已完成的「AI 基座 + 插件即工具」之上,引入 **「用户」** 概念,
> 进而构建 **插件市场生态**——开发者用脚手架开发插件,选择 **私人 / 公开** 发布,
> 公开插件通过 **下载量 / 评分** 形成评级与排行,沉淀为可流通的生态。
>
> 心智模型(项目定义):
>
> - **AI = 大脑 / 设计师**
> - **可安装的 skill = 大脑能学习的知识**
> - **插件(Synapse plugin)= 大脑的四肢 / 设计师的员工**
> - **市场 = 让四肢可被生产、流通、互评的「社会」**
>
> 配套阅读:[ai-foundation.md](ai-foundation.md)(基座设计)、[ai-foundation-progress.md](ai-foundation-progress.md)(基座进度)。

---

## 0. 一句话结论:离目标还差多远?

**「给大脑造手脚」的技术内核已经做完了。** 现在缺的不是手脚,而是**让手脚能被生产、流通、互评的「社会层」——人、身份、信任、市场。**

| 维度                         | 状态      | 说明                                                                           |
| ---------------------------- | --------- | ------------------------------------------------------------------------------ |
| 插件**开发**(脚手架/SDK/CLI) | ✅ 已具备 | `create-synapse-plugin` + `@synapse/plugin-sdk` + `plugin-cli`(build/validate) |
| 插件**运行时**(沙箱/权限)    | ✅ 已具备 | `src/main/plugins/*` 全套宿主/沙箱/权限/工具桥                                 |
| **大脑**(AI 编排/双向 MCP)   | ✅ 已具备 | AgentRuntime + 多 provider BYOK + MCP server/client(P0–P5b)                    |
| 插件**本地安装**(.syn 包)    | ✅ 已具备 | `install-from-package.ts` 解包安装                                             |
| 插件**分发**(市场)           | 🟡 半成品 | 只读**静态** `registry.json`(GitHub raw)+ 手动 GitHub Release 发布;**无后端**  |
| **用户 / 身份**              | ❌ 不存在 | 无账户、无登录、无「我的插件」                                                 |
| **私人 / 公开**可见性        | ❌ 不存在 | 所有市场条目均公开;无隐私边界                                                  |
| **发布闭环**(app/CLI 内)     | ❌ 不存在 | 发布 = 手动打 tag → CI → 手动 PR 改 registry 仓库                              |
| **下载量 / 评分 / 评级**     | ❌ 不存在 | 静态 JSON 无法承载可写计数与评价                                               |
| **后端服务**                 | ❌ 不存在 | 当前架构是「无服务器 + 静态 git」,无法支撑上面四项                             |

> **关键判断**:剩余工作的 ~90% 集中在一个此前完全不存在的子系统——**带鉴权与数据库的市场后端服务**,
> 以及围绕它的 CLI / 桌面端 / 信任链改造。这是一次从「纯客户端 + 静态 git」到「客户端 + 云服务」的架构跃迁。

---

## 1. 现状基线(设计出发点)

### 1.1 已有的「四肢生产线」

```
作者本机                          分发                         用户本机
─────────                        ────                        ─────────
create-synapse-plugin  ──脚手架──►  (手写工具/命令)
        │
   plugin-cli build  ──►  <id>-<version>.syn (zip)
        │
   git tag v* ──CI(release.yml)──►  GitHub Release(.syn + .sha256)
        │
   手动 PR ──►  WiIIiamWei/Synapse-Marketplace/registry.json (静态)
                                          │
                          marketplace-registry.ts ──fetch(只读)──►  市场列表
                                          │
                          install-from-package.ts ──解包──►  已安装插件
```

- **`marketplace-registry.ts`**:从固定 GitHub raw URL 拉 `registry.json`,zod 校验,引擎兼容过滤;失败回退到 `resources/mock-marketplace`。**纯读、静态、无计数、无鉴权。**
- **`MarketplaceEntry`** 现有字段:`id / name / displayName / description / author / homepage / version / downloadUrl / sha256 / synapseEngine / icon? / categories?`。**没有 owner(用户)、visibility、downloads、rating 等字段。**
- **发布**:作者侧靠 `release.yml`(打 tag → 构建 .syn + sha256 → GitHub Release)。把条目登记进市场仍是**手动改注册表仓库**。
- **桌面端**:`src/renderer/src/components/plugins/` 目前只有 **view-renderer**(渲染插件命令返回的 View),**没有市场浏览页 / 账户页 / 发布页**。

### 1.2 核心张力

> 现有市场是「**只读静态 git 注册表**」。
> 而「用户、私人/公开、下载量、评分、排行」**本质上都需要一个可写、可鉴权、可计数的服务**。
> 静态 JSON 无法表达「谁拥有这个插件」「这个插件只给我自己看」「它被下载了多少次」「平均几星」。

因此本方案的核心,是**新增一个市场后端服务**,并把现有的「静态 registry」演进为「后端 API(+ 可缓存的公开快照)」。

---

## 2. 核心架构抉择:市场后端形态

引入「用户」就必须有一个**可信、可写、有状态**的中心(或准中心)。三种形态:

| 形态                         | 用户/私有 | 下载量/评分 | 运维成本 | 评价                                       |
| ---------------------------- | --------- | ----------- | -------- | ------------------------------------------ |
| **A. 纯静态 git(现状)**      | ❌        | ❌          | 极低     | 无法满足目标,仅作公开快照的 CDN 兜底       |
| **B. 轻后端(推荐起步)**      | ✅        | ✅          | 中       | 一个 API 服务 + DB + 对象存储,够用且可演进 |
| **C. 全平台(Web 门户+审核)** | ✅        | ✅✅        | 高       | B 的超集,加 Web 端、人工审核、组织、付费   |

**已定路线:C(全平台)。** 目标是完整的市场平台——桌面端 + Web 门户 + 人工审核 + 组织/协作者 + 付费分成。
**实现策略仍是「先内核后外延」**:M0–M4 先把 B 的内核(后端服务 + 桌面端闭环 + 下载量/评分)做扎实,
再在其上叠加 C 的外延(Web 门户、审核流水线、组织、付费)。静态 git(A)降级为**公开市场的只读缓存/兜底**
(离线或后端故障时仍能浏览公开插件),与后端形成「**后端为权威源、静态快照为兜底**」的双层。

> 选 C 不等于一次性全做。C 的内核 = B;C 的差异化(门户/审核/组织/付费)按 M6–M9 增量上线。
> 这样既锁定「完整平台」终局,又避免在内核未验证前就背上门户与付费的复杂度。

### 2.1 技术形态(已锁定,2026-06-05)

走**解耦组合**,与「零原生依赖、TypeScript 优先」基线一致:

- **API 服务**:**Fastify** + TypeScript,pnpm workspace 新包 `packages/marketplace-server`。长驻 Node 服务(承载大文件上传、后台队列、审核流水线、Stripe webhook)。
- **ORM / 校验**:**Drizzle**(纯 JS,无原生引擎,契合零原生基线)+ **zod**(复用,放进共享 `marketplace-types`)。
- **数据库**:**Neon**(serverless Postgres,可缩到零、分支化、慷慨免费额度)。
- **对象存储**:**Cloudflare R2**(S3 兼容、**出流量免费**——下载密集型市场的关键省钱点)存 `.syn` 包;DB 只存元数据 + 签名下载 URL + sha256。
- **鉴权**:**Fastify 自管**(Auth.js/Lucia/Better Auth 之一,不手搓 token);**GitHub OAuth 起步**(受众=开发者),**身份建模为 provider 无关** `User ⇄ AuthIdentity{provider, providerUserId}`,M6 再加邮箱/Google;桌面 app 走系统浏览器 OAuth + loopback 回调,**CLI `publish` 走 device-code flow**(M2 即需)。
- **公开快照**:后端定时把「公开插件」导出为只读 `registry.json` 发到 CDN(自有域名);`marketplace-registry.ts` 改造为「快照读取器」,URL **可配置**(去硬编码)。仅作离线/容灾兜底,**非权威源**。
- **代码归属**:统一收编进 GitHub Org **`J-C-Lab`**(app + `marketplace-server` + 快照仓库);品牌名**暂定 Synapse**。

> 这样桌面端的「公开浏览」可继续走快照(快、可缓存、可离线),而「登录、私人插件、发布、评分」走后端 API。

---

## 3. 领域模型(引入「用户」)

```
User (账户)
  ├─ id, handle, displayName, avatar, authProvider(github), createdAt
  └─ role: user | developer | admin           # developer = 已发布过插件者

Plugin (一个插件的逻辑实体,跨版本)
  ├─ id (反向域名: com.author.foo), ownerUserId
  ├─ visibility: private | public             # ← 私人/公开 的核心字段
  ├─ displayName, description, categories, homepage, icon
  ├─ latestVersion, stats{ downloads, ratingAvg, ratingCount }
  └─ status: active | deprecated | unlisted | removed

PluginVersion (不可变版本)
  ├─ pluginId, version(semver), synapseEngine
  ├─ packageUrl(对象存储), sha256, sizeBytes
  ├─ manifestSnapshot(权限/工具/命令,供安装前展示与审计)
  └─ publishedAt, yanked?(撤回标记,不物理删)

Download   { pluginId, version, userId?, at }   # 计数与防刷的事实表
Rating     { pluginId, userId, stars(1..5), updatedAt }   # 每用户每插件唯一
Review     { pluginId, userId, body, createdAt }          # 可选,评分附带文字
OwnershipClaim / Collaborator  { pluginId, userId, role }  # 多人协作(后期)
```

可见性语义:

1. **私人插件(private)**:仅 owner 可见、可下载、可在自己设备间同步安装。不进公开列表、不计入公开排行。
2. **公开插件(public)**:所有人可见、可下载;参与下载量/评分统计与排行。

**评级 = 由 `stats.downloads` 与 `ratingAvg`/`ratingCount` 派生的派生量**(如 Wilson 置信下界 + 时间衰减),用于排行榜与「精选」。详见 §6 M4。

---

## 4. 端到端用户流程(目标态)

```
① 开发者:登录                synapse-plugin login            (device-code → 浏览器 GitHub 授权)
② 开发:脚手架               npx create-synapse-plugin myfoo  (现有,无需改)
③ 本地联调                   synapse-plugin dev / link        (现有)
④ 发布:私人或公开            synapse-plugin publish [--public]
       └─ build .syn → 计算 sha256 → 上传对象存储 → 注册 PluginVersion(后端鉴权校验 owner)
⑤ 桌面端「市场」浏览          公开走快照/后端;「我的插件 / 私人插件」走后端鉴权
⑥ 用户:安装                 选择插件 → 校验 sha256 → install-from-package(现有)→ downloads+1
⑦ 用户:评分/评价            登录后 1..5 星(+可选文字)→ 影响 ratingAvg 与排行
⑧ 大脑使用                   已安装插件的 tools 自动进入 AgentRuntime / 对外 MCP(现有,无需改)
```

> 第 ⑧ 步已经是现成能力——这正是「四肢已就位」的体现。本方案不触碰 AI 基座,只补「人 + 流通」。

---

## 5. 系统组件拆分(要做什么)

### 5.1 新增:市场后端服务 `packages/marketplace-server`

| 模块      | 职责                                                                       |
| --------- | -------------------------------------------------------------------------- |
| 鉴权      | GitHub OAuth、JWT 签发/刷新、CLI device-code、PAT 管理                     |
| 用户      | 账户 CRUD、handle、developer 升级                                          |
| 插件/版本 | 发布(校验 owner/semver 单调递增/sha256/引擎)、可见性切换、yank、列表/详情  |
| 下载      | 签发下载 URL、计数(防刷:去重窗口 + 速率限制)、统计聚合                     |
| 评分/评价 | 每用户每插件唯一评分、聚合 `ratingAvg/ratingCount`、可选文字评价、滥用举报 |
| 排行/检索 | 关键词/分类检索、排行榜(评级算法)、精选位                                  |
| 快照导出  | 定时把 public 插件导出为 `registry.json` 静态快照(兼容现有读路径)          |
| 审核/安全 | 上传扫描、manifest 权限审计、敏感权限标记、下架/封禁(admin)                |

### 5.2 扩展:CLI(`packages/plugin-cli`)

- `synapse-plugin login` / `logout` / `whoami`(device-code,token 存 OS 凭据库)。
- `synapse-plugin publish [dir] [--public|--private] [--tag]`:build → 上传 → 注册版本。
- `synapse-plugin unpublish` / `yank <version>` / `visibility <public|private>`。
- 复用现有 `build.ts`(已产出 `.syn` + 可算 sha256)与 `manifest-io.ts`。

### 5.3 扩展:桌面端(`src/renderer` + `src/main`)

- **账户**:登录(打开系统浏览器 OAuth 回调)、`我的资料`、token 存主进程凭据库(复用 `AiCredentialStore`/`SecretProtector` 思路,renderer 不碰 token)。
- **市场页(新)**:浏览/搜索/分类/排行;插件详情(权限清单、工具列表、评分、版本历史);**安装前展示 manifest 权限与 tools**(信任透明)。
- **「我的插件 / 私人插件」页**:列出 owner 名下插件、可见性切换、发布状态。
- **评分/评价 UI**:已安装插件可打分(复用 shadcn `dialog`/`form`)。
- **IPC 新增面(遵循四段式)**:`market:*`(login/status/search/detail/install/publish/rate/myPlugins)。

### 5.4 信任与安全(贯穿)

- **包完整性**:沿用 `sha256` 强校验(安装前必校);后端为权威 sha256 源。
- **来源可信**:发布需登录鉴权;owner 与插件 `id` 域名前缀绑定(防抢注/冒名)。
- **权限透明**:安装前在 UI 展示插件声明的 `permissions` 与 `tools`(尤其 `destructiveHint`)。
- **可信源开关**:用户可选择「仅允许来自官方市场 / 也允许任意 URL / 仅本地 .syn」。
- **滥用治理**:评分防刷(每用户唯一 + 需已安装)、举报、admin 下架、版本 yank(不物理删,保可复现)。

---

## 6. 分期路线图

> 命名 **M(arketplace)** 阶段,与 AI 基座的 P 阶段区分。每阶段独立可验收。

| 阶段                        | 内容                                                                                                  | 产出 / 验收                                                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **M0 数据模型 + 协议**      | 定义 User/Plugin/Version/Download/Rating 的 schema(zod 共享包 `@synapse/marketplace-types`)、API 契约 | ✅ **已完成**(见 §11)——类型 + 契约,无运行时,前后端共用                                                                                    |
| **M1 后端骨架 + 鉴权**      | `marketplace-server` 起服务、Postgres + 对象存储接线、GitHub OAuth、JWT、用户表                       | ✅ **已完成**(见 §12)——Fastify+Drizzle 骨架、全量 schema、device-flow 鉴权、pglite 集成测试                                               |
| **M2 发布闭环(CLI)**        | `publish`(鉴权+上传+注册版本)+ owner/semver/sha256 校验;CLI `login/whoami`                            | ✅ **已完成**(见 §13)——CLI login/whoami/publish + GitHub 浏览器登录腿;**真实端到端冒烟通过**(登录→发布→搜索→详情→签名下载,Neon+R2+GitHub) |
| **M3 桌面端市场(读)**       | 市场浏览/搜索/详情页 + 安装前权限展示;公开走**快照**,登录态拉私人;复用现有 install                    | ✅ **已完成**(见 §14)——市场页接后端搜索/详情 + 安装前权限/工具披露 + 经签名 URL 校验 sha256 安装。桌面端账户登录(私人插件)留作增强        |
| **M4 下载量 + 评分 + 评级** | 下载计数(防刷)、评分写入与聚合、排行算法(Wilson+衰减)、排行榜/精选位                                  | ✅ **已完成**(见 §15)——下载计数(authed 窗口去重)+ 评分 upsert/聚合 + 评论 + relevance 排行评分;桌面端只读展示 ★。评分提交 UI 待桌面登录   |
| **M5 私人/公开治理**        | app 内可见性切换、yank、举报、admin 下架;可信源开关                                                   | ✅ **已完成**(见 §17 + §18)——后端治理 + 桌面 UI(我的/管理标签、可见性切换/yank/举报/下架)+ 可信源开关                                     |
| **M6 Web 门户**             | 浏览器端市场门户(复用现有 Fumadocs/Next 工作流)、SEO、可分享插件详情链接、Web 端浏览/搜索/详情        | ✅ **已完成**(见 §21)——docs 应用内 `/marketplace` + `/marketplace/[id]`(RSC 读公开 API、SEO metadata);next build 通过                     |
| **M7 审核流水线**           | 上传自动扫描 + 人工审核队列、敏感权限分级、审核状态机(pending/approved/rejected)、admin 控制台        | ✅ **已完成**(见 §19 + §20)——后端(自动扫描/队列/状态机/下架恢复)+ 桌面 admin 控制台(审核队列接「管理」标签)                               |
| **M8 组织 / 协作者**        | Organization 实体、团队命名空间、Collaborator 角色与权限、转移所有权                                  | 多人共同维护一个插件 / 组织发布                                                                                                           |
| **M9 付费 / 分成(可选)**    | 付费插件、结算(Stripe 等)、开发者收入分成、发票                                                       | 形态 C 完整体;插件可商业化                                                                                                                |

**实现优先级(C 平台分波次上线)**:

- **第一波 内核(M0–M4)**:「登录 → 发布(私人/公开)→ app 内浏览安装 → 下载量与评分」最小生态闭环。**这是必须先跑通的地基。**
- **第二波 治理+门户(M5–M7)**:可见性治理、Web 门户、审核流水线——**公开市场对外开放的前置**。
- **第三波 商业化(M8–M9)**:组织协作与付费分成,按增长与商业需要再上。

---

## 7. 待定决策(需要拍板)

> 这些选择会显著改变实现量与运维形态,建议在进入 M1 前定稿。

**已拍板(2026-06-05,见 §2.1 与 §10):**

1. ✅ **后端形态**:C(全平台),后端为唯一权威源 + 自动快照兜底。
2. ✅ **托管与栈**:Fastify + Drizzle + zod / Neon / Cloudflare R2(解耦组合)。
3. ✅ **鉴权方式**:Fastify 自管,GitHub OAuth 起步 + provider 无关身份表;CLI device-code。
4. ✅ **域名与品牌**:代码收编进 GitHub Org `J-C-Lab`;品牌名暂定 **Synapse**;真实域名待注册(需查 "Synapse" 商标/可用性,可能加限定词)。

**仍待定(可在对应阶段前再定,不阻塞 M0):**

5. **私人插件存储**:私人 `.syn` 是否同进 R2(签名 URL + 鉴权)?是否需要设备间同步?(M2 前定)
6. **审核策略**:第一波先发后审;M7 上人工审核 + 上传期自动扫描清单。(M7 前定)
7. **评级算法**:排行权重(下载量 vs 评分 vs 时新度)与防刷强度。(M4 前定)
8. **成本/合规**:运维预算上限、数据存放区域、隐私政策。(公开上线即 M5/M6 前定)

---

## 8. 范围与排期(走完整平台 C)

**在范围内(分波次,见 §6)**:用户/身份、私人/公开、发布闭环、下载量/评分/评级、治理、
**Web 门户(M6)、审核流水线(M7)、组织/协作者(M8)、付费分成(M9)**——即形态 C 的完整能力。

**第一波(M0–M4)明确不做、留给后波**:

- 付费 / 分成 / 结算 → M9。
- 组织与团队权限 → M8(第一波只支持单 owner)。
- Web 门户 → M6(第一波只在桌面端 app 内)。
- 人工审核 → M7(第一波公开插件先发后审 + sha256/owner 校验兜底)。

**始终排除(不在本方案范围)**:

- 插件自动更新后台服务(先手动「检查更新」即可)。
- 跨语言运行时(仍是 JS/TS 插件)。
- 触碰 AI 基座(P0–P5b)——**保持不变**,市场层与其正交。

---

## 9. 对现有代码的影响摘要(落地锚点)

| 现有文件/包                      | 变化                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `marketplace-registry.ts`        | 从「唯一数据源」降级为「公开快照读取器」;`MarketplaceEntry` 扩展 owner/stats 字段 |
| `install-from-package.ts`        | 基本不动;安装前增加权限展示钩子(UI 调用)                                          |
| `packages/plugin-cli`            | 新增 `login`/`publish`/`whoami`/`visibility`/`yank`                               |
| `create-synapse-plugin/template` | README 增加「发布到市场」指引;`release.yml` 可保留为「GitHub Release 兜底分发」   |
| `src/renderer/src/components/`   | 新增 市场页 / 我的插件页 / 账户 / 评分组件                                        |
| `src/main/ipc/`                  | 新增 `market.ts`(四段式);token 存主进程凭据库                                     |
| `packages/`(新)                  | `marketplace-server`、`marketplace-types`                                         |

---

## 10. 决策记录

- **2026-06-05**:**后端形态 = C(全平台)** 拍板。终局为完整市场平台:桌面端 + Web 门户(M6)+ 审核流水线(M7)+ 组织/协作者(M8)+ 付费分成(M9)。新增 `marketplace-server`(Node+TS)+ Postgres + 对象存储 + GitHub OAuth;公开走静态快照兜底。实现按三波次推进:内核 M0–M4 → 治理+门户 M5–M7 → 商业化 M8–M9。
- **2026-06-05**:**后端为唯一权威数据源**。现有「手工维护的 GitHub 静态 `registry.json`」(`WiIIiamWei/Synapse-Marketplace`)是协作者时代的占位桩,**计划 C 中整体退役**。浏览/搜索/发布/私人公开/下载量/评分全部走后端 API。
- **2026-06-05**:**保留「后端自动生成的只读快照」作为离线/容灾兜底**。该快照由后端定时导出到 CDN,**非手工 JSON**——是权威数据源的影子,不是数据源本身。`marketplace-registry.ts` 改造为「快照读取器」并把 URL 改为**可配置**(去掉硬编码 `DEFAULT_MARKETPLACE_REGISTRY_URL`)。
- **2026-06-05**:项目现由单人开发(`sunzrnobug`);前协作者 `WiIIiamWei` 名下的注册表仓库不再作为权威源。**建议建 GitHub Org** 统一持有 app / 后端 / 快照仓库(待确认)。
- **2026-06-05**:**栈 = 解耦组合**拍板。**Fastify + Drizzle + zod**(API/ORM/校验)、**Neon**(Postgres)、**Cloudflare R2**(对象存储,出流量免费)、**Fastify 自管鉴权**(GitHub OAuth 起步 + provider 无关 `User⇄AuthIdentity` 身份表 + CLI device-code)。理由:契合零原生/TS-first 基线;C 平台后期付费/组织/审核权限不被 Supabase RLS 绊住;单人运维成本可控。
- **2026-06-05**:**归属 = GitHub Org `J-C-Lab`**。app + `marketplace-server` + 快照仓库统一收编进 `J-C-Lab`;前协作者 `WiIIiamWei` 注册表退役。**品牌名暂定 Synapse**(真实域名待注册,需查商标/可用性)。
- **2026-06-11**:仓库已转移到 `J-C-Lab/Synapse`(原 `sunzrnobug/Synapse` 重定向);本地 `origin` 已改指新地址。
- **2026-06-05(M1)**:**会话采用「不透明 token + DB」而非 JWT**。只存 token 的 SHA-256,撤销=删行,无签名密钥管理——对 §2.1「JWT 签发/刷新」的实现细化。如未来需无状态/跨服务校验再引入 JWT 访问令牌。
- **2026-06-05(M1)**:**测试数据库 = pglite**(进程内 WASM Postgres),生产 = node-postgres 对 Neon。同一 Drizzle schema + 迁移两边通用;集成测试零外部依赖。
- _(待定,不阻塞 M0)_:§7 第 5–8 项——私人包存储/同步、审核策略、评级算法、成本合规,各在对应阶段前定。

---

## 11. M0 成果(已落地,2026-06-05)

**领域模型 + API 契约**,纯类型 / zod 校验,**零运行时**。新增 pnpm workspace 包 `@synapse/marketplace-types`(`packages/marketplace-types/`),作为后端 / CLI / 桌面端 / Web 门户的**单一事实源**——zod schema 权威,TS 类型由 `z.infer` 派生(不手写双份、不漂移)。

| 文件                | 作用                                                                                                                                                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/common.ts`     | 共享原语:`pluginId`(反向域名)/ `handle` / `semver` / `sha256` / `timestamp`(ISO)/ `httpsUrl` / `localizedString` + 枚举 `visibility`/`userRole`/`pluginStatus`/`pluginSort`/`authProvider`                                                                           |
| `src/domain.ts`     | 实体:`User`、`AuthIdentity`(provider 无关身份)、`Plugin`(含 `visibility`/`stats`/`status`)、`PluginVersion`(不可变,`manifestSnapshot` 复用 `@synapse/plugin-manifest` 的 `manifestSchema`、支持 `yankedAt`)、`Download`/`Rating`/`Review`、`PluginSummary`(列表投影) |
| `src/api.ts`        | HTTP 契约:device-code 鉴权(`discriminatedUnion` pending/authorized)、搜索(分页+排序)、详情、发布(metadata + 嵌套 manifest)、可见性/yank、下载解析(签名 URL + sha256)、评分/评价、统一 `apiError` 信封                                                                |
| `src/index.ts`      | 桶导出(schema + 推导类型)                                                                                                                                                                                                                                            |
| `src/index.test.ts` | 20 条契约用例:id/handle/sha256/visibility 校验、strict 拒未知键、嵌套 manifest 校验、评分 1–5 边界、搜索默认值、device-code 判别联合                                                                                                                                 |

**关键不变量(M1+ 必须遵守)**

- **schema 是唯一事实源**:任何字段变更改 zod,类型自动跟随;**不要**手写并行 interface。
- **身份 provider 无关**:`User ⇄ AuthIdentity{provider, providerUserId}`,加 Google/邮箱不迁 user 表。
- **版本不可变**:坏版本 `yankedAt` 撤回,**不物理删**,保安装可复现。
- **manifest 单源**:`PluginVersion.manifestSnapshot` 与 `PublishRequest.manifest` 直接复用 `manifestSchema`——发布校验与安装前权限披露,与插件宿主运行期强制的规则一致。
- **所有对象 schema `.strict()`**:拒未知键,契约收紧。

**质量基线**

- 接入仓库工具链:`vitest.config.ts` + `tsconfig.node.json` 已加 `@synapse/marketplace-types` 别名;`package.json` 的 `build:packages` / `typecheck` 链已纳入本包(依赖 `plugin-manifest`,排在其后构建)。
- `pnpm lint` ✅ · `pnpm typecheck` ✅ · `pnpm test` **412 passed**(原 392 + M0 新增 20)。

---

## 12. M1 成果(已落地,2026-06-05)

**后端骨架 + 鉴权闭环**。新增 pnpm workspace 包 `@synapse/marketplace-server`(`packages/marketplace-server/`):Fastify + Drizzle 服务,消费 M0 的 `@synapse/marketplace-types` 做请求/响应校验。**全程零外部凭据可测**——生产用 node-postgres(对 Neon),测试用 pglite(进程内 WASM Postgres),GitHub 身份用可注入端口(测试注入 fake)。

| 区域                              | 内容                                                                                                                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db/schema.ts`                    | **全量 9 张表** Drizzle schema(users / auth_identities / sessions / device_codes / plugins / plugin_versions / downloads / ratings / reviews),列形与 marketplace-types 对齐;`drizzle/` 生成迁移 SQL(已提交) |
| `db/client.ts`                    | 驱动无关 `MarketplaceDb` 类型 + node-postgres 工厂;`db/migrate.ts` 生产迁移脚本                                                                                                                             |
| `auth/github.ts`                  | `IdentityProvider` 端口 + GitHub OAuth 实现(code→token→/user);可注入,测试用 fake 不触网                                                                                                                     |
| `services/`                       | `UserService`(按身份 upsert + handle 去重)、`SessionService`(不透明 token,仅存 SHA-256,可撤销)、`DeviceCodeService`(RFC 8628 式 start/approve/poll,一次性消费)                                              |
| `routes/`                         | `GET /health`(探活+DB ping)、`POST /auth/device/{start,approve,poll}`、`GET /session`(whoami,Bearer 鉴权);统一 `apiError` 信封                                                                              |
| `app.ts`                          | `buildApp(deps)` 依赖注入装配(db / github / config / clock),生产与测试共用同一工厂                                                                                                                          |
| `test/harness.ts` + `app.test.ts` | pglite 集成测试(单实例 + 每用例 truncate);**10 条**:健康检查、完整 device 流、单次消费、未知码、入参校验、whoami、缺/错 token、身份幂等、handle 去重                                                        |

**关键决策 / 不变量(M2+ 注意)**

- **栈落地**:Fastify(长驻)+ Drizzle + zod;ORM 选 Drizzle(纯 JS 无原生引擎);DB 测试 pglite、生产 node-postgres(对 Neon 走标准 PG 协议)。
- **会话 = 不透明 token + DB**(非 JWT):仅存 token 的 SHA-256,撤销=删行,无签名密钥管理。(对 design §2.1「JWT」的实现细化,已在决策记录登记。)
- **身份 provider 无关**:`users ⇄ auth_identities`,GitHub 起步,加 Google/邮箱不迁 user 表。
- **DI 装配**:一切经 `buildApp(deps)` 注入(db/github/clock),故无需真实 Neon/R2/GitHub 即可全量测试;`now` 可注入做确定性过期测试。
- **时间**:DB 存 `timestamptz`(JS `Date`),在 mapper 边界 `toISOString()` 转 marketplace-types 的 ISO 字符串,并经 zod 复核响应契约。
- **改了 schema 必须**`pnpm -F @synapse/marketplace-server db:generate` 重新生成迁移。

**质量基线**

- 接入根工具链:root `typecheck` 链加入本包;root `pnpm test` 自动发现 pglite 集成测试(`// @vitest-environment node`)。
- 顺带修复一处**既有 flaky**:`plugin-sandbox.test.ts` 的默认沙箱超时 100ms→2000ms(只影响非超时用例;显式超时用例仍传小值)。CPU 高负载下 100ms 墙钟预算会偶发失败,与本次新增的 WASM 测试并发时暴露。
- `pnpm lint` ✅ · `pnpm typecheck` ✅ · `pnpm test` **422 passed**(M0 后 412 + M1 新增 10);连跑两次稳定。

---

## 13. M2 成果(进行中 —— 后端段已落地,2026-06-05)

**发布 / 浏览 / 下载的后端端点 + 测试**(M2 的「凭据无关段」)。在 `@synapse/marketplace-server` 上新增对象存储端口与插件服务;`.syn` 字节经可注入 `StorageProvider` 落地,测试用进程内 fake,**仍零外部凭据**。

| 区域                             | 内容                                                                                                                                                                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage/types.ts` + `memory.ts` | `StorageProvider` 端口(`put` / `signedDownloadUrl`)+ `InMemoryStorageProvider`(测试 / 本地 dev;返回合成 https URL)。R2 实现留待凭据段。                                                                                                                              |
| `lib/semver.ts`                  | `compareVersions`(发布单调性校验)                                                                                                                                                                                                                                    |
| `services/plugin-service.ts`     | `publish`(owner 校验 + 版本不存在且严格大于 latest + digest/size 校验 → 上传 → 写不可变版本 → upsert 插件 → 首发布升级 `developer`)、`search`(仅 public/active)、`listByOwner`、`getDetail`(私有仅 owner 可见,否则 404 不泄露)、`resolveDownload`(签名 URL + digest) |
| `routes/plugins.ts`              | `POST /plugins`(鉴权 + multipart:`metadata` JSON + `package` 文件)、`GET /plugins`(搜索)、`GET /plugins/mine`(鉴权)、`GET /plugins/:id`(详情,可选鉴权)、`GET /plugins/:id/versions/:version/download`                                                                |
| `mappers.ts`                     | 新增 `toPluginDto` / `toPluginSummaryDto` / `toPluginVersionDto`(行→契约,日期转 ISO 并经 zod 复核)                                                                                                                                                                   |
| `routes/plugins.test.ts`         | **11 条** pglite 集成测试:发布建插件+版本+升级 developer、匿名拒绝、digest 不符、版本单调/重复(409)、跨 owner 发布(403)、搜索仅公开、详情含版本、私有可见性(owner/anon/他人)、myPlugins、下载签名 URL、私有下载 404                                                  |

**关键不变量(凭据段 / M3 注意)**

- **发布顺序**:先 upsert `plugins` 行再插 `plugin_versions`(满足 FK)。
- **存储端口契约**:key 形如 `plugins/<id>/<version>/<id>-<version>.syn`;`put` 与 `signedDownloadUrl` 用同一 key 推导。R2 实现只需实现该端口,路由/服务无需改。
- **可见性裁决**集中在 `PluginService.canView`:`removed`→不可见;`public`→所有人;`private`→仅 owner。下载/详情共用。
- **multipart**:`@fastify/multipart`,单文件、上限 50MB;`metadata` 字段为 JSON 串,经 `publishRequestSchema` 校验。
- **下载计数 / 评分**仍属 **M4**:`resolveDownload` 暂不自增 `downloads`。
- **搜索**为 M2 基础版:`q` 匹配 id + displayName(jsonb 转文本 ILIKE);排序 downloads/rating/recent;全文检索留待后续。

**凭据段进展**

- ✅ **R2 `StorageProvider` 实现**(@aws-sdk/client-s3 + 预签名)+ `createStorage` 工厂(按 R2\_\* env 切换,缺则 InMemory dev 兜底);index.ts 已接。**已对真实 R2 桶端到端验证**(put→presign→fetch→字节一致)。
- ✅ **Neon 接通**:`db:migrate` 已对真实 Neon 建好 9 张表;真实 `.env` 启动服务 `/health` 返回 ok(对 Neon 跑通 `select 1`)。
- ✅ **CLI**(`@synapse/plugin-cli`):`login`(device-flow:开浏览器→轮询→token 交给系统 credential helper 持久化)/ `logout` / `whoami` / `publish`(复用 `buildPlugin` → 算 sha256 → multipart 调 `POST /plugins`)。token 解析顺序 `--token-stdin` > `SYNAPSE_TOKEN` > 已登录存储。**安全修复(2026-07-22)**:token 不再明文落盘——`~/.synapse/config.json` 只存非敏感元数据(`credentialId`),真正的密钥经 `credential-helper/`(macOS Keychain / Windows DPAPI / Linux `secret-tool`,零原生依赖)存取;所在平台没有可用 helper 时 `login` 直接失败,不降级明文。`MarketplaceClient`(可注入 fetch)+ 命令逻辑全部依赖注入,单测覆盖 account-commands + credentials-store + 三平台 credential-helper。
- ✅ **GitHub 浏览器登录腿**:`/auth/device/start` 的 `verificationUri` 改为 GitHub 授权 URL(userCode 走 `state`);新增 `GET /auth/github/callback`(换 token→upsert 用户→approve 设备授权→返回成功 HTML)。
- ✅ **真实端到端冒烟通过**(2026-06-05):`login`(浏览器 GitHub 授权,登录为 `sunzrnobug`)→ `publish --public`(样例 `com.synapsetest.hello@1.0.0`)→ `GET /plugins` 列出 → 详情含版本 + R2 packageUrl → `whoami` 角色升为 `developer` → 解析签名下载 URL → 从 R2 取回 689 字节,**sha256 与发布时一致**。**M2 完成。**

**质量基线**

- 顺带修一处**既有 flaky**:`plugin-sandbox.test.ts` 的「times out a tool」用例把 load/invoke 预算 100ms→2000ms(只测 5ms 工具超时);并在 `vitest.config.ts` 加 `maxWorkers`(核数 70%)上限,给 CPU 密集套件(pglite WASM / LAN TLS / vm 墙钟超时)留调度余量,消除并发竞争 flaky。
- `pnpm lint` ✅ · `pnpm typecheck` ✅ · `pnpm test` **446 passed**(M1 后 422 + M2 后端 11 + GitHub 回调 1 + CLI 12)。

---

## 14. M3 成果(已落地,2026-06-05)

**桌面端市场页接入后端**(凭据无关)。把现有 marketplace 页从静态 registry 演进为后端 API 驱动:搜索 / 详情 / **安装前权限与工具披露** / 经签名 URL 校验 sha256 安装。

| 区域                                           | 内容                                                                                                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/plugins/marketplace-api.ts` (新)     | 后端客户端 `createMarketplaceApi`(`search`/`detail`/`resolveDownload`),baseUrl 走 `SYNAPSE_MARKETPLACE_URL` 可配置,可注入 fetch;`MarketplaceApiError`。6 条单测         |
| `plugin-host.ts`                               | `searchMarketplace`/`marketplaceDetail`/`installFromMarketplace`(resolveDownload→fetch→**sha256 校验**→复用 staged install + id/version 检查);`downloadVerifiedPackage` |
| `ipc/plugins.ts` + preload + `lib/electron.ts` | 新增 `marketplace:search`/`detail`/`backend-install` 三段式通道 + 包装;旧静态 `marketplace:list/install` 保留作兜底                                                     |
| `pages/marketplace-page.tsx`                   | 重写:防抖搜索 → `PluginSummary` 卡片 → 详情 Dialog(**权限徽章 + AI 工具列表 + 版本历史**)→ 安装(经后端、装好刷新)。3 条页面集成测试                                     |
| i18n + tsconfig.web                            | `marketplace.detail.*` / `by` / `viewDetails`(en/zh-CN);web tsconfig 加 marketplace-types / plugin-manifest 路径                                                        |

**关键不变量 / 说明**

- **后端为数据源**:页面走 `search`/`detail`;旧静态 registry 路径(`listMarketplacePlugins`/`installMarketplacePlugin`)保留但页面不再使用,作离线兜底,待 §2.1「快照读取器」整合。
- **安装即信任披露**:安装前在详情 Dialog 展示该版本 `manifestSnapshot` 的 `permissions` 与 `contributes.tools`(对应设计「权限透明」)。
- **完整性**:`installFromMarketplace` 对下载字节做 sha256 校验(后端为权威 sha256 源),再走与其它安装路径一致的暂存解包 + id/version 校验。
- **遗留增强**:桌面端账户登录(系统浏览器 OAuth + loopback)以拉取**私人**插件、以及评分 UI(M4)未做;当前页面仅浏览公开插件。
- 一处小遗留:详情 Dialog 的 `useEffect` 有 4 条 `react/set-state-in-effect` **warning**(非 error,不阻塞 lint),后续可清理。

**质量基线**

- `pnpm lint` ✅(0 error)· `pnpm typecheck` ✅ · `pnpm test` **455 passed**(M2 后 446 + 后端客户端 6 + 页面 3);连跑两次稳定。

---

## 15. M4 成果(已落地,2026-06-05)

**下载量 + 评分 + 评论 + 排行**(后端为主,凭据无关,pglite 全测)。第一波内核「登录 → 发布 → 浏览安装 → 评分」就此闭合。

| 区域                   | 内容                                                                                                                                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin-service.ts`    | `recordDownload`(写 `downloads` 事实表 + 自增 `plugins.downloads`;**authed 用户 1 小时窗口去重**,匿名每次计)— 在 `resolveDownload` 内触发;`rate`(upsert 评分 → `avg/count` 聚合回写 `plugins`)、`upsertReview`、`listReviews`、`getRating`;`getDetail` 带 `myRating` |
| 排行                   | `relevance` 排序改为 popularity 评分 `ratingAvg·ln(ratingCount+1) + ln(downloads+1)`(log 阻尼,避免单条 5 星压过广装好评插件);`downloads`/`rating`/`recent` 各自排序                                                                                                  |
| `routes/plugins.ts`    | `PUT /plugins/:id/rating`(鉴权)、`GET /plugins/:id/reviews`(分页)、`POST /plugins/:id/reviews`(鉴权);详情返回 `myRating`                                                                                                                                             |
| `mappers.ts`           | `toRatingDto` / `toReviewDto`                                                                                                                                                                                                                                        |
| 桌面端                 | 详情 Dialog 只读展示 `★ avg (count)`(评分**提交** UI 待桌面登录)                                                                                                                                                                                                     |
| `ratings.test.ts` (新) | **8 条** pglite 集成测试:匿名计数、authed 窗口去重、评分需鉴权、跨用户聚合 + myRating、评分 upsert、评未知插件 404、评论建/改/列、downloads 排序                                                                                                                     |

**关键不变量 / 说明**

- **下载计数**:`resolveDownload` 现有副作用——每次解析签名 URL 记一次下载;authed 用户窗口内去重,匿名每次计(更强的 IP/速率防刷属 M7)。
- **评分**:每用户每插件唯一(`onConflictDoUpdate`),聚合实时回写 `plugins.ratingAvg/ratingCount`;评分/评论要求 `canView`(私有仅 owner)。
- **遗留**:桌面端**账户登录**未做,故 app 内无法提交评分(只读展示);评级的时间衰减、精选位、排行榜页留作后续。

**质量基线**

- `pnpm lint` ✅(0 error,4 个 M3 遗留 warning)· `pnpm typecheck` ✅ · `pnpm test` **463 passed**(M3 后 455 + M4 新增 8);连跑两次稳定。

> 第一波内核(M0–M4)完成。下一步可选:**桌面端账户登录**(解锁私人插件浏览 + app 内评分提交),或进入**第二波**——M5 治理(可见性切换/yank/举报/下架)、M6 Web 门户、M7 审核流水线。

---

## 16. 桌面端账户登录(已落地,2026-06-11)

补齐 M3/M4 在 app 内的体验缺口:桌面端可**登录**(复用 device-flow)、**浏览私人插件**(请求自动带 token)、**app 内提交评分**。凭据无关(复用已验证的后端鉴权),account-service 纯逻辑单测。

| 区域                                                    | 内容                                                                                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `marketplace/token-store.ts` (新)                       | 会话 token 加密落盘(复用 `SecretProtector`/safeStorage),**仅主进程**,renderer 永不接触                                                         |
| `marketplace/account-service.ts` (新)                   | `login`(deviceStart → 开系统浏览器 → 轮询 → 存 token → 返回 user;`onPrompt` 回推 URL+码)、`logout`、`status`(401 自动清 stale token)。7 条单测 |
| `plugins/marketplace-api.ts`                            | 加 `getToken`(每请求带 `Authorization`)+ `session`/`rate`/`deviceStart`/`devicePoll`;host 的 `fetch` 拓宽支持 `init`(POST/headers)             |
| `plugin-host.ts`                                        | `marketplaceGetToken` 注入到 api(登录态下 browse/detail/install 自动带 token,owner 可见私有)+ `rateMarketplace`                                |
| `ipc/marketplace.ts` (新) + preload + `lib/electron.ts` | `market:status`/`login`/`logout`/`rate` + `market:login-prompt` 事件;index 装配 `accountService`、`marketplaceGetToken`、广播                  |
| `pages/marketplace-page.tsx`                            | 头部 `AccountControl`(登录/退出 + 登录时 toast 提示 URL/码);详情 Dialog 在登录态显示 `RatingControl`(★ 提交,即时刷新 stats/myRating)           |
| i18n                                                    | `marketplace.account.*` / `marketplace.rate.*`(en/zh-CN)                                                                                       |

**关键不变量 / 说明**

- **token 仅主进程**:加密落盘,IPC 只回 `{user}` / 操作结果,token 永不过桥到 renderer(与 AI key 同基线)。
- **登录态自动透传**:host 的 marketplace api 用 `marketplaceGetToken`,故登录后 detail 自动含 `myRating`、私有插件对 owner 可见、下载归属到用户(参与窗口去重)。
- **device-flow 复用**:桌面端与 CLI 共用后端 `/auth/device/*` + `/auth/github/callback`;主进程用 `shell.openExternal` 开系统浏览器,`market:login-prompt` 把 URL+码回推给 renderer 兜底显示。
- **真实端到端**:GitHub 浏览器授权那一步仍需人工点一次(代码就绪);account-service 逻辑 + 后端鉴权均已分别测过。

**质量基线**

- `pnpm lint` ✅(0 error,4 个 M3 遗留 warning)· `pnpm typecheck` ✅ · `pnpm test` **470 passed**(M4 后 463 + 账户 7);连跑两次稳定。

> 第一波内核 + 桌面端账户全部就绪。下一步进入**第二波**:M5 治理(可见性切换 / yank / 举报 / admin 下架 / 可信源开关)、M6 Web 门户、M7 审核流水线。

---

## 17. M5 治理(后端已落地,2026-06-11)

**治理后端**:可见性切换、版本撤回(yank)、举报、admin 下架。后端为主、pglite 全测、零凭据。

| 区域                       | 内容                                                                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `marketplace-types`        | 新增 `reportRequestSchema`(复用已有 `setVisibilityRequestSchema` / `yankRequestSchema`)                                                                                     |
| `db/schema.ts` + 迁移 0001 | 新增 `reports` 表(id / pluginId / reporterUserId / reason / status open\|reviewed\|dismissed / createdAt);已对 Neon 应用                                                    |
| `plugin-service.ts`        | `setVisibility`(owner)、`yankVersion`(owner;标 `yankedAt`+`yankReason`,**重算 latestVersion** 排除已撤回)、`report`(可见即可报)、`adminRemove`(role=admin → status=removed) |
| `routes/plugins.ts`        | `PATCH /plugins/:id/visibility`、`POST /plugins/:id/yank`、`POST /plugins/:id/report`、`POST /plugins/:id/remove`(均鉴权;owner/admin 校验)                                  |
| `governance.test.ts` (新)  | **8 条**:可见性切换 + 隐藏 + 非 owner 403、yank 重算 latest + 撤回版本下载 404 + 非 owner 403、举报 201 + 未知 404、admin 下架(非 admin 403 / admin 隐藏全站)               |

**关键不变量 / 说明**

- **yank 不删**:仅标 `yankedAt`,已装可复现;`latestVersion` 从非撤回版本重算;撤回版本 `resolveDownload` 返回 404。
- **admin 下架**:`status="removed"` 墓碑,`canView` 一律不可见(搜索/详情/下载全隐藏),不物理删。
- **admin 角色**:暂无自助路径(手动改 `users.role`);测试直接置库。
- **可见性裁决**仍集中在 `PluginService.canView`。

**遗留(M5 续作)**

- 桌面端**治理 UI**:「我的插件」管理页(可见性切换 / yank 按钮)、举报入口、admin 控制台。
- **可信源开关**(桌面设置:仅官方市场 / 任意 URL / 仅本地 .syn),属客户端策略,后续单独做。

**质量基线**

- `pnpm lint` ✅(0 error)· `pnpm typecheck` ✅ · `pnpm test` **478 passed**(账户后 470 + 治理 8);连跑两次稳定。

> 第二波继续:**M6 Web 门户**(复用 docs 的 Next/Fumadocs 栈)或 **M7 审核流水线**(消费 §17 的 `reports` 表)。

---

## 18. M5 桌面治理 UI + 可信源(已落地,2026-06-11)

把 §17 的治理后端接入桌面端,并加上客户端可信源策略。

| 区域                                          | 内容                                                                                                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| main api/host/ipc/preload + `lib/electron.ts` | `myPlugins` / `setVisibility` / `yank` / `report` / `adminRemove` 直通(host→`marketplaceApi`,登录态自动带 token);`MARKETPLACE_ERROR` IPC 错误码透传 403/409 等                   |
| `pages/marketplace-page.tsx`                  | **浏览 / 我的 / 管理** 三标签:「我的」列 owner 插件 + 可见性切换;详情 Dialog 加 **举报**(任意登录)、**yank**(owner,按版本)、**下架**(admin);「管理」标签仅 `role==="admin"` 可见 |
| `settings/settings.ts`(重构)                  | 旧 launcher 设置抽成模块 + 新增 `trustedSourcePolicy`(official-marketplace / any-url / local-syn);`normalizeSettings` 向后兼容                                                   |
| `components/trusted-source-settings.tsx`      | 设置页可信源开关(radio)                                                                                                                                                          |
| 客户端强制                                    | `marketplace-page` 在 `local-syn` 下禁用市场安装;`plugins-page` 在 `official-marketplace` 下禁用本地 `.syn` 导入(用户自身策略,非安全边界)                                        |

**说明 / 不变量**

- **admin 双重校验**:UI 仅对 admin 显示「管理」标签,后端 `adminRemove` 仍校验 `role==="admin"`(防御纵深)。
- **可信源 = 客户端策略**:在自己机器上对自己生效,故只做客户端 UI 门控;无需服务端介入。
- 所有治理写操作经 `MARKETPLACE_ERROR` 把后端 owner/admin 拒绝(403)等如实回显到 UI。

**质量基线**

- `pnpm lint` ✅(0 error)· `pnpm typecheck` ✅ · `pnpm test` **493 passed**(治理后 478 + 桌面 UI/可信源/设置重构相关 +15);连跑两次稳定。

> M5 全部完成。第二波继续:**M6 Web 门户** 或 **M7 审核流水线**(消费 `reports` 表)。

---

## 19. M7 审核流水线(后端已落地,2026-06-11)

**审核后端**:上传自动扫描(敏感权限分级)→ 自动入队、admin 审核队列 + 报告状态机、下架/恢复。后端为主、pglite 全测、零新凭据。

| 区域                                       | 内容                                                                                                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `marketplace-types`                        | `reportKind`(user\|auto)/`reportStatus`(open\|reviewed\|dismissed)枚举、`reportSchema` 实体、`adminReportsResponseSchema` / `resolveReportRequestSchema` |
| `db/schema.ts` + 迁移 0002                 | `reports` 表加 `kind`,`reporterUserId` 改可空(支持系统自动报告);已对 Neon 应用                                                                           |
| `lib/risk.ts` (新)                         | `assessManifestRisk`(纯函数,只读 manifest):`system:*` 前缀 / `clipboard:write` / 工具 `destructiveHint` → high + 原因列表。3 条单测                      |
| `plugin-service.ts`                        | 发布后 `autoFlag`(high → 建一条 `kind:"auto"` open 报告,按插件去重);`listReports`/`resolveReport`(admin)、`adminRestore`(admin)                          |
| `routes/plugins.ts`                        | `GET /admin/reports?status=`、`POST /admin/reports/:id/resolve`、`POST /plugins/:id/restore`(均 admin 校验)                                              |
| `mappers.ts`                               | `toReportDto`                                                                                                                                            |
| `risk.test.ts` + `moderation.test.ts` (新) | **8 条**:风险分级(low/system/destructive)、高风险发布自动入队 + 普通不入队、队列需 admin(403)、解决报告后从 open 队列移除/转 reviewed、下架后恢复可见    |

**状态机映射 / 说明**

- 设计的「pending/approved/rejected」落到:**报告 open = 待审**;`reviewed`/`dismissed` = 已处理;**下架** = plugin `status=removed`(可 `restore` 回 active)。「先发后审」:发布即上架,自动扫描只把高风险**入队**,不阻断上架。
- **自动报告**:`reporterUserId` 为空、`kind:"auto"`、`reason` 含触发的敏感项;同插件已有 open 自动报告则不重复建。
- **admin 双重校验**:所有 admin 端点服务层再校验 `role==="admin"`。
- **遗留**:桌面/Web 的 **admin 控制台 UI**(审核队列页)待续;扫描规则可继续扩充(目前是保守的权限/注解启发式)。

**质量基线**

- `pnpm lint` ✅(0 error)· `pnpm typecheck` ✅ · `pnpm test` **501 passed**(M5 UI 后 493 + M7 新增 8);连跑两次稳定。

> 第二波剩 **M6 Web 门户**;M7 的 admin 控制台 UI 可作为 M7 续作。第三波 M8 组织 / M9 付费按需。

---

## 20. M7 admin 控制台 UI(已落地,2026-06-11)

把 §19 的审核队列接进桌面端「管理」标签,闭合 M7。

| 区域                                          | 内容                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| main api/host/ipc/preload + `lib/electron.ts` | `adminReports(status?)` / `resolveReport(id,status)` / `adminRestore` 直通(登录态带 token);`market:admin-reports`/`resolve-report`/`restore` 通道 |
| `pages/marketplace-page.tsx`                  | 「管理」标签顶部新增 `ReviewQueue`:列 open 报告(插件 id 可点开详情、`user`/`auto` 徽章、原因)+ **标记已处理 / 忽略** 按钮;下方保留下架网格        |
| i18n                                          | `marketplace.review.*` + `governance.reportResolved`(en/zh-CN)                                                                                    |
| 测试                                          | 页面新增 1 条:admin 进「管理」→ 看到自动扫描报告 → 标记已处理调用 `resolveReport(id,"reviewed")`                                                  |

**说明**

- 队列只拉 `status=open`;解决后从列表移除(后端转 reviewed/dismissed)。报告里的插件 id 可点开详情弹窗,admin 可在那里直接下架。
- `adminRestore` 通道也接好了(撤销下架),UI 入口可后续按需加。

**质量基线**

- `pnpm lint` ✅(0 error)· `pnpm typecheck` ✅ · `pnpm test` **502 passed**(M7 后端后 501 + 审核队列 UI 1)。

> **M7 全部完成。** 第二波只剩 **M6 Web 门户**(复用 docs 的 Next/Fumadocs 栈);第三波 M8 组织 / M9 付费按需。

---

## 21. M6 Web 门户(已落地,2026-06-11)

**浏览器端公开市场门户**,复用 `docs` 的 Next 16 + Fumadocs + Tailwind v4 栈。无需登录,只读后端公开 API。

| 区域                                      | 内容                                                                                                                                                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/lib/marketplace.ts` (新)            | 只读门户客户端:`fetchPlugins(q?)` / `fetchPlugin(id)`(RSC server fetch + `revalidate:60` ISR;404→null)、`localize`、`marketplaceApiBase`(`MARKETPLACE_URL` env 可配)。复用 `@synapse/marketplace-types`。8 条单测 |
| `docs/app/marketplace/page.tsx` (新)      | 列表 + 搜索(GET 表单):公开插件卡片(名称/描述/作者/下载/★)链到详情;API 不可用时优雅降级                                                                                                                            |
| `docs/app/marketplace/[id]/page.tsx` (新) | 详情:描述 + owner + 版本历史 + **权限/工具披露** + 统计;`generateMetadata` 出 SEO title/description;404→`notFound()`                                                                                              |

**说明**

- **后端为源**:门户读 `GET /plugins` / `GET /plugins/:id`(仅公开+active);与桌面端同一公开 API。
- **SEO / 可分享**:每个插件有独立可索引 URL `/marketplace/<id>`,带 metadata。
- **部署**:`MARKETPLACE_URL` 指向生产后端;门户随 docs 站点部署(需域名,见 §7 待定项)。
- 路由为动态 SSR(读 API),`next build` 通过(`/marketplace`、`/marketplace/[id]` 均 ƒ Dynamic)。

**质量基线**

- `pnpm lint` ✅(0 error)· `pnpm -F docs typecheck` ✅ · `pnpm -F docs build` ✅ · `pnpm test` **510 passed**(M7 后 502 + 门户 8)。

> **第二波(M5–M7)+ M6 全部完成。** 整个市场平台:契约→后端→CLI 发布→桌面端(浏览/账户/评分/治理/审核)→Web 门户。第三波 **M8 组织 / M9 付费** 按商业化节奏再上;运维待 §7 域名/部署落地。

---

## 22. PR #1 审查 + 安全加固(2026-06-11)

合并前对 PR #1 做了完整审查(鉴权/治理/存储/桌面端逐行)。结论可合并;按审查里的两条"中等"建议在分支上直接补掉:

| 加固                            | 实现                                                                                                                                                                                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **全局 + 路由级限流**           | 引入 `@fastify/rate-limit`,`buildApp` 内按 IP 限流。全局上限 `RATE_LIMIT_MAX`(默认 300/min);auth/写接口收紧:device `start`/`approve` 20、`poll` 60(容纳 5s 轮询 15min)、`publish` 30、`report` 20。路由在子插件内注册以保证 onRoute hook 生效;超限统一走 `rate_limited` 错误信封(429)。 |
| **关闭 `/auth/device/approve`** | 该编程审批端点绕过浏览器/CSRF,仅供测试与非浏览器流。新增 `ENABLE_DEVICE_APPROVE_ENDPOINT`(默认 **false**),生产不注册 → 404;真实登录只走 GitHub 回调。harness 默认开启以复用为测试登录助手。                                                                                             |

**配置**:`config.ts` 新增 `RATE_LIMIT_ENABLED`(默认 true)、`RATE_LIMIT_MAX`(300)、`ENABLE_DEVICE_APPROVE_ENDPOINT`(false);`envBool` 正确解析字符串布尔(规避 `z.coerce.boolean("false")===true` 坑)。`.env.example` 已补注释。

**测试**:`routes/security.test.ts`(approve 未启用→404 / 启用→200;超限→429 且 `error.code==="rate_limited"`;harness 默认不限流)+ `config.test.ts` 新增 2 条标志解析。

**质量基线**:`pnpm lint` ✅(0 error)· `pnpm typecheck` ✅ · marketplace-server **55 passed**(+5)。

> 审查里"低/信息"项(下载/举报无索引、search 全表扫、resolveDownload 先记后签)留作后续性能债;运维仍待轮换聊天里贴过的 OAuth secret / Neon 密码 + §7 域名部署。
