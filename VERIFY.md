# Meta 协作验证记录

## 当前完整验证状态：持久预算全链通过（2026-09-07）

- 84244/967c3b最终exit0：完整pnpm test（主集、broker、桌面、普通/headless打包链）通过；包含独立通道及wrapper，源码/测试运行期间固定。输出截断不补造统计。结合89940/019bd7和55193/34d141，本批完整验证已齐，所有句柄终态；以下“运行中”为中间观察记录。

- 拆分独立验证后，89940/019bd7已exit0：当前源码的持久checkpoint接线及真实Docker五场景/清理通过；55193/34d141已exit0：pnpm typecheck、独立tsc输出/tmp/openmausbot-checkpoint-typecheck和diff通过。以上终态来自前轮交接证据，不再轮询。
- 本轮6dd83b/3803bb重新读取84244，确认为运行中且新增多项通过输出；继续同一pnpm test，无重启。源码和测试固定，完整结果仍待最终退出码。
- 436c10只读指定Docker context及launchctl/lsof：原群容器healthy，未加载拟用LaunchAgent，18101没有监听输出。未安装或切换群服务，不构成OS自动启动/恢复验收。

## 历史完整验证入口状态（2026-09-07）

- cell417与唯一重试cell419都在执行授权审核阶段超时，命令未启动；两者均终态，没有运行中的完整回归或真实Docker会话。不能将等待回执的旧记录当作当前仍有进程。
- 本批有效证据止于54535/c6d111的42项定向、typecheck、build:server及diff；真实进程退出/SIGKILL为合成SSH操作。启用本批持久checkpoint的真实Colima五场景和完整pnpm test仍未运行。旧b57d8ef之前的全量证明不覆盖当前代码。
- 不重复超过已许可的一次重试；保留代码、用例与证据，待用户确认重新发起验证或执行入口明确恢复后继续。原模型调用授权不缺失，无需密钥。

## 2026-09-07 跨进程SSH恢复预算

- ca8fa5、57ec75、dceb06均为新增契约预期红灯；54535/c6d111 exit0：4文件42项、pnpm typecheck、build:server、diff通过。包含4个真实独立Node进程共享私有状态的失败预算；另连续3次在prepare内SIGKILL，文件各保留1/2/3，第四次不进入prepare并正常结束。这里只用合成SSH操作，不冒称真实master崩溃/主机重启。
- 文件用例验证同端口复读、跨端口拒绝、严格字段/0–3范围/4KiB、权限/软硬链接/父目录、外部替换/删除拒绝；状态机验证先落盘后修改、监听成功后清零、写入失败不再修改。bridge损坏存储启动拒绝且释放监听，无SSH调用。
- cell417完整验证调用审核超时未启动；cell419是唯一重试，当前等待回执和最终链路结果。源码和测试固定，不能提前声称真实五类或本批全量通过。
- fc7e81只读launchctl/路径检查：未加载同名通道服务，拟安装plist/ModelChannel目录均不存在；没有写入宿主服务配置、创建身份/读取凭据或切换群服务。

## 2026-09-07 可重复Docker模型服务烟测

- 9089d71业务代码保持不变；新增scripts/smoke-docker-opencodex.mjs，基于已经验证的临时脚本，改为当前用户/仓库路径、显式opt-in和缓存镜像完整摘要、读取实际远端专用UID/GID，并收紧私有目录清理归属条件。176ad1：默认不开启、缺少摘要、非法摘要三种拒绝路径均exit1且无stdout，不创建临时资源。语法检查通过。
- 66468/55d694 exit0：新仓库脚本用固定缓存镜像验证生产wrapper/relay/headless五场景，含SIGSTOP冻结relay后约10秒退出1/State.Pid0；全部临时容器、派生镜像标签、SSH通道/目录清理通过。无真实群/模型请求、身份/凭据或原账本变更。76770负责本批typecheck/node-check/diff最终核对。
- 76770/f0173f最终exit0，类型/语法/diff核对完成；7f8da79本地提交本批4文件，不push。本批仅验证脚本及说明变更，不重复9089d71已通过且业务代码未变的完整回归；不能把这项测试资产提交当真实六场景或常驻部署完成。所有句柄终态。

## 2026-09-07 启动接线完整验证终态

- 54406/773901 exit0：严格四类真实临时Docker烟测、完整`pnpm test`、`pnpm typecheck`、`pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-docker-wrapper-typecheck`和`git diff --check`全部完成。普通包无node_modules启动/9个代理、新channel父管道关闭和兼容Docker wrapper的headless健康/启动/SIGTERM均通过。中间输出截断，不补造总数；此前steer-e2e连接重置本次未复现，根因仍未知。
- 38168/1681d8另证实冻结生产relay后关闭超时触发Docker整体退出（code1/State.Pid0），加原四场景及全部临时资源清理通过。此前文档“尚未验证强制超时路径”已由此证据替代；仍非OS/VM重启或群业务验收。
- 本批代码/测试在54406运行期间固定，所有验证句柄已终态；仅只读原账本统计首次cell401审核超时，后续唯一重试不属于业务动作或验证重跑。未迁移原账本、切换服务、修改Owner/凭据或推送。
- a4115b exit0：以readOnly DatabaseSync及一致性读事务统计原账本，1个active Owner/1个live租约、运行记录无running、节点无leased/running/validating、Outbox无pending/claimed。保留5项needs_configuration及1项collecting，不清掉旧失败或采集事项。此为瞬时快照，切换前必须再次核对。

## 2026-09-07 卡死中继与容器强制关闭验证

- 前轮cell393授权审核超时，命令没有启动。cell395是回执允许的唯一重试，已返回54406；cf5a31证明收紧的四类Docker烟测（真实app/钉钉禁用健康JSON、缺通道空stdout）通过并清理，随后完整pnpm test实际运行。steer-e2e本次2项通过，但此前ECONNRESET根因仍未知，不称修复。54406仍待完整链终态，代码与测试固定。
- 新增故障注入只改/tmp/openmausbot-docker-wrapper-probe.mjs：先启动正常生产wrapper/relay/headless临时容器，以relay同UID对其发送SIGSTOP，再向容器主进程发SIGTERM。断言退出码1、至少经历9秒的关闭等待，以及Docker State.Pid=0。38168/1681d8 exit0：原四类及此冻结中继超时场景均通过，全部临时容器、缓存派生镜像标签、私有通道和目录清理通过。第一次cell397仅审核超时未启动，唯一重试成功。
- 此证据覆盖本次Docker/tini PID命名空间强制收束，不代表OS自动启动/VM或主机重启恢复，也不证明真实群业务ready。原试点9b9e95只读仍running/healthy，未切换。

## 2026-09-07 Docker双进程生命周期和无密钥Compose

- 原19337/2ed275已终态exit1：完整主集3110通过/1失败/18跳过，唯一steer-e2e排队用例fetch ECONNRESET；独立复测2项此前通过，根因未知。不重轮询旧句柄，不称完整通过。
- 766c94/f49e1c红灯后实现；fccf97新增测试复现就绪/退出同刻仍启动业务、取消后非零退出误报0，两项已修复。30186/a00885 exit0：55项/typecheck/build/server和无依赖通道父stdin关闭、旧模式Docker wrapper健康启动/SIGTERM通过。
- 47985/65531f因默认沙箱Unix监听EPERM失败；授权宿主87818/4c4ae3 exit0：57项/typecheck、四类生产Docker临时容器启动退出通过。首次76406/bd7879烟测超时来自等待NULL_LOGGER不输出的事件；修正为健康JSON，不改业务。真实测试固定context/缓存镜像、无网络/只读、原三cap、无群/执行/原数据凭据，清理全部本次资源。无响应relay强制超时收束尚未真实验证。
- b922df真实Compose合成环境合并exit0：6挂载且无旧模型auth，四角色同Astra/medium回环路由，无模型密钥、cap仍CHOWN/SETGID/SETUID；不读取真实.env、不部署服务。
- 新严格Docker烟测+完整pnpm test/typecheck/独立编译/diff命令已提交，等待functions cell393回执与后续终态。没有本批完整通过或commit证据；对应源码/测试保持固定，文档检查点可更新。后续不要依据历史绿色报告提交未完整验证的新启动接线。

## 2026-09-07 中继启动通道探测（完整验证待终态）

- da7582 exit1：新增12项红灯，旧relay没有probe、旧CLI拒绝选项。6952/680a51 exit0：31项及pnpm typecheck/git diff --check通过；覆盖上游空请求、状态/类型/JSON/响应超限拒绝、头/正文挂起超时、断开、权限及超时范围，默认旧路径仍兼容。
- 19337/47abcf：生产relay显式开启probeUpstream，两个无网络/非root/只读临时Colima容器经既有master私有Unix通道完成真实Astra/medium合成请求，完成元数据与错误模型拒绝通过；中间仅取消本次转发，守护恢复后第二次探测/调用成功，connections=2，临时资源清理通过。不等于实际群服务、主机重启或常驻装配。
- c6e15d exit0：指定context缓存镜像临时容器验证setpriv最小权限，UID/GID501、无额外附加组，Inh/Prm/Eff/Amb能力均零和NoNewPrivs=1；无挂载，不影响原试点。
- 19337完整验证会话仍运行，8907c1主集发现既有steer-e2e排队用例失败；最终详细原因待该会话终态。82679/c8b5eb独立复测2项通过不抵消该失败，不宣称根因已修复。本批代码/测试固定，尚未提交；后续继续原19337，不重复启动全量，终态失败时其后&&链未执行。新打包smoke代码已启用显式probe，但尚未取得本批打包验证通过证据。

## 2026-09-07 已有SSH master桥接守护

- 48bfef为新模块缺失TDD；45997/257911 exit0为15项与typecheck。066333两项真实本地shell负例发现set-e不能保护&&列表早期失败；改显式guard后同一测试通过，未变更用户路径。8cdf3f为bridge/CLI缺失红灯；8743/96891a exit0（61项/typecheck/原两模式和headless打包smoke）。0885df为缺少/proc/net/unix监听校验红灯，随后实现。
- 69856/13f69e exit0：62项/typecheck/diff和真实/tmp/openmausbot-managed-channel-probe.mjs通过。生产SSH命令经当前既有master运行，profile固定；新私有目录事前确认不存在，固定回环端口绑定后创建通道。两个指定缓存镜像的临时network=none/read-only/UID501容器分别得到Astra/medium合成JSON，完成元数据与错误模型拒绝均核验；中间取消此次forward，守护重新connect后再确认活监听，connections=2。最终撤销forward/删除本次socket、临时容器退出、事前确认新建的空目录rmdir和网关退出全部通过。不等于真实SSH master消失/VM重启或群业务交付。
- 1f8745为新增超时/其他退出取消判定的两项红灯；已收紧完整SSH退出255与精确良性诊断组合，非正常子进程结果为-1。90291/1391b6 exit0：最终64项定向/typecheck、相同真实恢复复测、完整pnpm test/typecheck/独立编译至/tmp/openmausbot-managed-bridge-typecheck/diff全链通过。主集283文件通过/1文件跳过、3099项通过/18项跳过（3117登记），broker 7项及桌面/打包链均通过。独立通道bundle约20.1KiB；打包smoke执行host/relay，不把它说成bridge模式的OS服务重启验证。源码/测试在运行期间固定；所有本批句柄终态，13文件本地提交，不push。原群服务、Docker常驻接线、真实master/VM重启与Owner验收仍未完成。

## 2026-09-07 独立模型通道进程和容器回环relay

- 3ee706 exit1：TDD两个新模块尚不存在，未运行行为测试。首次宿主测试cell332权限审核超时、未启动；唯一重试82678/c32b81为38通过1失败，来自新增it.each数组展开夹具，修复参数传递后验证。14473/22eefd typecheck exit0。
- 737915 exit1：新增打包烟测预期暴露opencodex-model-channel.js未进入bundle。补入口后7376/aea721 exit0：39项回归、typecheck、headless打包smoke、relay真实探测包编译和diff通过；两模式在无node_modules暂存目录启动/转发合成SSE/SIGTERM退出均通过，原headless健康JSON/存活/退出也通过。
- 27453/1e9ed1 exit0：指定Colima缓存镜像的临时容器，network=none/read-only/UID501/no-new-privileges/cap-drop ALL，仅挂本次私有socket。使用生产startLocalOpenCodexRelay与原ResponsesNaturalIntakeModel，容器普通HTTP fetch只访问其回环地址，经私有SSH Unix通道和宿主网关真实请求Astra/medium；解析器核验完成元数据，合成JSON相符，其他模型400。临时资源清理断言通过。恢复测试是合成socket停止/重建后新请求成功，不代表真实SSH重连/宿主重启恢复。
- 完整63105/28d0d8 exit0：`pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-model-channel-typecheck && git diff --check`全链终态通过，含主集、broker、桌面、普通包/9代理路径、独立通道两模式和headless无node_modules启动/SIGTERM。源码和测试在运行期间固定，跨轮继续原进程，没有重新启动；完整输出截断，不补造统计。本批12文件本地提交，不push。无真实群消息/账本迁移/Owner更改/旧容器替换，所有相关会话已终态。

## 2026-09-07 本机网关和私有容器通道

- 84586/dc93f4 exit0：前轮网关12项/typecheck/diff取得终态。扩展测试首次c31aca因默认沙箱loopback EPERM失败，非网关行为失败；授权宿主63631/c1d5c9 exit0：21项及typecheck/diff通过。覆盖四并发、断开释放、挂起fetch超时及迟到body取消、挂起流/close、输出8MiB限制、chunked输入限制、非SSE拒绝和客户端工具白名单。
- 首次真实宿主探测cell299审核超时，未启动；唯一重试56240/0dcf68 exit1：自然解释成功，开发CLI拒绝。747f73合成请求字段诊断发现CLI0.146.0默认web_search，网关400；仅输出字段名、工具类型及模型参数，未输出请求正文/凭据。41217/cfab9e新增web_search=disabled断言预期失败；实现后20382/28d82e exit0，35项/typecheck/diff及/tmp/openmausbot-gateway-host-probe.mjs全部通过。真实自然解释验证完成元数据，真实开发建议准确且原合成文件不变；未独立核验CLI返回的模型元数据。
- 84932/c6a841 exit0：/tmp/openmausbot-unix-channel-probe.mjs复用已存在SSH master，VM私有socket实测501:600，指定缓存镜像临时容器network=none/read-only/UID501/cap-drop ALL/no-new-privileges。通过生产自然模型适配器的Unix fetch传输返回合成JSON，SSE核验模型gpt-6-astra/medium；其他模型400拒绝。随后撤销forward、删除本次socket目录、关闭网关，临时容器--rm退出，清理断言通过。不含容器回环relay、开发CLI容器执行、持久服务/重启或任何真实群任务。
- 完整验证92435/28c45a exit1：3055通过/1失败/18跳过，279文件。唯一失败runtime-repository-serialization.test.ts:679，两个不同仓库均在释放前启动，数组顺序相反；用例不应要求跨仓库固定启动顺序。仅改为排序副本精确相等，仍检查完整成员数与各一次启动，未放宽同仓库串行、未改生产调度。
- 77051/906cb3 exit0：`pnpm vitest run server/collaboration/operations/runtime-repository-serialization.test.ts && pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-local-gateway-typecheck && git diff --check`全链终态通过。定向22项通过；完整含主集、broker、桌面与普通/headless打包无node_modules启动、健康JSON及SIGTERM。运行期间业务代码/测试固定；完整中间输出截断，不补造统计。所有句柄已终态，不再轮询。仅本批10文件本地提交，不push；常驻接线及真实群/文档/六场景仍未验收。

## 2026-09-07 开发Provider OpenCodex路由验证

- 83962/480adf exit1：新增4项预期失败，CLI未收到路由覆盖/临时配置选项，非法端点仍走目录创建而非提前配置拒绝。实现后90272/c76344 exit0：2文件21项/typecheck/diff通过；增加空/片段/错误路径、显式模型、推理及清理覆盖后79034/aaeeb8 exit0：2文件25项/typecheck/diff通过。
- 29364/f4ce98 exit0：真实宿主Codex CLI 0.146.0经生产CodexReadOnlyPatchProvider，显式设置OpenCodex回环Responses provider、gpt-6-astra/medium、临时CODEX_HOME及--ignore-user-config；合成src/value.txt建议精确为after换行，实际文件仍before，未执行应用。该证据验证请求路由/CLI兼容与合成建议，不宣称独立核验模型端返回元数据或完整业务语义。
- 47234/c3ff86 exit0：`pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-opencodex-provider-typecheck && git diff --check`，主集、broker、桌面、普通及headless打包运行全部通过。全部句柄终态，业务/测试代码在全量运行期间固定。输出截断不补造全量总数。
- 29548c exit0仅查询指定旧容器的挂载路径；未读取挂载文件内容、模型密钥或现有账本，不执行迁移。新路由尚未在真实群服务启用；本批不能替代单账本切换、Docker代码应用、真实六场景或Owner签字。

## 2026-09-07 已授权宿主模型与Docker执行路径

- 83385/659985 exit0：直接宿主运行生产ResponsesNaturalIntakeModel；回环10100、OpenCodex gpt-6-astra/medium，严格JSON schema要求connected=true并核对；生产SSE解析器验证模型与推理强度。无密钥、无工具、无文件输入、store=false。首次cell264权限审核超时未启动，随后唯一重试成功。
- 1c3b01 exit0：显式colima-openmausbot-pilot只读查询，旧服务healthy，固定镜像sha256:2ae332cd23df93e5bb6a4339e4190d2ad0416d016c618a586d89702f0646af58。首次cell263超时未启动，后续唯一重试成功。
- 002f2d exit0：`OMB_CANCEL_SMOKE_CONTEXT=colima-openmausbot-pilot OMB_CANCEL_SMOKE_IMAGE=sha256:2ae332cd23df93e5bb6a4339e4190d2ad0416d016c618a586d89702f0646af58 node --experimental-strip-types server/collaboration/operations/docker-command-cancel.smoke.ts`在宿主执行；before_gate未产生心跳、running_tree心跳停止，容器均停止，所有脚本隔离断言和本次临时资源清理完成。仅使用自生成可信夹具、缓存镜像与生产执行器，不下载镜像、不处理用户材料。
- 两个独立smoke不是集成headless部署：未证明开发Provider接入OpenCodex、真实钉钉消息处理、账本迁移、文档镜像、独立supervisor或六类验收。没有代码/测试变化；原88277完整回归仍保留，不声称本轮重新跑全量。Goal恢复后不可继续引用旧“未授权”作为阻碍。

## 2026-09-06 当前产品验收范围审计（文档批次）

- 代码基线469de46无业务改动。核对SPEC、旧试点手册及scripts/collaboration-pilot/report-schema.ts：旧v1报告没有当前六类单独门禁；标明旧报告不能证明PMO目标完成，不更改旧数据或补造证据。
- e4e55e exit0：显式colima-openmausbot-pilot只读容器/镜像查询，旧服务healthy、没有解析器镜像缓存；aacd9c是默认沙箱socket权限失败，不是Docker服务故障。92084/d5d272 exit28：匿名官方Registry HEAD在域名解析阶段超时。没有业务副作用；本轮不再盲重试网络。
- 43565/2163e7 exit0：Node只读检查两份手册本地链接及六类必测行、pnpm typecheck和git diff --check通过。仅证明文档结构与类型检查；无六场景实际执行。本轮没有重跑完整测试，沿用业务代码未变的88277/a3ced9完整终态证据。

## 2026-09-06 运行配置批次完整回归终态

- 10722/72b0ff exit0：pnpm vitest run server/env-path.test.ts，13通过7平台跳过。后台探测允许5000ms而断言默认等待更短是静态线索，但未取得失败时探测时序，不能确认为根因。没有改动PATH代码或测试，没有放宽断言。
- 完整复测首次cell238权限审核超时未启动；cell239唯一重试成功启动88277。88277/a3ced9 exit0：`pnpm vitest run server/env-path.test.ts && pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-runtime-policy-typecheck && git diff --check`。包含主集、broker、桌面、普通打包无node_modules启动/9代理和headless健康/运行/SIGTERM；全部命令终态通过。输出截断不补造新测试总数。
- 该完整通过证据替代本批33396失败后的未验证状态，但保留其PATH间歇失败记录。业务代码/测试在完整运行期间固定，所有句柄终态。未调用真实模型、改Docker/网络/凭据或发钉钉消息；OpenCodex gpt-6-astra/medium和完整产品验收范围不变。

## 2026-09-06 运行配置快照验证

- TDD32120/487868 exit1为4项预期失败；94985/c80849 exit1为62通过2失败（旧审批夹具与恢复待审接线）；96347/b0ab53 exit1为195通过1失败（审批夹具execution依赖不齐）。保留权限断言，补齐会抛错且断言不调用的执行端口，恢复账本只在live时发布。
- 19926/108718 exit0：10文件199项、pnpm typecheck及git diff --check通过。覆盖匹配策略的生产协调器双收据正例、换模型直接完成拒绝、独立连接、旧实例/移除仓库、probe/禁用执行/待审恢复、schema28到29和Owner审批幂等。
- 完整回归33396/c41865 exit1，必须检查失败后再提交。
- 本批未调用真实模型；沿用OpenCodex gpt-6-astra/medium，无需密钥。自动测试不替代真实群/文档/Docker六场景与Owner验收。

