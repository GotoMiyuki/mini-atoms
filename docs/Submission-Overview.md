# Mini Atoms — ROOT 交付概览

源码候选保持现有布局：

~~~text
apps/builder/                    Builder、Policy、Runner、Gateway、SQLite 迁移、测试
spikes/m0-5-tsx-runtime/         冻结 Compiler / Preview / v0.1 Validator、Compose、fixtures
spikes/m0-preview-validation/   早期固定 fixture 基线及被历史脚本引用的源码
docs/                           公开操作说明、原冻结指南与 v1.1 决策记录
~~~

已完成真实本机计数器生成和正式 v1.1 Chromium 证据闭环，也完成固定 HTTPS 下单个计数器的真实模型闭环。公开交付展示这些能力，不把有限断言升级为完整需求通过。

当前限制：单用户工作区、受控评审访问、有限 Typed DSL、需要外部 Provider 和获批准的精确 OCI 镜像。没有 M3 自动修复、匿名公开生成、多租户或长期容量保证。历史 M2-B 专项正例门禁及完整真实在线 R4 仍单独保留状态。

不包含任何真实用户工作区或历史证据；公开历史展示索引为空，首次启动为空工作区。内部验收记录保留在原私有工作区，不以公开夹具冒充历史或真实 LLM 输出。冻结指南按原字节保留，其旧阶段状态、内部文件引用和日期是历史上下文，当前运行说明以根 README 为准。

演示地址：https://demo.mini-atoms.win （访问受控，默认关闭）。
