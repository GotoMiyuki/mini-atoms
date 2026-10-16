# Mini Atoms v0.1 — Design & Implementation Guide

> **状态：Architecture FROZEN v0.1 · M1/M2 implementation authorized（非公开部署许可）**  
> **冻结日期：2026-10-14**  
> **架构基线：改良方案 B — LLM 直接生成 React/TSX + 固定依赖受控构建 + 隔离预览 + 独立真实验证**  
> **部署目标：阿里云 ECS 香港，Ubuntu 24.04，x86_64，2 vCPU / 4 GiB，Docker Compose**  
> **关联证据：** `M0-Spike-Report.md`、`M0-ECS-Validation-Report.md`、`M0.5-Spike-Report.pre-shell.md`、`M0.5-Spike-Report.md`。历史失败需保留，最新结论以 2026-10-14 的最终报告为准。

## 0. 文档地位与已知事实

### 0.1 依据与事实边界（已按 M0/M0.5 最新报告更新）

- 招聘笔试要求：可在线测试的网页 Demo；Agent 驱动代码（应用）生成并可视化展示；真实交互和数据持久化；提供公开访问链接及 GitHub；建议 3–4 小时专注开发，正式 48 小时提交期限依候选人与 HR 的约定执行。
- **M0 已 GO / ECS_VERIFIED**：可信固定 React fixture 在 Windows、Docker、阿里云 ECS 实测浏览器输入/点击/断言、PASS/FAIL/ERROR、Evidence、SSH 用户预览；报告：`M0-ECS-Validation-Report.md`。M0 的历史 `CLOUD_NOT_VERIFIED` 是旧状态，不得沿用。
- **M0.5 已 GO / ECS_VERIFIED**：在受限 TSX 源码、固定构建、`trusted-shell-v1` 外壳、独立 Playwright Worker 和分层隔离条件下，通过本地 Docker、真实阿里云 ECS 和 Windows 经 SSH 的用户预览测试。报告：`M0.5-Spike-Report.md`。
- **曾有真实 NO-GO**：直接顶层打开生成 HTML 时发生导航越界；批准并实施 `trusted-shell-v1` 后通过复验。保留修正前报告与原始失败证据，不得把此路径描述为从未失败。
- **未验证的范围**：真实 LLM 集成、数据库/正式 API、正式产品 UX、HTTPS/公开网关、匿名访问控制、长期容量与多用户并发，以及生产级隔离安全。M0.5 GO 不是它们的批准或验收。
- 文档将运行时的已实测**行为契约**冻结；测试中记录的镜像/文件 hash 用于证明当次运行身份，并非未来版本必须沿用的 Git SHA/注册表 digest。依赖更新必须重新运行受影响的 Gate。

### 0.2 最高优先级

**P0：可在线运行的完整产品闭环与真实证据；P1：有限自动修复；P2：视觉润色与其它扩展。** 不因增加架构完整性而牺牲 P0 交付。

### 0.3 不可变设计决定

1. **改良方案 B**：LLM **直接输出真实 React/TSX 源代码**，不是预定义 App IR、固定模板库或截图合成。
2. **自由度有限的是执行权限，不是前端业务逻辑**：允许自定义组件、Hooks、表单、列表、排序、筛选、状态管理；不允许任意后端、npm 安装、Vite 插件、Shell、外部网络调用。
3. 统一的应用工作流（Orchestrator），无复杂多 Agent 通信协议；Spec、Generator、Validator、Repair 是职责分工，不必映射为四个 Agent。
4. **LLM 不得宣称 PASS**：每条 PASS 必须关联真实浏览器中的操作、断言、具体代码版本和可检查证据。
5. **用户最终验收权独立于自动验证**。所有测试通过，只意味着“已覆盖验收条件通过”。
6. **M0 与 M0.5 均已实测 GO，但准入范围有限**：仅许可受控 M1/M2 开发；面向公众的实际生成/验证开放还需独立的 Release Gate。
7. **trusted-shell-v1 是唯一批准的 v0.1 Preview 契约**；裸生成 HTML 顶层访问必须拒绝，不得退回旧方案。

## 1. 产品定义和场景边界

### 1.1 一句话定位

> **Evidence-Driven App Builder**：根据自然语言直接生成可交互 React/TSX 应用，并将每条需求链接到浏览器真实验证记录。

### 1.2 面向的用户流程