## 2026-09-06 源码上下文真实模型验证与直接验收漂移修复

- 5cccaa exit1：默认沙箱最小loopback bind检查返回EPERM，因此未将默认沙箱当作可运行完整端口测试。没有开启常驻监听、外部网络或Docker通道。
- 95749/367859 exit0：上轮模型探测审核超时后的唯一重试已实际启动并通过。/tmp/openmausbot-astra-source-context-probe.mjs创建临时固定Git两文件，生产采集器传测试和implementation上下文，真实OpenCodex gpt-6-astra/medium Proposer+Verifier完成精确函数契约映射；收据重读与重复请求不产生新模型调用。无候选执行或真实钉钉交付，不能替代六类试点。
- 87080/326c27 exit1：新增直接读取门禁测试复现readScope变化后candidateHasPassedMetaReview仍true。改为v3双收据保存/直接重算Spec身份后，新增read/deny漂移与低风险自动完成拒绝断言通过。60308/ad07de exit1的4项失败为旧v2合成政策夹具；显式更新夹具到v3并按其当前数据库输入计算身份，不伪造真实验证证据。
- 84705/c06b36 exit0：7文件133项/typecheck/diff通过，包含candidate-verification、candidate-approval、acceptance-source/mapping、actions、runtime-verification-retry、runtime测试。
- 27855/f1f4ee exit0：`pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-source-context-v3-typecheck && git diff --check`完整终态通过。涵盖主集、broker、桌面及普通打包无node_modules启动/9代理路径和headless健康/运行/SIGTERM；固定源码/测试下取得完整链证据，输出截断不补造测试总数。全部句柄终态，本批16个任务文件可本地提交；不混入用户AGENTS.md/outputs、不push、不部署。真实模型证据只覆盖前述合成函数场景，整个产品目标未完成。

## 2026-09-06 固定候选业务实现上下文（尚未完整验证）

- 基线6a0f734；TDD95506/bb016a exit1：12失败/32通过，复现未采集实现、未执行read/deny、角色schema不接受及headless丢字段。96882/66ae34 exit1：两个候选验证新增用例失败，模型视图缺实现且越界未拦截。
- 首次实现68492/2a2550 exit1：80通过/1失败，原有无效报告器错误提示被新清单校验抢先覆盖。未放宽原断言，修复报告器校验顺序；新增cwd基准、重复角色、祖先目录/空read范围和总数约束用例。
- 99466/c72d70 exit0：`pnpm vitest run server/collaboration/acceptance-source.test.ts server/collaboration/acceptance-mapping.test.ts server/collaboration/candidate-verification.test.ts server/collaboration/worktree-manager.test.ts server/collaboration-headless.test.ts && pnpm typecheck && git diff --check`；5文件83项通过。两个模型端口为合成夹具；真实Git对象与SQLite验证固定读取、当前范围、实现角色不可绑定、缓存失效、先于模型/执行阻断。不能替代真实模型或完整回归。
- 完整回归命令计划为 `pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-source-context-typecheck && git diff --check`。cell199 CreateProcess因自动权限审核超时未启动；cell200唯一重试同样未启动。无session/无退出码，不能记测试失败或通过，不再盲重试。
- `/tmp/openmausbot-astra-source-context-probe.mjs`已准备合成固定Git两文件来源、Astra/medium两真实角色、SQLite收据重读及重放探测；cell200首次执行同样在CreateProcess前审核超时，未向模型发请求。模型探测尚可按工具规则重试一次，完整回归需要用户指导/权限执行安排。当前所有工具cell均终态，无运行中操作。本批不提交、不部署；真实群和Docker验收均未发生。

## 2026-09-06 语法感知源码脱敏批次

- 接续TDD c6b77d exit1：初始27项19失败/8通过。parse-only实现后518ad7/ca8f52 exit0：27项与类型检查通过。新增集成及边界578b7b exit1：7失败/49通过；包含两处尚未接线、动态键括号/解构别名/类型字面量遗漏，以及一个把凭据样式正则误设为原样保留的新增测试。后者拆成普通正则保留、凭据样式正则隐藏两例，不放宽敏感值保护。
- 66362/6d2c26 exit0：`pnpm vitest run server/collaboration/sensitive-source.test.ts server/collaboration/acceptance-source.test.ts server/collaboration/acceptance-mapping.test.ts server/collaboration/candidate-verification.test.ts && pnpm typecheck && git diff --check`；4文件89项通过。覆盖固定Git而非可变工作区、源码不执行、解析失败不泄诊断、精确证据行、两角色请求、收据重读、重放幂等和候选验收既有门禁。
- af6b45 exit0：package.json与锁文件root运行依赖TypeScript ^5.8.3/5.9.3一致，开发项已移除；没有升级、安装或清理node_modules。
- 34382/31219e exit0：仅调用已授权本机OpenCodex Astra/medium的真实独立Verifier，Proposer是合成端口。新源码视图保留比较语法且隐藏比较字面量；Verifier明确实际登录/界面未覆盖，返回missing，协调器rejected、无contracts。脚本断言真实拒绝，不将传输失败当负例通过。仅合成源码，无钉钉发送、候选执行或真实交付验收。
- 完整回归45320/55e815 exit0：`pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-source-redaction-typecheck && git diff --check`。主集、broker、桌面、普通打包无node_modules启动/9代理及后续类型/独立编译全部通过，运行期间源码/测试不变；输出截断不补造总数。
- 补查headless打包d792d1 exit1：TypeScript初始化Node系统时引用未定义__filename。不能把上述仅启动index的打包检查当headless已通过。修复bundle-server的CJS位置全局映射（保留模块局部变量），并把既有headless烟测加入默认test:packaged-server。51283/3ad32f exit0：`pnpm test:packaged-server && pnpm typecheck && git diff --check`，所有打包入口重建、普通入口及9代理、headless无依赖目录启动/脱敏健康JSON/运行/SIGTERM均通过。修复后仅重跑受影响的构建/打包/类型链，之前完整主集业务与测试代码未改变，不声称重新跑了一次完整pnpm test。
- headless bundle约11.5MiB：引入完整TypeScript运行包有体积代价，当前无node_modules启动已覆盖，不等于真实容器资源/性能验收。所有本批命令终态，无运行中操作；只提交13个本任务文件，不含用户AGENTS.md/outputs。真实文档/群入口、Docker受限通道、独立隔离/恢复及六场景仍未验收；本批不解决依赖源码采集。

## 2026-09-06 验收映射批次完整验证通过

- 53277/d40579 exit0：`pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-mapping-explanations-typecheck && git diff --check`。主集、broker、updater、desktop-viewer、package-link、save-file、打包无node_modules启动及9代理路径、类型/独立编译全部经过命令串终态验证。终态输出较长被截断，不补造未保留的新统计值。代码和测试在整次运行保持固定。
- 前序61336/5b2f08 exit1：env-path.test.ts第95行等待合成login-shell结果未在默认等待内完成；274文件/2961项通过，1失败，18跳过，430.51秒。19540/c94e6d exit0独立复测13项通过/7跳过，加typecheck/独立编译/diff通过；再进行上述完整重跑。未改该不在本批的路径代码或测试，未放宽断言，根因未确认。
- 本批基于67a941c加acceptance-mapping.ts/test.ts和四份状态文档，完成自动化及已记真实模型合成正反例验证后本地保存，不push或部署。全部句柄终态；下一轮不要再轮询61336/53277或重复尚未开始的运行。
- 产品级缺口继续存在：语法感知源码脱敏、被测依赖源码、Docker授权通道和真实文档/群/六场景验收。函数级模型正例仅覆盖声明的机制测试；不据此缩小完整业务目标。

## 2026-09-06 安全说明契约与真实独立复核正反例

- 1551/4dc256 exit1：模型未收到安全说明契约的新增测试失败，15项通过（含两个角色输出凭据样式示例会失败且收据不保存示例值）。修复后42491/a065f7 exit0，两文件48项及pnpm typecheck通过，未改既有安全拒绝。
- 38354/1bdc1a：真实Astra/medium Proposer提议局部saveStatus测试覆盖完整保存显示流程，独立Verifier返回missing，协调器rejected；原探测期望approved，因此exit1。这是探测预期过宽，不能改模型判定迁就。完整业务条件仍未证实。
- 16859/e1c32b：将另一正例明确限定为saveStatus(true)函数返回值契约，真实两角色输出approved，当前收据重读及缓存幂等核对通过；不等于真实保存/界面或开发执行验收。弱断言负例使用合成Proposer强行绑定两个固定文案相等的断言，真实Verifier识别未调用被测函数，missing/rejected且无contracts。第三个脱敏负例Verifier在60001ms报natural_model_transport_unavailable，整次exit1；失败不算安全通过。
- 73694/ad7e5f exit0：仅重试脱敏负例，真实Verifier在26073ms给uncertain/rejected，指出关键判断已脱敏且无实际登录/界面来源，不以局部辅助函数推断完整业务满足。该负例Proposer为合成端口，Verifier为真实本机模型，角色证据不混淆。
- faf403只读探测证实redactSensitiveText将password ===中的比较运算符替换成隐藏标记；源码采集器仅收集显式测试文件。两个限制尚未修复，不能将不完整上下文带来的拒绝说成上线可用。保护Secret、固定Git对象、依赖上下文与完整业务目标必须一起满足。
- 旧全量11392/e5e1b5 exit1：274文件通过/1失败/1跳过，2961项通过/1失败/18跳过，357.27秒；运行期间插入了TDD，失败项仍使用旧说明，需固定最终版本重跑。61336最终全量已启动仍活跃，最近6aad6e无退出码，命令`pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-mapping-explanations-typecheck && git diff --check`。cell149首次审批超时未运行，唯一重试成功。未提交，恢复先轮询原句柄。

## 2026-09-06 验收映射条件身份真实接线

- 测试先行 89644/913f87 exit1：只依据实际模型输入生成输出的合成端口无法获取 conditionHash，原实现失败；旧测试直接从测试进程预计算标识，未覆盖该真实边界。补模型视图的条件标识后 2626/45b798 exit0，三文件50项与pnpm typecheck通过；canonical request、映射哈希和读取收据验证保持不变。
- 原真实请求 26471/95404e exit1：模型选对连续测试行4–6和确切名称，但返回的条件标识以 c0f416 开头，而主程序 8fcb9e 计算值以 c5c89f 开头，未到独立复核即 failed。入口仅已授权本机 OpenCodex Astra/medium，初次执行审批 cell135 超时未启动，唯一重试成功。
- 修复后 7823/cae783 exit1：条件标识正确、行引用正确，但 rationale 含“错误密码 \"wrong\"”，既有敏感文本规则会改变该文案，validateProposal 会拒绝敏感输出。未拿到独立复核结果，本次不能记approved。不要把该合成字符串当真实Secret，也不能据此移除真实防泄漏门禁；后续对齐模型输出说明与安全契约。
- 全量 11392 正在运行，最近 cfe8dc 无退出码；`pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-mapping-identities-typecheck && git diff --check`。cell139审批超时未启动，cell140唯一重试启动成功。未提交未部署，下次先取该句柄终态。

## 2026-09-06 自然需求契约完整验证终态与 Docker 拒绝原因

- 57677/d17126 exit 0：完整命令为 `pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-natural-answer-contract-typecheck && git diff --check`。275 文件通过/1 跳过，2958 项通过/18 跳过，2976 注册，457.59 秒；broker7、updater15、viewer5、package-link2、save-file10、打包无 node_modules 启动及9代理路径通过，后续类型与独立编译全部完成。存 natural-answer-full-final，原句柄终态。
- 证据对应 c431d4b 加本批 natural-intake.ts/test.ts 改动；四份状态文档与模型说明不影响已验证行为。真实模型/SQLite 的入账、重放、重启及回答已在上一节逐项记录，不代表真实群或执行交付完成。此前未分类的模型失败不作已找到根因处理。
- Docker d2a44a：显式 context colima-openmausbot-pilot；只读 ps 和格式化 inspect，不读取 Env/Secret。主容器 healthy、docker_default 网络，其余历史容器 exited，未修改。93213d exit0 仅表示探测命令完成；HTTP403/error.code=origin_rejected 明确为失败。
- 来源核对 5b33d1：已安装 `/opt/homebrew/lib/node_modules/@bitkyc08/opencodex/src/server/auth-cors.ts`，isAllowedRequestOrigin 在无认证模式先要求 loopback Host；isApiAuthRequired 以 bind hostname 判断，非 loopback 服务必须有数据面凭据。源码另明确支持可信 SSH 本机转发的端口差异，但不意味着任意容器别名被授权。本轮未伪造 Host、关闭防护、增加凭据或改全局配置。
- 受限本机通道会授予指定试点调用当前模型的能力，需 Owner 明确同意后实施与验证；不擅自扩成公网监听或全局无认证访问。当前新审批待答，Goal 保持 active 而非 complete/blocked。

## 2026-09-06 业务问题输出 schema 与真实多轮接线

- 新增三项生成约束测试；初始 af327d 的两项因测试参数表写法错误，修正表后 a26566 exit 1 三项均按预期因无枚举/maxItems=0 失败。实现后 65676/3d1419 exit 0：natural-intake/natural-association 两文件 56 项、pnpm typecheck 通过。原 reserved question/answer、来源/版本/Owner/重放/上下文完整性断言保留。
- 7852/210e45 exit 0：本机无密钥 OpenCodex gpt-6-astra/medium，生产解释器/服务/真实 SQLite；明确登录提示需求入账、保留原话和两条验收、重放不变；另一合成群模糊页面需求重启后 applied、waiting_clarification，追问页面范围和可用性两个问题，Owner 未绑定。无执行器或 DingTalk transport，不能称线上完成。
- 同一临时库追加自然回复：77404/cf8ad5 exit 0，answers 仅包含原 natural-page / natural-pain-point，quotes 精确对应用户补充，questions=[]，两项旧疑问均消除，重复事件未改变快照。前一 21522/6121fd exit 1 未取到 applied，无错误分类，随后同一消息第二次处理通过；原因未确定，不归因为本次修复或宣布稳定性已解决。
- 97481/29d1d0 是探测脚本前提错误：明确需求已成功，但同群第二条模糊输入可进入关联澄清，没有 intake job。独立 intake/restart 测试改用另一合成群，不修改产品新事项判定、权限或关联规则。
- 全量验证正在运行：session 57677，最近 7fd199 无退出码并继续输出通过的 executor/candidate-verification 等套件。命令 `pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-natural-answer-contract-typecheck && git diff --check`。本批不能记完整通过、不能提交，恢复时轮询原句柄。旧 61494 只覆盖上轮版本，不代替当前完整结果。

## 2026-09-06 自然目标确认契约与真实持久化接线复测

- TDD f30f2c exit 1：新增精确目标契约测试失败，25 项通过；补充模型指令后相关三文件 83 项通过。首次组合执行 447d70 exit 1 的唯一失败为沙箱禁止 HTTP listen，82 项通过，未运行其后类型检查；经明确套接字权限运行后通过，未修改断言。
- 完整链 61494/6ee015 exit 0：`pnpm vitest run server/collaboration/natural-intake.test.ts server/collaboration/natural-association.test.ts server/collaboration/operations/opencodex-model.test.ts && pnpm typecheck && pnpm test && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-natural-contract-typecheck && git diff --check`。包含主集、broker、桌面和打包启动/9 代理路径。观察终态存 natural-contract-full-last；这仅证明本地回归，不能覆盖下面的真实模型失败。
- 真实直接解释 71179：8d1ca2 输出 clear_requirement valid=true，目标逐字保留、两项业务验收、无追问；c8b7f5 exit 0 输出 ambiguous_requirement valid=true，泛化优化目标原文、无验收、两个页面/可用性澄清。临时 harness 捕获错误，exit 0 本身不是通过证据，以上是逐项输出核对。此前同脚本 HTTP 502 未重现，原因不明。
- 更接近生产的持久化探测失败：52884/555cbf、89311/9d33a6 均 exit 1，首条明确需求 job=pending 而非 applied。第二次在模型端口加分类，确认 natural_intake_answer_not_pending：answers 中错误加入 questionId=natural-input-pending。生产验证器正确拒绝，未写入已确认目标或伪造修改完成；后续模糊需求/重启断言未执行，不能记通过。首个失败无分类，不能推断同因。脚本 /tmp/openmausbot-astra-durable-probe.mjs 保留，终态存 natural-contract-durable-last。
- 前一探索：Docker context colima-openmausbot-pilot，旧 pilot healthy；宿主两种别名 health 200，host.docker.internal:10100/v1/models 403。无实际容器/网络/配置改动，此证据不证明模型 API 可访问。真实归并样例曾正确选 WI-LOGIN，但六类真实钉钉试点仍未验收。
- 保留六个未提交任务文件，因真实接线失败不自动 commit；恢复需修复系统状态与业务问题输出契约、通过真实探测和完整回归后再提交。不读取密钥、不触及生产或用户文件，不把本地测试成功当最终目标完成。

## 2026-09-06 产品 OpenCodex 流式适配完整验证

- TDD：276aa0 exit 1，新文件 22 失败/6 通过，其中 1 项为沙箱 listen EPERM（环境阻碍），其他失败复现未支持显式本地流式模式/工厂无密钥配置。获准本机套接字测试后 1142/ac33ae 三文件 42 项通过，778d25 exit 0 包含 pnpm typecheck。初次执行审查超时未启动，唯一重试成功，未把环境错误当业务红灯。
- 边界 TDD：3153/aa2306 exit 1，两项新增测试复现取消后迟到响应、错误 Content-Type 响应未清理。修复后 27697/cfe4f1 三文件 44 项通过，后续完整链在 c3c563 exit 0。主集 275 passed/1 skipped，2949 passed/18 skipped，448.03s；broker7、updater15、viewer5、package-link2、save-file10，打包服务无可达 node_modules 启动、9 路代理、类型检查和独立编译/diff 全部通过。
- 完整命令：`pnpm exec vitest run server/collaboration/operations/opencodex-model.test.ts server/collaboration/operations/natural-intake-model.test.ts server/collaboration/operations/acceptance-mapping-model.test.ts && pnpm typecheck && pnpm test && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-opencodex-stream-typecheck && git diff --check`。不改变旧断言/超时，不把跳过测试算通过。
- 真实模型检查：86269/3d52ac exit 0，直接调用生产适配器，指定 opencodex_local、gpt-6-astra、medium、现有本机 /v1/responses，无凭据/Authorization；系统要求返回简单 JSON Schema，user 仅 Set result to OK，结果 {result:OK}。生产解析器已核对流的消息/text done/completed、响应身份和实际 model/effort；不是只读模型目录或假 fetch。该检查先于两项响应清理修复，最终清理版本由完整回归覆盖。
- 覆盖：真实本机 HTTP 请求、JSON Schema/消息数组/stream/no-tools/no-store、跨块中文 UTF-8/CRLF、空 completed.output 的完整流证据；模型/强度/响应身份/消息归属不符、拒绝/工具/错误/中断/后续矛盾/重复结束/缺结束/非空冲突输出、畸形帧/错误类型/超量/取消及迟到 body 清理；未知传输/混合凭据/非回环/URL 能力拒绝，独立复核上下文及策略传输/强度绑定。旧 HTTPS+文件凭据模式回归通过。
- 证据基于 116c0e2 加本批四个业务/测试文件；观察存 opencodex-adapter-full-output/last、opencodex-production-adapter-live，所有句柄终态。说明文档后续更新不改变已测代码，另做 diff 检查。没有部署、改全局包/密钥/身份或发送真实群任务，不能宣称 Docker 接入、真实复杂语义和六类产品场景完成。

## 2026-09-06 OpenCodex Astra/medium 无密钥真实连通通过

- 用户明确纠正 OpenCodex（非 OpenCode）；此前 OpenCode launcher 管理认证问题不是所需路径，不再请求修复该启动器。e426bc 显示 OpenCodex 公开接口地址 `http://127.0.0.1:10100/v1/responses`；36610/239e91 exit 0，对外模型目录含 gpt-6-astra 与 medium。接口查询走现有 CLI，未调用 key 子命令或输出密钥。
- 请求没有 Authorization 或其他认证头，不读取/复制登录凭据；仅 Content-Type:application/json，model=gpt-6-astra，reasoning.effort=medium，tools=[]，tool_choice=none，store=false，input 为只要求回复 OK 的消息数组，stream=true。未发送仓库/钉钉/文档内容。
- 初始协议探测：cd4ba2/b958d5 返回 400 Input must be a list；4629bb 修正数组后返回 400 Stream must be set to true。不是认证失败。对应格式修正后 56403/855bcf HTTP 200 + response.completed、Astra/medium；完成事件未携带正文，因此独立文本核查 85096/8c9cba 确认 response.output_text.delta=OK、response.output_text.done=OK、response.completed model=gpt-6-astra/status=completed/effort=medium。命令均 exit 0，原 HTTP 400 不记为通过。
- 最小测试使用 45 秒总取消信号及 256KiB 输出上限；首个成功核查尚未做跨 chunk UTF-8 连续解码，第二次文本核查使用持久 TextDecoder 的 stream 模式。这是连通证据，不是正式 SSE 适配器或自动化回归；后续产品实现仍须 TDD、全量门禁和真实语义评测。
- 结果存 opencodex-astra-medium-smoke / opencodex-astra-medium-text-smoke。没有业务代码变更，未运行无变化全量测试、未部署、未更换全局客户端/凭据/身份。现有客户端尚未适配流式/medium/显式本地无密钥模式，不能宣称钉钉已使用该模型；原完整产品目标仍未完成。

