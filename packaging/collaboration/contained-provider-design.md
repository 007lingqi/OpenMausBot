# 独立任务容器：Provider 与受控写入

状态：只读视图、任务容器启动器、两阶段worker及headless显式装配已实现，完整回归通过。真实Linux五类合成场景证明模型前登记、私有候选拒读、失败无写入及脱离进程组后代停止；正式worker已通过现有私有通道调用真实Astra/medium，独立拼写夹具修改后两套隔离断言通过。固定新controller镜像也已通过隔离打包health。完整引擎在途恢复和真实群闭环尚未验收，运行试点仍用既有Provider进程；这些组件证据不是完整引擎Meta收据，不扩大授权。

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

新组件边界：新启动已保存v2签名launch记录并提供跨进程只读身份对账；unknown create仍保留资料和runId占用。该查询不是自动恢复器，不释放仓库锁。递增心跳10秒失联检测使用worker单调时间，不能据此证明旧协调器停止或释放Git锁。候选写入不是多文件原子事务，中途故障仍须账本恢复和候选校验。smoke-contained-patch是零模型合成Provider验证；smoke-contained-opencodex是固定一次性新夹具的真实模型组件验证，后者已消费并保留原证据，不重复运行、不冒充群任务或原失败事项验收。

## v2启动身份对账（2026-09-07）

- 新启动保持原名称推导，独占记录固定name/image、完整binding、hostGeneration、verifierVersion及用途隔离的HMAC；文件、任务目录和父目录均fsync成功之后才提交Docker create。create完整回执也独占落盘并fsync后才start。失败不覆盖既有文件；v1历史不升级或倒签。
- Docker标签新增非秘密launch摘要；HMAC只保留在可信控制文件，不放标签、日志或群消息。查询先验证原签名、代次及expected binding，再按完整绑定标签列出唯一完整ID，核对精确名字、固定Image/Config.Image、launch摘要、标签和明确状态。已有container.json时ID还必须相同；缺失、多个、改名、与已保存ID不同的重建、旧代次、restart/dead/缺字段均unknown。未保存原ID时，查询只能观察当前符合签名启动约束的对象，不能证明未被有Docker权限的操作者替换，因此不生成可解锁的执行凭据。
- `DockerContainedPatchAgent.inspectPendingLaunch(name,binding)`只读原目录和独立Docker；返回observed created/active/exited或unknown，不返回execution proof，不签回原生命周期、不发start/kill/rm、不清理目录或更改attempt。created和查不到都不能当成未执行证明。当前未接入runtime自动settlement。
- 实际独立Node调用方在create成功、回执未落盘之前被SIGKILL，新进程使用持久记录找回真实容器；created不签执行proof，后续合成active/exited可观察，删除后unknown、旧代次unknown，原记录逐字节不变。该测试无模型、无业务挂载/群消息；不代表headless/Git在途恢复。

## 必须继续解决的恢复缺口

2026-09-07增量：`DockerUnactivatedLaunchRecovery`已接入lifecycle/runtime/headless。仅新v2第一条Provider command无proof、无后续command、原coordinator事前proof已独立stopped、唯一固定实际容器及未激活控制资料全部确认时，独占fsync永久start:false门禁；等待容器先持久预留最多三次kill，确认created/exited及gate未变后记录独立aborted_before_activation。保留原目录/容器防迟到start，不补签execution proof，不写假finalization，不刷新attempt；即使有finalization也必须证明原coordinator停止。全量及真实Docker强杀/丢create回执/迟到start零Provider调用烟测通过。此条覆盖下方“全部缺proof都阻塞”的旧描述，仅上述有限分支已解决；未匹配、已激活、旧记录/跨boot/缺失容器仍阻塞。尚未部署或完成真实群业务验收。

- create回执丢失后的持久身份查询已实现，但未知状态不自动解锁。仍须把新启动日志与命令账本做只读关联，并在协调器独立停止证据齐全后设计明确的恢复/收束协议；不得从观察状态倒签执行proof。
- 原协调器的Git/候选操作由新coordinator启动代次proof覆盖；仅对有事前登记的新session，可在旧启动实例独立stopped、所有command proof/empty齐全后收束。旧记录、跨VM boot、missing container及unknown-create缺任务proof仍保守阻塞；租约过期不是停止证据。
- 旧无proof事项保留原失败/次数/占用，不追补假凭据、不换账本重置尝试次数。新实现只为新启动记录真实证据。

## 启用门禁

新coordinator装配要求`OMB_DOCKER_COORDINATOR_CONTAINER`为当前controller名称、`OMB_DOCKER_COORDINATOR_IMAGE`为其固定实际sha256；compose overlay已列出必填项。签发前后由daemon核对同一StartedAt与真实PID namespace，签名绑定实例owner/fence；独立查询区分原启动终止与同容器的新启动。runtime启动取得lease后先登记schema31不可变proof，再允许恢复/执行/群连接；probeOnly不执行Docker诊断。必须先准备schema31兼容回退镜像和当前数据备份，不能部署后直接退到旧schema30镜像，更不能覆盖旧快照丢失新事件。现有在线服务及账本仍schema30，尚未迁移。

headless现已支持显式`OMB_DOCKER_PROVIDER_ISOLATION=task_container`。它要求`OMB_DOCKER_PROVIDER_IMAGE`固定sha256、`OMB_PROVIDER_MODEL_SOCKET_DIRECTORY`为controller与daemon共同可见的原生绝对目录、既有relay UID/GID，以及Astra/medium和Provider UID10001；不接受自定义CLI/launcher或其他endpoint，不因配置失败回退。独立任务镜像不改既有`OMB_DOCKER_COMMAND_IMAGE`。

`docker/compose.contained-provider.yaml`仅作为base+OpenCodex之后的显式overlay；实际Compose合并已确认保留原环境/挂载，仅为同一授权socket目录补充同路径只读别名。尚未在运行服务启用，不能将配置文件当作部署或恢复验收。

必须先完成：固定任务镜像/entrypoint及headless装配；Provider只能读视图、无法读写真实候选/他人任务/凭据；模型前凭据入账；正常和失败建议；源漂移和脱敏文件写入拒绝；setsid/双重fork后代停止；控制进程强杀后独立核验与恢复；同仓库串行/不同仓库并发；真实Astra/medium建议→代码→双阶段测试→Meta→钉钉业务回复。维持真实材料来源、唯一Owner和失败预算。

只读视图当前明确限制：最多512文件、总计8MiB、单文件512KiB；现有JS/TS/JSX/TSX和JSON语法脱敏器另有约32KiB上限。空JS文件允许；不支持的二进制或解析失败不以“已读取”通过。脱敏是已知表示的防护，不是任意Secret的完美识别器。