1. 创建一个 Project，输入“做一个可以新增、完成、筛选任务的 Todo App”。
2. 系统生成可审阅的 Specification（需求、假设、可验证范围）。
3. 用户可修改关键验收要求；确认或直接使用默认方案后启动生成。
4. LLM 输出受文件白名单约束的 `.tsx` / `.css` 文件集合。
5. 固定工具链编译、输出静态产物和哈希；在隔离 Preview 中实际执行。
6. Validator 用浏览器输入/点击/断言，并产生明确的 PASS/FAIL/UNVERIFIED；运行时异常独立标记 ERROR。
7. 用户可查看需求、步骤、失败证据、截图与历史版本；选择接受、手动重新生成或限次自动修复。
8. 刷新页面后仍能打开 Project、生成版本和 Evidence。

### 1.3 MVP 的“支持”与“不支持”

| P0 支持 | v0.1 不支持 |
| --- | --- |
| 单页纯前端 React/TSX、自定义组件与 Hooks | 生成可在 ECS 执行的 Node/Python/Rust 后端 |
| 使用平台预装的 `react`、`react-dom`、少量批准依赖 | 用户或模型随意增删依赖、执行 npm scripts |
| 在内存中管理生成应用的交互状态 | 为每个生成应用建立独立后端数据库 |
| 需求追踪、基本测试动作、截图/Trace | 任意浏览器脚本或任意 shell 执行 |
| 保存项目、源文件、版本、验证证据 | 多租户 SaaS 的安全和可靠性保证 |
| 部署 Builder 并提供可测试在线链接 | 自动为每个生成应用部署独立网站 |

**数据持久化语义**：v0.1 首先承诺 Builder 的 Project/Spec/源码版本/测试结果能够持久保存；生成应用内部的 Todo 列表默认仅保留当前会话，除非某个生成能力额外实现并明确告知用户。不得混淆二者。

## 2. 组件拓扑与信任边界

### 2.1 逻辑组件

```text
Browser (user)
  ├─ Main UI (trusted origin)
  │      └─ API / Orchestrator ── LLM Provider (outbound, credentials server only)
  │                  ├─ SQLite + persisted Evidence
  │                  ├─ Controlled Build Worker (fixed toolchain)
  │                  └─ Job inbox/outbox (bounded local queue)
  └─ sandboxed iframe → Preview origin (untrusted React JS, static only)
                                    ↑
                     Validator Worker (Playwright Chromium)
                     └─ fixed-origin and allowlisted-test executor
```

这是**职责拓扑**，并不意味着必须部署大量常驻容器。推荐 Compose 区分：`app-api`（可信）、`compiler`（**独立无网络受限进程/容器，M0.5 已验证容器实现，不得在 app-api 进程直接执行不可信构建输入**）、`preview-static`（只读）、`validator`（非 root、独立隔离网络）、`reverse-proxy`（HTTPS）。可共享仓库与固定依赖，不意味着常驻运行全部 Worker；任务由可信 Controller 排队触发。

### 2.2 强制信任边界

- **Control Plane**：API、LLM Key、SQLite、项目元数据、内部任务控制；不得执行由模型提供的任意系统命令。
- **Generated Source**：完整不可信输入；即使 AST 校验通过也不视为安全代码。
- **Build Plane**：平台拥有并锁定构建工具/依赖/入口/插件；模型只能提交指定文件，构建阶段不运行模型提交的 npm 脚本。
- **Preview Plane**：只提供静态、版本化编译产物；不承载管理员凭据；浏览器 iframe 与 Main UI 严格隔离。
- **Validation Plane**：浏览器接触不可信预览；与 Control Plane 最小通信；没有数据库凭据及云访问凭据。

### 2.3 Preview 访问契约：`trusted-shell-v1`（已冻结）

1. **唯一用户直接入口**为可信固定外壳 `GET /preview/<version>`；Main 的嵌入式预览使用相同外壳（M0.5 中由 `/harness/<version>` 演示）。这里的 “direct” 指用户直接打开**外壳**，不是生成 HTML 裸页。
2. **生成 HTML 只能在外壳内部**的 `iframe sandbox="allow-scripts"` 运行；不包含 `allow-same-origin` / `allow-top-navigation` / `allow-popups` / `allow-downloads` / `allow-forms`。
3. 外壳使用限制性 `frame-src`，生成 HTML 同时施加 HTTP CSP `sandbox`、当前版本 script/style 资源白名单、默认拒绝连接和未授权资源/导航/表单行为；所有脚本资源绑定当前 version/build identity。
4. **裸生成 HTML 顶层访问必须拒绝**。M0.5 的具体守卫仅允许可信 URL 环境下浏览器原生 `Sec-Fetch-Dest=iframe`、`Sec-Fetch-Mode=navigate`、`Sec-Fetch-Site=same-origin`；缺失、跨站、错误模式、顶层加载返回 403（无生成应用内容）。这是辅助访问限制，不是用户身份认证/源码保密机制。
5. 验证器只能加载控制器给定版本：M0.5 中 `127.0.0.1:8765` 代理仅转发固定 preview:8080 的 GET 静态白名单，不接受任意 URL、API、Shell、凭据。**必须保留浏览器原生 Fetch Metadata 请求语义**；不得使用会把导航请求变成 `cors` 的通用 fetch 转发机制。校验浏览器实际加载的 HTML/JS/CSS 字节与 manifest 一致。
6. 开发可通过 localhost / 已限制的 SSH 隧道进入；公开部署前必须配置 HTTPS，重新验证浏览器 Fetch Metadata、CSP、iframe、反向代理及公网访问。不因 HTTP 下缺少该请求头而放宽拒绝规则。