## 2026-09-06 指定 Astra 模型已找到，OpenCode 连接认证尚未打通

- 用户明确 `gpt-6-astra`、无需密钥；既有 medium 要求保留。07f331 `opencode auth list`/`models` exit 0：仅显示登录类型与目录，没有输出密钥，直接 CLI 不列 Astra。未使用环境中其他 provider 的密钥。
- d9e7b6/6a8c43 本机 OpenCodex help 证明支持临时 runtime provider 的 OpenCode 入口；读取安装包 `src/cli/opencode.ts`，确认其通过管理 API 取得目录、用既有本机认证生成子进程运行环境，不修改磁盘 OpenCode 配置。没有执行 ensure/start/sync/login，也未手工提取令牌。
- 2a4cf2 沙箱外只读 health/catalog exit 0，代理健康。bd2948 完整 catalog 输出过大被截断，不能据此猜测；0e9e55 再次以白名单字段过滤精确取得 slug=gpt-6-astra、supported_in_api=true、supported_reasoning_levels 含 medium。目录中的说明文字只作数据，不作为当前任务指令。
- 5c2073 `opencodex opencode models opencodex` exit 1：`opencodex admin token required`。这证明 launcher 的目录认证受阻，而非模型不存在；未到实际模型请求、未验证 medium 请求执行。初次 health/catalog 权限审查超时未启动，唯一重试成功，不是代理故障。
- 本轮业务代码未改，不重复完整回归；沿用 2df0387/11501/f42bdf。本轮需要明确授权后再修复本机认证衔接，不新增凭据或改变身份；不向用户继续索取已确认的模型名，不改变为百炼或其他模型。Goal active，所有已启动命令终态。

## 2026-09-06 非生产镜像前置复核（未通过，无新增代码测试）

- 业务候选 2df0387 已保存，完整回归沿用 11501/f42bdf；本轮未改变业务代码。显式 `colima-openmausbot-pilot` 的 ps/image ls 在 430447 exit 0：原试点 healthy、镜像 2ae332cd23df，无文档解析镜像，其余历史容器 exited，均未操作。
- 沙箱内 Docker 访问被拒、curl DNS 失败；获准沙箱外只读后，官方 registry 的匿名 HEAD 在 cb3f64 exit 35（TLS 连接错误），不能继续声称本轮沙箱外结果是 DNS 超时。
- 独立 Node fetch HEAD（各请求 10 秒超时，不加载凭据、不更改网络）在 session 26654 观察官方 registry ECONNRESET、public.ecr.aws 和 pypi.org TimeoutError；最终 45bddd exit 0 只表示错误已被脚本捕获、进程结束，不表示端点通过。输出存 pilot-prerequisite-independent-https / -final；三个失败对应不同端点，未对同一失败无限重试。
- 本轮未构建/拉取/运行解析镜像、未发送群消息或调用模型。真实 Docker 隔离及六场景仍未验收。恢复前置为可信固定镜像/依赖可用或官方源连通恢复，以及用户指定 OpenCode 模型实际渠道；无运行中命令。

## 2026-09-06 文档容器创建回执丢失恢复（本地完整通过，非真实 Docker 验收）

- TDD 历史证据：92645/6d8162 exit 1，12 项新增断言失败、23 项既有测试通过，复现未知 ID 被跳过、无持久查询尝试及取消/接管边界。实现后 80090/c75972 exit 0，恢复/账本/提取器/摄取四文件 99 项、typecheck/diff 通过。追加真实生产提取器与重建恢复器的受控端口联通测试后，接续原 session 11501，不重复启动。
- 本轮直接观察：11501/b1dd60 两文件 41 项通过；完整链最终 11501/f42bdf exit 0。主集 274 文件通过/1 跳过（275），2919 项通过/18 跳过（2937），333.85 秒；broker、updater、desktop-viewer、package-link、save-file、packaged-server 检查均成功，打包服务在无可达 node_modules 环境启动且 9 个代理路径有效。
- 完整命令：`pnpm exec vitest run server/collaboration/operations/document-resource-journal.test.ts server/collaboration/operations/document-resource-recovery.test.ts && pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-document-discovery-typecheck && git diff --check`。全链 exit 0，类型检查、独立服务端编译和补丁检查通过；文档更新后另行 diff 检查。
- 覆盖：精确名称发现、ID 持久化先于清理、独立查缺、错误 ID/名称/标签/镜像/多结果拒绝、写失败/冲突迟到回执/新尝试/取消/实例接管拒绝删除、查询失败三次跨重建预算、无归属旧记录保留，以及生产提取器丢回执后无需重解析的恢复链。没有放宽测试断言或超时。
- 证据对应 c00ab23 基础上的本批四个代码/测试文件，观察保存 document-discovery-full-output/last（早期观察另见 b1dd60/390f36）。schema 28 未改，无实际 Docker 删除、群消息、模型切换、凭据或部署操作。真实镜像强隔离/强杀、独立 supervisor、主机重启、六类试点与 Owner 验收仍未证明，Goal 不标 complete。

## 2026-09-06 OpenCode GPT-6 Astra选择核查（尚未接入）

- 用户撤销百炼/.env要求，明确OpenCode、GPT-6 Astra、medium。没有百炼代码/配置变更或真实模型请求；前一轮相关文档阅读和.env配置名称检查不能当作接入成果，密钥未显示。
- OpenCode本机版本1.18.15；models/run --help/serve --help在65549/8d1e46 exit0完成，run明确支持--variant。opencode models openai --refresh在66458/389a0c exit0完成，刷新成功但无GPT-6 Astra。仅读取opencode.json的model/provider模型名称元数据，未发现自定义provider，未显示或改写凭据。
- 这是当前CLI模型目录缺项证据，不是断言GPT-6 Astra不存在，也不是验证了medium可用于该模型。待Owner确认实际渠道/完整模型标识后再装配并测试；未回退到gpt-5.6、未改变默认模型、未部署或执行真实群聊。业务代码未变，沿用6e9d243完整回归，不重复无变化测试。

## 2026-09-06 真实试点依赖阻塞收束（无新增测试）

- 当前Git核实6e9d243已保存20个任务文件，仅用户AGENTS.md/outputs未跟踪。最近完整链仍为80357/bd32bb exit0，未将重复读取算作新增验证或整体完成。
- 上轮Docker只读fc667d确认专用colima-openmausbot-pilot健康、旧镜像2ae332cd23df且无解析镜像，其余历史容器exited。cell1299匿名镜像站检查权限审查超时，未创建进程；不是网络失败或活跃等待。本轮没有重复拉取、改配置、部署、发送消息或读取其他凭据。
- 引用任务01a042e8-1b13-7793-a766-eaee31626730最近两轮只证明旧接收/回复基础流程的历史记录，不提供当前模型/文档授权，不能替代新目标验收。连续三轮没有所需新增Owner输入，原生Goal已blocked；本轮分类no progress。恢复需已授权模型配置引用及真实接入条件，不能以更多受控测试替代六类真实场景或Owner签字。

## 2026-09-06 自动核查与实时租约批次完整通过

- 完整命令pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-query-reconciliation-typecheck && git diff --check；80357/bd32bb exit0，主集274文件通过/1跳过，2907项通过/18跳过（2925注册），347.65秒。
- 后续broker7、updater15、desktop-viewer5、package-link2、save-file10全通过；packaged-server实际脱离node_modules启动及9路代理路径检查通过；类型检查、独立服务端编译、diff检查均通过。原始观察存reconciliation-final-full-output，终态reconciliation-final-full-last。所有句柄终态。
- 上轮env-path失败的调查：vite配置fileParallelism=false，每文件临时HOME；原用例真实execFile异步探测并由waitFor观察。当前证据不能确定上轮延迟/失败机制，没有修改该实现、测试或超时。隔离复测13项通过及本次完整链通过证明当前信号成功，不证明偶发故障根治；保留历史失败，若再次出现应捕获子进程退出/输出/时间证据而不是盲目加大超时。
- 本批相关覆盖包括消息入站/事项关联/Owner权限、真实SQLite Ledger/迁移、Outbox不重复发送、生产运输的受控查询回执、服务重建、三次查询预算与迟到结果拒绝。HTTP和身份为合成测试材料；不是实际钉钉送达、Linux强隔离或六类真实试点证明。
- 20个任务文件经diff审查，无新增真实凭据；保存本地批次、不push，用户AGENTS.md/outputs排除。实际提交结果以Git为准。真实模型/文档/入口授权与解析镜像等仍缺，Goal不标complete。

## 2026-09-06 Owner授权后的完整回归（1项失败，隔离复测通过）

- Owner明确“运行”后启动完整命令：pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-query-reconciliation-typecheck && git diff --check。16187/28528b exit1：273文件通过/1失败/1跳过，2906项通过/1失败/18跳过（2925注册），423.58秒。
- 唯一失败：server/env-path.test.ts第95行，keeps the last login-shell PATH available during a rescan，等待PATH包含临时shell输出路径未满足。该文件及实现均未修改。之前完整链的五项失败已在本轮通过；本批钉钉相关测试通过。不据此断言失败只是环境问题或已经修复。
- 隔离复测：pnpm exec vitest run server/env-path.test.ts && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-query-reconciliation-typecheck && git diff --check；19519/4c744e exit0，13项通过/7平台跳过、972ms，后续类型/编译/diff全通过。隔离通过不覆盖完整链失败；完整pnpm test的broker、updater、viewer、package-link、save-file、packaged-server因前段失败没有执行。
- 本轮无代码修补、没有放宽测试、没有本地提交/push/部署/真实钉钉或Docker操作。执行权限已解除，原生Goal查询为active；下方历史blocked记录不再代表当前授权。所有句柄终态。证据：approved-full-regression-output（部分早期输出截断，终态汇总完整）、approved-full-regression-last、approved-full-regression-followup。下一步定位全量时序失败并重新完整验证，真实试点及Owner最终验收仍待进行。

## 2026-09-06 阻塞收束（没有新增验证）

- 工作区/HEAD2445b52及历史真实工具终态复核：本轮无业务代码变化、无运行中的验证、无新的授权输入。最近相关验证仍为80343/934f41 exit0，最近完整链仍为37204/a7c432 exit1；不能将状态记录或旧通过项当作全量通过。
- 原生Goal按连续阻塞条件转blocked而非complete：同一完整回归执行权限问题已连续多个目标续办轮次存在，cell1252及唯一重试1255均未启动子进程。局部安全验证/修复已完成，目前无可替代全量门禁的安全路径。保留全部未提交改动，等待Owner明确授权或权限环境变化；恢复后再执行完整验证，不自动部署或变更真实身份。

## 2026-09-06 异步租约时效漏洞修复（相关回归通过，完整回归待权限）

- TDD 9b69f3 exit1：4失败/30跳过。证明Stream维护期间实例过期后仍会发送或查询，以及普通发送在claim/实例超期后仍能落sent。实现后31184/bb704c exit0：3文件43项/typecheck/diff。
- 补充维护返回过期反例d3d338 exit1：1失败/23跳过，健康仍被误报ready。修复后80343/934f41 exit0：12文件220项（28.10秒）、typecheck、独立服务端编译/tmp/openmausbot-live-lease-time-typecheck及diff通过。含恢复/正常消息交替/同仓串行/Verifier重试/自然需求/健康/钉钉接收与生产运输装配。原始终态保存在live-lease-time-related。
- 所有本轮执行句柄终态；没有新增沙箱外申请或真实网络/身份/部署操作。最新完整链仍是37204/a7c432失败，不能用局部通过声称完整通过；等待此前请求的Owner执行授权/权限处理。本批不提交，不改用户AGENTS.md/outputs。

## 2026-09-06 自动核查修正的接续验证（完整回归仍未通过）

- 无网络启动的后续检查41037/c797ec exit0：broker7、updater15、desktop-viewer5、package-link2、save-file10及服务端打包构建/diff通过；未执行packaged-server的实际启动smoke，不能据构建成功称运行验证完成。全部已启动命令终态。

- 原 functions.exec cell1252 及允许的一次重试 cell1255 均在权限自动审查阶段超时，未创建测试进程；不是测试运行超时，不重复启动。两cell均已终态，无遗留待查询的执行句柄。
- 现有权限下 41964/f3c810 exit 0：runtime-lifecycle-recovery/runtime-repository-serialization/outbox-reconciliation/delivery-routing/db/runtime/group-receipt-vault/stream-adapter/outbox-dispatcher 共9文件168项通过（16.61秒），typecheck、独立服务端编译和diff通过。此前五项失败均在此范围内，不削弱重发与后续发送断言。
- 完整测试最新结果仍为37204/a7c432 exit1；局部修正验证不替代完整pnpm test及打包启动，不提交或部署本批。等待Owner明确执行授权/权限处理后再运行完整链。本轮不改变实际模型/钉钉/容器身份配置。

## 2026-09-06 自动只查询核查与重启恢复（首条完整链失败，已修测试待验证）

- 最终检查点优先于下方启动记录：37204/a7c432 exit 1，272 文件通过/2 失败/1 跳过，2897 通过/5 失败/18 跳过（2920注册），354.76秒。四项生命周期回复测试仍假定不进行只读核查或下一轮立即发送，另一个 v15升级夹具漏删新增查询表；已改两文件，未再次取得测试结果，不宣称修复已验证。
- 接续验证：functions.exec cell1252 仍未返回，不能确认 exec_command 子进程启动。后续先 wait同cell，取得句柄则继续原进程；请求命令为定向runtime-lifecycle-recovery/runtime-repository-serialization/outbox-reconciliation/delivery-routing→typecheck→pnpm test→typecheck→独立编译/tmp/openmausbot-query-reconciliation-typecheck→diff。不重跑已结束首链；不重复启动未确认的当前请求。没有提交或部署本批。

- 上批提交已实际成功：b4486d exit 0，2445b52，仅十个任务文件，无 push。以下验证对应其后的自动核查变更。
- TDD e8b47c exit 1：6 项失败，旧 dispatcher 不调用核查。实现后 27228/59a9d1：68 项通过/1 项旧期望失败（原测试要求永不查询）；更新为 PROCESSING 只查、重建 SUCCESS 送达且 sends=1。
- 扩展 87735/63c6ef：194 通过/1 夹具外键失败，修正为不需要原事件外键的普通澄清回复。类型检查 d93c95/eb66b8 发现新增卡片夹具字段不符，已按真实类型补全。最终 55058/ea11d4 exit 0：12 文件 / 220 项（12.29 秒）、typecheck/diff 通过。
- 追加运行时 stop/start→drainOnce 只查询测试后，37204 首段 2 文件 / 30 项通过（2.14 秒）。同句柄随后执行完整 pnpm test/typecheck/独立服务端编译 /tmp/openmausbot-query-reconciliation-typecheck/diff，仍运行；原始输出 outbox-query-reconciliation-full-output。未提前记录最终通过。
- 覆盖：查询前次数落库、重建退避/三次停止、无回执停止且不发送、过期查询接续、旧结果/旧实例/认领超时/内容和superseded变化拒绝、正常发送交替、不可删改尝试、生产路由加密回执→重建只查询→sent，以及历史 v27/更早库升级不虚构证据。真实 API、多人群聊、主机强杀/重启和 Owner 人工验收未进行。

## 2026-09-06 加密受理回执与只查询恢复入口（完整链通过）

- 提交结果纠正：14423/7d662f exit 0 为真实完整测试终态；后续 32c850 exit 128 的本地 git add 被文件写权限阻止，未产生提交。此前“保存本地任务提交”为提前记录，不作为提交成功证据。本轮先纠正记录并按工具权限执行本地提交。

- 最终检查点（优先于下方启动记录）：完整链 14423/7d662f exit 0，pnpm test、typecheck、独立服务端编译和 diff 全通过。Test Files 273 passed | 1 skipped (274) Tests 2891 passed | 18 skipped (2909) Start at 14:54:20 Duration 343.80s (transform 1.90s, setup 7.26s, import 4.47s, tests 312.82s, environment 13ms) 原始观察 durable-group-receipts-full-output，最后结果 durable-group-receipts-full-terminal。本轮 20 工具轮收束；保存本地任务提交，不 push。 真实 API/部署/群聊未验收，后台调度仍待实现。

- 测试先行 c5916e exit 1：新模块不存在导致测试加载失败（不记作行为反例）。基础实现后 4 项及 typecheck 通过。生产装配初查 70352/b7d7a7 exit 0：5 文件 / 123 项/typecheck/diff。
- 反例 1d915e exit 1：2 失败 / 43 跳过，证明删除路由后仍会 session 发送、无历史回执时缺凭据会误挡正常 session。修复后扩展 36128/25b8e8 exit 0：10 文件 / 193 项（5.75 秒）、typecheck/diff。覆盖文件重建、机密不明文、权限/符号链接/篡改/错误 Secret、app/群/payload绑定、保存失败、真实运输重建只查询及 Outbox 原有不重发。
- 完整 pnpm test/typecheck/独立编译 /tmp/openmausbot-durable-group-receipts-typecheck/diff：14423 正在运行，待终态，不先记通过。最终完整链包含进一步加强的原 payload+渲染双绑定及回执消失失败关闭。
- 受控 HTTP 与临时文件/真实 SQLite 测试，不是实际钉钉 API 送达、真实群或主机重启验收。后台自动查询尚未接入，不更改 dead_letter 行为，无真实身份/凭据/容器/部署变更。

## 2026-09-06 主动群消息实际发送确认（完整链通过）

- TDD e7aaa1 exit 1：7 失败 / 35 跳过，PROCESSING/RECALLED/未知/缺状态/HTTP 错误/失联/矛盾均错误返回成功。实现后 87284/ab791d exit 0：6 文件 / 126 项、typecheck/diff。
- 查询时限 TDD 6bddef exit 1：2 失败 / 17 跳过；限定查询四秒后扩展 9542/6b4a99 exit 0：9 文件 / 185 项（5.23 秒）、typecheck/diff。生产 createDingTalkDelivery→OutboxDispatcher 在 PROCESSING 时 sent_at 保持空、重建不重发；query 的 group/app/key 来源固定，无原始回执进错误，模拟头/正文挂起均在四秒后取消。
- 完整 pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-group-delivery-confirmation-typecheck && git diff --check：23002 在 fa2b11 exit 0。272 文件通过 / 1 跳过，2883 项通过 / 18 跳过（2901 注册），520.63 秒；broker 7、updater 15、viewer 5、package-link 2、save-file 10、无 node_modules 打包启动/9 路代理、类型/独立编译/diff 全通过。输出工具状态 group-delivery-confirmation-full-output，verbose 有截断但汇总及终态可见。
- 无真实 API、模型、身份、容器或部署操作。查询契约使用上一批已核对官方文档；本批受控回执不证明真实送达，也不支持后台持续对账或引用映射。全部句柄终态。

## 2026-09-06 Docker 前置条件复核（未启动解析验证）

- 7fd00c9 仅审计文档后，业务代码仍 943a0ed；任务工作区干净，用户 AGENTS.md/outputs 保留。没有业务代码或实际配置改动，旧完整回归不当作新 Docker 通过证据。
- b1e002：显式 colima-openmausbot-pilot ps/image ls 确认既有服务 healthy、镜像 2ae332cd23df、没有解析器/Python 镜像，历史容器 exited。串联官方 registry 匿名 HEAD，6979 在 07acf7 exit 28：DNS 10008ms 超时，没有收到 HTTP 业务响应。
- 后续只读 manifest inspect 的 exec cell 1200 在权限审查阶段超时，进程未启动；未把审批超时解释为安全拒绝，也未在已知 DNS 故障下反复提交。没有活跃命令，无拉取、构建、解析 smoke、容器删除/暂停、网络/身份/凭据修改。
- 本轮是已知阻塞复核，no progress；需要外部条件或 Owner 授权信息变化后才能运行真实解析。未将待授权通道、待配置模型或镜像缺失改写为已通过。

## 2026-09-06 真实钉钉接入契约审计（非试点通过）

- 代码基线 943a0ed，任务工作区干净，仅用户 AGENTS.md/outputs 未跟踪；本轮只有文档修改。审计覆盖 normalizer 的 originalMsgId、association 的入站事件匹配、发送器丢弃 processQueryKey 和主动 sampleMarkdown 的接口边界。
- 官方公开文档访问：沙箱内 d82665 exit 6；授权外 b75c75、8fef76、d146b5、87208f、b7d718、e687c3、2f5ae9 exit 0。发送文档首次输出截断，响应章节独立重读。DWS 只读本地 devdoc schema/help，75788 在 b470bb exit 0，无认证或业务操作。
- 发现足以改变执行顺序的新证据：群文件不可按现有应用机器人入口承诺，主动发送 @ 不受官方支持，引用消息 ID 未核实；送达查询存在但不提供引用 ID。完整来源和后续门禁见 packaging/collaboration/dingtalk-capability-audit.md。
- 本批不执行真实发送、凭据读取、身份接入、Docker 部署或模型调用。不将官方文档等同实际租户/版本测试；不重跑无代码变化的完整回归，不新增虚构通过项。

## 2026-09-06 附件选择定向澄清（完整链通过）

