# 受控评审入口（公开副本）

已验证链路：固定 HTTPS Tunnel → loopback TLS Basic Gateway → 原 Main → 原 Preview。Demo 为 https://demo.mini-atoms.win ，默认拒绝；凭据不随仓库分发。

实现见 apps/builder/src/review-gateway，服务模板见 apps/builder/deploy/linux/mini-atoms-review.service.template。TLS 密钥、受控 CA、Tunnel token、owner token、manifest、grant 及 Provider 配置均属于私有部署材料。

READ_ONLY 按批准的精确对象白名单投影响应；INTERACTIVE 仅对预建项目内属于该 grant 的任务和关联结果开放限定操作。相同 owner / projectId 不构成动态对象读取授权。所有者 Bearer 只在服务端注入，不能交付评审网页。模型调用另有显式开关、次数和金额上限，默认零预算。

管理工具在 apps/builder/scripts/review-admin.mjs，使用私有 Unix control socket。issue / issue-interactive 将随机短期凭据写入新的受限私有文件；最长 1800 秒，绝不能输出到公开日志。revoke / disable 撤销访问并按原任务归属和取消机制处理后台任务。重启后不恢复旧 grant。

新部署必须先完成默认拒绝，再做短期授权、真实浏览器 opaque iframe / JS / CSS / Evidence 检查和在线撤销检查。保持 Tunnel 在线撤销后仍应拒绝已缓存 Basic 的浏览器；不能把关闭 Tunnel 后的边缘错误当作源站撤销证据。Cloudflare 自动 HTML 注入曾改变资源字节，需要禁用；不能放宽 CSP 或资产摘要校验。此仓库不自动安装 Tunnel、不启用公网访问或付费生成。
