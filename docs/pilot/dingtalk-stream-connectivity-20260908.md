# 非生产切换中的钉钉连接核验

用户明确要求直接切换，后续同类低风险、可恢复操作不重复索要业务许可；不扩张到生产、默认分支、身份凭据变更或不可逆影响。原生 Goal 当前为 paused，按本次明确请求执行，不能用状态工具模拟恢复或标记全部完成。

## 已观测事实

- 1906b8 停机前、96ce1a 停机后确认 schema31、唯一 Owner 1、完整性正常、在途执行/验证/消息均 0。a6b7e1/6bc2d9 确认原服务干净退出。
- 4519fb 在 VM 私有 releases/13a373c/offline-data 保存离线备份。646929 先将 systemd 恢复入口固定至 schema37 兼容回退，避免意外主机启动时旧 schema31 镜像打开已升级库。
- d84af6 以无网络、无业务处理的健康探针迁移真实非生产库至 schema37；cf86c9 对比停机快照，66 张旧业务表原列及全部行哈希一致，完整性/外键/Owner 通过。
- 候选 13a373c 的镜像 217009a93665…单次启动为容器 8f05753a5e51…，51475f 启动、1a888d 确认 running/healthy/restarts0/restart=no。590ca2 确认实际 coordinator 匹配、relay UID501、Astra/medium 保持，历史事件12和 Outbox39sent/10superseded 保留。
- 64a80d 的实际启动报告为 dingtalk=reconnecting、ready=false；不能用 Docker 的 probe-only 健康检查代替实际 Stream 状态。3bff21 累计16次 connect success、15次 Disconnecting、错误行0，确认持续重连，不是仅启动瞬间状态。
- 0c02e4 停止该候选，避免继续重复。caf994/43513e 为单次有界协议探针的最终回执：原凭据、相同订阅、40秒连接打开，SYSTEM帧0、业务帧0，主动关闭且退出0；没有群发送、业务确认或数据库写入。
- 64b326 比较当前与247f99a的 stream-sdk.ts 内容完全相同，SHA256均为371e6d2770b029bca9d13990258046c9325ad6ea68575f96ce85e39254dee755。该错误的注册前置在旧版就存在，并非本次两个镜像配置字段的差异。

## 原因与修复依据

高置信原因：封装把 SDK 可选的 registered 标志当作必需的就绪条件，30秒后主动断开已经通过 gateway 票据认证的健康连接。SDK connect 先用凭据和订阅换取票据，再建立 WebSocket；真实探针在没有 REGISTERED 的情况下保持40秒。官方 [Python Stream SDK](https://github.com/open-dingtalk/dingtalk-stream-sdk-python/blob/main/dingtalk_stream/stream.py) 同样不等待 REGISTERED，成功进入 WebSocket 后直接处理系统/业务消息及保活；系统帧处理见 [handlers.py](https://github.com/open-dingtalk/dingtalk-stream-sdk-python/blob/main/dingtalk_stream/handlers.py)。这构成修订原错误测试判定依据的独立协议证据，而非为了变绿放松群/Owner授权。

修复只将连接就绪和重连条件绑定实际 authenticated transport 状态，继续依赖既有 SDK 的 heartbeat/close/error 处理实际掉线；保留停止代次、并发单次重连、失败退避、确认失败恢复、下游群白名单/Ledger/Owner/Outbox 边界。不把传输已连接等同于业务消息送达或完整目标验收。

## 验证状态与恢复入口

- fb8a71 新增90秒无 REGISTERED 场景先行失败，精准复现 reconnecting 而非 connected。
- 24b3eb 修复后5文件199项、pnpm typecheck、git diff --check通过，涵盖Stream、运行时、自然关联和审批权限。
- 4c1de5确认完整回归会话50474终态exit0，含主集门槛、broker/桌面/打包/类型检查。本批代码在整套运行期间固定；主集临时JSON由test-floor自动删除，未从旧报告推断新数量。
- 721fd3确认兼容回退源叠加的Stream修复与主仓库字节一致。34b091构建因临时目录Node类型解析失败，显式使用主仓库实际解析的已有类型目录后52f8c5打包通过，未安装依赖或修改用户依赖。尚未构建或切换带此修复的镜像，不能宣称群服务恢复。
- 当前原候选容器停止、restart=no，systemd 尚未完成候选交接，恢复入口仍为兼容schema37回退。备份/迁移/运行摘要保留在VM私有 releases/13a373c；回退必须保留 CURRENT 数据，不得覆盖后续事件或使用schema31镜像。
- 临时整体编排脚本创建审核超时且未生成；后续逐项经权限审核执行。其他审核超时均在 CreateProcess 前未执行，并仅按允许重试一次，成功回执如上；不是实际数据库或容器操作失败。