- 先行 3d3280 exit 1：1 行为失败 / 51 跳过，原卡片没有具体文件列表和应答路径。实现后 55686/ec77e3 exit 0：4 文件 / 99 项、typecheck/diff。扩展后 21199/42b0d7 exit 0：9 文件 / 243 项（023358，12.34 秒）、typecheck/diff 通过。
- 覆盖原序号/名称、实际 Markdown 和 atUserIds、提醒材料提供者而不是另一个事项创建者、只先展示选择问题但保留未读门禁、回答后检查剩余附件，以及他人/部分正文不描述为可用替代。来源身份经过现有 principal/event/quote/staff 校验，不增加权限。
- 完整命令：pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-attachment-question-typecheck && git diff --check。2535 在 41f6db exit 0：272 文件通过 / 1 跳过，2870 项通过 / 18 跳过（2888 注册），371.09 秒；broker 7、updater 15、viewer 5、package-link 2、save-file 10、打包脱离 node_modules 启动与 9 路代理、类型检查/独立编译/diff 全通过。原始输出已存 attachment-question-full-output，所有句柄终态。
- SQLite、生产协调器和实际渲染执行；合成材料，无真实钉钉发送/模型调用/文档权限/解析容器/部署。这些结果不能替代六类非生产真实试点。

## 2026-09-06 多附件选择及精确确认反馈（完整链通过）

- 先行行为失败 81794/eff51a：7 失败 / 42 通过，暴露多文件定位和后续选择缺失。初步实现相关三文件 115 项通过；扩展后八文件 223 项通过。加强真实返回卡片断言后 30f140 exit 1：3 失败 / 47 跳过，单独选择虽正确关联但没有明确确认。未将早先弱断言通过冒充文案 TDD 红灯。
- 修复确认反馈：70624/4772b3 exit 0，8 文件 / 223 项、11.97 秒、typecheck/diff 通过。补自然解释排队入口的确认/重放覆盖：29490/cfc8f3 exit 0，51 项、3.10 秒及 typecheck/diff。
- 完整命令：pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-attachment-selection-typecheck && git diff --check。首次权限审查超时未启动；一次获准重试后 34020 在 35105c exit 0。主集 272 文件通过 / 1 跳过，2866 项通过 / 18 跳过（2884 注册），332.08 秒；broker 7、updater 15、viewer 5、package-link 2、save-file 10、无 node_modules 打包启动及 9 路代理、类型检查、独立编译、diff 全通过。原始输出已保存 attachment-selection-full-output，所有句柄终态。
- 覆盖原上传序号/唯一名称、重复名称/越界/他人/错误引用/冲突拒绝、未读兄弟文件持续阻塞、双文件依次补齐、来源收据持久化与重建。SQLite/生产协调器实际执行，正文和模型受控；无真实钉钉发送、在线文档授权、实际容器解析、模型调用或部署，不能据此宣称六类试点已完成。

## 2026-09-06 可读附件替代材料来源（完整链通过）

- 33249 在 fad711 exit 1：3 行为失败 / 26 通过，三种明确替代表达仍被旧失败文件阻塞。初修 98494 在 2b8d57 exit 0：3 文件 / 95 项/typecheck/diff 通过；扩展来源模型收据、反馈与漂移后 58787 在 510665 exit 0：8 文件 / 203 项/typecheck/diff 通过。
- 42042 在 674823 exit 1：2 行为失败 / 30 通过，复现较早无权替代提示永久阻塞、多个有效替代被静默接受。已补唯一有效关系过滤及只针对当前未读材料的澄清，并提供通俗替代材料回复。
- 完整命令：相关 8 文件回归 && pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-attachment-replacement-typecheck && git diff --check；59762 在 8c4f9f exit 0。相关 8 文件 / 205 项（11.05 秒）；主集 272 文件通过 / 1 跳过，2847 项通过 / 18 跳过（2865 注册），311.84 秒。broker 7、updater 15、viewer 5、package-link 2、save-file 10、打包无 node_modules 启动/9 路代理、typecheck、独立编译及 diff 全通过。旧附件及双方来源未删除，否定/引用/其他成员/多附件/不完整正文保持门禁；所有句柄终态。
- 使用真实 SQLite、生产 service/摄取/自然解释协调器与合成文本/受控模型，未调用真实群、在线文档权限或实际解析容器。不是六类 Docker 试点验收。

## 2026-09-06 附件需求整理中断预算（完整链通过）

- 86896 在 b4aa93 exit 1：attachment-ingestion 2 失败 / 44 通过，复现过期认领被无记录覆盖、通知写失败未发生回滚。属于行为失败，非模块/环境问题。
- 修复后 6804 在 db30db exit 0：7 文件 / 181 项（9.83 秒）、pnpm typecheck、git diff --check 通过。过期认领与失败/必要通知同事务结算；现有迟到回调及通知回滚测试更新为保留中断证据，并验证退避后仍可继续，不删除原断言对应的保护。
- 新增在三次真实账本过期记录后，普通成员不能恢复、Owner 自然请求可恢复一次、重放不重复授权、旧正文不重新下载的覆盖；定向 46 项通过。完整命令先运行 attachment-ingestion，再执行 pnpm test、pnpm typecheck、独立服务端编译 /tmp/openmausbot-projection-interruption-typecheck 和 diff 检查；79813 在 a89bcd exit 0：272 文件通过 / 1 跳过，2835 项通过 / 18 跳过（2853 注册），418.20 秒。broker 7、updater 15、viewer 5、package-link 2、save-file 10、打包无 node_modules 启动/9 路代理、类型检查、独立编译及 diff 全通过。所有句柄终态，未重启长测试或放宽断言。
- 测试使用合成正文、SQLite 实际事务和重建协调器，不是实际进程强杀、容器解析或群消息。未调用真实模型/钉钉/文档权限，未修改网络或其他容器。

## 2026-09-06 文档资源实例绑定恢复（完整链通过）

- 接续已有未提交实现。先行扩展恢复测试：46761 在 dcd7b3 exit 1，5 失败 / 14 通过，复现取消、接管和实时租约过期在末条记录被吞掉。修复后回归覆盖身份不匹配、无 ID、旧归属、迟到 ID、缺失容器查证、删除/查询失败、取消边界、预算持久化与摘要镜像。
- 39467 在 7995fe exit 0：db/attachment-ingestion 两文件 53 项，真实 v26 升级保留旧行、headless 工厂恢复后再摄取和重建去重通过。此前 typecheck 缺 fixture.instance 已修复，未放宽生产类型。
- 90098 在 fced42 exit 0：13 文件 / 218 项（18.15 秒）、pnpm typecheck、git diff --check 全通过。SQLite/工厂实际执行，Docker/下载为受控合成端口，不是实际解析容器验收。
- 完整命令：pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-document-recovery-typecheck && git diff --check。99898 在 db403f exit 0：272 文件通过 / 1 跳过，2833 项通过 / 18 跳过（2851 注册），262.12 秒；broker 7、updater 15、viewer 5、package-link 2、save-file 10、打包脱离 node_modules 启动/9 路代理、typecheck、独立编译及 diff 全通过。全部验证句柄终态，受控恢复证据不替代真实 Docker 或群聊验收。
- 非生产只读 e27b6e exit 0：指定 colima-openmausbot-pilot 的现有试点 healthy，其他历史容器保持 exited，未更换/删除/暂停。沙箱内读取 socket 被拒（100ee4）后获准只读查询；未尝试修网络或重复拉镜像。

## 2026-09-06 文档资源持久归属（完整链通过）

- 72516 exit 1（0da3f2）：4 行为失败 / 39 通过及缺新模块的收集失败。13698 exit 0（41e50c）：4 文件 / 67 项/typecheck/diff。27460 exit 1（c5d9c3）：标签先行回归与 2 个启动/版本问题；12000 exit 1（df8336）只剩后两项。
- 修复后 35221 exit 0（528216）：document-resource-journal、document-extractor、document-extractor-smoke、attachment-ingestion、db、backup、service、lifecycle-recovery、natural-intake-recovery、runtime-repository-serialization、headless 共 11 文件 / 173 项及 typecheck/diff 通过。真实 SQLite 与 headless 生产装配，加受控 Docker/下载端口，不是实际容器解析。
- 完整 `pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-document-journal-typecheck && git diff --check`，11909 在 d861b2 exit 0：271 文件通过 / 1 跳过，2808 项通过 / 18 跳过（2826 注册），440.34 秒；broker 7、updater 15、viewer 5、package-link 2、save-file 10、打包脱离 node_modules 启动及 9 路代理、typecheck、独立服务端编译及 diff 全通过。所有句柄终态，无真实 Docker/模型/群消息操作，未以持久记录替代崩溃恢复或容器无遗留证明。

## 2026-09-06 文档解析停止传播（完整链通过）

- TDD 8468 exit 1（dcee4c），8 失败 / 51 通过，其中 2 个 native ESM spy 夹具失败；更正为透传真实 spawn 后 34754 exit 1（8aec05），2 行为失败 / 2 通过，证实已有 abort 不生效。
- 初修 57925 exit 0（838723）：3 文件 / 59 项、typecheck/diff。扩展 document-extractor/docker-containment/attachment-ingestion/document-extractor-smoke/docker-command-runner/docker-patch-agent/runtime-lifecycle-recovery/headless：58471 exit 0（1e0575），8 文件 / 126 项及 typecheck/diff 通过。真实本地子进程被取消后观察 SIGKILL 和 close；Docker 容器部分仍为受控端口，未运行实际文档。
- 完整命令 `pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-document-stop-typecheck && git diff --check`，30505 在 20751d exit 0：270 文件通过 / 1 跳过，2801 项通过 / 18 跳过（2819 注册），390.25 秒；broker 7、updater 15、viewer 5、package-link 2、save-file 10、打包脱离 node_modules 启动及 9 路代理、typecheck、独立服务端编译和 diff 均通过。所有句柄终态。没有实际 Docker 文档/模型/钉钉/主机重启证据，不将取消 CLI 的局部证明提升为无遗留容器保证。

## 2026-09-06 文档解析 headless 装配（完整链已通过）

- 沙箱外授权复验同一完整链：72315 在 92ea6e exit 0。270 文件通过 / 1 跳过，2793 项通过 / 18 跳过（2811 注册），314.68 秒；broker 7、updater 15、viewer 5、package-link 2、save-file 10、打包脱离 node_modules 启动及 9 路代理、pnpm typecheck、独立服务端编译、diff 均通过。失败范围中的通信/端口用例全部重验，未改这些测试、未删除断言或增加跳过。

- 先行 `pnpm exec vitest run server/collaboration/operations/document-extractor.test.ts server/collaboration/attachment-ingestion.test.ts`：57962 exit 1（eae2b0），5 失败 / 45 通过。
- 修复后加入 server/collaboration-headless.test.ts：59221 exit 0（af0598），3 文件 / 61 项，随后 pnpm typecheck 和 git diff --check 通过。Docker/下载均是合成夹具受控端口；SQLite、headless 生产工厂、协调器和重建投影实际执行，没有联网/群消息/真实附件。
- 完整 `pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-document-wiring-typecheck && git diff --check`：历史沙箱内会话 95895 在 07d0f1 exit 1，29 文件失败 / 241 通过 / 1 跳过，28 项失败 / 2536 通过 / 247 跳过（2811 注册），16 未处理错误，623.21 秒。socket EPERM 与监听超时使该次结果不能通过，串联后续未执行。该句柄终态后才启动上述授权复验。
- 非生产环境只读 d67187：试点 healthy、旧镜像 2ae332cd23df、无解析器镜像；官方 registry 匿名 HEAD 40559 在 620e88 exit 28，DNS 10010ms 超时。未构建或运行实际文档 smoke，无部署/身份/凭据/群消息变更。所有句柄终态。
- 已观察本批 attachment-ingestion 43、headless 11、document-extractor 7、document-extractor-smoke 17 项在完整主集内通过，但不能替代完整链，更不能代替真实 Linux 文档解析和六类群聊。


## 2026-09-06 普通直接控制与回复原子化（已验证）

- TDD delivery-routing/actions：47504 exit 1（ff4398），7 失败 / 48 通过。初修五文件 62107 exit 0（bd15aa），118 项及 typecheck/diff。反向复用 TDD 84067 exit 1（b04e53），1 失败 / 13 通过。
- 扩展 delivery-routing/actions/runtime/runtime-verification-retry/stream-adapter/headless/delivery-review：49469 exit 0（24cf06），7 文件 / 142 项及 typecheck/diff。实际 SQLite 故障触发器验证暂停/取消/允许批准及拒绝结果整体回滚，批准再试仅一次成功；事件双向复用被拒。均为本地合成数据，非真实钉钉/Owner 动作。
- 完整 `pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-direct-reply-typecheck && git diff --check`，77419 exit 0。保存的原输出确认主集 270 文件通过 / 1 跳过，2786 项通过 / 18 跳过（2804 注册），366.70 秒；broker 7、updater 15、desktop-viewer 5、package-link 2、save-file 10 通过。打包脱离 node_modules 启动及 9 路代理、typecheck、独立服务端编译和 diff 全通过。所有句柄终态；本地事务证据不等于远端消息送达或六类试点完成。

## 2026-09-06 Token 审批事件与文本回复原子化（已验证）

- TDD actions/delivery-routing/text-actions：9740 exit 1（5158fb），3 失败 / 49 通过。初修 86895 exit 0（684535）：5 文件 / 94 项/typecheck/diff。
- 扩展 actions/delivery-routing/text-actions/runtime/stream-adapter/headless/delivery-review：39221 exit 0（2d7d29），7 文件 / 119 项及 typecheck/diff 通过。包含动作与 token 消费回滚、原始拒绝结果、跨入口事件冲突、文本重启来源和卡片不猜群；全部合成数据，无真实发送。
- 完整 `pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-token-action-typecheck && git diff --check`，54142 exit 0（64ea61）。pnpm test 串联主集/broker/updater/desktop-viewer/package-link/save-file/packaged-server 全通过，后续 typecheck、独立编译/diff 通过；打包脱离 node_modules 启动和 9 路代理实际通过。主集数量/耗时汇总输出被截断，未另行猜测统计；d9cf8a 临时 JSON 报告定位无匹配文件退出 1，不代表测试失败，不重跑已通过候选。所有句柄终态。本地原子性与受控发送不证明真实卡片回执或六类群聊通过。

## 2026-09-06 状态查询与刷新审批收据（已验证）

- TDD delivery-routing：37157 exit 1（29f7c1），4 失败 / 29 通过；缺原始收据、拒绝重放误报成功及写失败无回滚。
- 初修 16946 exit 0（64e3c4），4 文件 / 85 项及 typecheck/diff。扩展 49945 exit 0（b922e8），6 文件 / 109 项；清理旧错误分支后 67067 exit 0（493286），6 文件 / 109 项及 typecheck/diff 通过。
- 扩展覆盖允许刷新、原 Outbox supersession 回滚、旧无收据回复保守处理、query 改写/入口复用拒绝、runtime 重建后原始结果不变及原群发送；只使用合成数据/受控 fetch。
- 完整 `pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-owner-query-typecheck && git diff --check`，15574 exit 0（712852）。主集 760c57：270 文件通过 / 1 跳过，2774 项通过 / 18 跳过（2792 注册），354.11 秒；broker 7、updater 15、desktop-viewer 5、package-link 2、save-file 10 通过。6a281a：打包脱离 node_modules 启动及 9 路代理通过；随后 typecheck、独立服务端编译及 diff 全通过。所有句柄终态，未执行真实钉钉、模型、文档容器或部署，不以全量本地测试代替六类试点。

## 2026-09-06 直接文本控制回复来源（已验证）

- 先行 delivery-routing/actions：74645 exit 1（7ea8f1），7 失败 / 29 通过。新增解析器来源和允许控制来源断言失败，证明原实现缺失，不冒充已到达网络发送断言。
- delivery-routing/actions/text-actions/stream-adapter/runtime/headless 六文件：48696 exit 0（843998），94 项及 typecheck/diff 通过；补充 Owner 允许、旧收据及控制事务回滚后，18489 exit 0（4597e9），97 项/typecheck/diff 通过。
- 完整命令 `pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-control-origin-typecheck && git diff --check`，16925 exit 0（0b5f70）：270 文件通过 / 1 跳过，2769 项通过 / 18 跳过（2787 注册），421.03 秒。broker 7、updater 15、desktop-viewer 5、package-link 2、save-file 10、打包服务脱离 node_modules 启动及 9 个代理路径、typecheck、独立服务端编译及 diff 均通过。无运行中验证、无真实发送/凭据/部署操作；全量本地回归不替代完整六类真实验收。

## 2026-09-06 文档解析 Docker 前置复核（未执行解析测试）

- 业务候选仍为 4b20d9c；本轮只有文档记录变化。此前该候选完整回归通过不等于文档 Docker 或真实钉钉试点通过。
- 671e66：沙箱不能连接 Colima socket。cell 951：自动权限审查超时，进程未启动；一次重试后 8a6d98 exit 0，显式 context=colima-openmausbot-pilot 的 ps/image ls 确認当前试点 healthy、其他历史容器 exited、没有解析镜像；docker manifest --help 确认内置 inspect 可用，未执行远端清单查询。
- 匿名官方仓库 HEAD：curl --head --silent --show-error --connect-timeout 10 --max-time 20 https://registry-1.docker.io/v2/。沙箱内 c164b2 exit 6；沙箱外 55383 / 859561 exit 28，DNS 解析约 10 秒超时。没有收到注册表业务响应，不判断镜像存在性或 digest。
- 无构建、拉取或文档 smoke 进程启动；未更改配置/网络/身份/凭据、未发送群消息。cell 954 和 session 55383 均已终态。主服务尚未装配 configuredDocumentExtractor，真实文档支持未上线。
- 文档更新首次补丁因 VERIFY 标题不匹配整体未应用，按实际标题修正；无业务代码变化。恢复入口为 document-parser/README.md 的固定镜像构建和正式 smoke，不安装 buildx 作为必需前置，不以宿主机解析替代隔离验证。

## 2026-09-06 自然恢复回复来源（当前批）

- TDD `pnpm vitest run server/collaboration/delivery-routing.test.ts`，70865 exit 1（5e50ba）：2 失败 / 17 通过，缺来源导致生产装配返回 delivery_unroutable。扩展 `delivery-routing / natural-intake-recovery / attachment-ingestion`，48909 exit 1（20b862）：4 失败 / 68 通过。
- 生产实现后六文件路由/自然恢复/附件/Stream/runtime/Outbox回归与 typecheck/diff，55508 exit 0（5a50ad）：123 项通过。扩展实际 Outbox 派发后 60598 exit 0（582add）：同 123 项/typecheck/diff 通过。新增回滚用例的定向终态另记。
- 本地临时 SQLite、模拟凭据及受控 fetch；成功和拒绝恢复的来源、同事件改群冲突、收据不可变/事务回滚、历史缺来源不补造、发送器重建后不重复发送。没有真实钉钉、模型或在线文档调用，没有部署/身份/凭据变更。
- 回滚扩展路由单文件 15995 exit 0（043cd2）：21 项/typecheck/diff 通过。完整命令 `pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-recovery-origin-typecheck && git diff --check`，64739 exit 0（a8c966）：270 文件通过 / 1 跳过，2760 项通过 / 18 跳过，2778 注册，314.01 秒。
- broker 7、updater 15、desktop-viewer 5、package-link 2、save-file 10 通过；打包服务无 node_modules 可访问启动、9 路 spawned proxy、typecheck、独立服务端编译/diff 全通过，所有命令终态。
- Docker 仅只读核查（b64fcf）：现有非生产试点 healthy、restart=unless-stopped，其他容器/镜像均未修改；列表未见专用 document-parser 镜像。未读取容器环境变量/凭据，不代表本批新代码或真实六类场景已在 Docker 验收。

## 2026-09-06 多群路由及 API 隔离最终完整验证（当前批）

- `pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-delivery-routing-typecheck && git diff --check`，获得本地监听所需沙箱外权限后启动 13203，最终 exit 0（9e00ed）。期间始终等待同一会话，无超时误重启。
- 主集 270 文件通过 / 1 跳过；2756 项通过 / 18 跳过，2774 注册，343.32 秒。原 index.test.ts Chief 用例 430ms，全部 88 项 API 通过，完整 product-fleet 配置与新增路由覆盖未删减。
- broker 7、updater 15、desktop-viewer 5、package-link 2、save-file 10 全通过；packaged-server 构建并在无 node_modules 可访问情况下启动，9 路 spawned proxy 路径通过；后续 typecheck、独立服务端编译、diff 均通过。
- 这是当前 8 个任务文件对应的完整本地验证；前轮 EPERM/Chief 超时和主动诊断失败均保留历史，本次不沿用它们的失败/未验证结论。所有测试句柄终态。comms 个别用例本次接近时限但通过，不外推为全套性能稳定性已证明。
- 尚未部署/验证真实钉钉或模型/在线文档/Docker 六类场景，未改变凭据/Owner，不能将本地通过等同真实试点通过。

## 2026-09-06 回归超时定位与夹具隔离（当前批）

