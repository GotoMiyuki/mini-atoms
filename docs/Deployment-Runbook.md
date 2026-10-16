# 部署与恢复说明（公开副本）

本文件仅保留可公开的操作说明。运行条件和本机入口见 [README](../README.md)。不包含生产数据目录内容、主机身份、TLS 私钥、令牌或内部部署日志。

先完成两个活动包的 npm ci 和 Builder 构建，安装 runtime.lock.json 精确指定的 OCI 镜像，再运行 runtime:check。镜像分发尚待维护者确定；不能更换锁、seccomp、网络或 Chromium Sandbox 以绕过检查。

Linux 模板在 apps/builder/deploy/linux；M0.5 Compose / Dockerfile / seccomp 在 spikes/m0-5-tsx-runtime/deploy。模板路径由操作者在独立部署目录适配，不直接覆盖已有服务。Node Controller 是可信宿主服务，独立数据目录应为专用用户所有，0700；私有配置和数据库为 0600。Main 和 Preview 保持 loopback，HTTPS Origin 必须精确且唯一。

以下操作均在仓库根目录执行，参数使用自己的私有绝对路径：

~~~sh
node apps/builder/scripts/deploy-preflight.mjs <workspace> <private-data-root>
node apps/builder/scripts/package-release.mjs create <workspace> <new-release-directory>
node apps/builder/scripts/package-release.mjs verify <release-directory>
~~~

预检只读，但需要正确的本机私有配置和 Docker。发布工具必须在已构建源码目录运行，生成含前端 dist 和完整性清单的源码发布包；原工具保留，不会推送仓库或镜像。

备份前停止项目服务，确保无活动任务；使用新目录，不覆盖原库：

~~~sh
node apps/builder/scripts/backup-restore.mjs backup <workspace> <stopped-private-data-root> <new-backup>
node apps/builder/scripts/backup-restore.mjs verify <backup> <workspace>
node apps/builder/scripts/backup-restore.mjs restore <backup> <workspace> <new-restore-root>
~~~

备份是私有数据，可能包含 Spec、源码、证据和账本，绝不能加入 Git。恢复先在独立目录验明数据库、全部对象身份与摘要；活动任务、异常容器归属和身份冲突仍拒绝。生产私有历史索引与公开空索引不同，原备份不能直接与公开候选混用；恢复需要原匹配的私有来源材料，不能修改历史记录迁就公开副本。

systemd / 反向代理只是模板，需要独立核验运行用户、权限、固定后端 Host、精确 Origin、TLS、Fetch Metadata 和关闭状态。公网启动不属于源码安装步骤；不把 Main / Preview 端口直接公开。