M0.5 的验证证据并不能证明与主站同源部署在所有浏览器和真实认证配置中安全。最终 Main/Preview 域名、Cookie、跨源策略需在 **Release Gate** 用正式部署拓扑复测，不能仅以“不同端口”视作隔离。

## 3. Technology Baseline

| 领域 | v0.1 决策 |
| --- | --- |
| UI | React + TypeScript + Vite；尽量复用现成 UI 库，不扩张 |
| API | Node.js + TypeScript，HTTP JSON；可用 Express/Fastify 其一 |
| Data | SQLite（单进程写、事务）和持久化 Evidence 目录 |
| LLM | 服务端配置单一兼容 Provider，结构化输入与 JSON/文件输出；密钥不进入浏览器 |
| Generated code | React/TSX + CSS，固定框架入口与依赖 |
| Build | 独立无网络 `compiler`，可信 esbuild + 前置 TypeScript AST；固定依赖和文件白名单 |
| Preview | **trusted-shell-v1** 静态外壳 + sandbox iframe + CSP + 裸页顶层 403 |
| Verification | Playwright Chromium；结构化白名单执行器 |
| Deployment | ECS Ubuntu 24.04 + Docker Compose + HTTPS reverse proxy |
| Concurrency | 初始全局同一时刻最多一个资源密集生成/验证作业 |

**M0.5 已验证锁文件基线：** React/React DOM 19.3.0、esbuild 0.28.2、TypeScript 6.0.3、Playwright 1.64.0（容器内 Node 24.21.0、Chromium 156.0.8078.4）。依赖以 Spike lockfile 为准。后续新依赖、升级工具链或更改构建策略必须重新跑受影响的 T1–T4 / S1–S10 回归。

## 4. Contracts：Specification（字段级）

以 TypeScript 类型和 runtime schema validator（例如 Zod）共同实施；以下为规范性的逻辑形状，可增加实现细节但不得改变语义：

```ts
type VerifyMode = 'AUTOMATED' | 'MANUAL' | 'UNSUPPORTED';
type ReqPriority = 'MUST' | 'SHOULD';
interface Requirement {
  id: string;                       // 如 R1；在一个 Spec 内唯一且稳定
  text: string;
  priority: ReqPriority;
  verificationMode: VerifyMode;
  acceptance: string;               // 用户可以阅读和修改
  targetHints?: string[];           // 如 task-input/add-task；不是测试结果
}
interface Specification {
  schemaVersion: '0.1';
  specId: string;
  projectId: string;
  sourcePrompt: string;
  assumptions: string[];
  requirements: Requirement[];
  unsupported: string[];
  createdAt: string;                // ISO 8601
}
```

**约束**：一个请求最多形成合理数量（初始建议 3–8 条）的验收条件；歧义会实质影响结果时请求确认；Spec 在生成开始后不可原地修改。未支持的用户需求必须显式说明，不可悄悄丢弃。

## 5. Contracts：Generated Source / Build

### 5.1 LLM 输出格式

采用固定 JSON envelope，严格 Schema 校验：

```json
{
  "schemaVersion": "0.1",
  "files": [
    { "path": "src/App.tsx", "content": "import React from 'react';\nexport default function App() { return <main>Hello</main>; }" },
    { "path": "src/styles.css", "content": "main { padding: 1rem; }" }
  ],
  "summary": "简单页面"
}
```

仅接受预先允许的相对路径（如 `src/App.tsx`, `src/components/*.tsx`, `src/styles.css`）；拒绝 `..`、绝对路径、symlink、Unicode/大小写归一化后的冲突路径、隐藏配置文件、超限文件数与超限内容。**禁止**生成/修改 `package.json`、lockfile、构建配置、服务端文件、测试执行器、Shell 脚本及 Dockerfile。

