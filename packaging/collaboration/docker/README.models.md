# 非生产模型配置（显式启用）

## 独立通道进程（已打包，尚未部署）

此节更新下方“尚无入口/relay”的历史状态。`pnpm build:server`现在输出自包含`dist-server/collaboration/operations/opencodex-model-channel.js`。可由受控进程管理器显式启动两种角色：

```sh
node dist-server/collaboration/operations/opencodex-model-channel.js --mode host --port 10101 --endpoint http://127.0.0.1:10100/v1/responses
node dist-server/collaboration/operations/opencodex-model-channel.js --mode relay --port 10101 --socket /run/omb-channel/model.sock
```

两条命令分别运行在宿主和容器，不是同一网络空间；此处仅示例，不是现有服务已配置。端口显式指定，0仅适合探测动态端口。host仅回环访问OpenCodex；relay仅回环监听，通过私有Unix socket到宿主网关，无任何远端TCP回退。配置不从群消息、附件或环境凭据推断，未知/重复参数、非本机上游和非规范socket路径拒绝；启动错误仅输出固定诊断，不回显配置或上游正文。

relay启动和每次连接均要求socket所有者是其当前UID、权限0600，父目录同UID/0700且为无符号链接别名的真实目录；路径不超过100字节。由受信任进程管理目录、挂载和SSH转发，同UID恶意进程不在该检查的防护范围内。不要让候选代码或附件进程使用relay身份或挂载该目录。上游断开/权限变化当前请求失败，socket重建后新请求恢复，不重放旧模型请求。SIGTERM/SIGINT会关闭监听并取消活跃请求；stdout的ready仅代表本地监听建立，不能当模型或钉钉健康证明。

默认headless打包烟测已验证无node_modules的两模式启动、合成HTTP/Unix转发及正常停止；临时无网络容器的生产relay已真实调用Astra/medium并清理。Dockerfile/Compose尚未携带或启动此进程，常驻SSH守护与重连尚未接线，原群服务未切换。本例不迁移账本/Owner或授予新的凭据能力；后续必须先完成唯一服务装配及恢复验证。

## 2026-09-07：保留原服务，私有模型通道已验证但尚未常驻装配

此节替代下方“优先宿主控制面”的实施方向：原账本和工作区在Colima虚拟机内，继续保留唯一原Owner/服务/路径，通过既有SSH master的私有Unix socket调用宿主回环网关，不迁移账本或新建第二个Stream。

新增`startLocalOpenCodexGateway`是显式启动的库入口，尚无自动启动/容器relay/Compose接线。它只绑定127.0.0.1，默认动态端口，上游固定宿主HTTP回环`/v1/responses`。仅接受Astra/medium、无会话续接、不存储的SSE请求，输入1MiB/输出8MiB/并发4/默认60秒；不转发调用者头、不执行工具、不记录正文，拒绝Origin、认证、Cookie以及web_search/MCP/服务端shell等内建工具。客户端function/custom/单层namespace定义可通过，由原受限CLI执行；开发Provider已显式关闭CLI默认web_search，不能以放开网关工具来解决400。

临时真实验证已完成：宿主生产自然模型、宿主CLI只读建议，以及无网络/非root/只读临时容器经Unix socket的自然模型请求。容器仅挂本次私有socket目录，不挂账本、凭据或Docker socket；SSH转发仅复用已有master，缺失时失败；结束已撤销并清理。Unix socket所有者501、权限600、父目录0700；此权限是探测试点事实，不是可跨主机硬编码的通用身份。旧服务root缺少DAC_OVERRIDE，不能假定可访问该socket，后续relay需明确身份与生命周期。

SSE完成事件、模型元数据及业务结果仍由消费适配器验证，网关本身不判定业务完成。尚需实现常驻进程、SSH断线恢复、容器本机回环relay及打包接线，再验证唯一旧服务切换。临时探测不是线上启用，127.0.0.1依然只代表进程所在网络空间。保持候选代码/附件隔离，不因模型网络诊断取消隔离；六类真实群场景、文档正文、独立supervisor和Owner验收不变。

## 开发Provider的本机OpenCodex路由

开发阶段使用Codex CLI执行只读检查，但模型服务可以显式选择本机OpenCodex；这不是OpenCode。宿主控制面可设置：

```sh
OMB_CODEX_OPENCODEX_ENDPOINT=http://127.0.0.1:10100/v1/responses
OMB_CODEX_MODEL=gpt-6-astra
OMB_CODEX_REASONING_EFFORT=medium
```

