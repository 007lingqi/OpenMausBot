# 独立任务容器：Provider 与受控写入

状态：只读视图、任务容器启动器、两阶段worker及打包入口已实现，完整回归通过。真实Linux五类合成场景证明模型前登记、私有候选拒读、失败无写入及脱离进程组后代停止；正式worker已通过现有私有通道调用真实Astra/medium，独立拼写夹具实际修改后两套隔离断言通过。headless接线和在途恢复尚未验收；当前试点仍使用既有Provider进程。组件证据不是完整引擎Meta收据，不构成整体验收通过或扩大授权。

## 选择

将只读 Provider 和固定的受控写入程序放在同一个专用任务容器中，不再让 Provider 与 headless 共用 PID 命名空间。不为两个阶段补造同一个进程凭据，也不用预先创建的空 applier 容器代表另一个未受控 Provider。

Docker daemon/cgroup v2 提供独立于候选进程的运行状态。可信 headless 保管签名密钥与账本；任务容器不挂载该密钥、钉钉凭据、账本、Docker socket、原仓库或宿主 HOME。Provider 沿用 UID10001 和 Astra/medium；模型 relay 使用既有独立 UID，通过已授权私有 socket 提供固定模型通道，Provider 无权读取 socket。本设计不申请新身份、密钥、付费服务或宿主网络旁路。

## 启动与写入契约

1. 预留原执行生命周期；可信启动器创建只运行等待 gate 的独立任务容器，取得真实完整 ID、绑定标签及代次。凭据经独立 Docker 查询验证并持久化后才允许模型开始。任何进程启动必须被该容器身份覆盖。
2. 只读视图取自当前固定、干净 Git 候选。根据 readScope/denyScope 读取完整 blob，排除 `.git`、`.ssh`、`.env*`；不跟随链接、子模块或 imports，不运行仓库 hooks/filters，不静默截断。文件及总量超限、二进制或无法安全解析时明确阻塞。
3. `createProviderReadView()` 返回来源 commit/blob、视图文本哈希、作用域和完整文件清单。视图文件0444、目录0555，随后仅以只读挂载提供给 Provider。原始可写候选位于 root 专用0700祖先目录下；不能只把 Provider 的工作目录改到副本，却仍允许它读取原候选或其他任务。
4. 模型只能提交建议；固定可信程序重新验证源/视图未变、全部写入路径和denyScope，再写入原候选。新启动器及worker均拒绝`automaticReplacementAllowed=false`文件的整文件覆盖，并拒绝覆盖视图外既有文件；worker写入前复核原内容hash、链接和全部祖先，申请内容必须等于先前建议。新链路尚未接入现有headless，不得宣称旧运行链路已执行拦截。视图描述符只由可信协调器持有，fingerprint不是鉴权凭据。
5. Provider及其脱离进程组的后代仍在同一容器/cgroup中。退出、取消、超时、失去调用方时，启动器停止整个任务容器，按完整ID和绑定确认exited/Pid0；失败保留资料和占用。`disposeProviderReadView()`只能在已确认退出后调用，不得在未知进程仍可能读取时清理。
6. 之后继续原 Executor 自测、独立 Verifier、当前 Spec/候选/断言的 Meta 验收。独立任务容器不能代替测试证据、风险判断或 Owner 审批。

新组件边界：控制面保存独占launch/container记录，但尚无跨重启启动对账器；未知create继续保留资料和runId占用。递增心跳10秒失联检测使用worker单调时间，不能据此证明旧协调器停止或释放Git锁。候选写入不是多文件原子事务，中途故障仍须账本恢复和候选校验。smoke-contained-patch是零模型合成Provider验证；smoke-contained-opencodex是固定一次性新夹具的真实模型组件验证，后者已消费并保留原证据，不重复运行、不冒充群任务或原失败事项验收。

## 必须继续解决的恢复缺口

- create回执丢失仍可能有真实容器；不得把“查不到”或零PID当成未启动证明。需要可信、持久的启动身份登记和可重新查询的绑定，不得猜测进程或容器ID。
- 原协调器还会运行容器外的 Git/候选操作。没有 finalization intent 不能仅靠任务容器退出解锁；需进一步证明旧协调器确实终止、不会继续原生写入，或将其写入也纳入持久隔离身份。现有租约过期不是该证据。
- 旧无proof事项保留原失败/次数/占用，不追补假凭据、不换账本重置尝试次数。新实现只为新启动记录真实证据。

## 启用门禁

headless现已支持显式`OMB_DOCKER_PROVIDER_ISOLATION=task_container`。它要求`OMB_DOCKER_PROVIDER_IMAGE`固定sha256、`OMB_PROVIDER_MODEL_SOCKET_DIRECTORY`为controller与daemon共同可见的原生绝对目录、既有relay UID/GID，以及Astra/medium和Provider UID10001；不接受自定义CLI/launcher或其他endpoint，不因配置失败回退。独立任务镜像不改既有`OMB_DOCKER_COMMAND_IMAGE`。

`docker/compose.contained-provider.yaml`仅作为base+OpenCodex之后的显式overlay；实际Compose合并已确认保留原环境/挂载，仅为同一授权socket目录补充同路径只读别名。尚未在运行服务启用，不能将配置文件当作部署或恢复验收。

必须先完成：固定任务镜像/entrypoint及headless装配；Provider只能读视图、无法读写真实候选/他人任务/凭据；模型前凭据入账；正常和失败建议；源漂移和脱敏文件写入拒绝；setsid/双重fork后代停止；控制进程强杀后独立核验与恢复；同仓库串行/不同仓库并发；真实Astra/medium建议→代码→双阶段测试→Meta→钉钉业务回复。维持真实材料来源、唯一Owner和失败预算。

只读视图当前明确限制：最多512文件、总计8MiB、单文件512KiB；现有JS/TS/JSX/TSX和JSON语法脱敏器另有约32KiB上限。空JS文件允许；不支持的二进制或解析失败不以“已读取”通过。脱敏是已知表示的防护，不是任意Secret的完美识别器。