### 5.2 固定入口与编译

- 平台提供可信的 `src/main.tsx` / `index.html`、依赖、TypeScript 和 esbuild 配置；模型写入 `App.tsx` 和白名单组件/样式。
- 采用可信构建插件/解析策略，只从内存或受控目录解析允许的源码、固定的已安装依赖和平台入口。拒绝未知 bare import、动态依赖解析、非批准插件及外部网络资源。
- 不执行 `npm install`、`npm run dev`、模型定义的 npm scripts，也不加载模型提供的构建插件。
- 静态检查用于改善生成质量和拒绝明显越界输入；**不宣称静态扫描能证明任意 JS 无恶意行为**。
- **M0.5 已实测限额，v0.1 初始保持不放宽**：最多 12 文件、每文件 64 KiB、源码合计 256 KiB、输出 1 MiB；构建上限 20 秒，独立编译进程 Node 堆 128 MiB、容器内存 512 MiB，且同一时间只运行一份编译。若真实 LLM 案例证明不足，必须提出可复现样例和资源证据，获批准并回归 T1/T3 后才能改变。
- 源码/依赖检查在构建前进行 TypeScript AST 解析，**包括仅在类型中引用或未被最终打包保留的 import**，防止 tree-shaking 消除非法导入造成漏检。
- 输出 `sourceSha256`、`buildSha256`、受控配置版本/hash 和构建日志；versionId 必须同时反映源码、构建产物和平台构建配置（字段/排序规范沿用 Spike）。源码不同即使产物相同也保留不同 source identity。
- 生成应用不得通过 JS/CSS/资源 URL 获得未经授权的外网访问。限制要由浏览器 CSP 与网络策略实施，不能仅靠字符串匹配。

### 5.3 AppVersion

```ts
interface AppVersion {
  id: string;
  projectId: string;
  specId: string;
  parentVersionId: string | null;
  files: Array<{path: string; content: string}>;
  sourceSha256: string;
  buildSha256: string | null;
  runtimeConfigVersion: string;
  configSha256: string;           // 构建配置/受控工具链身份，不能只保存人类可读版本
  buildStatus: 'PENDING'|'SUCCEEDED'|'FAILED';
  buildLogRef: string | null;
  createdAt: string;
}
```

Spec / AppVersion 不可变。Source hash 用排序后的路径与原始文件字节按规范算法计算；Build hash 对真实构建产物计算 SHA-256，不使用构建工具不稳定的内部 hash 充当完整性签名。M1 应直接复用 M0.5 已验证的 hash/versionId 计算逻辑，禁止重新发明不兼容的编码规则。

## 6. Contracts：Test Plan 与 Evidence

### 6.1 计划应在源码生成前建立

Spec 后产出可审查的 TestPlan；Generator 可以知道 **稳定 `data-testid` 约定**，但不能拿到 Validator 在执行阶段产生的随机值。测试计划来自需求且经过白名单校验，不能把测试“改到能通过”为默认修复策略。

```ts
type TestAction = 'fill'|'click'|'assertVisible'|'assertAbsent'|'assertCount'|'assertValue';
interface TestStep {
  action: TestAction;
  target: string;               // 白名单 testid 标识，不接受任意 CSS/XPath/URL
  value?: string;               // 可使用仅执行器解释的 ${RUN_UNIQUE} 占位符
  expected?: string | number;
  timeoutMs?: number;
}
interface RequirementTest {
  requirementId: string;
  steps: TestStep[];
}
interface TestPlan {
  schemaVersion: '0.1';
  id: string;
  specId: string;
  tests: RequirementTest[];
  createdAt: string;
}
```

默认测试动作只包含安全的浏览器操作及断言。测试步骤数量、单步超时和总运行时间必须有限。TestPlan 引用需求 ID 必须存在；`UNSUPPORTED/MANUAL` 无法被程序自动标记 PASS。

**注意**：`data-testid` 是定位契约，不是行为证据。针对“新增”之类的动态行为，需在操作前检查测试值不存在，随机填入，点击后检查出现。对于筛选/切换，应核验操作前后可观察变化。计划无效或测试器没有完成关键动作时是 UNVERIFIED/ERROR；有效执行后未满足行为断言才是 FAIL。不要为“找不到按钮”一律判基础设施 ERROR：若该按钮是明确要求且 TestPlan 有效，属于应用功能失败。

### 6.2 两层结果语义

- Requirement result：`PASS` / `FAIL` / `UNVERIFIED`。
- Run execution state：`QUEUED` / `RUNNING` / `COMPLETED` / `ERROR` / `CANCELLED`。
- **成功的 harness 验收**：能观察一个正常应用的 PASS、一个已注入故障应用的 FAIL，并能区别浏览器启动/Preview 不可达的 ERROR。绝不能把“故障被检出”改写为该应用的 PASS。