- 时序诊断 43610 exit 1（868336）：原 Chief 用例 20012ms 超时，POST /api/bots 两次分别 8040/8031ms。直接模拟 CLI 探测 eaae09 exit 0：version 60ms、auth 55ms。
- 只读/单创建诊断 94704（e00f68）、58337（69b04c）、85713（b2feb5）均 exit 0，耗时波动且未展示完整诊断日志，不据此宣称修复。63079 exit 1（e98cb9）为专门临时诊断主动抛错，展示正式服务的非 fake CLI 探测，配合 instanceConfigs 产品默认补齐逻辑定位夹具泄漏；不是新增产品断言失败。诊断用例和 procs/index 临时日志已全部移除。
- 修复只在 index.test.ts 固定自动补齐项为 unavailable shadow，模拟 Claude 和全部原业务断言不变，新增 fixture 隔离断言；生产默认引擎行为不变。
- `pnpm vitest run server/index.test.ts server/config.test.ts server/collaboration/delivery-routing.test.ts && pnpm typecheck && git diff --check`，53158 exit 0（046931）：3 文件 / 146 项通过，总 9.62s，typecheck/diff 通过。原 88 项 HTTP API 全部运行通过，不调高超时、不筛掉失败用例。
- 此候选尚未跑完整 pnpm test、附属/打包服务链和独立服务端编译，不继承前轮代码的完整通过结论；当前无运行中验证。下批需沙箱外本地端口权限重跑完整链，不提交/部署当前未全量验证的候选。

## 2026-09-06 多群备用投递来源绑定（当前批）

- 先行 `pnpm vitest run server/collaboration/delivery-routing.test.ts`，0184f9 exit 1：3 失败 / 1 通过，使用生产装配、SQLite 和受控 fetch/合成凭据；未调用真实钉钉。
- 初修 66998 exit 0（2092b7）：5 文件 / 60 项及 typecheck/diff 通过。扩展 20073 exit 0（a7568b）：8 文件 / 124 项，覆盖路由/Owner 查询/Stream/Outbox/runtime/恢复/headless/router，typecheck/diff 通过。
- 全量 `git diff --check && pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-delivery-routing-typecheck`，89823 exit 1（c631ea）：29 文件失败 / 241 通过 / 1 跳过；28 项失败 / 2499 通过 / 247 跳过、16 errors，2774 注册。620.37 秒，出现多处 listen EPERM（本地 TCP/UDS/UDP），后续编译未执行。不删断言/排除测试；已获沙箱外权限，同一完整验证链在 67552 重跑中（diff 检查置末尾）。
- 沙箱外重跑 67552 exit 1（462572）：372.58 秒，269 文件通过 / 1 失败 / 1 跳过；2755 项通过 / 1 失败 / 18 跳过，2774 注册。唯一失败 `server/index.test.ts:688` / `elects one Chief of Staff per section and preserves other section Chiefs`，原 20000ms 超时；不是回归全通过，附属命令被 && 中止。
- 不改代码、断言或超时，独立运行 `pnpm vitest run server/index.test.ts -t 'elects one Chief of Staff per section and preserves other section Chiefs'`：36115 exit 1（df1b73），仍 20011ms 超时，其他 87 项为主动筛选跳过。后续 broker/updater/desktop-viewer/package-link/save-file/packaged-server/typecheck/编译链未执行；不以筛选运行冒充完整回归。该超时已连续复现两次，尚未证实根因，不提交本批。
- 独立收尾 `pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-delivery-routing-typecheck && git diff --check && git status --short`：22873 exit 0（9ac09c）。所有测试/编译句柄终态；工作区仅本批七个任务文件及用户原有 AGENTS.md/outputs 未提交。目标仍 active，非生产真实试点仍未部署/验收。

## 2026-09-06 Owner 自然查询待核查回复（当前批）

- 提交环节权限审查超时（cell 861），发生于进程创建前，不是测试失败；全套验证仍有效，恢复时仅重试一次本地提交。
- TDD 5f1910 exit 1：新模块尚不存在，无测试实际运行；不声称行为复现。初实现 024f59 exit 1：3 通过 / 7 因合成 sender 缺 displayName 失败。修正后 28222：10 项通过，但 typecheck exit 2（新增标题不在类型联合中）。
- 扩展 3020 exit 1（82b934）：72 项通过 / 1 失败，预期当前群 8 条而只找到 1 条。查询将 association 的内部 externalEventId 当 source_event_id，正式关联修复为 e.id；没有放宽断言。
- 扩展命令 `pnpm vitest run server/collaboration/delivery-review.test.ts server/integrations/dingtalk/stream-adapter.test.ts server/collaboration/outbox-dispatcher.test.ts server/collaboration/operations/runtime.test.ts server/collaboration-headless.test.ts server/collaboration/natural-intake-recovery.test.ts server/collaboration/attachment-ingestion.test.ts server/integrations/dingtalk/sender.test.ts && pnpm typecheck && git diff --check`，67393 原句柄终态待记录。
- 覆盖同群/引用筛选、非 Owner/无身份/未知和跨群引用拒绝、五条上限与真实总数、重放/事件改写、旧投递/事项不变、响应持久化失败回滚、Owner 变更/源变更清单失效、实际 dispatcher 丢弃过期清单、runtime 其他控制入口重放拒绝、Stream 持久化前不 ACK 且不新建事项。均为本地受控消息，没有真实钉钉发送/授权变更。
- 扩展 67393 exit 0（d51d92）：8 文件 / 142 项、typecheck/diff 通过。
- 完整命令 `pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-delivery-review-typecheck && git diff --check`：8602 最终 exit 0（186f50）。主集见 2bbb4c：353.46 秒，269 文件通过 / 1 跳过，2,739 项通过 / 18 跳过，注册数 2,757。
- broker 7、updater 15、desktop-viewer 5、package-link 2、save-file 10 全通过；打包服务无可访问 node_modules 启动、9 条 spawned proxy 路径通过；后续 typecheck、独立服务端编译与 diff 检查全通过。所有测试句柄终态。本批未调用真实钉钉/模型/在线文档或 Docker，未部署。

## 2026-09-06 回复投递待核查的后台可见性（当前批）

- TDD `pnpm vitest run server/collaboration/operations/delivery-health.test.ts`：fff00d exit 1，5 项失败；缺少排查状态而不是已有投递实现失败。
- 初修 43040 exit 0（1186a9）：4 文件 / 43 项、typecheck/diff。扩展命令 `pnpm vitest run server/collaboration/operations/delivery-health.test.ts server/collaboration/operations/runtime.test.ts server/collaboration-headless.test.ts server/collaboration/outbox-dispatcher.test.ts server/collaboration/operations/runtime-lifecycle-recovery.test.ts && pnpm typecheck && git diff --check`，55022 终态待记录。
- 覆盖真实 runtime + SQLite 聚合分类、记录前后完全不变、输出去敏、无法读取/未打开/已关闭时非伪零、认领刚好到期、无效时钟、待核查不阻塞下一回复、重启持久可见、--health 不取租约/不绑定 Owner/不消费队列。消息发送用受控 transport，不是真实钉钉。
- 扩展 55022 exit 0（13a27f）：5 文件 / 69 项、typecheck/diff 通过。
- 全仓命令 `pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-delivery-health-typecheck && git diff --check`：80516 已 exit 0（707063）。主集 315.04 秒，268 文件通过 / 1 跳过，2,725 项通过 / 18 跳过，注册数 2,743。
- broker 7、updater 15、desktop-viewer 5、package-link 2、save-file 10 通过；打包服务在无可访问 node_modules 下启动、9 条 spawned proxy 路径通过；后续 typecheck、独立服务端编译及 diff 检查全通过。所有验证句柄终态；本批未实际运行 Docker、调用真实钉钉/模型/在线文档或部署。

## 2026-09-06 钉钉业务回执冲突保护（当前批）

- `pnpm vitest run server/integrations/dingtalk/business-receipt.test.ts`：a6f78d exit 1，18 失败 / 7 通过。修复前会将冲突状态误报成功、忽略部分数字错误码、缓存并使用被拒绝的令牌。
- 初修定向 37235 exit 0（b2324a）：7 文件 / 104 项、typecheck/diff 通过。扩展后 14024，命令为 `pnpm vitest run server/integrations/dingtalk/business-receipt.test.ts server/integrations/dingtalk/sender-deadline.test.ts server/integrations/dingtalk/sender.test.ts server/integrations/dingtalk/interactive-card-sender.test.ts server/integrations/dingtalk/reply-router.test.ts server/collaboration/outbox-dispatcher.test.ts server/collaboration/operations/runtime-lifecycle-recovery.test.ts && pnpm typecheck && git diff --check`。
- 覆盖正常成功兼容、明确拒绝回退、冲突/无效类型不成功不重发、异常令牌连续两次均重新获取且从未发消息、普通消息不能以通用 success 代替查询回执；生产 headless + SQLite + 受控 fetch 验证冲突送达未确认且重建 dispatcher 不重发。无真实钉钉/模型/文档/卡片目标回执证明。
- 扩展定向 14024 exit 0（b45969）：7 文件 / 116 项、typecheck/diff 通过。
- 全仓命令：`pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-business-receipt-typecheck && git diff --check`；45428 已 exit 0（4a040c）。主集结果见 6cbdf3：290.95 秒，267 文件通过 / 1 跳过，2,718 项通过 / 18 跳过，注册数 2,736；index 88 项通过，仍有约 8 秒调用，不宣称旧间歇性延迟已修复。
- broker 7、updater 15、desktop-viewer 5、package-link 2、save-file 10 通过；打包服务无可访问 node_modules 启动、9 条 spawned proxy 路径、后续 typecheck、独立服务端编译和 diff 检查均通过。所有句柄终态，未运行真实钉钉/文档/模型/Docker，不是产品最终验收。

## 2026-09-06 回复超时与有界正文读取（当前批）

- TDD `pnpm vitest run server/integrations/dingtalk/sender-deadline.test.ts`：26d27c exit 1，10 项失败。当前实现在 header/body/超大无 EOF 响应中不会结束，受控 fake timers 复现，不调用真实网络。
- 初修 39095 exit 0（19f7bd）：6 文件 / 71 项、typecheck/diff 通过。新增边界/真实装配队列测试后 56412 exit 2（bd5216）：79 项通过，但新 PrimaryStatusCard 夹具缺字段导致类型检查失败。修正后 30719 exit 0（25ff49）：6 文件 / 79 项、typecheck/diff 通过。
- 定向命令：`pnpm vitest run server/integrations/dingtalk/sender-deadline.test.ts server/integrations/dingtalk/sender.test.ts server/integrations/dingtalk/interactive-card-sender.test.ts server/integrations/dingtalk/reply-router.test.ts server/collaboration/outbox-dispatcher.test.ts server/collaboration/operations/runtime-lifecycle-recovery.test.ts && pnpm typecheck && git diff --check`。覆盖入账装配、超时放开下一回复、未知状态不重发、令牌阶段不误当作消息提交、通俗 Markdown 以及原回复路由。
- 全仓命令：`pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-reply-deadline-typecheck && git diff --check`；首次权限审查超时，未产生测试进程，重试一次后句柄 31815 最终 exit 0（1ae167）。主集 428.13 秒，266 文件通过 / 1 跳过，2,681 项通过 / 18 跳过，注册数 2,699。index 88 项通过，部分约 8 秒调用仍保留观察，不宣称旧稳定性疑点已修复。
- broker 7、updater 15、desktop-viewer 5、package-link 2、save-file 10 通过；打包服务在无可访问 node_modules 条件启动、9 条 spawned proxy 路径通过；后续类型检查、独立服务端编译及 diff 检查均通过。所有验证进程已终态。未调用真实钉钉/模型/在线文档或部署，不替代六类真实试点。

## 2026-09-06 非幂等投递回执丢失保护（当前批）

- 只读 DWS help 75008 exit 0，结合 dingtalk-chat chat-bot/contracts 本地契约：processQueryKey 不等于 openMessageId，Bot/Webhook 不支持幂等键。仅接口能力调查，不是实际消息或远端映射结果。
- 先行 router/Outbox 8766dc exit 1：5 失败 / 9 通过，证明未知发送会跨通道或自动重试、崩溃认领会重新发出。初修 82639 exit 0：4 文件 / 39 项/typecheck/diff。旧 pending 回归 fadb8a exit 1；安全分类标记长度错误 62150 exit 1，修正后 94981 exit 0：4 文件 / 46 项/typecheck/diff。
- 定向命令：`pnpm vitest run server/integrations/dingtalk/reply-router.test.ts server/integrations/dingtalk/interactive-card-sender.test.ts server/collaboration/outbox-dispatcher.test.ts server/collaboration/operations/runtime-lifecycle-recovery.test.ts && pnpm typecheck && git diff --check`。包含真实 headless 装配+受控 fetch+SQLite 的丢回执后重新构造 dispatcher 不重发，发送前 token 失败仍可重试，明确业务拒绝可回退，unknown 不标送达，旧待重试/崩溃认领停止。
- 全仓命令：`pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-delivery-certainty-typecheck && git diff --check`，82059 exit 1（4d104e），507.66 秒：264 文件通过 / 1 失败 / 1 跳过，2,659 项通过 / 4 失败 / 18 跳过，注册数 2,681。失败为 index.test.ts 第 688/936/1058 行三项 20 秒超时及第 1306 行 Mira 2 vs Mira 4。因短路，broker 等后续检查和 typecheck/编译未执行；不列为全仓通过。
- `pnpm vitest run server/index.test.ts` 独立复测 13711 exit 0（46156f），88 项 / 31.20 秒，未变更测试条件。源码显示 POST /api/bots 等待 defaultSelection，驱动 snapshot 存在 8 秒 CLI 探测超时，与首次很多请求约 8 秒相符；尚无进程证据确认是哪次探测，名称差异可能来自前项超时后的残留操作，不下确定根因结论。
- 第二次同一完整命令 40092 已 exit 0（d40202），无排除：主测试 452.74 秒，265 文件通过 / 1 跳过，2,663 项通过 / 18 跳过，注册数 2,681；index 88 项全部通过。附属 broker 7、updater 15、desktop-viewer 5、package-link 2、save-file 10 全通过；打包服务无可访问 node_modules 启动及 9 条 spawned proxy 路径通过。后续 pnpm typecheck、独立服务端编译、git diff --check 均通过。独立检查 97112 亦 exit 0。所有句柄已结束。本次未复现首轮失败，不等于已定位或修复超时根因。
- 未实际调用钉钉/模型/文档、未运行 Docker、未部署；本地待核查保护不是端到端恰好一次投递或机器人引用验收。

## 2026-09-06 引用上下文与乱序续办（当前批）

- TDD 26823 exit 1：association/natural-association 两文件 4 失败 / 32 通过，证明未知引用导致错误新建或模型误归并。初修 61624 exit 0（36 项/typecheck）。新增入站通俗反馈 44000 exit 1（1 失败 / 34 通过），修正后 17641 exit 0（64 项/typecheck/diff）。
- 最终定向命令：`pnpm vitest run server/collaboration/association.test.ts server/collaboration/inbound.test.ts server/collaboration/natural-association.test.ts server/integrations/dingtalk/sender.test.ts && pnpm typecheck && git diff --check`，77377 exit 0：4 文件 / 68 项。包含乱序引用重启续办、持久来源、重放无重复、跨群/循环/终态原引用不采用、其他引用不套用已发送序号、无任务时只保存澄清和通俗缺上下文提示。
- 无排除完整命令：`pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-reply-context-typecheck && git diff --check`，86281 exit 0（1dccad）。主集 265 文件通过 / 1 跳过，2,648 项通过 / 18 条件跳过，2,666 注册数达到底线；490.29 秒。broker 7、updater 15、desktop-viewer 5、package-link 2、save-file 10 项均通过；无 node_modules 可达的打包服务及 9 个代理入口通过，类型/独立服务端编译/diff 检查成功。所有验证句柄已终态。
- 本批 schema 25 不变；测试使用合成事件与受控模型，不是出站机器人回执映射或真实群自然交互验收。未部署、未访问真实模型/文档或运行 Docker，上一批 Docker 证据不能冒充此版验证。

## 2026-09-06 Owner 需求解释恢复（当前批）

- Stream TDD 首先 3 失败 / 17 通过；恢复实现后 90146 exit 0（53 项/typecheck）。后续新增通知版本漂移回归 84808 exit 1（1 失败 / 13 通过），并被运行中的旧整组 5918 捕获（1 失败 / 642 通过）；均为修复前红灯，不能当作当前未修复失败。
- 通知加入 Spec 修订后 60081 exit 0（40 项/typecheck）。最终加入实际 dispatcher 旧提醒抑制、失租回滚和 ACK 持久化顺序后，20188 exit 0：`pnpm vitest run server/collaboration/natural-intake-recovery.test.ts server/collaboration/natural-intake.test.ts server/integrations/dingtalk/text-actions.test.ts server/integrations/dingtalk/stream-adapter.test.ts && pnpm typecheck && git diff --check`，4 文件 / 62 项。
- 无排除完整验证 29394 exit 0（最终输出 e71072）：`pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-server-typecheck && git diff --check`。当前 schema 25：主集 265 文件通过 / 1 跳过，2,638 项通过 / 18 条件跳过，注册数 2,656 达到测试数量底线；本机 HTTP 模型适配测试实际运行。broker 7、updater 15、desktop-viewer 5、package-link 2、save-file 10 项均通过。打包服务在无 node_modules 可达条件下启动，9 个子进程代理入口验证通过；随后类型/独立服务端编译/diff 检查均成功。没有运行中验证句柄。
- Docker 当前源码/schema 25 复测：`OMB_INTAKE_SMOKE_CONTEXT=colima-openmausbot-pilot OMB_INTAKE_SMOKE_IMAGE=sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e node --experimental-strip-types server/collaboration/operations/natural-intake-recovery.smoke.ts`，aec269 exit 0。输出 linux_process_sqlite/controlled、15 条全部恢复、重放防重、权限不变和隔离检查通过；只清理本次临时容器。不证明真实 Owner 恢复短句投递、在线模型/文档、完整主机重启。
- Docker 前后清单 9c0623/4c3c45 exit 0：原试点 healthy、历史容器保持退出状态、无本批临时容器残留。未部署当前恢复入口，不能宣称真实群已生效。

## 2026-09-06 全仓与实际 Docker 进程恢复（最新）

- 当前 030f09c 业务版本：`pnpm vitest run server/collaboration/operations/natural-intake-model.test.ts` 实际监听本机临时 HTTP，9 项通过（496a0a exit 0）。不使用真实模型凭据。
- 完整 `pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-goal-full-regression && git diff --check`，68403 exit 0。没有任何测试过滤/排除；包含 test-floor、broker、updater、desktop-viewer、package-link、save-file、packaged-server。实际无 node_modules 的打包服务启动成功，9 个子代理路径通过。输出分段未保留可复核的总计，本记录不猜测总测试数。此前端口/全仓未验证限制在此业务版本已补齐，不能反向修改历史证据。
- 真实 Docker context `colima-openmausbot-pilot`，固定 image `sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`：既有 `node-test-reporter.smoke.ts` 和 `docker-command-cancel.smoke.ts` 全链 83726 exit 0，assertion passed/failed/skipped 正确，取消后 Linux 子进程 heartbeat 停止。
- 新验证命令：`OMB_INTAKE_SMOKE_CONTEXT=colima-openmausbot-pilot OMB_INTAKE_SMOKE_IMAGE=sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e node --experimental-strip-types server/collaboration/operations/natural-intake-recovery.smoke.ts`。bce00d exit 0，真实 Docker inspect 隔离参数、服务进程 durable 后 SIGKILL、新进程从 SQLite 恢复 14 个待办至全部 15 项、同消息重放无新增、Owner 无变化、容器退出零/非 OOM/最终清理确认。证据源 linux_process_sqlite，解释器 controlled，不能算真实模型或钉钉场景。
- 新探针先后遇到准备复制、子进程参数继承、SQLite 返回记录原型比较失败，均有实际非零退出；修正后才记通过。最终 `pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-intake-linux-smoke && git diff --check` 50206 exit 0，覆盖探针最终版本。
- Docker 前后 ps 确认原试点 healthy、历史容器不动、无本批容器残留。公开 registry-1.docker.io 与 pypi.org DNS 各一次 5 秒超时（15152/60645 exit 28），没有真实解析镜像/Office 文档 smoke。全仓通过与进程恢复不能替代整机重启、真实在线文档/群聊、独立 supervisor 或 Owner 签字。

## 2026-09-06 长会话增量上下文与逐条队列（最新）

- 先行 `pnpm vitest run server/collaboration/natural-intake.test.ts`：4752 exit 1，2 失败 / 16 通过，分别证明超过 12 条永久 contextTruncated 和当前消息末尾要求截断。首修后 30981 exit 0，18 项及类型检查通过。
- 突发逐条队列测试 39744 exit 1：上一条任务被 supersede 且未保留 pending 门禁。修复后 natural-intake/natural-association/attachment-completeness 三文件 59 项及 typecheck 通过（59177 exit 0）。早期输入失败、后续成功时缺通知的测试 12633 exit 1，按同事项失败收据修复后纳入最终整组。
- 最终命令：`pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts --exclude server/collaboration/operations/natural-intake-model.test.ts && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-natural-context-typecheck && git diff --check`。13822 exit 0，70 文件 / 616 项，Vitest 68.62 秒。当前业务源码的相关测试、类型、服务端编译和 diff 检查全部实际通过；无运行中句柄。
- 未运行完整 pnpm test；端口依赖模型测试仍因已有执行权限阻碍排除。没有真实模型语义评分、钉钉收发、Docker 解析或六类真实试点证明。旧版无覆盖收据/已替代历史的补偿、需求解释停止恢复、机器人出站引用仍未完成。

