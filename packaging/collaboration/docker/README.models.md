# 非生产模型配置（显式启用）

2026-09-08启用更新：长响应修复已同时启用宿主固定bundle与Docker权限修正版f09d3bf3…（受测源码d6b4e0b），systemd交接通过。正式relay经产品实际客户端真实调用Astra/medium完成并校验通过；不是原业务任务交付。临时镜像构建的umask077曾令六程序bundle变成root0600、UID501启动失败，现仅程序文件为0444，字节hash不变；实际501/10001读取/语法及501 relay启动均已检查。以后打包必须显式保证运行身份可读，不能只用root健康检查或内容哈希替代。socket、checkpoint和凭据权限未放宽。当前固定实例、失败/恢复、备份及待验收项见PROGRESS与conversation-provider-timeout-rollout-20260908.json；下方“未切换”等为历史。

2026-09-08长响应修复：原需求只提案实测确认宿主/容器网关的旧60秒硬期限截断正常SSE。两层网关现在默认入站60秒、空闲60秒、硬总15分钟；仅合法上游进展刷新空闲期限，入站/总期限不刷新，输入1MiB、输出8MiB、并发4和权限过滤不变。显式timeoutMs仍是硬总时限，idleTimeoutMs最多60秒。宿主固定发布bundle与Docker relay均须更新；只更新其中一层仍可能被另一层截断。可选onDiagnostic只输出固定终态元数据，不默认记录正文。原上下文最终154秒长响应、CLI0和3文件建议校验已通过，未应用；正式启用状态看PROGRESS。下方60秒业务客户端和历史“无需覆盖网关”仅指此前不同修复。

2026-09-07最新证据：已授权第4次固定候选双阶段真实映射通过，并核对全部绑定断言在两个独立Docker报告中通过，更新下文“映射失败待诊断”的历史状态。恢复只供受信任本机入口一次性使用，普通流程仍三次，不能从环境变量/群消息启用。v30仅追加恢复表，不改旧三次记录；尚未迁移原群账本，切换前必须准备匹配schema版本的备份/回滚。真实文档/六类群业务及OS恢复仍待验收。

本地OpenCodex流式适配器分别限制传输8MiB和最终正文256KiB，避免逐token协议开销提前耗尽正文额度；超限仍失败并取消，60秒请求时限和全部完成证据校验不变。这是业务客户端修复，不要求覆盖已安装的固定宿主网关副本。

2026-09-07开发中更新：验收实现上下文支持显式.tsx/.jsx（下方旧清单仅列.js/.mjs/.cjs/.ts的描述由此扩展），与原固定候选/范围/脱敏限制相同。测试执行参数仍不支持TSX/JSX。当前新增试点行为测试为tests/board-behavior.test.mjs，复核需同时提供app/release-board-state.ts及app/release-board.tsx；原源码规则测试仍保留。此配置尚未应用于VM原仓库；真实模型映射探测失败待诊断，不据此切换或声称业务完成。

## 宿主用户级常驻通道（2026-09-07已安装，群服务未切换）

当前宿主已安装专用`com.openmausbot.opencodex-pilot-channel`用户LaunchAgent，固定版本f294357；18101连接既有Colima master，VM目录`/tmp/omb-model-channel-18101`。私有安装根目录为`/Users/mac/Library/Application Support/OpenMausBot/ModelChannel`，installation.json保存版本/发布目录/摘要，state/channel.json为稳定预算；不得清空或改路径重试。已用隔离临时容器通过常驻通道真实调用Astra/medium，原钉钉服务尚未切换。

只停止此次通道的回滚入口为`launchctl bootout gui/501/com.openmausbot.opencodex-pilot-channel`；保留plist、固定发布副本和checkpoint，不删除身份/凭据或其他服务。重新加载前核对原状态，不同时运行第二个同端口bridge。此服务仅用户加载/登录，不等于Linux systemd或主机/VM重启验收。下述模板用于受控安装，不应再次覆盖现有安装。

专用`com.openmausbot.opencodex-pilot-channel.plist`与`opencodex-launch-agent.mjs`配套：安装时把已验证通道bundle复制为同目录`opencodex-model-channel.mjs`，替换HOME/NODE/ROOT/RELEASE占位符并校验plist；发布目录固定，不能使用构建中的dist-server。ROOT/state须当前用户/0700，稳定channel.json不得清空换预算；默认固定宿主18101，VM socket随该端口固定。安装前检查runtime、端口和既有服务，不能覆盖未知配置。