### 6.3 运行与证据契约

```ts
interface VerificationRun {
  id: string;
  projectId: string;
  specId: string;
  appVersionId: string;
  sourceSha256: string;
  buildSha256: string;
  configSha256: string;           // 与 AppVersion / 构建 manifest 一致
  testPlanId: string;
  state: 'QUEUED'|'RUNNING'|'COMPLETED'|'ERROR'|'CANCELLED';
  startedAt: string | null;
  finishedAt: string | null;
  results: Array<{
    requirementId: string;
    status: 'PASS'|'FAIL'|'UNVERIFIED';
    observed: string;
    assertionResults: Array<{stepIndex: number; passed: boolean; details: string}>;
    failureCategory?: 'APP_BEHAVIOR'|'INVALID_TEST_PLAN'|'INFRASTRUCTURE';
  }>;
  evidenceRefs: Array<{kind:'BEFORE_SCREENSHOT'|'AFTER_SCREENSHOT'|'TRACE'|'BROWSER_LOG'|'REPORT'; path:string; sha256:string}>;
  error: string | null;
}
```

实际字段可在实现中归一化为多张表，但所有关联与状态语义必须保持。截图/Trace/log 只保存已真实采集的文件；若不存在，记录 `null`/缺失原因，禁止自动补造。

**测试真实性额外校验**：对正常案例和人为注入的 no-op 故障案例分别运行；还必须保留 Browser crash、Preview unreachable、非法 action/URL/shell/evaluate/selector 等负例。截图和报告必须绑定 **同一 buildSha256 / sourceSha256 / config identity** 和独立 Run ID。验证使用运行时产生的随机测试值。套件 PASS 表示预期行为（含故障被检出）正确，不代表故障 App 自身 PASS。

## 7. Execution Lifecycle / bounded repair

```text
CREATED
  → SPECIFYING → SPEC_READY → GENERATING → BUILDING → PREVIEW_READY
  → VERIFYING → AWAITING_ACCEPTANCE
                    ├─ human accepts → ACCEPTED
                    ├─ user revises → new Spec / new Version
                    └─ repair authorized → REPAIRING → BUILDING → VERIFYING
  failures / timeout / limit → BLOCKED
```

这些是 Orchestrator 的内部状态；最终前端可以合并展示，不必把每个状态暴露给用户。失败不能直接转成 `ACCEPTED`。自动修复属于 P1：最多 **2 次**，每次新 AppVersion，原测试计划与证据保留；若失败为无效测试计划，先报告而非擅自放宽测试。用户可随时停止新任务；已保存版本和证据不得因取消丢失。

**已实测与冻结的初始执行限额**：编译 20 秒；验证器普通交互 watchdog 15 秒，CPU 循环 watchdog 5 秒；Spike 外层命令 90 秒后精确回收本次容器。Validator `1 GiB RAM / 1 CPU / 192 PIDs / 256 MiB shm`、私有 IPC；全局同一时间最多一个高资源作业。**注意**：Spike 外层 90 秒上限是执行实验的控制策略，不是正式 LLM 端到端链路 SLA；LLM 调用、排队、用户取消和作业总超时需 M1 单独设计，严禁无上限等待。

## 8. Persistence / API / Data Ownership

### 8.1 数据库

SQLite 表至少包含：`projects`、`specifications`、`test_plans`、`app_versions`、`verification_runs`、`requirement_results`、`evidence_files`、`job_records`。所有主键、外键及不可变版本约束应在 DB 层落实；用迁移文件管理 schema。SQLite 持久化文件与 Evidence 目录必须独立于容器临时文件系统并可备份。

### 8.2 最小 API

| Verb | Path | 功能 |
| --- | --- | --- |
| POST | `/api/projects` | 创建 Project |
| GET | `/api/projects` | 列出可访问项目 |
| GET | `/api/projects/:id` | 项目、当前版本、需求摘要 |
| POST | `/api/projects/:id/specifications` | 解析需求，生成 Spec/TestPlan |
| POST | `/api/specifications/:id/generate` | 开始生成（异步 job） |
| GET | `/api/jobs/:id` | 查询任务状态、错误/完成结果 |
| GET | `/api/versions/:id` | 源码和构建状态、只读预览地址 |
| POST | `/api/versions/:id/verify` | 运行验证（异步 job） |
| GET | `/api/runs/:id` | 验证结果与 Evidence 索引 |
| GET | `/api/evidence/:id` | 授权后取得实际证据文件 |
| POST | `/api/versions/:id/accept` | 用户确认验收（与测试 PASS 分离） |

