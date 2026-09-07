# 对话版Docker发布前置验证

本次仅准备非生产发布；业务代码为03b6484，兼容回退为07cae17。用户已授权的纯对话目标不变。群服务尚未切换。

## 实际通过

- 两个提交的迁移、lockfile及打包脚本无差异；复用原固定runtime依赖层，离线打包正式六bundle，不安装依赖。
- 候选镜像：`sha256:ee86bbc3be1a2ab8314efc8154df29f3e3839056b5a3afe1661c058544dbea0e`。
- 回退镜像：`sha256:034ea40ae0cc4c1b0d5d0332662cd1821b60d3522d5e2a02c847c964ec4147ed`。
- 镜像内六bundle与构建回执逐项一致。
- Node SQLite以readOnly源执行一致性backup；副本目录0700、库文件0600。无网络、无凭据、无Docker socket、无真实仓库的临时容器只运行headless健康探针，未开启Stream或执行。
- schema31→36后，66张旧业务表的原列/记录哈希全部一致，quick_check及foreign_key_check通过。schema_migrations不属于旧业务行比较。
- 在副本中增加明确合成的schema36意图标记，再用兼容回退镜像读取同库；旧行和新版标记均保留。没有伪造真实群事件或Owner操作。
- 最后核对原服务容器ID与镜像未变、healthy，真实库仍schema31。模型仍OpenCodex/gpt-6-astra/medium，task与command镜像不变。

## 证据及一次性操作

宿主目录：`/private/tmp/omb-conversation-stage-03b6484/`。

- `build.mjs`、两个Dockerfile、`build-attempt.json`、`candidate-receipt.json`、`rollback-receipt.json`、`build-receipt.json`：已执行，0dcc18确认exit0。
- `verify-copy.mjs`、`copy-attempt.json`、`copy-receipt.json`：已执行，ae552a确认exit0。
- VM副本：`/var/lib/openmausbot-collaboration-pilot/conversation-rehearsal-03b6484/`；只在该私有目录保留旧列/行哈希及副本，不把群消息原文/身份/凭据写入仓库。
- 启动专项脚本`verify-startup.mjs`创建的权限审核两次超时（cells1341、1343）；未落地、未运行，没有startup回执。不要把它算作测试失败或启动成功。没有切换脚本执行。

构建及副本脚本具有一次性attempt守卫，不能盲重跑或删除守卫。恢复先核对回执、镜像ID、HEAD及实际服务；已有终态的session41518、session88094不再轮询。

## 剩余安全步骤

1. 获得用户对未完成启动操作的明确授权后，完成候选和兼容回退的实际entrypoint、私有model relay、init/三项cap/coordinator及干净退出专项。使用合成仓库/密钥，不绑定真实群凭据；上游空请求只作协议握手，不能当模型推理成功。
2. 核对当前固定Compose/systemd配置、在途执行/验证/自然输入和Outbox。确认无在途后再暂停唯一非生产服务，并在停止后复核及保存私有离线备份。
3. 准备固定候选与同schema回退配置。首次启动禁止自动重启循环；健康和实际coordinator核验后恢复原restart策略及systemd管理。禁止使用旧schema31镜像打开升级账本；回退保留CURRENT数据，不覆盖后续消息。
4. 再验证真实钉钉自然对话与交付。多人、真实Owner决策、未@/引用平台行为、序号接续、主机恢复和最终人工验收仍须独立证据。

本报告只证明发布前置验证通过，不证明新版群服务、完整研发交付或最终目标完成。Goal仍active。