最小环境启动；正常停止不自动拉起，异常死亡由launchd恢复（30秒节流/停止）。启动器捕获配置/导入/通道异常后静态报错并驻留停止尝试，需操作者检查；launchd显示running不能当健康。Node缺失等JS启动前错误不受驻留机制保护。用户级RunAtLoad不代替Linux systemd和无人登录主机恢复，原群服务切换仍须先核对账本/租约/在途任务及回滚。

## 已有Colima SSH master的守护桥接（代码已接线，尚未部署）

通道入口新增`bridge`模式，它包含宿主网关和SSH转发守护，替代手工维护临时forward。只支持此次授权的`colima-openmausbot-pilot`，例如：

```sh
node dist-server/collaboration/operations/opencodex-model-channel.js --mode bridge --port 10101 --endpoint http://127.0.0.1:10100/v1/responses --ssh-config /Users/mac/.colima/_lima/colima-openmausbot-pilot/ssh.config
```

上例是当前宿主路径示例，不是已安装服务。端口必须非零并独占；对应VM socket固定为`/tmp/omb-model-channel-10101/model.sock`。先绑定宿主端口再变更转发，退出先清理转发再释放端口。目录保留以支持同路径bind mount上的socket重建，不复制账本或Owner。

仅复用已存在SSH master；缺失时继续观察，不建立新登录连接、不读私钥或修改SSH认证。SSH每次调用有5秒/4KiB上限，禁止回退连接；master PID加VM boot ID作为代次。目录/socket由当前SSH UID拥有且为0700/0600，拒绝链接和普通文件；Linux内核监听表确认转发仍在监听，残留socket文件不能冒充健康。取消只认可正常成功，或完整退出255且精确返回“未转发”；超时/其他失败保持清理不确定。

守护每10秒串行检查，同代次连续三次恢复失败后不再修改，只观察代次变化；不重放模型请求。状态JSON区分waiting/connected/retrying/failed，ready仍只表示本机监听。收到SIGTERM/SIGINT等待在途有界操作后清理；无法确认清理时退出失败，不伪报成功。显式配置下文`--state-file`可跨进程持久保存预算，未配置时只在进程内计数。当前持久预算完整回归及真实Docker五场景通过；OS自启和真实VM重启仍待验收。

真实临时通道已验证同一master下取消转发后自动恢复，前后两次隔离容器模型请求均通过并清理。本节不表示launchd/systemd、Dockerfile/Compose或原群服务已切换；后续仍需完成受控常驻装配和真实群六场景。

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

## 中继启动前检查

### 常驻bridge的持久失败次数

bridge模式新增可选`--state-file`。常驻部署应为同一固定端口始终使用同一绝对规范路径；状态父目录必须当前用户所有、0700且不是符号链接，文件必须当前用户所有的0600单链接普通文件。路径或文件损坏时拒绝启动，不自动删除/覆盖修复；父目录需由部署步骤显式准备。

状态保存通道端口、实际master代次和恢复次数，不保存模型输入、凭据或账本。每次SSH恢复变更前先持久预留一次，监听确认成功后持久清零；准备期间进程被强制终止也消耗一次。同代次达到3次后不再恢复；观察到新代次才允许新预算。写入失败会锁定本进程，不继续改通道或反复重试写文件。固定本机端口同时承担单写者锁，不能让不同部署共用一个状态路径。

未设置该参数仍为旧进程内计数，不能据此声称重启不退款。不要通过删除状态、换文件路径或主动重建SSH master来绕过停止条件；异常应保留证据并重新规划。当前已经实现并完成定向/强制退出测试，用户级launchd安装与OS真实重启仍未验收。

### 可重复的Docker回归

`scripts/smoke-docker-opencodex.mjs`已固化五类临时容器验证：正常关闭、中继异常退出、业务启动失败、冻结中继后超时整体退出，以及通道缺失拒绝启动。它不是六类真实群业务验收脚本。