所有 ID 只读/写访问需要受权限控制；防止通过遍历 ID 读取他人数据。Demo 可使用短期邀请码或单用户试用令牌代替完整账号系统，但不能公开无上限的付费 LLM/验证接口。使用 Job Id 防止 HTTP 请求因模型/浏览器运行过久而阻塞；初版可简单轮询，无需 Redis。

### 8.3 Preview 文件交付

Preview 资源以固定版本/构建哈希关联的只读 manifest 获取。不得通过“任意路径读取”HTTP 接口提供源码、`.env`、数据库或 Evidence。Main UI 展示生成源码应走受控 API，不是暴露宿主机文件夹。

## 9. Security Baseline（强制）

### 9.1 不可信生成源码风险

- 不允许服务器 `eval`、动态 import 执行模型源码，或执行任意生成 Shell / npm scripts。
- 构建 Worker 使用固定依赖/配置，禁止未审查代码、插件在构建主机执行。
- 生成文件/模块路径、大小、数量、内容类型受约束；SSR、`node:*`、动态安装与远程导入禁止。
- 前端生成 JS 仍可构造请求、尝试导航、执行大量计算，因此 **仅检查源文本不能实现沙箱安全**。

### 9.2 客户端 Preview 防护

- 严格隔离 iframe：默认 `sandbox="allow-scripts"`，无 `allow-same-origin`、`allow-top-navigation`、`allow-popups`、`allow-downloads`、`allow-forms`。
- 静态 Preview 的 **HTTP 响应头**保持 M0.5 已实测的 CSP sandbox、脚本/样式资源白名单及限制性 `connect-src`、`form-action`、`frame-src`、`object-src`、`base-uri`、`img-src`；变更必须重新做相应负向测试。不要只依赖 `navigate-to`（部分浏览器不支持）。
- 预览来源不共享主应用认证 Cookie 或敏感 Storage；不要仅凭“不同端口”假设 Cookie 隔离。
- 除经明确允许的静态预览产物，不加载外部脚本、字体、CSS、图片。必要图片可以使用审查过的静态资产或安全 `data:`（须有容量/类型限制）。
- 不要允许 Preview 向父窗口发送任意可执行命令；若有 `postMessage`，校验来源和结构，不视收到的消息为可信证据。

### 9.3 验证器 / 容器防护

- Playwright Worker **冻结 M0.5 已验证的边界**：容器 UID 1001、`chromiumSandbox: true`，Chromium Namespace/PID namespaces/Seccomp-BPF 实际有效；`cap_drop: ALL`、`no-new-privileges`、只读根目录/私有 IPC/必要 tmpfs、`1 GiB / 1 CPU / 192 PIDs / 256 MiB shm`。官方 seccomp 仅对必需 chroot 做增量允许，不得放宽为 unconfined。
- 生产容器禁止 `--privileged`、`SYS_ADMIN`、`--network host`、直接挂载 Docker socket；默认删除不必要 capabilities，启用 `no-new-privileges`、PID/CPU/内存限制与最小读写权限。
- 避免 `--ipc=host` 作为方便修复；需独立配置共享内存并实测浏览器稳定性。
- 仅允许验证器到指定 Preview 的必要网络流量；沿用 M0.5 `internal + isolated browser` 网络及无任意外连/DNS 的边界，不要把 Main API/DB 放进 Browser Worker 可达的控制网络。**Playwright route 拦截不能作为网络隔离的证明**。
- 云实例元数据 `169.254.169.254` **和阿里云 `100.100.100.200`**、主 API、数据库、非白名单 IPv4/IPv6、外部 DNS 均须不可由执行路径访问；M0.5 已对指定路径实测，正式部署须保留回归。
- 测试队列串行化和限额；证据文件路径不能由请求任意指定；添加日志清理/保留期机制。

### 9.4 暴露策略和 Security Gate

**M0.5 的 GO 只放行 M1/M2 受控开发，不自动放行公众匿名执行。** 公开 Demo 前必须完成 Release Gate：真实 LLM/API/DB 集成后的安全回归、HTTPS/外壳/Fetch Metadata、身份与会话权限、服务端额度/并发控制、Evidence 访问/清理、网络隔离、真实用户从公网访问与恢复测试。可以通过**限制次数的评审访客体验**满足笔试“可公开访问的测试链接”，但不得把测试 API、凭据或资源密集型任务无限制暴露。若发现凭据/内网越权，必须阻断上线。