## 2026-09-06 Owner 附件整理恢复（最新）

- 接续 Stream 三条短句 TDD 为 3 失败 / 14 通过；初轮集成新增 1 失败 / 58 通过，系夹具使用错误审计表名，修正后 59 项/typecheck 通过（31383 exit 0）。
- 按真实外部群标识构造 fixture 后 4 失败 / 34 通过（42568 exit 1），证明原查询错误地拿外部标识匹配内部会话。修复群别名查询，并加入普通入口和 Owner 命令跨路径重放拒绝验证。
- 最终命令：`pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts --exclude server/collaboration/operations/natural-intake-model.test.ts && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-projection-recovery-typecheck && git diff --check`，18332 exit 0：70 文件 / 611 项，Vitest 68.89 秒。类型检查、服务端编译及 diff 检查均经过实际执行。
- 证据对应本批 schema 24 源码及测试；合并前早一组 75587 绿灯不能替代最终版本。没有运行中句柄。不等于全仓 pnpm test，也没有真实群、在线文档、模型、Docker 或主机重启验收。

## 2026-09-06 投影失败三次收束与无端口回归（最新）

- 默认权限 `node:net` 随机端口绑定 127.0.0.1 预检返回 EPERM（569e5c exit 1）；未产生运行服务器。结合上轮两次审批超时，本轮不重复申请全仓执行，也不把缺失的端口/全仓测试列作通过。
- TDD 摄取套件 2 失败 / 18 通过（27545 exit 1）：第四次仍调用失败回调、1 ms 后即再次调用。初实现 3 失败 / 24 通过（41976 exit 1），原因是把重试时间写到 owner=NULL 的租约 expiry，违反既有 paired-null CHECK；新 schema 的不可变 receipt 增加 retry_after，释放 owner/expiry 同时归空，未删除或放宽约束。
- 修复后摄取与 db 27 项/typecheck 通过（91999 exit 0）；加入 50 停止 + 1 健康批次、旧 claim/取消、反馈写入失败回滚与不可变收据后，摄取/db/service/lifecycle-recovery/backup 五文件 69 项/typecheck 通过（26677 exit 0）。
- 最终 `pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts --exclude server/collaboration/operations/natural-intake-model.test.ts && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-projection-retry-typecheck && git diff --check` 全链通过（85915 exit 0）：70 文件 / 594 项，04:45:17 开始，Vitest 65.97 秒。含最后新增 v22 升级原下载失败/Outbox 保留和实际文本渲染断言。排除项仅因需监听权限，仍未验收，不是隐藏失败或修改全仓脚本。
- 未重新运行完整 pnpm test，未验证真实钉钉/模型/在线文档/解析容器和主机重启。停止后的安全恢复入口尚未实现；换实例/重启不能清空三次停止状态。当前没有运行中验证句柄，历史未验证项继续保留。

## 2026-09-06 生产附件 ACK 组合边界（最新）

- 计划对固定 fc2033f 执行 `pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-attachment-feedback-full-typecheck && git diff --check`。原请求及仅一次重试均自动权限审核超时，命令未启动、无进程句柄；不计为失败测试，不存在可以继续 poll 的全仓测试。
- 无新增权限的组合测试首次运行 3 失败 / 10 通过（86399 exit 1）：确认和能力持久化已通过，download 次数仍 0。源码 normalizer receivedAt=Date.now，inbound 用 receivedAt 登记 next_attempt_at，而夹具维护时间停在 1700000000000；证明测试时间轴不一致，不是生产调度缺陷。修正测试时钟与接收时间对齐，未修改业务代码或降低下载/确认断言。
- 修正后 Stream 13 项、typecheck、diff 检查通过（49162 exit 0）。最终 `pnpm vitest run server/integrations/dingtalk/stream-adapter.test.ts server/integrations/dingtalk/attachment-downloader.test.ts server/collaboration/attachment-ingestion.test.ts server/collaboration/operations/runtime.test.ts && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-attachment-stream-integration-typecheck && git diff --check` 通过（20610 exit 0）：4 文件 / 73 项，04:29:06 开始，Vitest 3.35 秒。
- 组合检查真实 Ledger/Vault/coordinator，但 SDK/下载为受控端口、投影回调未启用；覆盖 ACK 前持久证据、保存/ACK 失败与重复投递、确认后服务重建、单批挂起读取/持续续租/Outbox，以及停止后迟到结果不写失败和证据。不把这些测试称为真实钉钉、成功正文到 Spec 或整机重启证明。
- 全仓回归当前仍未执行，真实模型/在线文档/Docker/六类试点仍未完成；没有访问真实凭据或更改运行环境。当前无未结束验证句柄。

## 2026-09-06 附件失败收据与业务反馈（最新）

- 先行 `pnpm vitest run server/collaboration/attachment-ingestion.test.ts`，3 失败 / 13 通过（20231 exit 1）：第三次仍 pending、不同原因串联后没有停止、恢复后没有可检查的积压回复。不是因缺失新 schema 而假造红灯。
- 初实现同文件 16 项和 typecheck 通过（85148 exit 0）；数据库/摄取/服务/生命周期恢复/备份 5 文件 60 项及 typecheck 通过（22544 exit 0）。来源路由测试首次导入错误使套件未运行；修正实际 reply-router 路径后，摄取与数据库 2 文件 / 25 项及 typecheck 通过（11796 exit 0）。覆盖三次同因、变更原因重计、重建 coordinator、不可变收据、事务回滚、恢复后的旧提示抑制、原附件 session 真实装配和重复投递抑制、v21 无虚构历史失败升级。
- 最终 `pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-attachment-feedback-typecheck && git diff --check`，59374 exit 0，71 文件 / 592 项，04:11:10 开始，Vitest 66.84 秒。请求等待期间未重启；现已终态。
- 本批未运行全仓 pnpm test、真实钉钉/模型/在线文档或 Docker；测试网络为受控 fetch、没有真实凭据。不能据此宣称自然协作六类试点通过。投影回调异常仍需独立的失败预算与反馈设计，解析器进程收束不由下载失败收据替代。

## 2026-09-06 附件非阻塞生命周期（最新）

- 下载器先行测试：`pnpm vitest run server/integrations/dingtalk/attachment-downloader.test.ts`，8 失败 / 13 通过（15722 exit 1）。六个网络/流阶段无超时、取消无法结束、迟到 token 测试挂起均被复现，未以测试超时冒充成功。
- 实现后首次三文件 48 通过 / 1 失败（83718 exit 1）：原同步测试期待第二次 process，但后台首批还没结算；入站进一步改为仅持久化，明确由维护启动，测试等待批次结束后验证第二次维护。52 项/typecheck 通过（87757 exit 0）；增加停止/失租/退出未收束后 54 项/typecheck 通过（16278 exit 0）。
- 最终相关链：`pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-attachment-background-typecheck && git diff --check`（36561 exit 0），71 文件 / 586 项，03:51:49 开始、Vitest 67.25 秒。覆盖入站、关联、Owner、Ledger、Outbox、回复格式和当前附件生产装配；网络输入为受控夹具。
- 最后仅增加挂起附件时实际 Outbox deliver 断言：`pnpm vitest run server/collaboration/operations/runtime.test.ts && pnpm typecheck && git diff --check`，20 项通过（72400 exit 0）。其他源码未再变化；相关整组包含新事务内 fence，最后测试补充有独立终态证据。本批未重新执行完整 pnpm test；上一批完整绿灯不能自动当作本版本全仓证明。
- 明确未验收：真实 token/下载/群回复组合、真实 Office 解析容器及进程终止、线上文档和模型、主机重启、六类真实试点。可重试附件失败目前仍按既有退避再次处理，三次停止及用户反馈尚需实现。取消只确保等待有界和旧结果拒绝，不证明忽略信号的外部工作已停止。

## 2026-09-06 同轮输入夹具与全仓回归恢复（最新）

- 原源码完整 `pnpm vitest run server/index.test.ts server/steer-e2e.test.ts` 通过（5769 exit 0）：2 文件 / 90 项，03:22:11 开始、37.89 秒。这不证明历史 20 秒超时的原因，只排除稳定必现的两文件原顺序失败。
- 延迟复现：在等待 activity 后、发送第二条消息前增加 1,200 ms，保持原 slow 夹具 800 ms 完成及全部原断言；`pnpm vitest run server/steer-e2e.test.ts -t 'a message during a Claude turn'` 失败（15930 exit 1），second.body.steered 为 undefined，与原全仓症状一致。这证实时序假设有缺陷，不说明 Chief 超时与它同因。
- 专用夹具改为真实 stdin 补充事件握手后，`pnpm vitest run server/steer-e2e.test.ts server/drivers/claude.test.ts && pnpm typecheck && git diff --check` 通过（31289 exit 0）：2 文件 / 52 项通过 / 1 既有跳过，03:24:41 开始、41.28 秒。新增观察延迟保留为回归，原 slow 模式未移除，产品逻辑/40 秒测试时限不变。
- 最终 `pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-steer-fixture-full-typecheck && git diff --check` 全链通过（36219 exit 0）。包含主 Vitest/test-floor、broker、Electron、打包无 node_modules 启动/全部九个代理路径、类型和服务端编译。完整主套件总数所在工具输出截断，不从上一轮推算。中间明确观察到 steer-e2e 2 项通过、index 88 项通过（Chief 690 ms，原 20 秒上限未改）。
- 修复前完整两文件 1 次通过；延迟故障注入 1 次失败；修复后定点/共享夹具 1 次通过、正式全仓 1 次通过。有限试验不能保证永不抖动，Chief 原超时的直接根因仍未知。之后只更新状态文档；现无未结束验证进程或未解决当前测试失败。
- 未改产品权限、运行服务/容器、网络或 Owner 身份，未调用真实模型/钉钉/在线文档。前两批正文链路已纳入本次完整回归，但真实 Docker 文档、线上来源、主机恢复和六类真实群协作依旧未验收；Goal active，下一步为 D-048 的附件后台生命周期。

## 2026-09-06 固定 5db6a79 全仓复测（未通过）

- 保持业务源码和测试不变，执行 `pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-document-source-full-typecheck && git diff --check`。启动请求等待后实际启动 15254，持续跟进同一句柄至 exit 1，没有因观察等待重启。主套件：2 文件失败 / 262 通过 / 1 跳过，2 项失败 / 2561 通过 / 18 跳过（2581 收集），03:11:42 开始、467.73 秒。test-floor 保留并按失败退出。
- 失败 1：server/index.test.ts:688 `elects one Chief of Staff per section and preserves other section Chiefs`，20,000 ms 超时。失败 2：server/steer-e2e.test.ts:103 `second.body.steered` 期望 true、实际 undefined。没有证据将其归因于文档改动或 DNS，当前视为全仓验收未通过。
- 原进程结束后原源码执行 `pnpm vitest run server/index.test.ts server/steer-e2e.test.ts -t 'elects one Chief|a message during a Claude turn'`，2 文件 / 2 项通过、88 项因定向过滤跳过（20997 exit 0），03:19:53 开始、7.28 秒。没有增大 timeout、屏蔽错误或修改断言。局部成功仅证明单独运行可通过，不能把整套失败改记为成功；仍需查共享状态/顺序/时序。
- 单独补跑 `pnpm broker:test && pnpm test:updater && pnpm test:desktop-viewer && pnpm test:package-link && pnpm test:save-file && pnpm test:packaged-server && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-document-source-full-typecheck && git diff --check` 全链通过（26259 exit 0）：broker 7 项，Electron 15/5/2/10 项，打包无 node_modules 启动与全部 9 个代理路径、类型和服务端编译通过。它们在首次 && 链中并未执行，不能混为一次全仓通过。
- 本批业务源码未变，只有状态文件更新，因全仓失败暂不自动提交。只读审查的附件 ACK/drain 阻塞及缺超时风险见 D-048；这不是已复现真实群故障或已实现修复。Goal active，未完成项仍含真实 Docker 文档镜像、在线文档/模型、完整主机重启和六类群试点。

## 2026-09-06 正文尾部、来源与字符完整性（最新）

- 最终 `pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-document-source-typecheck && git diff --check` 全链通过（31434 exit 0）：71 文件 / 570 项，03:04:42 开始、66.37 秒。之后只更新文档；本批未运行全仓 pnpm test，不将前几批全仓结果算作当前证据。
- 针对性 `pnpm vitest run server/collaboration/attachment-completeness.test.ts server/collaboration/plan-reviser.test.ts server/collaboration/attachment-ingestion.test.ts server/collaboration/attachment-text-extractor.test.ts && pnpm typecheck && git diff --check` 通过（83059 exit 0）：4 文件 / 49 项。
- 首批新增三格式长正文与缺尾部测试实际复现旧投影丢尾部（74744 exit 1）；同时测试扩展误改原 text 夹具 MIME，引发一个既有来源冲突，恢复原 MIME 后解决（70927 exit 1 为修复前结果）。分段实现后 40 项通过，但新测试用了项目 TS lib 尚未支持的 String.isWellFormed（38119 exit 2）；改用 UTF-8 round trip 精确比较，不升级全局 lib。
- 新增长行第 8,000 字处表情符号案例（1393fb exit 1）实际复现入库替换为乱码，修复原始切块边界后通过。先行调用按 -t 选择单项，其余跳过仅为定点复现；最终整组没有新增跳过或削弱原用例。
- 新增正文分段还原包含边界空白/Unicode、三格式生产适配器→Ledger→Spec→服务重建和重放、表格尾部验收引用/原始来源收据、三格式 partial 保持、删除事实尾部阻塞。原 2,100 字“必定阻塞”用例由完整保存/丢尾部再阻塞覆盖替代；超 12 chunk 和满 100 事实边界仍验证阻塞。
- 这些集成使用受控 Docker 命令端口/解析结果及自造下载字节，并非真实 Office 文档解析或 Linux 隔离证明。未调用真实模型/钉钉/在线文档，不处理真实附件，不改试点。旧投影迁移/乱码重提取、超上下文文档完整处理、全仓回归及六类真实试点仍待完成。

## 2026-09-06 文档容器验证入口与防假通过（最新）

- 最终 `pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-document-smoke-typecheck && git diff --check` 全链通过（79314 exit 0）：71 文件 / 561 项，02:52:37 开始、65.07 秒；类型检查及服务端编译通过。之后只改状态文档。没有运行本批全仓 pnpm test，不挪用 18f4176 的全仓结果。
- `/tmp/omb-parser-verification-20260905/bin/python -m unittest test_extractor test_smoke_fixtures` 在 parser 目录通过（5725c8 exit 0），13 项；仅自生成可信夹具。七份样例涵盖 Word 表格位置/脱敏样例、隐藏 Excel 页、未求值公式、PDF 页来源/部分未读、活动内容和加密文件拒绝。
- 新 TS smoke 17 项含实际隔离参数断言与受控 Docker 命令端口编排。检查创建/隔离/进程状态/固定拒绝响应、超时确有运行中容器、逐案适配器清理，以及创建回执丢失、检查失败、错误退出、错误正文、假超时、重复场景、清理失败/谎报/无法查询。既有用户容器哨兵不被移除，单个清理失败仍检查其他本次容器。
- TDD 首轮 15 项中 8 项失败（80c9c4 exit 1），实际复现通用异常误算成功；实现后相关 21 项和 typecheck 通过（93035 exit 0）。追加两个用例/证据来源标识后整组首次 560 通过 / 1 失败（44942 exit 1），仅 loopback listen EPERM。允许临时本机监听后原套件重跑取得最终通过，没有跳过、弱化或改写失败用例。
- 只读 Docker ps（cfe447 exit 0）确认现有非生产 pilot healthy，未更改任何原有容器。真实镜像下载前段受 Docker Hub EOF/Colima DNS 超时阻塞；本批备用 public.ecr.aws HEAD 在 DNS 解析超时（83823 exit 28，15 秒）。首次权限审查超时未启动命令，唯一重试启动后跟进原句柄至终态。
- 未构建/运行 parser 镜像、未执行真实 Docker smoke、未接入 headless、未调用在线文档/模型/钉钉、未改变身份或全局网络。报告把受控端口标为 controlled_docker_port；其通过不证明 Linux 隔离、正文 Ledger 摄取/恢复、真实群回复或六类场景。Goal active，下一步见 PROGRESS 当前批次。

## 2026-09-06 全仓基线与恢复通知投递门禁（最新）

- 修改前保持 18f4176 源码不变，`pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-background-recovery-full-typecheck && git diff --check` 全链通过（51696 exit 0）。包括主 Vitest/test-floor、broker、Electron 测试与无 node_modules 打包启动/九个代理路径检查。中段工具输出被截断，未保留精确主测试数量，不提供推算值。这是修改前基线，不能冒充后续代码的全仓回归。
- 最终修改后 `pnpm vitest run server/collaboration/operations/runtime-lifecycle-recovery.test.ts server/collaboration/outbox-dispatcher.test.ts server/collaboration-headless.test.ts && pnpm typecheck && pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-recovery-notice-typecheck && git diff --check` 全链通过（54390 exit 0）：针对性 3 文件 / 34 项；相关整组 70 文件 / 544 项，02:22:25 开始、65.01 秒，类型检查及服务端编译通过。此后只更新文档，代码/测试未再改变。
- 11 个新增案例覆盖：当前有效 blocked/recovered 提示可投递，暂停、取消、新贡献、旧占用已结算、重试后暂停、过期 claim 接管、恢复后又有同仓库活动时抑制过期提示；当前/上一版合成恢复事件通过真实 headless 装配与 session sender 的受控 fetch 关联到所属任务消息，不读真实凭据或依赖卡片模板。
- 首轮先行六项失败（7847）复现旧提示仍发送/重试及装配未公开；实现后 30 项与 typecheck 通过（63751）。随后旧 work_item 格式单项复现 delivery_unroutable，补兼容后最终整组通过。权限审查第一次超时未启动命令，只重试一次确认启动 54390 并一直跟进同一句柄。当前无未解决测试失败或运行中验证句柄。
- 仅临时 Git/SQLite、受控 HTTP/fetch、既有本地子进程与打包 smoke；未调用真实钉钉/模型/在线文档，未部署容器或修改 Owner/凭据。没有证明网络请求已开始后仍可撤回消息，也没有完成无 session 的恢复投递和多群主动路由。后续改动后的全仓复跑及全产品真实验收仍待完成，Goal active。

## 2026-09-06 后台恢复、通知与安全续排（最新）

- 最终全链 `pnpm vitest run server/collaboration/operations/runtime-verification-retry.test.ts -t 'abandoned zero-command' && pnpm typecheck && git diff --check && pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-runtime-lifecycle-recovery-typecheck` 通过（41694 exit 0）。整组 70 文件 / 533 项，02:04:36 开始、63.20 秒；类型检查及服务端编译通过。之后仅更新状态文档，生产代码与测试未再改。未运行本批全仓 pnpm test。
- 新增九项 runtime 恢复测试：启动/维护不等待权威检查；未知通知跨 drain/重启去重且真实 session 渲染无内部编号；关机/失租/暂停不发迟到提示；检查超时后不接受迟到成功；durable running 不进入阻塞式 legacy 扫描；不同仓库可并行恢复；结算后崩溃漏通知可补回且不重复检查/结算。
- 仓库集成测试证明：旧孤立执行预留释放后，只启动同仓库另一个未执行事项；即使尝试预算还剩余，也不新增旧事项 dispatch 或重做旧修改。独立复核集成证明零命令旧 verifier 恢复后会再次核对当前候选，不调用修改 Agent、不产生新 Run。
- 先行五项失败复现后台恢复缺失（25240）；同仓库续排先行失败（39998）；基础接入后 27 项及 typecheck 通过（16663）。追加超时/跨仓库两项先行失败（18720），取消读取与并发分组后 82 项及 typecheck/diff 检查通过（57464）。结算后漏发先行失败（60351），收据补发后通过。
- 最新 52 项针对性中一项复核续排失败（87838），进一步断言确认 settlement 已落库但 runner 未启动（59048）；原因是 canonical session 路径不能按字符串匹配历史符号链接候选路径。统一 repository key 后单项和最终整组通过。以上失败均已修复，无未解决测试失败。
- 测试只用临时 Git/SQLite、受控 containment/runner、本机 HTTP 服务和既有独立子进程，没有调用真实模型/群聊/在线正文，也没有更新 Docker 或身份凭据。新通知渲染已验证，不冒充真实群投递。
- 待续：全仓 pnpm test；确认退出但仍为 running 的旧 Run 的安全状态收束；无生命周期记录的 legacy 运行隔离/启动恢复；通知投递时的最新 Spec/控制状态校验；Docker 强制重启和完整六类真实验收。Goal 保持 active。

## 2026-09-06 被动恢复证据与收束边界（最新）

