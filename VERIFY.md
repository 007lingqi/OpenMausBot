# Meta 协作验证记录

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