端点只允许HTTP字面回环地址及精确`/v1/responses`路径，不接受远端、URL凭据、查询或片段；模型必须明确，推理省略时使用medium。开发器以CLI配置覆盖选择OpenCodex Responses provider，并在每次运行的私有临时CODEX_HOME中执行`--ignore-user-config`，不继承原CODEX_HOME登录文件或模型密钥环境变量；结束时随本次Provider目录清理。未配置此端点时保持原CLI路径，不隐式改变其他Provider。

既有只读sandbox或已配置的独立UID/外部文件权限约束不变；没有添加绕过sandbox的标志。需要支持`--ignore-user-config`的Codex CLI，已用宿主0.146.0验证；不兼容时失败，不自动降级或借用认证。此路由不取消上下文与写范围校验，也不代替Docker写入和独立测试证据。真实合成文件已验证CLI提出准确修改且原文件不变，尚未在现有群服务中启用。

## 2026-09-07：已授权本机直连，优先宿主控制面

Owner 已明确授权受限本机 OpenCodex 调用，并允许网络问题时直接在宿主机执行诊断和模型请求。宿主机生产适配器已真实验证 `http://127.0.0.1:10100/v1/responses`、`gpt-6-astra`、`medium`、无密钥请求；宿主调用现有 Docker 生产执行器的启动前取消和运行中父子进程终止也通过。两项验证独立完成，不是整个 headless/钉钉链路已上线。

优先采用宿主机 headless 控制面直连模型、指定 Colima context 隔离代码/文档执行的路径，不新增容器到宿主的 TCP 代理、全网监听或 Host 覆写。runtime 已允许 macOS 在 `docker_linux` 执行隔离配置下运行；这不自动解决配置迁移。下文三个模型角色的回环配置只能用于实际运行在宿主机的控制进程，不能直接写入现有容器。

切换现有试点前仍需核对：唯一服务/账本租约与原 Owner 保持不变、Docker daemon可见的仓库/工作区/交换目录、当前Linux VM启动代次文件及既有containment密钥引用、开发Provider的OpenCodex路由。当前开发Provider仍为CodexReadOnlyPatchProvider，不能仅配置自然解释和两个验收角色就宣称开发模型已经切换；不得关闭其只读执行约束或绕过真实文件范围保护。未确认以上装配前，不启动另一个有钉钉接收能力的控制进程，不复制出第二个Owner账本，不停止旧服务。

本次授权解决了“是否允许本机模型调用”的阻碍，不授权取消不可信附件/候选代码隔离，不改变凭据/身份。现有试点仍为旧镜像；六类真实场景、独立supervisor/主机恢复和Owner验收保持待验收。下方2026-09-06“尚未授权”是历史状态。

## OpenCodex 本机无密钥模式

Owner 本次选择为 OpenCodex、`gpt-6-astra`、`medium`，不是 OpenCode。无需修改 OpenCode 启动器或生成 API 密钥。三个角色分别显式配置；不要使用本文下方凭据挂载叠加模板来启动该模式。

自然解释配置：

```sh
OMB_NATURAL_INTAKE_ENABLED=1
OMB_NATURAL_INTAKE_TRANSPORT=opencodex_local
OMB_NATURAL_INTAKE_MODEL=gpt-6-astra
OMB_NATURAL_INTAKE_ENDPOINT=http://127.0.0.1:10100/v1/responses
OMB_NATURAL_INTAKE_REASONING_EFFORT=medium
```

验收映射仍需 `OMB_ACCEPTANCE_MAPPING_ENABLED=1` 和显式 `OMB_ACCEPTANCE_MAPPING_POLICY_REVISION`。对于 `OMB_ACCEPTANCE_MAPPING_PROPOSER` 和 `OMB_ACCEPTANCE_MAPPING_VERIFIER`，分别设置同样的 `_TRANSPORT`、`_MODEL`、`_ENDPOINT`、`_REASONING_EFFORT` 后缀，构造独立无历史请求。此模式不得设置对应 `_CREDENTIAL_FILE`；默认传输仍为 `responses`，只有显式选择才允许不提供凭据。拼错传输名或非法推理值拒绝启动，不静默回退。

无密钥模式只支持字面 `127.0.0.1` 或 `[::1]` 的 HTTP `/v1/responses`，禁止远端/带认证 URL/查询参数/重定向。没有关闭 OpenCodex 本身的认证或改变服务权限；若所配实例要求认证，请求会失败而非绕过。请求固定无工具、无会话复用且不存储，SSE 全部证据核对后才产生 JSON 结果。

本机生产适配器的最小真实 Astra/medium 结构化请求已通过；完整自动化结果见 VERIFY.md。此示例未启用或部署任何服务。Docker 内的 `127.0.0.1` 指容器自己，**不能直接照抄当宿主 OpenCodex 地址**；容器接入方式、真实文档与六类试点仍需验证，不把无密钥模式放宽到远端解决。

