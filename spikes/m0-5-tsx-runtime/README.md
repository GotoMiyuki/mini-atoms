# M0.5 受控运行时

活动 Builder 直接复用此目录的 Compiler、Preview 和 v0.1 Worker。31 个文件按 apps/builder/runtime.lock.json 冻结；不要变更镜像、seccomp、Sandbox 或网络设置绕过启动检查。

依赖安装和完整启动见 [根 README](../../README.md)。npm run test:build 可在无 Provider 的环境执行受控编译测试；浏览器、安全和资源测试需要对应容器及批准的运行条件。tests/verify-*-evidence.mjs 等历史核验脚本需要私有归档，不是公开默认测试。运行输出位于被 Git 忽略的 artifacts / evidence，绝不随源码交付。