- 最终 `pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-lifecycle-recovery-typecheck && git diff --check` 全链通过（13581 exit 0）：69 文件 / 522 项，01:38:10 开始、62.15 秒。生产代码及测试此后未改，仅更新四份状态文档；未运行本批全仓 pnpm test，不用历史全仓证据替代。
- 新增恢复测试 32 项；执行/复核重验原始隔离证明及 empty fingerprint、同一恢复重放/两个独立 SQLite 连接竞争只结算一次、恢复不改事项/候选/复核记录。活进程、未知、缺证明、证明拒绝、指纹不匹配、原实例仍有效、等待中失租、取消和数据库关闭均不落结算。
- 收束标记不可改删，标记后不得继续预留命令或补证明；零命令执行无标记仍阻塞，零命令复核仅在旧实例失去租约后可恢复且旧命令预留被拒。v20 升级保留原 sessions/commands/proofs，不回填假的收束证据；v15/v18/v19 重建夹具、健康及备份版本检查同步到 schema 21。
- 前段原有 6 个先行测试在模块未实现时失败，基础实现后 6 项及 typecheck 通过（54883 exit 0）。本次扩充后 14 项行为通过，但 TypeScript 报测试夹具联合类型无法安全收窄；统一夹具接口并继续补边界后 4 文件 / 90 项、typecheck、diff 检查通过（50811 exit 0），最终整组通过，无遗留测试失败。
- 仅临时 Git/SQLite、受控 containment/runner、独立本机子进程及本机 HTTP 夹具，不调用真实模型、钉钉或在线文档。未更新原试点，不把 schema 21 本地回归说成线上完成。
- 底层恢复函数尚未接到 runtime 一次性后台扫描、生命周期/关机等待及群内幂等提醒，也未证明 Linux/Docker 强制重启安全续办。下一批先为这些路径补测试再接入；完整产品 Goal 继续 active。

## 2026-09-06 执行层持久仓库占用与自测清理（最新）

- 最终相关全链 `pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-execution-lifecycle-typecheck && git diff --check` 通过（72596 exit 0）：68 文件 / 490 项，01:13:37 开始、59.66 秒。随后生产代码未改，只增强同仓库不同事项竞争断言；该测试、typecheck 及 diff 检查通过（69868 exit 0）。本批未跑全仓 pnpm test。
- 新增四个执行用例和一个 v19→v20 升级用例。确认 prepare 前有不可变执行预留，第二执行器/真实 Node 子进程持同一有效 owner 身份也无法启动同仓库的相同或不同事项；Agent 失败且进程 active 不结算；自测清理未知不被转成普通配置结果、新执行器接管后仍拒绝重跑；修改和复核的持久预留双向互斥。既有不同仓库并发与混合队列测试包含在整组中。
- 先行三项复现缺执行表、失败活进程返回普通结果、自测清理未知返回配置提示。实现后 17 项通过 / 2 项失败：启动拒绝且没有证明改为明确不结算，保留 Run 终态并补充持久占用断言；原暂停 Agent 夹具漏登记证明，补上实际注册后保留原 Owner 中断断言。随后 65 项通过 / 1 项失败为 runtime 错误优先级变化，恢复内存 busy 优先、持久占用后验，41 项和 typecheck 通过。
- 独立 Node 子进程暴露 TypeScript 参数属性不支持 strip-only，改为普通字段构造后通过，没有换用模拟导入逃避兼容性问题。升级夹具同时移除新表并更新至 schema 20；v19 升级保留已有映射预留及不可变触发器验证通过。
- 新增执行记录存 binding/proof，而非凭据或 Owner token。仅临时 Git/SQLite、受控 containment/Agent/runner 和独立本机进程验证；未部署 schema、镜像或运行真实模型/钉钉/在线文档。
- 不证明旧 v19 历史 Run 已被自动回填隔离、不证明遗留 session 受控清理、进程崩溃恢复或 Linux 主机重启成功。真实 Docker/群聊六类试点仍待验收，Goal active。

## 2026-09-06 底层复核持久占用与迟到结果（最新）

- 最终 `pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-direct-verifier-typecheck && git diff --check` 全链通过（62528 exit 0）：68 文件 / 485 项，01:02:16 开始、68.67 秒。本批未运行全仓 pnpm test，不复用上一批全仓通过作为本批证据。
- 新增三项：第二 SQLite 连接和真实 Node 子进程对同一候选、同一有效实例身份再次复核时被持久占用拒绝，命令启动次数不增加；缺失进程证明的直接复核在租约接管后仍锁定；runner 返回前 lease fence 改变，Verifier/Meta 表零新增、占用保持未结算。
- 先行两项复现无持久记录。迁移到复核器后 50 项通过 / 1 项失败，原 runner 未配置夹具被包装成一个缺证明命令；保留原“不调用 runner 的配置失败”路径后通过。迟到结果测试先误断言内层错误消息，改为断言 CommandCleanupError 后复现旧实例写入两条记录，加入三处事务租约检查后 52 项和类型检查通过。独立子进程用例另行通过，之后最终整组通过，无遗留失败。
- 原候选测试夹具现在真实持有实例租约；时钟为复核器的可信运行配置，headless 传入其既有时钟，独立默认使用当前时间。未弱化原验收断言或跳过用例。
- 子进程竞争证据覆盖底层复核器持久互斥，不证明所有代码执行入口互斥或 Linux 主机重启恢复。没有部署或调用真实模型/群聊/在线文档，未修改凭据和 Owner；执行准备、自测清理、遗留恢复及六类真实试点仍需完成，Goal active。

## 2026-09-06 混合队列与直接执行入口（最新）

- 最终 `pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-mixed-repository-typecheck && git diff --check` 全链通过（83130 exit 0）。主 Vitest 261 文件通过 / 1 文件跳过，2475 项通过 / 18 项跳过（2493，总数门禁通过），00:48:27 开始、401.25 秒。broker 7 项、Electron 独立套件 32 项、无 node_modules 的打包服务启动和 9 个代理路径均通过。类型检查和服务端编译通过。
- 新增 6 项：自动 prepare 期间直接入口拒绝同仓库执行；直接 prepare 期间禁止重复调度并在结束后推进等待事项；复核与新修改在同仓库串行/不同仓库并行；shutdown 不再启动排队候选；Owner 复核重试等待直接修改结束后运行。完整套件内新旧 runtime-repository 21 项与 verification-retry 20 项均通过。
- 两个入口先行测试失败，分别实际启动到 Agent 超时、prepare 计数由 1 变为 2，证明原公开入口绕过内存占用。修复后针对性 56 项通过，第六项单独通过；两次类型检查暴露测试 spy this 隐式 any，同一问题加显式 WorktreeManager 类型后最终全仓类型检查通过。第一次完整回归权限审查超时未开始，一次重试确认启动后始终跟进同一 83130，没有重复启动或削弱测试。
- 真实临时 Git/SQLite/prepare 与受控 Agent、runner、containment 验证了 headless 进程内互斥；没有调用真实模型、钉钉群、在线文档或部署 Docker。保留既有平台跳过项，不宣称 Linux 主机重启、独立进程竞争或六类真实群聊通过。
- 全产品仍未完成：底层 service/executor/coordinator 尚缺统一持久仓库预留、遗留复核受控恢复和真实强制重启证据；在线文档及真实自然会话/六类试点仍依赖授权和实际验收。Goal active。

## 2026-09-06 启动复核后台化与仓库队列（最新）

- 最终 `pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-background-verification-typecheck && git diff --check` 全链通过（22034 exit 0）：68 文件 / 476 项，00:39:16 开始，54.13 秒。未运行本批全仓 pnpm test。
- 针对性 runtime / repository serialization / verification retry 三文件 51 项和 typecheck 通过（39813）。新增三个场景：startup 复核等待时 start 返回、入站消息写入/回复 sent/租约续期；同仓库两候选依次运行；不同仓库两候选同时等待。后两场景还检查失败后多次 drain 不额外执行，review 各一条。
- 先行测试确认 startup 被阻塞。共享会话夹具第二条进入 ambiguous 归属，并非产品并发失败；改用独立会话测试调度，补齐 teardown 释放后来进入的 runner。首轮整组 475 passed / 1 failed（59177），唯一失败为 loopback listen EPERM；申请本机端口测试权限后完整重跑通过，没有跳过或削弱 HTTP 测试。
- Git、SQLite 为真实临时夹具；runner/containment/Outbox 为受控端口，消息接收走运行时 API，不冒充真实 Stream 群聊。未部署 Docker、调用真实模型/在线文档、改变凭据或原试点容器。仍缺复核与修改混合队列专门测试、强制重启/跨进程压力、遗留 session 受控恢复、全仓测试及六类真实试点；Goal active。

## 2026-09-06 持久复核运行与仓库占用（最新）

- 最终 `pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-verifier-ledger-typecheck && git diff --check` 全链通过（53653 exit 0）：68 文件 / 473 项，00:16:39 开始、57.18 秒。覆盖协作/钉钉/headless；本批未运行全仓 pnpm test。
- 新增两个 runtime 场景和 v18→v19 数据保留升级测试。确认租约过期后新 runtime 不重新验证未结算仓库、直接执行也被拒绝；第二 SQLite 连接抢占相同仓库失败；隔离证明不可变；正常测试失败但进程为空可结算并允许 Owner 显式重试。不相关仓库的占用查询为 false，未据此声称跨进程并发压力已通过。
- 先行测试缺生命周期表导致两项失败；实现后新功能及候选复核测试通过，旧迁移条数断言漏改导致一项失败。整组先暴露 v15 夹具保留 v19 表，补齐移除后又暴露旧 user_version=18 断言；更新为 19 并检索其余 18 引用后最终全部通过。一次补丁因 hunk 顺序无法定位而未应用，重排后成功；第一次整组授权审查超时未启动，一次重试成功。
- 验证使用真实临时 Git/SQLite、双连接及新 runtime 对象，containment/runner 是受控测试端口；不等于真实进程崩溃恢复、Docker schema 19 试点或 Owner 群操作。没有升级服务数据库、部署镜像、调用真实模型/群消息/在线文档或变更凭据。
- 未完成：遗留 session 的受控解除与安全清理、无证明记录恢复、全入口统一仓库锁、跨进程压力及强制重启、启动后台化、六类真实群聊。当前证明持久阻止重复执行，不证明自动续跑成功；Goal active。

## 2026-09-05 Docker 取消与清理确认（最新）

- 最终 `pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-docker-cancel-typecheck && git diff --check` 全链通过（91577 exit 0）：68 文件 / 470 项，23:57:24 开始、50.56 秒。本批未运行全仓 pnpm test。
- Docker 先行测试 7 failed / 1 passed，复现取消不生效、登记失败残留运行容器及清理不明仍作普通失败。runtime 新测试复现清理不明仍 ready；修正后针对性 21 项及 typecheck 通过。
- 第一轮整组（25900）469 passed / 1 failed：自然归属正例只生成旧提问、未先送达，同毫秒排序会产生后续提问；夹具改为先真实 dispatch 旧提问再创建归属问题，保留产品规则及原断言。重跑首次审批超时未执行，一次重试成功。最终无遗留测试失败；上一轮 20 工具轮收束时尚未取得最终类型检查状态，本轮先跟进同一 91577 句柄确认 exit 0，没有重复启动测试。
- 真实 docker-command-cancel.smoke.ts exit 0：context colima-openmausbot-pilot，固定缓存镜像 sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e。before_gate 未执行；running_tree 观察到子进程 heartbeat 后取消，确认 Running=false 且 heartbeat 不再更新；同时检查无网络、只读根和非 root。
- 两个自建临时容器及目录已清理，前后 ps 确认原钉钉试点仍 Up 2 days healthy，历史容器不动。没有镜像下载、服务替换、真实模型/群消息/在线文档或凭据变化。
- 不证明 verifier 持久运行/恢复、跨实例接管安全、启动后台化或六类真实群聊。清理未确认标记仍仅内存，后续须持久化。Goal active。

## 2026-09-05 复核取消与关机后迟到结果（最新）

- 最终 `pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-verification-cancel-typecheck && git diff --check` 全链通过，89949 exit 0：67 文件 / 461 项，23:41:31 开始、49.87 秒。消息接收/归属/Owner/Ledger/Outbox/回复及 headless 在整组范围内。本批未运行全仓 pnpm test。
- 新增 7 项：提议与独立模型等待期间取消；预先取消不预留不调用；超时提议迟到不调用独立模型；候选映射取消无后续测试/review；测试返回时取消不记验证结果；Owner retry 关机后返回不写库、不通知、无未处理 rejection，未收束时报告并拒绝同对象重启。
- 先行失败：映射两项等待超时、预取消仍 approved、超时迟到仍调用独立模型；候选新测试曾漏导入 vi，补齐后通过。运行期先复现 database is not open 未处理异常；取消接入后 51 项和 typecheck 通过。补充未收束提示先失败，再跟踪复核/限时等待后整组通过。
- 91443 首轮整组也为 461 项通过，但执行期间调整了隔离登记取消边界，因此不能用它替代最终固定代码的 89949 结果。最终无遗留测试失败。取消不打断已进入 runner 的登记握手，防止在其清理前放弃控制。
- 所有新增验证为受控模型/runner 与真实临时 Git/SQLite，不是 Linux 进程终止或真实群聊证据。尚缺 verifier 持久运行与 containment 记录、跨进程恢复、已启动测试可验证终止、启动后台化、pending 自动续办和六类真实试点。无 Docker 部署、真实模型/钉钉/在线文档调用或凭据变更；Goal 保持 active。

## 2026-09-05 复核反馈与过期通知（最新）

- 最终 `pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-verification-notices-typecheck && git diff --check` 全链通过，92132 exit 0；67 文件 / 454 项，23:17:04 开始、48.87 秒。覆盖接收、归属、Owner 权限、Ledger、Outbox、session 回复和 headless。没有运行本批全仓 pnpm test，不借用上批全仓证据。
- 新增 9 项：三类通知无代码/状态/内部标识；pause/cancel/换计划/未投影贡献后旧失败；pending 区分去重与旧尝试拒绝；错误契约和被替换租约。首轮 8 failed / 15 passed 复现原问题，修复后 23 项和 typecheck 通过。补充租约夹具先误设 expires_at 违反约束，改为 fencing_token 增长后复现 StaleFenceError 外抛，修复后最终全组通过。文档补丁一次标题上下文不符未应用，核对后重试。
- 临时 Git/SQLite 真实，执行和模型返回为受控端口；状态变化是夹具注入，非真实 Owner 群审批。pending 为运行时边界测试，未证明首个模型调用期间主动通知。无真实群聊、模型、在线文档调用或服务部署。
- 未实施/未验证：启动复核后台化、等待期间租约维护、shutdown 等待/取消复核、后台 promise 异常收束、pending 自动重扫、完整 Docker 六类试点。整体目标继续进行。

## 2026-09-05 显式模型配置与最终收据核查（最新）

- 最终 `pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-mapping-config-typecheck && git diff --check` 全链通过，66111 exit 0。主 Vitest 260 文件通过 / 1 文件跳过，2438 项通过 / 18 项跳过（2456，总数门禁通过），22:46:12 开始、491.13 秒；broker 7 项、Electron 独立套件 32 项、打包服务脱离 node_modules 启动和 9 个代理路径检查均通过。类型检查、服务端编译及补丁检查通过。
- 本次完整测试通信链路和 server/index 明显较上轮慢，但同一进程持续产出通过结果，未重启、跳过用例或扩大超时。所有既有平台跳过项保留，不宣称跨平台全通过。
- 先行失败：配置模块不存在与 headless 未装配两项；补齐后 14 项及类型检查通过。假 mapping 收据被完成判定误接受的测试先失败，加入持久收据重建后候选/映射 35 项通过；TS object 属性收窄失败已补齐 in 判断并通过全仓类型检查。Compose 叠加模板先缺失，添加后四文件 23 项和 typecheck 通过（5903）。最终无遗留测试失败。
- 新增覆盖：默认不开模型、不借其他凭据；独立无历史上下文、受限凭据文件、无工具/无存储/无 previous_response_id；模型/地址/凭据引用/规则版本任一改变使策略身份失效；headless 探针不加载模型凭据；pause/cancel/Spec/HEAD/dirty 变化后测试启动数为 0；收据缺失或与当前 Spec/候选/条件不匹配不通过。
- 配置测试使用本地假凭据与 fake fetch，不是实际模型调用。状态变化测试直接写入受控数据库或临时工作区，不是 Owner 真实群决策。Compose 使用 YAML 解析检查显式 opt-in 和三份只读文件挂载，未做真实 Compose 合并或部署。
- Docker 只读 ps 首次授权审查超时未启动；一次重试成功，原 openmausbot-collaboration-pilot Up 2 days healthy，历史退出容器保留。无运行配置、凭据或身份变更；未停止/重建容器。真实模型配置已向用户异步询问，但尚无获确认配置，不读取其他功能凭据。
- Goal 仍 active：真实授权配置/语义效果/六类群聊、长文档在线读取、独立复核依赖上下文与补测试、跨进程映射竞争等仍未完成。20 工具轮后只跟进已运行的最终验证、状态记录及本地提交。


## 2026-09-05 有来源的自动验收映射（最新）

- 最终 `pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-acceptance-mapping-typecheck && git diff --check`：65 文件 / 433 项通过，22:26:25 开始、43.49 秒，8560 exit 0；全仓类型检查、服务端编译和补丁检查通过。
- 先行映射与来源模块缺失导致测试无法导入；初版 ledger 夹具使用不存在 database 属性导致 5 项失败，改用真实 DatabaseSync 后通过。候选接入测试先复现 reporter 强制静态契约导致失败，动态采集/映射接通后针对性 31 项及 typecheck 通过（95003）。
- 第一次整组 431 passed / 2 failed（25564）：参数属性不兼容 Node strip-only 直接启动，以及旧 schema 17 断言未更新。显式类属性和 schema 18 断言修正后，上述最终整组全部通过，不把初次失败视为验收成功。一次补丁因 runtime import 上下文不符而整体未应用，核对后重试成功。
- 覆盖：固定 Git blob 不受工作区改写影响；拒绝 symlink/缺失/超限/非字面命令；双阶段来源引文、过时 request/proposal、独立上下文、三次持久预算、模型忽略取消超时、并发认领/晚到结果、策略身份变化；候选复核生成局部绑定后仍检查自测和独立断言。持久收据不可变，升级旧 dispatch schema 后保留原记录。
- 映射模型和候选执行结果均使用明确的受控测试端口；Git 来源是真实临时仓库。没有真实语义模型准确率或 Docker 新链路证明。未运行本批全仓 pnpm test、未部署 schema 18、未调用真实凭据/模型/钉钉/在线文档。
- 后续必验：headless 显式模型配置、从持久映射收据验证最终完成记录、映射等待期间 Owner/Spec/候选漂移、跨进程竞争、缺失测试自动补充及依赖源码语义核对、六类真实群聊场景。Goal 保持 active；20 工具轮后只完成最终验证、记录和本地提交。


## 2026-09-05 Node test 报告器与真实 Docker smoke（最新）

- 最终 `pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-node-reporter-typecheck && git diff --check` 全链通过，82423 exit 0。主 Vitest 256 文件通过 / 1 文件跳过，2415 项通过 / 18 项跳过（2433，总数门禁通过），21:56:38 开始、236.44 秒。broker 7 项、Electron 独立套件 32 项、打包服务无 node_modules 启动和 9 个代理路径检查均通过；类型检查、服务端编译及补丁检查通过。平台跳过项不是跨平台验收通过。
- 前一轮相关回归 63 文件 / 421 项、类型检查和服务端编译通过（85172 exit 0）。后补“未 attestation reporter 的 runner 不通过”用例，在最终全仓 candidate-verification 20 项中通过。报告器自身 6 项、headless 9 项通过。
- 真实 Docker smoke：固定已缓存镜像 sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e，context colima-openmausbot-pilot，`operations/node-test-reporter.smoke.ts` exit 0。真实读取候选文件：passed→passed、failed→missing、skipped→missing；普通 stdout 伪报告未进入证据，测试中改写只读报告器被拒绝。通过 runTargetTests 完整收集和 containment 校验，不是 FakeDocker 参数断言。
- smoke 仅生成自有临时数据、随机测试证明密钥与 3 个一次性无网络/非 root 容器；成功后清理。随后只读 ps 核对原 openmausbot-collaboration-pilot 仍 healthy、未出现本次测试容器，历史退出容器保留。不拉取镜像、不更新运行服务、不调用真实模型或钉钉、不读取用户凭据。
- 先行失败：新增 reporter 测试因模块尚未实现而无法导入；实现后 6 项通过。检索曾使用不存在文件或无匹配 shell glob，属于定位错误，不作产品失败证据。最终无未解决测试失败。
- 不证明：自动 Spec-to-case 生成/独立语义核对、抵御同 UID 恶意测试的父进程/旁路干扰、完整 Linux cgroup/主机重启恢复、真实在线文档、复杂解析镜像、真实模型自然群聊和六类试点。当前 reporter 和断言配置没有部署到服务。Goal 保持 active。


## 2026-09-05 断言级业务验收（最新）

- 最终命令：`pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-assertion-acceptance-typecheck && git diff --check`。62 文件 / 414 项通过，21:43:16 开始、41.01 秒；句柄 73209 exit 0，类型检查、服务端编译及补丁检查全部通过。
- 前一轮 62 文件 / 413 项及全链检查通过（93760）；最后新增回归先复现其他失败命令被局部通过忽略（1 failed / 8 passed），修复后由上述 414 项覆盖。针对性 55 项及类型检查也已通过（75035）。
- 覆盖条件变动、缺少/失败/跳过/重复/无关断言、过期 run/nonce、超长/带指令报告、仅命令成功、旧 v1/裸 v2 review、自测缺证据、其他命令/未绑定断言失败。真实本地 Node 用例读取固定候选 value.txt 并断言 after，隔离证明仍为夹具，不是 Linux 实测。
- 失败记录：初始红测确认旧命令名匹配误通过；两次开发自测夹具试图 UPDATE 不可变证据而失败，修正为首次 INSERT，保留不可变约束。没有删除断言或降低门禁以换取通过。
- 未验证：本批全仓 pnpm test、真实 Docker 的报告变量传递、独立 headless 配置边界专测、可信 reporter/自动需求用例映射及语义核对、真实模型/在线文档/六类群聊场景。未更新容器、群消息或凭据。政策 review 合成夹具不作执行证明。