先构建服务端包，显式设置`OMB_DOCKER_MODEL_SMOKE=1`和`OMB_DOCKER_MODEL_SMOKE_IMAGE`（已缓存运行时镜像的完整`sha256:`摘要），再执行`node --experimental-strip-types scripts/smoke-docker-opencodex.mjs`。未opt-in或镜像不是完整摘要时，在创建临时资源前拒绝。固定使用`colima-openmausbot-pilot`及当前用户的既有Colima SSH master；远端UID/GID只读取后用于专用relay，不能是root或Provider身份。不新建登录连接、不拉取镜像、不调用真实模型、不启用钉钉、不挂原账本或凭据。Docker构建和临时容器均无网络，沿用原三项cap，结果检查后清理本次容器/镜像标签/通道/临时目录。

脚本只清理事前确认不存在、且本次bridge已成功启动对应的私有目录，拒绝接管或删除预先存在的目录。需要本机Docker和回环/SSH访问权限；执行审批超时不表示测试已启动。运行期间不要修改受测源码或包。

Docker运行镜像现在包含`collaboration-docker.js`及独立channel包；默认不启用relay，兼容原headless。`compose.opencodex.yaml`是无密钥模式专用overlay（Compose >=2.24.4），只和base compose合并，不和`compose.models.yaml`混用。需要显式提供已验证的VM私有socket目录、拥有该socket的专用UID/GID及验收策略版本；端口固定18100，四角色固定Astra/medium。!override保留原账本、仓库、Docker socket和两份业务凭据挂载，仅移除旧模型auth挂载，不修改或删除原文件。缺少目录不能自动创建。

wrapper经setpriv清空附加组、继承/ambient能力和凭据环境；relay必须非root且不同于执行Provider身份，只有socket持有者可启动。relay探测后才启动headless；二者任一退出则关闭另一方，父stdin管道关闭是relay终止通知，不需要新增CAP_KILL。启动5秒/关闭10秒有界，Compose给20秒停止宽限；异常/超时以非零主进程退出交给Docker/tini关闭PID命名空间。不要在宿主启用relay wrapper模式。真实临时容器已补SIGSTOP冻结生产relay的故障注入：它不能响应父管道关闭，约10秒后wrapper失败退出、整个容器停止且State.Pid=0；不代表宿主/VM重启恢复。

真实缓存镜像已验证：正常SIGTERM、中继被终止后业务退出、业务配置失败后中继退出、缺少通道时无业务启动输出。全部为禁用钉钉/业务执行、无原账本/凭据的临时容器；服务启动健康JSON不表示业务ready或Owner验收通过。原试点未切换，需先核对租约/在途任务/原配置连续性与回滚，再启动唯一非生产服务。

独立通道入口的relay模式可增加`--probe-upstream 1`。监听前通过受保护Unix socket向宿主网关发送空请求，要求返回网关的明确拒绝；不调用模型、不发送用户材料。连接失败、超时、错误协议或超限响应会终止启动，不打印上游诊断正文。默认1.5秒、4KiB响应/响应头，无重试、无TCP回退、无重定向。

这是通道可达检查，不是OpenCodex模型或钉钉业务健康检查；未启用此选项的旧relay仍只验证文件权限和本地监听。真实临时容器已验证探测后Astra/medium调用及私有连接恢复；wrapper和镜像/Compose接线已实现，常驻宿主服务与唯一群服务切换仍未完成。

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
## 2026-09-07 当前非生产部署事实

唯一`colima-openmausbot-pilot`服务已切换到固定`opencodex-def5f17`镜像，四角色使用宿主OpenCodex的`gpt-6-astra`/medium，无新增模型密钥。原账本schema11→30已先在隔离副本验证，再保存完整停机备份后迁移；Owner与原事件/回复历史保留。原仓库保持不动，新独立试点仓库具备六项业务/源码测试、Node断言报告器和TSX只读实现上下文。

systemd已使用VM内固定版本配置，操作只针对collaboration，不使用down/remove-orphans；实际进程重启后恢复租约且无事件/Outbox重放。版本目录为`/var/lib/openmausbot-collaboration-pilot/releases/def5f17`，其中ROLLBACK.txt明确禁止用旧schema11镜像打开现账本；schema匹配观察模式与完整备份均保留。宿主模型通道原安装副本及预算不变。

以上不是完整产品验收：独立`--health`返回configured不能证明原Stream connected；真实新群消息、六业务场景、在线文档/表格、解析镜像、独立supervisor和VM/宿主重启及Owner最终确认仍待完成。以下关于“尚未切换/安装”的段落为历史实现记录。