## 10. UX / Presentation

三栏布局：左侧 Project + Specification + 任务阶段；中央交互 Preview + 版本切换 + 代码查看；右侧需求维度验证结果 + Screenshot/Trace/错误原因 + 修复操作。移动端可纵向切换，不追求完整桌面 IDE。

核心 1 分钟展示脚本：创建 Todo → 看见结构化要求 → 实时生成 TSX → 操作新增 → R1 PASS/R2 PASS → 对缺陷版本显示真实 FAIL → 查看截图证据 → 二次生成/修复产生 V2 → 重新验证 → 刷新页面仍可找到历史。

失败和未验证结果应真实且醒目，**不以虚构进度、静态截图、假的 AI thinking log** 充当真实执行。

## 11. Milestones / Implementation Authority

| 阶段 | 交付 | Gate |
| --- | --- | --- |
| **M0（GO）** | 可信 React/Playwright 本地+Docker+ECS 闭环 | **ECS_VERIFIED**；可复用 Evidence，不重跑已冻结旧报告 |
| **M0.5（GO）** | 受控 TSX 编译 + `trusted-shell-v1` + 真浏览器 + 负向安全验证 | **ECS_VERIFIED**，S1–S10、T1–T4 报告已形成；冻结候选底座 |
| M1（P0） | Spec、LLM 直接 TSX、构建、预览、SQLite 持久化 | 两种不同需求生成不同可交互应用，刷新恢复 |
| M2（P0） | TestPlan、Playwright、Evidence 与右侧验证面板 | PASS/FAIL/UNVERIFIED/ERROR 区分，hash 绑定 |
| M3（P1） | 再生成与最多 2 次自动修复、历史版本比较 | 修复产生新版本，复测不可继承旧 PASS |
| M4（P0） | ECS、HTTPS、受限公开体验、GitHub、README、笔试文档 | 全新浏览器能真实生成+预览+验证+恢复 |

**实施规则**：M0 和 M0.5 均已 GO，现在可以进入 M1/M2；M3 仍是 P1，如时间紧迫优先延后，不得删除真实测试、安全 Gate 或持久化。**M4 公开部署必须独立 Release Gate**，不可因为 M0.5 已 GO 就提前宣布公开服务安全。

**Codex 权限**：可自主做文件组织、组件、测试、内部重构；不可擅自放宽安全约束、静默删 Gate、打开管理员权限、公开密钥或修改需求验收含义。发现冲突要写出证据/最小替代提案并请求确认。每个 milestone 提交实际执行命令、测试摘要、失败记录和未完成项。

## 12. Final Acceptance Checklist

- [ ] 用户在真实在线页面输入自由语言并触发真实 LLM（非预录结果）。
- [ ] 至少两种需求生成不同的 TSX 与可交互页面；源代码可查看。
- [ ] 固定可信工具链构建；没有执行模型生成的 npm scripts。
- [ ] 用户 Preview 可操作，Validator 检验同一构建哈希。
- [ ] 正常行为 PASS，故意缺陷 FAIL，基础设施异常 ERROR，未覆盖 UNVERIFIED。
- [ ] 每个结论存在实际浏览器断言及可检查证据；不得伪造。
- [ ] Project/Spec/Version/Run/Evidence 在服务重启后恢复。
- [x] M0.5 指定的高风险隔离测试在固定候选上通过并保留证据；后续集成和正式公网访问仍须回归。
- [ ] 生成和验证受到配额/并发/时长限制，公众不能无限消耗 API Key。
- [ ] 新浏览器测试在线链接，GitHub 和 README 均可访问，用户最终验收与自动 PASS 分离。

## 13. Freeze Decision Register 与剩余 Release Decisions

### 13.1 已冻结（Codex 不得擅自变更）

| ID | 决策 | 冻结依据 |
| --- | --- | --- |
| F-01 | 改良方案 B：LLM 直接生成 React/TSX，不采用 App IR 模板作为主路线 | 产品目标及用户授权 |
| F-02 | 固定依赖、受控源码 envelope、前置 AST 检查、隔离编译 | M0.5 T1 / S1 |
| F-03 | `trusted-shell-v1`：直接 URL 是可信外壳，生成 HTML 仅 iframe 内执行、裸 HTML 顶层拒绝 | 修正前 NO-GO → 经批准修正 → T2/T3/T4 GO |
| F-04 | Chromium 非 root sandbox + 容器权限、私有 IPC、网络限制和资源限额 | M0.5 S2–S10、ECS 证据 |
| F-05 | Validator 不接受任意 URL/Shell/evaluate/selector；按声明式计划真实执行 | M0/M0.5 实验 |
| F-06 | Spec → AppVersion → VerificationRun → Evidence 的不可变版本/实际 hash 追踪 | 产品目标与 Spike 证据身份约定 |
| F-07 | 自动 PASS、功能 FAIL、计划 UNVERIFIED、执行 ERROR 严格分离；用户验收独立 | M0/M0.5 真实错误分支 |
| F-08 | SQLite 持久化 Builder 资料；全局单高资源作业；M3 最多两次修复作为 P1 | v0.1 产品边界 / 部署约束；**尚待 M1/M2 实现验证** |