## 2026-09-05 已发送选项与迟到失败（最新）

- 先行失败：取消/新计划之后旧失败通知两项均失败，修复后调度 19 项及类型检查通过。序号选择先复现仍调用模型且无法关联原消息；实现带真实送达收据的双消息关联后通过。
- 先行时序测试复现回答先于发送完成却被错误关联；记录实际完成时间后通过。追加后续提问保护先失败；加入发送顺序判断后，成功夹具暴露还在投影另一任务并发送新提问。停止重复尝试并重审场景：成功夹具先处理完早期需求提问，并新增断言证明待选择卡确实是最后的已发送问题；保留真正 intervening_question 拒绝断言，不削弱保护。
- 初次完整回归 397 项通过（52908），加入后续提问保护后的整组有 397 passed / 1 failed（25138），不能算最终通过。修正上述夹具后，3 文件 / 38 项及 typecheck 通过（68406）。
- 最终 `pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-displayed-choice-typecheck && git diff --check`：61 文件 / 398 项通过，39.25 秒（21:10:18 开始），句柄 12190 exit 0。
- 验证覆盖实际顺序来源、不可变收据、排序变化、重启、原需求不丢、双投影、重放幂等，以及未发送/业务拒绝/跨人跨群/过期/多提示/取消/越界/发送延迟/后续机器人提问。均为本地受控传输和模型夹具，不是钉钉真实自然协作验收。
- 未运行本批全仓 pnpm test；未部署 schema 17、未配置真实模型或在线文档。机器人出站引用、人工中间提问的歧义及标题/新问题选择回填仍待覆盖。早期通配符检索因无匹配报错，随后用 rg --files 定位，不是产品测试失败。


## 2026-09-05 执行准备异常恢复（最新）

- 先行失败：旧实例中断无通知、准备失败无持久结果；补齐后 12 项调度测试及类型检查通过。随后覆盖 Owner 重试跨重启、重复事件、三次上限、运行中不重分类、旧 fence 拒绝、schema 15 升级保留 dispatch，4 文件 / 25 项通过。
- 取消通知测试先复现已取消任务被写入中断结果，过滤后修复。清理错误两项测试先复现普通 Error 和可重试 failed；添加独立 CommandCleanupError 与不可重试 unsettled 后修复。运行真实短命子进程的清理测试仅模拟负 pid 检查失败，不访问真实凭据或服务。
- 最终 `pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts`：61 文件 / 385 项通过，38.59 秒（20:47:45 开始）；随后 `pnpm typecheck`、服务端构建到 `/tmp/openmausbot-preparation-recovery-typecheck` 和 `git diff --check` 全通过，句柄 23747 exit 0。
- 首次整组执行 cell 230 为授权审查超时，未创建测试进程；一次获准重试成功，不是功能测试失败。早期 sed 路径不存在及 zsh 无匹配 glob 为检索错误，不是产品证据。
- 仍未验证：准备期间取消/换计划后通用错误通知竞态、残留隔离环境的安全解除协议、真实主机重启/容器更新、全仓 pnpm test 和六类真实群聊试点。不能将受控夹具当线上闭环。


## 2026-09-05 排队未启动任务恢复（最新）

- 新增测试先复现启动漏任务、暂停队头、准备前失败重试；9 项调度测试与类型检查通过后，追加真实 Owner 暂停/恢复及未投影贡献的互斥场景。夹具起初断言了不存在的 status 字段，修正为 allowed/reason 后，真实复现 Owner-resumed task was lost；按完整控制版本链修复。
- 最终命令：`pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-execution-recovery-typecheck && git diff --check`，句柄 16301 exit 0，全链成功。只使用本地夹具；HTTP 测试获准绑定回环地址，不连接真实模型/群。
- 准备错误持久预留一次，重复 drain/重启均不增加，未启动 Agent/run；不可变删除被拒绝。重启恢复排队兄弟任务而不重试中断任务、禁用/probe/低磁盘、Owner 控制版本链均有自动化覆盖。
- 未验证：真实容器更新、主机重启、六类群聊试点、schema 14 升级专门夹具、别名并发压力、预留后崩溃的 Owner 恢复通知。未运行本批全仓 pnpm test，不扩大本次结论。


## 2026-09-05 文档解析源码批次（最新）

- 最终补强：表格来源缺少行/单元格、文本框段落重复两项先行测试失败；补齐位置和段落去重后，本地 Python 12 项全部通过（0.122 秒），pnpm typecheck 和 diff 检查通过，句柄 51683 exit 0。前一轮 TypeScript 2 文件 / 17 项相关回归也通过，句柄 82378 exit 0；命令中 packaging 模板测试不属于当前 Vitest 收集范围，未计入已通过项。

- 只读 Docker 状态：openmausbot-collaboration-pilot Up 47 hours healthy，其余历史容器退出；未变更现有容器。缓存 node:24-bookworm-slim 固定 ID ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e、arm64；没有已拉取的 Python 镜像。
- PyPI 查询获得 4 个实际 wheel 的版本和 SHA256，require-hashes 安装成功：defusedxml 0.7.1、et_xmlfile 2.0.0、openpyxl 3.1.5、pypdf 6.17.0。安装仅限临时 venv，不改系统环境。
- 先行 Python 9 项中 1 项失败：Word fldSimple 没有 unread_revision_or_field 警告。加入 fldSimple/fldChar 后，新增外链与 CLI 错误边界，总计 11 项全部通过（0.120 秒）。PDF indirect resources 测试已通过，无需推测修补其实现。
- 非测试阻碍：docker pull python:3.13-slim（59971）DNS 超时；docker manifest inspect（69940）HTTP 超时；公开 GitHub 运行时元数据请求（85602）fetch failed。均终止，无需轮询或无条件重启。检查缓存容器 Python 的命令因授权超时未启动，不能推断运行时有无 Python。
- 临时 venv 首次执行授权超时未启动，获准重试后成功（39612）；不是访问真实附件。没有真实 Docker 构建、容器 Python 测试、headless 复杂文档启用或六类群聊试点证据。

## 2026-09-05 账本完整性与正文解释批次（最新）

- 上批 listen EPERM 已通过获准的 loopback 夹具复测：natural-intake-model 9 项通过，不连接真实模型服务。
- 先行测试：补齐 sender 夹具后 6 failed / 1 passed，复现根级标志丢失、长片段/片段数/事实容量遗漏、未支持附件被清门禁和伪造投影被接受。正文续办测试先复现读取前调用模型两次，修复后通过。
- 19:13:51 的协作/钉钉/headless 回归：61 文件 / 369 项全部通过（33.86 秒），句柄 64510 exit 0；后续 pnpm typecheck、服务端编译到 /tmp/openmausbot-attachment-completeness-typecheck、git diff --check 全部通过。
- 指纹竞态夹具初次违反账本 CHECK（已投影附件不可直接改 failed）；改用 AttachmentStore 合法追加附件且不改 Spec，证明旧模型结果被拒绝。19:15:15 开始的完整性 11 项、全仓类型检查、diff 检查通过，句柄 68619 exit 0。
- 随后尝试再次启动整组回归时授权审查超时（cell 175），命令未启动，没有待轮询进程；不将其记为测试失败或通过。广泛回归与补充验证是两次独立证据。
- 上批未提交的异步提取/固定镜像 Docker 命令适配器与 EPIPE 修复已被本批相关回归覆盖；真实 Python 镜像无运行证据，草稿不提交。Fake Docker 参数检查不是 Linux 隔离实测。
- 未跑本批全仓 pnpm test，未部署容器或发送群消息，未配置/调用真实自然模型。Goal 仍需最终完整回归、长文档覆盖及六类真实试点。

## 2026-09-05 隔离文档接口批次

- 最终相关回归（document-extractor、attachment-ingestion、docker-containment）、全仓 pnpm typecheck、服务端编译到 /tmp/openmausbot-document-port-typecheck 和 git diff --check 全部成功；句柄 89349 exit 0。广泛回归的 EPERM 仍未解决，未提交。

- 测试先行：异步调用/自有名称清理两项先失败，修复后 13 项通过。随后复现配置解析器错误归因和真实子进程未捕获 EPIPE；完成修复后广泛回归中对应测试通过。
- 协作/钉钉/headless 回归（19:02:40，33.23 秒，句柄 51351 已结束）：59 文件通过 / 1 失败，358 项通过 / 1 失败。唯一失败为 natural-intake-model 实际 HTTP 测试 listen EPERM 127.0.0.1；该链后续类型检查未运行。不自动提交，不将环境失败视为通过。
- pypdf 公开版本请求先错误 URL 返回 404，正确 URL 的授权审查又两次超时；无依赖版本查询结果、无 Python 镜像或文档解析真实试验。隔离参数测试使用 Fake Docker，EPIPE 测试使用真实本地 Node 子进程；均不是 Docker 运行验证。
- 先前 2344 项完整回归属于上一提交，不覆盖本批变更。未变更凭据/身份，未访问群或更换运行容器。

## 2026-09-05 测试子进程隔离修复

- 仅修改 HTTP 测试启动环境，明确保留 VITEST 标识、禁止本机模型自动探测；原测试超时和全部断言保持不变。
- `pnpm vitest run server/index.test.ts && pnpm typecheck` 成功：88 项全部通过（56.13 秒），此前的三个超时和一个导入命名失败均未出现。
- 原子进程环境同时缺失本机模型与登录 shell PATH 的测试保护；补标识后的对照证明测试隔离修复有效，但未测量两条探测路径分别贡献的时间，不能精确归因到其中一条。
- 正式完整验证 `pnpm test && pnpm typecheck && git diff --check` 全部成功，句柄 `55000` exit 0。主 Vitest：252 文件通过 / 1 跳过，2344 项通过 / 18 跳过，2362 项注册，数量下限 1070 检查通过；耗时 397.76 秒。
- 后续 broker 7 项通过；Electron updater 15、desktop-viewer 5、package-link 2、save-file 10 项通过。服务端构建成功，复制到仓库外后无 node_modules 的服务成功启动，9 个代理路径均可解析。最后全仓类型检查及 diff 检查通过。
- 之前 4 个失败已在默认项目测试链中消除；18 个跳过项仍为跳过，不计为通过。不覆盖独立 control-plane/CUA 平台专项或真实 Docker/钉钉六类试点，不能以默认测试链成功替代这些验收。

## 2026-09-05 有来源的人员定向批次

- 协作/钉钉/headless 59 文件 / 351 项通过（18:08:44 开始，33.49 秒），全仓类型检查、服务端编译和补丁检查通过。之后补强跨企业相同 staff 字符串歧义及真实卡片到 Markdown 的验证：27 项定向测试和类型检查通过。
- 覆盖：原提出人定向、模型提供专业发言来源、同事项原文核对、伪造人员/引文/群外来源拒绝、无可靠身份降级为角色提示、重启后的人员关联保留、Owner 不变、逐问题 @ 和通知 ID、无问题通知不额外追问。
- 失败及恢复：第一次测试夹具补丁上下文不匹配，未造成部分修改；测试先行复现误用 @、来源人员丢失等失败，完成实现后通过。旧 reserved-question 测试已补齐新增字段并断言具体门禁错误，避免因 schema 不完整假通过。
- 全仓 `pnpm vitest run` 已结束（18:11:43 开始，620.82 秒）：251 文件通过 / 1 失败 / 1 跳过；2340 项通过 / 4 失败 / 18 跳过。`server/index.test.ts` 三项 20 秒超时，另有 additive-only 导入命名期待 Mira 2 实际 Mira 4。不得据此声称全仓通过或自动提交。
- Chief 任命案例单独复现：当前工作区 20 秒超时；独立 HEAD 基线 worktree `/tmp/openmausbot-directed-review-baseline` 同样超时（18:21:57 开始，28.65 秒）。基线不含本次人员定向修改，确认该例为既有测试/环境问题，其他失败未作相同基线证明。
- `13713`、`84138`、`77991` 均已结束。最初受限 `ps` 被拒绝，后续获准的只读进程/端口检查确认测试服务存活，保留原进程直到完成。没有因观察超时重启全仓运行。
- 优先验证假设：显式 HTTP 测试子进程环境未传 VITEST，可能未跳过本机模型探测；下一步验证后修复隔离，不扩大超时或删断言。全仓 Vitest 失败后的串联类型检查/编译未执行，之前的独立通过记录不变。`pnpm test` 中其他 broker/Electron/打包套件尚未全跑。
- 未连接真实模型、未发送真实钉钉消息、未更新试点容器。

## 2026-09-05 异常收束与重启通知批次

- 最终：协作/钉钉/headless 回归 59 文件 / 345 项通过（18:01:59 开始，33.29 秒）；`pnpm typecheck`、服务端编译到 `/tmp/openmausbot-projection-recovery-typecheck` 和 `git diff --check` 均通过。
- 新增四项回归：投影连续失败跨重启最多三次且通知一次；投影恢复不重复模型归并和贡献；活租约不抢占/最后一次崩溃租约过期后停止；需求解释最后一次认领崩溃后恢复通知且不重复发送。
- 先行测试：2 failed / 19 passed，证明无限投影重试及崩溃后通知遗漏。首次修复后 1 failed / 20 passed，暴露通用计划卡丢弃摘要；修正后完整回归通过。测试启动曾遇权限审查超时，重试成功；无未解决的测试失败。
- Docker 仅做元数据检查：试点运行，模型 enabled/endpoint/model/credential-file 配置均为 false。未读取凭据内容、未部署、未发送群消息，不能作为真实自然协作验收。
- 不覆盖：真实模型效果、完整文档解析、人员定向、业务断言证据和六类实际群聊试点。通知入 Outbox 不等于钉钉真实送达；现有 sender/session 链路仍须真实验证。

## 2026-09-05 真实模型适配与自然归并批次

- 最终：协作/钉钉/headless 回归 59 文件 / 341 项通过；`pnpm typecheck` 通过；`pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-semantic-routing-typecheck` 通过；补丁格式检查通过。
- 真实 HTTP 传输：使用实际 fetch 调用 127.0.0.1 非生产测试服务，验证固定模型和 endpoint、Bearer 头、无工具、JSON 输出要求及返回解析。没有连接收费模型或钉钉。
- 安全/异常：未知控制字段、群外真实事项、过期目标版本的写入门禁、拒绝/未完成/工具调用输出、响应体大小限制、取消、凭据缺失及错误正文不回显。
- 自然归并：无 WI/无回复元数据的普通回答关联、自然新问题创建、关键词不抢先归并、原贡献入账、重放幂等、队列重启和忙碌群的有界近期窗口通过。模型回复使用受控夹具，不代表真实语义准确率通过。
- 失败及恢复：测试先行时模型模块不存在、自然归并三例失败，完成实现后通过；本机 TCP 监听在沙箱内报 EPERM，未删测试，获准仅为本地测试放开端口后回归通过。
- 最后复查新增后台 Spec 漂移回归，先复现旧归并判断错误生效；加入事务内 snapshotRevision 校验后通过最终回归。
- 未验收：真实模型配置/调用、真实多人群聊、角色到身份映射、机器人出站引用、序号选择来源、复杂文档、完整业务证据链及新版本 Docker 六类场景。普通序号指代当前明确留在澄清。
- 按 goal-protocol 本批最多 20 工具轮收束；Goal 保持 active，不把局部通过说成目标完成。

## 2026-09-05 自然需求解释机制批次

- 最终：协作/钉钉/headless 回归 57 文件 / 323 项通过；`pnpm typecheck` 通过；独立服务端编译检查通过；`git diff --check` 通过。
- 新增测试覆盖：普通确认与验收表达、上下文追问、重放原始来源、重启待处理恢复、过期认领恢复、关闭取消模型等待、并发 Spec 漂移、后台证据变化后的重新解释、三次失败回复、不可伪造控制字段/来源和未读附件门禁。
- 模型回复来自测试夹具；无工具模型端口及请求构造器已实现，真实模型适配器和 headless 装配尚未实现。以上结果不能证明真实模型自然理解、完整角色定向或六类群聊试点通过。
- 失败记录及恢复：测试先行缺少模块而失败；随后发现密码相关业务句被脱敏误伤，新增复现后修复；全回归发现 Node strip-only 不支持参数属性，已改为显式属性并通过真实 headless 子进程测试。
- 未运行：全仓所有测试套件、真实模型、真实群消息和新版本 Docker。容器仍保持旧版本，未改凭据、Owner 或生产配置。
- 本批按 goal-protocol 20 工具轮收束，完整目标保持 active；下一步按 PROGRESS 的接续入口继续。

## 2026-09-05 新 Goal：连接可靠性批次

- 测试先行：新增四项回归在旧实现失败（4 failed / 17 passed），修复后定向 21 项通过。
- 覆盖：注册未完成不能报已连接；维护轮询不能反复断开；30 秒注册超时恢复；失败退避；停止与在途重连竞争；初次连接延迟后 intake/outbox 恢复。
- 最终协作/钉钉回归：`pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts`，56 文件 / 311 项通过（16:46:51 开始，33.70 秒）。新增第五项覆盖 SDK 吞错、指数退避上限和并发重连合并。
- 最终全仓 `pnpm typecheck` 通过；服务端 `pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-goal-server-typecheck` 通过；`git diff --check` 通过。
- 失败及恢复：最初全仓类型检查报 React 声明不可用；发现 `node_modules/@types` 指向临时依赖目录，修复 React/react-dom 到现有包的链接。随后暴露并修复测试回调返回类型、联合类型收窄、只读夹具类型及本批 Stream 状态字面量类型。保留原断言，最终通过。
- 离线依赖安装未执行：pnpm 无 TTY 中止重建 modules，未强制清除本地依赖。
- 六类真实试点均待按新 Goal 验收。本批尚未发布 Docker，不代表用户群内效果已经改变。
- 下方均为历史验证记录，不能替代新目标验收。
- 收束：goal-protocol 的 20 轮工具预算到限，保存已完成/待完成/失败及恢复入口；Goal 仍 active。未运行全仓所有测试套件、未运行真实凭据 smoke、未验证新版本 Docker。

## 受信任验证命令

```bash
pnpm vitest run server/collaboration server/integrations/dingtalk server/collaboration-headless.test.ts
pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-server-typecheck
git diff --check
```

## 基线结果

- 协作与钉钉回归：通过，43 个测试文件、186 项测试。
- 服务端 TypeScript 构建：通过。
- 补丁格式检查：通过。
- 全仓 `pnpm typecheck`：仍受既有前端 React 类型依赖缺失阻塞；本批次使用的服务端严格构建已通过。
- Docker 服务：健康。
- 钉钉 Stream：已连接。
- 最新低风险真实任务：已自动完成并成功发送通俗结果。

## 当前批次验证

- 协作与钉钉回归：通过，56 个测试文件、306 项测试。
- 服务端 TypeScript 构建：通过。
- 补丁格式检查：通过。

## 本轮结果

- 结构化 Spec 和关键疑问门禁：通过。
- Execution 自测、独立 Verifier 和 Meta 验收分离：通过。
- 最新成对复核、候选漂移和 Spec 漂移拦截：通过。
- 同一验证失败三次停止；验证契约变化后重新获得独立预算：通过。
- 钉钉文本审批与重试幂等：通过。
- 同仓库写入串行、不同仓库并发、失败后释放队列：通过。
- 每个 Work Item 的不可变状态包、完整性校验和失败降级：通过。
- 用户需求中的常见中英文凭据、JWT、授权头和 URL 查询令牌脱敏：通过。
- 复杂文档/表格正文解析：DOCX、XLSX、PDF 和私有在线文档尚未接入，不能宣称已通过。
- 自然群聊归并和标题化归属澄清：通过。
- 钉钉直接上传 TXT/Markdown/CSV 的安全下载、加密能力隔离、脱敏提取、来源证据和恢复：自动化通过。
- 附件正文中的“确认目标、切换仓库、执行命令”等内容不改变控制面：通过。
- 澄清问题最多 3 个，并可定向提醒稳定身份：通过。
- DOCX、XLSX、PDF 与私有在线文档：尚未接入，不能宣称通过。
- 当前 Docker 试点容器：重建通过，healthy。
- 当前数据库迁移：schema 11 / migrations 11，通过。
- 当前真实钉钉 Stream：connected，执行模式 execute。
- 真实群附件消息：尚待发送，因此不能宣称线上附件闭环完成。
- 本次只替换了 `openmausbot-collaboration-pilot`；其他容器未删除或重建。
- 已保留上一版本回滚镜像。
- 历史 Work Item 状态包恢复：通过，启动后生成 5 个 CURRENT 指针。
- 回滚镜像：已保留并验证可用。
- 本批独立安全审查：附件投影并发 High 已通过数据库原子认领和 Spec 投影幂等门禁关闭；复核未发现新的 Critical / High。
