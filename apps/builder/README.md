# Builder

本地安装、配置、构建和启动步骤见 [根 README](../../README.md)。Node Controller 运行在可信宿主，编译和浏览器执行复用原 M0.5 沙箱。

- src/client：React 工作台与逐需求证据展示。
- src/server：API、SQLite、任务、Provider、版本、Policy 与正式验证调度。
- src/shared：v0.1 合同、v1.1 Typed DSL 及展示类型。
- src/validator：v1.1 Chromium Runner；v0.1 Worker 在 spikes/m0-5-tsx-runtime。
- src/review-gateway：全路径 Basic 网关、精确只读范围和受限交互 grant。
- migrations / deploy / scripts：数据库迁移、受控部署模板、发布及备份工具。

npm test 只包含随仓库提供的自包含测试，不调用真实 Provider。生产模型请求只能在私有配置和明确预算下执行。

test:integration 会调用真实 Provider，test:restore / test:evidence 需要私有历史，test:runtime 需要锁定 Docker 镜像及运行时夹具；这些入口保留源码，均不属于无凭据的默认测试，不在本轮执行。恢复测试需要操作系统允许 realpath 和临时目录 junction；受限执行器的文件权限可能导致拒绝，应在允许这些本地操作的终端运行，不能更改安全路径检查来让测试通过。

公开副本的 evidence-origins.json 是空的私有历史展示索引；不含原始用户对象或演示 ID，不参与 Policy 授权。新真实 LLM 规划仍通过正式保存的 receipt 识别来源。数据库、Evidence、Trace、调用账本和内部审计记录不随源码分发。

原工作区中依赖历史私有快照的五个测试文件未纳入公开候选：deployment-state、m1-1-api、m1-1-lifecycle、m2-c、planning-diagnostics。其通过状态不能由公开单元测试代替。保留的 m2-a-context / m2-b-context / delivery-interactive / delivery-workflow-browser 是原发布工具的源码依赖；不是默认测试，部分需要独立私有演示快照、TLS 工具或浏览器安装。不要直接对生产工作区执行这些历史辅助脚本。