**版本控制**：冻结并非不可修订。任何变更 F-02 至 F-05、安全阈值、接口行为、结果语义或用户目标，都需单独提交设计变更（问题、证据、最小改法、兼容影响、回归范围）并获得用户批准；正常代码组织/低级实现可由 Codex 自主决定。

### 13.2 仍需实施与验收（不阻塞架构冻结）

1. **LLM Provider/调用预算**：由用户配置实际 Provider、模型、凭据；不得把 key 放入前端或仓库；需完成真实模型生成和异常/限流测试。
2. **Auth & Public Demo**：选择限制次数的访客入口/邀请码等访问控制，并检查项目隔离、Evidence 资源权限；不得开放匿名无限模型/浏览器执行。
3. **HTTPS & Domain**：正式公网域名或可信 HTTPS 入口、Cookie/CSP/Fetch Metadata/代理转发的实际兼容性；重新验证裸页 403 和跨站攻击负例。仅 SSH/localhost 已验证，不等于公网最终链路通过。
4. **生成效果质量**：M0.5 使用固定 fixture，不是真实 LLM 输出；M1 必须验证多个自由需求的不同 TSX、正确性和错误分支。
5. **容量与长期运行**：ECS 首个 Todo worker memory.peak 为 822,263,808 bytes（约 784 MiB），之后三轮常规验证约 331–337 MiB；pids.peak 最高 161/192。有限轮数无 OOM 不能证明长期稳定；真实 API/SQLite/LLM 后重新测量并优化队列与限额。
6. **证据管理**：SQLite 数据迁移、证据访问、保留期、存储配额、清理与备份需要在 M2/M4 实现；M0.5 hash 不是恶意篡改防护签名。
7. **公开交付 Gate**：由外部新浏览器在公网、真实 LLM 和持久化条件下进行端到端验收；完成后方可声明正式笔试 Demo 可交付。

### 13.3 Release Gate（M4 必须通过）

- `R1 Public URL`：HTTPS 可打开 Main 与受控 Preview 外壳；顶层裸生成 HTML 仍被拒绝；不为 HTTP 降低限制。
- `R2 Access control`：未授权用户不能耗费付费 LLM/Chromium 资源，不能越权读取 Project、源码和 Evidence；会话取消/配额能生效。
- `R3 Regression`：M0.5 重要 S1–S10 与 T1/T2/T3 在真实部署网络及代理配置下按影响面复验，包括元数据两地址、出站网络、主 API、身份权限、顶层导航。
- `R4 Function`：至少两个不同自然语言需求真实生成不同的 React/TSX 可用页面；正常 PASS、故障 FAIL、异常 ERROR、未验证 UNVERIFIED 与实际证据一致。
- `R5 Persistence`：服务重启后 Project/Spec/Version/Run/Evidence 可恢复；清理不会删引用中的文件。
- `R6 Resource`：记录完整链路内存/CPU/磁盘/延迟/失败率；验证并发限制、超时、任务结束回收、费用及资源预算。
- `R7 Delivery`：公开 GitHub、README、笔试文档与在线链接均可访问；原招聘私有笔试题目不能发布到公开仓库。

**最终语义**：`FROZEN` = 架构基线冻结并允许受控开发；`GO (M0.5)` = 特定 runtime 候选通过特定 Gate；`PUBLIC READY` = M4 的独立 Release Gate 通过。三者不得混称。

## 参考

- 当前笔试正文（候选人私有文档，不在公开 GitHub 放原文）
- `M0-Spike-Report.md`（历史）、`M0-ECS-Validation-Report.md`（M0 最新 GO）
- `M0.5-Spike-Report.pre-shell.md`（原顶层导航 NO-GO）、`M0.5-Spike-Report.md`（受控外壳修正后最新 GO）
- Playwright Docker：https://playwright.dev/docs/docker
- esbuild API：https://esbuild.github.io/api/
- MDN iframe sandbox：https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe
- MDN CSP sandbox：https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox
- Docker Rootless：https://docs.docker.com/engine/security/rootless/