## 既有凭据模式

2026-09-06 试点检查：容器通过 `host.docker.internal` 可达健康接口，但 `/v1/models` 返回 `403 origin_rejected`。这是 OpenCodex 无密钥数据面的本机来源检查，不是“健康即模型可用”。不要用手工 Host 覆写、关闭检查或扩大无认证监听解决。容器模型接入须单独设计和验证受限本机通道，并取得 Owner 对该调用能力的明确授权；当前没有配置或部署该通道。

默认 `compose.yaml` 不启用自然解释或验收映射；新增 `compose.models.yaml` 是可选叠加模板，不会自行部署。只有取得唯一 Owner 对所用模型服务、费用和凭据使用的明确授权后，才可以在非生产试点使用。不要借用其他功能或 Codex 登录的凭据。

headless 验收映射配置：`OMB_ACCEPTANCE_MAPPING_ENABLED=1`、`OMB_ACCEPTANCE_MAPPING_POLICY_REVISION`，以及 `PROPOSER` 和 `VERIFIER` 各自的 `OMB_ACCEPTANCE_MAPPING_<ROLE>_MODEL`、`_ENDPOINT`、`_CREDENTIAL_FILE`。端点默认仅 HTTPS，无凭据的 URL；凭据通过绝对路径指向已有、受信任所有者且 mode `0600` 的文件，不通过 API_KEY 环境变量传正文。

两阶段可使用同一型号，但始终构造不同无历史上下文，不能把开发会话原样作为独立复核。有效策略身份由两端模型名、地址、凭据文件引用及规则版本共同派生；变更这些配置后旧缓存不会当作新策略结果。原位轮换密钥而涉及权限/身份改变时也必须更新规则版本并取得 Owner 授权，系统不读取密钥来计算身份。

Compose 叠加模板同时显式启用自然解释及映射，要求配置三个模型角色，并分别提供 `OMB_NATURAL_INTAKE_HOST_CREDENTIAL_FILE`、`OMB_ACCEPTANCE_MAPPING_PROPOSER_HOST_CREDENTIAL_FILE`、`OMB_ACCEPTANCE_MAPPING_VERIFIER_HOST_CREDENTIAL_FILE`。即使使用同一份已授权凭据，也应由操作者显式填写这三个引用，不提供隐式回退。

三个文件仅只读挂载到各自固定目标，`create_host_path: false` 防止路径错误变成新目录；不会挂载整个 Secret 目录或更改其他服务的身份。该模板继承主服务原有权限，不额外授予容器权限。健康探针只构造客户端、不读模型凭据或发请求，因此探针健康不证明授权、网络、模型输出或自然协作效果可用。

当前自动映射只支持显式 Node 测试文件及受保护报告器。可在受信任的 `OMB_EXECUTION_TARGET_COMMANDS_JSON` 中为对应命令配置 `acceptanceSourceFiles`，例如 `["src/save.mjs", "src/validation.ts"]`，让两个模型同时核对这些业务实现。此清单是运维配置，不要求群用户填写，也不接受聊天或模型直接设置。

清单路径相对仓库根目录，不受命令 `cwd` 影响；必须逐文件明确列出，不允许绝对路径、路径回退、通配符或重复项。仅支持 `.js/.mjs/.cjs/.ts`；配置仅可用于 `node-test-v1`。所有测试和实现路径都须符合当前 validate 节点的 readScope/denyScope，禁止路径的子目录也不能读取，`.git/.ssh/.env*` 和 node_modules 始终拒绝。通过固定候选 Git 对象读取，拒绝符号链接、子模块、缺失/二进制/损坏/超限文件，不读可变工作区、不执行源码或沿 import 自动扩大读取范围。测试加实现总共最多16项，每项最多32000字节，并受整个映射请求上限约束。

实现源码标记为 `role=implementation`，只能辅助核对实际调用逻辑，不能绑定为报告器的测试用例；源码清单与计划读取/禁止范围进入验收契约校验，变更后不能复用旧缓存。清单不是完整依赖图的证明，未提供的关键实现、资源或外部库仍按证据缺失处理。映射收据获认可并不代表业务验收通过；最终仍须当前 Spec、固定候选、自测和独立复测证据一致。缺少测试、依赖上下文或语义不确定时保持未完成，不能要求群用户填内部哈希绕过。该配置能力不表示试点已经启用或真实模型效果已验收。

此模板尚需真实 Compose 合并、授权配置、模型语义评测和六类群聊试点验证。只做模板测试不等于已启用或部署。
