# Meta 协作实施进度

## 当前检查点：Provider 修复与分段完整验证通过，原失败事项仍受恢复门禁保护（2026-09-07）

- 72060/d45bb6 已终态 exit2：主集287文件、3184通过/18跳过，broker及桌面测试通过；仅新增 smoke fixture 缺 containmentBinding 阻断打包。补合成 binding 后，79246/82a922 的 typecheck、真实Linux清理、完整 test:packaged-server 和 diff 全部 exit0；62888/b5e184 的20项定向测试再通过。验证分两段完成，不称原 pnpm test 命令 exit0；业务源码/单测从72060启动起未变，只修夹具类型。
- stdin提前关闭现以静态错误结束该Provider，不再因未处理EPIPE崩溃共享进程；即使CLI exit0及合法输出也拒绝不完整输入。清理由同一受限UID执行，保持原cap/drop、无网络及/tmp noexec；外部软链接目标不变。正式烟测入口为 scripts/smoke-docker-provider-cleanup.mjs，旧/private/tmp微探测不再使用。
- 15ec31只读核查原合成事项：session a88ac867-8f1f-4329-bcd9-6406c91debf9 的attempt1、command1、finalization intent count1均保留，但proof/settlement均为空。不能凭原容器Exited直接释放占用或伪造凭据，原事项不做自动执行重试。可在原证据根登记一次只读Provider复查，以原任务/工作树验证建议，不应用代码、不修改账本、不称引擎恢复。
- 原真实群服务仍使用def5f17、healthy；其他旧容器仍Exited，未删除。真实六场景、在线文档/表格、解析镜像、独立supervisor、VM/宿主恢复和Owner最终验收未完成。Goal active。先保存本批验证通过的修复，再进行有界只读复查；不push，不提交用户AGENTS.md或outputs。

## 当前检查点：真实引擎复现执行阻塞，修复尚未完成（2026-09-07）

- 上轮为部署/恢复progress；本轮也是实际诊断及TDD进展。原群仍12事件/49Outbox/Owner1，新群消息未到；原def5f17服务未再次切换。Goal active，不宣称完成。
- 真实引擎合成入站探测30944/395b10已exit1：Astra/medium自然理解applied，Spec ready_for_execution并启动run，随后needs_configuration/provider_sandbox_unavailable。合成事项WI-EA2FD321158E、VM证据根/var/lib/openmausbot-engine-probe-188ebd46-1b0b-4f6d-8887-1969df34dffd；合成Owner/出站与真实群分离。命名容器omb-engine-probe-188ebd46-1b0b-4f6d-8887-1969df34dffd已Exited1/Pid0/无OOM，保留证据和固定镜像，不能重跑随机根driver刷新预算。
- 1ec1a4/4cc0f7证明两因：真实Provider output.json为needs_configuration，因为它将项目AGENTS要求候选前测试误用于只读建议阶段；其次codex-home由10001拥有/0700，cap-drop root访问EACCES，finally清理错误覆盖了该业务理由。没有扩大Provider权限。
- 已补角色分工提示及provider-home-cleanup源码/4项测试：固定清理代码在Provider身份下清空私有状态，不跟随链接、不chmod文件、不删除顶层；Supervisor再回收受保护父目录下的空顶层。27287/2b4bd3为先行红灯，48807/7cec7a的18项本地测试/typecheck/diff通过，但不覆盖随后顶层chown调整。当前4个代码/测试文件未提交，PROGRESS/VERIFY随此记录变更；用户AGENTS.md/outputs不动。
- 真实Linux清理微探测尚未绿色：72bf7c EACCES；b7bb9c发现夹具umask导致fake CLI不可执行；显式chmod夹具后3170f9出现未处理stdin EPIPE，因fake CLI不消费prompt便退出。下一步先修夹具读取stdin，再验证同cap-drop/setpriv的清理；同时为生产runProcess的stdin提前关闭补隔离子进程回归，不能让EPIPE崩溃主进程。临时撤去的顶层chown已恢复，最终源码还需重新验证。
- 文档镜像仍受阻：宿主system/DirectoryServices可解析，host超时；已存在7897代理的进程级TLS请求及docker manifest仍失败。未改系统DNS/Clash/代理或凭据，不再重复拉取，不改为宿主解析真实附件。network技能是绘图工具，不适用；只采用clash-dns-diagnose的只读诊断部分。
- 恢复入口：/private/tmp/openmausbot-provider-cleanup-smoke.ts为清理微探测；/private/tmp/openmausbot-engine-probe-def5f17.ts及run-engine-probe driver为已消费的一次性引擎探测，后续需保留同一合成事项失败后有界复测，不新建账本清零。所有句柄终态，无运行中测试/模型；未运行当前全仓回归，不自动commit。真实六群场景、文档接入、独立supervisor、VM/宿主重启和Owner最终验收全部保留。

## 当前检查点：新版本已切换唯一 Docker 试点，等待真实群验收（2026-09-07）

- 本任务25文件已本地提交def5f17，无push，用户AGENTS.md/outputs未动。9754/d9a563完整回归和授权第4次固定候选映射均终态通过，不再运行旧恢复脚本或重置预算；原生Goal active，未完成。
- 7927ce离线构建新镜像sha256:70087328c7590f1775d64fcde3706e4b52b865cc019688d11042c00024d92bdb（opencodex-def5f17），原local及旧镜像保留。唯一context为colima-openmausbot-pilot。
- b9517c在旧账本隔离副本完成schema11→30、完整性/外键和五张历史表原字段逐值保留；初次比较把新增delivery_sequence列也计入哈希而误报差异，7f3daf已证明原字段不变，随后按原列重验通过。新VM仓库repository-release-readiness-def5f17在codex/pilot-def5f17分支，固定base0837a3fc6f02be0c6b067f63749f19d8d7104154；三文件补丁在旧基线上先check再应用，六项业务/源码测试在隔离Docker通过。旧仓库不改。
- 5d7cae切换成功：只停止/重建openmausbot-collaboration-pilot，先保存一致性offline-data及原环境/unit；systemd drop-in改用固定三份Compose配置，显式唯一service，不使用down或remove-orphans。四角色Astra/medium、reporter及TSX只读上下文已配置，保留业务凭据/Owner，仅移除旧模型auth挂载，不删除文件。其他旧容器保持Exited。
- 01b958/b9b458：真实systemd进程重启恢复后schema30、owners1、liveLease1、mode ready、integrity ok，原12事件/49 Outbox未增加，镜像固定且容器healthy/restarts0，service enabled/active。cfacef在异步启动瞬间检查lease读到0；未再次重启，等待同次启动完成后复查通过。不是VM/宿主重启或独立supervisor验收。
- 真实Stream接收/注册尚待新群事件证明：启动日志曾reconnecting，进程有已建立443连接；独立--health只检查配置并返回configured，不能据此称实时Stream connected。没有发送或伪造群消息、没有新模型调用。
- 文档解析尚未启用：423dfd官方镜像清单EOF，be4165宿主官方registry DNS超时；无新镜像拉取/解析部署。不扩大为无隔离解析。在线钉钉文档/表格正文仍待接线及真实只读资源，不能把附件接口或本地Schema当实际已读。
- 接续：请Owner在研发_1向研发助手发送一个明确的新自然语言低风险任务，例如“新增检查项默认优先级改为P2，其他规则保持不变，并检查没有影响原有功能。”收到后核验实际关联、Spec、开发/独立复测、当前验收与真实业务回复；再补多人、文档/表格、关键澄清、高风险Owner决定等六场景。独立supervisor、VM/宿主重启及Owner本人最终确认仍保留，不能标complete。
- 恢复入口（VM）：/var/lib/openmausbot-collaboration-pilot/releases/def5f17，包含固定Compose/release.env、offline-data、original.service/env、ROLLBACK.txt及restart-verified.json。已升级账本不得用旧schema11镜像打开；观察模式回退使用同一schema30镜像并保留当前数据，旧快照仅离线复查，不能丢弃切换后事件。/private/tmp/openmausbot-prepare-release-def5f17.mjs及switch脚本已消费，不盲目重跑。当前无运行中测试/模型/构建句柄。

## 当前检查点：授权后的真实双阶段映射及完整回归通过（2026-09-07）

- 53533/68d4de exit0：41项db/mapping专项、主项目typecheck/diff通过后，执行唯一授权的第4次真实Astra/medium映射。proposer传输379425字节/JSON3980字节，独立verifier传输173688字节/JSON1644字节，三项finding均covered；readApprovedAcceptanceMapping重算通过，所有绑定断言都在developer/verifier两套原Docker报告中passed，原3次记录逐行不变。原DNS/流式截断阻碍已在本次限定场景解除，不再重复索要相同授权。
- /private/tmp/omb-tsx-acceptance-HM5xui/owner-authorized-recovery-4.json为独占写入授权证据，retry-evidence-4.json为本次结果；原ledger在同路径加v30恢复表，三次旧表记录仍保留。授权已消耗，不重跑/private/tmp/openmausbot-tsx-authorized-recovery.mjs。53533已终态，不再轮询。
- 9754/d9a563已exit0：完整pnpm test && pnpm typecheck && git diff --check通过，主集3178 passed / 18 skipped（3196登记）、286文件通过/1跳过，broker、桌面及普通/headless打包启动退出通过。受测业务代码/测试固定，包含v30一次性恢复；没有运行中测试/模型句柄，不再轮询或重复启动。保存25个本任务文件，用户AGENTS.md/outputs不动、不push。
- 真实固定候选映射不等于真实群六场景或生产完成。原群容器仍未切换、原群账本未迁移v30。下一步取得9754终态并提交，再更新/private/tmp/openmausbot-build-opencodex-pilot.mjs的固定新版本标签（当前仍硬编码f294357，不能原样运行）、在回归打包完成后重建独立镜像；准备业务测试策略、旧账本备份和schema匹配回滚、systemd overlay后才切换唯一非生产服务。
- 本轮get_goal已确认原生目标active；以下历史blocked记录不再代表当前状态。完整目标未完成，后续文档正文/六真实场景/独立supervisor/VM和主机恢复/Owner最终签字全部保留。

## 最新授权接续：仅恢复一次固定候选验收（2026-09-07）

- Owner在本任务回复“授权相关权限处理”，承接上条额外一次完整验收申请；按相同候选/Spec/policy、保留三次失败、仅第4次解释，不扩展为生产部署、身份/凭据或无限重试。首次get_goal仍显示blocked；现已按新授权执行，不能据旧状态重复索要同一授权，也不调用不支持的active状态更新。
- f05d56九项TDD红灯后新增受信任本机第四参数ownerAuthorizedRecovery；逐字段验证requestHash/policy/afterAttempt3/referenceHash，不接收群消息字段或环境开关。调用者必须先确认Owner并保存referenceHash对应授权证据；摘要本身不是鉴权token。恢复授权和第4次占位在任何模型调用前写入，取消/崩溃不退款，第5次拒绝，成功重放只读旧收据。
- 87955/8ee40e暴露旧表CHECK attempt<=3；未放宽或重建旧表，新增v30独立recovery attempts/results表及只读合并视图，原3次不改，恢复表仅允许attempt4、引用原attempt3并不可更新/删除。408d13核心29项通过。79474/de4bcf十文件220项通过/1失败，唯一是旧迁移计数期望29，已随v30精确更新；旧schema模拟夹具只清理新增表/视图、保留原历史验收断言。
- 53533顺序执行db/mapping定向、typecheck、diff，全部通过才运行/private/tmp/openmausbot-tsx-authorized-recovery.mjs。该一次性入口只作用于原独立候选ledger：独占创建owner-authorized-recovery-4.json，并把其SHA256写入恢复记录；原三次逐行不变、完整收据重算及两套原Docker断言匹配均必须验证。不得重复运行；真实终态以该句柄为准。
- 当前新增v30未迁移原群服务，7f6c85只读确认指定context原试点healthy；未停止其他容器、未增Owner/Stream。后续仍须当前完整回归、真实恢复结果、候选镜像和原账本备份/回滚准备后再切换唯一非生产服务。完整目标不变。

## 当前收束：完整回归通过，真实验收等待Owner额外尝试授权（2026-09-07）

- 上轮progress（定位DNS故障并启动全量），本轮接续取得53609/7b7a64终态exit0，未重新启动。完整pnpm test、pnpm typecheck、git diff --check通过；主集286文件通过/1跳过、3168项通过/18跳过（3186登记），后续broker、桌面、普通和headless打包运行/退出检查通过。业务源码与测试在全量期间固定。此前关于53609运行中的描述已失效，所有执行句柄均终态，不再轮询。
- 真实映射仍只到第三次proposer成功，verifier因宿主DNS超时失败；DNS/HTTPS后续恢复不是模型成功证据。未发第四次、未改变候选/Spec/policy/账本或安装配置，无部署或新的Stream。当前16个本任务文件保留未提交；按仓库规则，真实验收仍失败时不自动提交，用户AGENTS.md/outputs不动。
- 额外尝试授权尚未收到；自动Goal续跑不是Owner批准例外。第三次失败收束、DNS诊断收束、本次全量终态收束三轮持续存在同一模型预算耗尽阻碍；安全诊断和当前完整回归已完成，下一步真实验收无法在现有授权内执行。按原生Goal规则标blocked而不是complete，实际状态以工具为准。
- 恢复入口：Owner明确允许额外一次固定候选完整验收后，再设计有审计记录的有界恢复；必须保留/private/tmp/omb-tsx-acceptance-HM5xui中的原三次不可变记录及两个Docker报告，不用删除账本/换policy/重建候选暗中刷新预算。批准前不重发。其后仍需当前镜像/原账本备份回滚和唯一非生产服务切换、真实文档/六场景、独立supervisor与VM/主机恢复、Owner本人最终验收，不能缩减原目标。

## 最新接续：502已定位为宿主上游DNS超时，完整回归正在运行（2026-09-07）

- 上轮progress，本轮诊断得到新证据；未发第四次模型请求、未改候选/policy/账本。c8035a读取宿主OpenCodex权威usage.jsonl的本次时间窗口，proposer于1788755225349开始、41418ms成功；verifier于1788755266812开始、13946ms返回502。5ab3dc确认该复核只有一次上游发送，无恢复重试；eb1078精确错误为Provider unreachable: getaddrinfo ETIMEOUT chatgpt.com。结合已安装OpenCodex错误生成源码，原因定位为宿主上游DNS解析超时，不是本地90秒验收超时、模型名/密钥缺失或Schema拒绝。未读认证配置或输出身份/令牌。
- 2035e8当前宿主10100监听存在；service.log最后修改12:05，早于本次复核，不能将旧upstream-retry行归因于当前失败。只读usage时间关联才是本次依据。
- 74169/5c17bf exit0：当前chatgpt.com能解析到公网地址，HTTPS完成DNS/TCP/TLS并返回403；仅证明当时网络连通，403不能当模型API成功，也不能证明间歇问题永久恢复。未修改DNS/代理/OpenCodex配置或重启服务。
- 53609为唯一运行中完整验证：pnpm test && pnpm typecheck && git diff --check；最后9f5634仍返回运行中与通过项（包含candidate-verification、runtime-verification-retry、backup、index等），尚无完整终态。functions cell512已结束，不再wait它；下一轮直接write_stdin 53609，不重复启动。保持业务源码/测试固定；本轮仅更新说明。
- 原三次预算继续耗尽，完整验收仍失败；后续真实模型恢复须Owner明确授权，保留原三次记录和固定候选，不通过改policy/清空账本变相重试。原群服务不切换；Goal active，真实文档/六场景/隔离与恢复/人工验收均保留。
- 本批20工具轮收束；查询74169已终态，只有53609测试仍在运行，无模型调用在途。询问Owner是否允许保留历史后额外一次完整验收，目前尚无新授权；在答复前可继续接收完整回归终态，但不调用模型、不部署或自动提交仍有真实验收失败的本批代码。

## 当前检查点：流式截断已修复，第三次真实映射在独立复核返回502（2026-09-07）

- 接续88061/08c689 exit1：第二次真实映射proposer返回natural_model_output_limit，未进入内容校验。检查确认原流式适配器把逐token封装/重复快照全部计入256KiB；144c90 TDD用约10KiB正文和大于256KiB传输复现同一错误。
- opencodex-stream.ts改为传输8MiB、跨正文片段累计256KiB，超限取消；不改变固定模型/完成快照/超时/无工具或验收引用规则。新增三项测试覆盖协议开销、正文UTF-8超限取消、纯heartbeat传输上限。53615/f16ec0的120项通过，但类型检查暴露新增测试夹具联合类型错误；已补类型收窄。57129/56cfb9→d754ed链路证明120项、主项目typecheck、diff通过后才进入第三次真实请求。
- 57129/d754ed exit1：同一candidate/Spec/policy/ledger第三次映射，proposer传输386106字节、JSON正文4010字节，requestHash和全部三条精确引文/来源/条件通过；已进入独立verifier，但其请求返回natural_model_http_502，无有效复核结果。上游失败具体原因未知，不能称网络问题或验收内容不合格。证据/private/tmp/omb-tsx-acceptance-HM5xui/retry-evidence-3.json；第二次retry-evidence.json保留。
- 三次映射预算已耗尽，停止同一候选重发；不得换policy、候选或账本重置预算。后续先用已有宿主OpenCodex诊断/静态日志定位502，未获受控恢复不能做第四次请求。原群服务仍未切换，没有新Owner/Stream或其他容器操作。
- 当前16个本任务文件未提交（前批14个加stream源码/测试）；用户AGENTS.md和outputs不动。由于真实独立复核仍失败，不自动commit；上批完整回归不覆盖新增stream变更，本批仅120项及typecheck通过，不能称新版本全量绿色。全部执行句柄终态，无后台测试/模型等待。Goal active，真实文档、六群场景、独立supervisor、VM/主机恢复及Owner人工验收仍未完成。

## 前序：TSX上下文和业务测试（2026-09-07，以下为历史）

- 上轮progress，本轮progress；起始ff30773、仅用户AGENTS.md/outputs未跟踪。6e0396 TDD复现TSX/JSX被上下文入口拒绝及JSX属性/正文敏感值漏脱敏；修复quality-gate只读实现扩展名和sensitive-source JSX处理，保留固定Git对象/范围/大小/不执行约束，Node测试命令仍拒绝tsx/jsx，不能把实现文件当测试绑定。
- e25684新增试点业务用例缺helper红灯后，在app内提取页面实际使用的release-board-state.ts，保持原行为，新增tests/board-behavior.test.mjs：筛选/搜索、新增默认值/空白、状态切换/计数/不变性、空清单。无依赖/manifest变更。当前9个代码/测试/试点文件改动尚未提交，用户文件不动。
- 81232/0c3664：4文件91项及主项目typecheck/diff通过；20419前半6项原生测试通过。6031/219b2e exit0：改动页面独立严格类型检查、试点npm test（原源码断言、Vite构建、两项真实服务端渲染）通过。额外全试点tsc因原Cloudflare声明缺失报3项，31779/a916ef用HEAD原页面与当前页面的编译诊断精确比较相同；未修无关worker/db声明，不称全试点tsc绿色。
- 29787/28da38已exit0：完整pnpm test→pnpm typecheck→diff通过，包含broker/桌面/普通及headless打包；受测业务和测试在全量期间固定，中间输出截断不补造总数。此句柄终态，不再轮询。
- 59629/857ba7 exit1：/private/tmp/openmausbot-tsx-acceptance-probe.mjs复制三份明确试点文件为独立固定Git候选；两个指定context无网络/只读/非root/无cap容器各4项真实Node业务断言通过且清理。随后真实Astra/medium两阶段映射返回failed，未认可为业务完成。证据保留/private/tmp/omb-tsx-acceptance-HM5xui/evidence.json及ledger；b70efc只读收据只含通用error，未保留有效proposal/review，具体原因仍未知。只消耗该候选第一次真实映射，不重建候选换预算。
- cell476自动执行权限审核超时，整个组合调用未执行，诊断脚本也未创建；允许的一次执行重试e77b44在node --check发现文件缺失，未调用模型。后来独立apply_patch补建/private/tmp/openmausbot-tsx-mapping-retry.mjs；第二次88061和第三次57129现均已终态，结果以上方最新检查点为准，不再运行该脚本。
- 本批收束：所有执行句柄终态，无在途测试/模型/审批；真实映射失败未解决，不自动commit本批，不部署。下一步诊断第二次真实映射，若需要修改生产源码补TDD并重跑受影响回归；之后重建候选镜像、更新试点测试策略/备份及唯一服务切换。真实文档/六群场景/独立supervisor/主机恢复/Owner签字仍待验收，Goal active，未达到blocked阈值。

## 当前接续：宿主常驻已安装，真实隔离模型调用通过（2026-09-07）

- a685b9 exit0：f294357已本地提交启动器7文件，不push；随后单次安装成功，专用用户LaunchAgent已加载，宿主18101已connected，持久checkpoint attempts=0，空请求拒绝协议正确。安装固定bundle摘要c1b0866634e027e15108d1665d4f1977e5591d77924876e02aaf8782ffa2acdc；状态和安装清单位于/Users/mac/Library/Application Support/OpenMausBot/ModelChannel，plist位于该用户Library/LaunchAgents。不得盲目再次运行只允许首次安装的脚本。
- 19335/a66f50 exit0：新的无网络/只读/非root/cap-drop ALL临时容器，经已安装私有通道和生产relay真实调用Astra/medium，完成元数据、合成JSON和错误模型拒绝均通过；临时容器已清理，宿主常驻保留。不是群业务六场景或OS重启验收。4f328f只读launchd为running/runs1；此前临时74200/c70108已验证SIGKILL恢复。
- dfa52a核对原容器配置：原目标命令仍只有tests/source-contract.test.mjs，无assertionReporter/acceptanceSourceFiles；其测试仅源码规则/安全检查，不覆盖具体UI行为。切换前须补受信任测试证据映射及试点实际业务回归，不能仅启用模型便声称可自动确定性完成。
- 原账本只读首次e85c05因列名错误失败，无写入；6986f3核对表结构后d40b87成功：activeOwner=1/liveLease=1；runs needs_configuration5/succeeded4，无running；items accepted3/cancelled2/collecting1；Outbox sent39/superseded10，无pending/claimed；活动节点0。保留全部既有事项和失败，不迁移或清理。切换时仍需重新查快照。
- 11697/ad3185 exit0：离线独立镜像openmausbot-collaboration-pilot:opencodex-f294357构建完成，摘要sha256:5a5ffa5fab271cef19678e7e2f76e545fc318ee0edb6e746d61aa7ba0e405dce；脚本只基于原缓存复制已验证产物，临时base标签/构建目录已清理，不覆盖原local标签、不启动群服务。所有本批工具/执行句柄均终态，不再轮询456/11697。
- 下一步：补试点业务测试/结构化证据及TSX实现上下文适配（51ff35确认quality-gate.ts:115拒绝tsx），必要代码变更后需重建候选镜像；准备数据库备份和唯一服务切换/回滚（包括systemd启动使用新overlay），再完成真实文档、六类群场景、独立supervisor、VM/主机恢复和Owner签字。Goal active，宿主模型通道是进展，不是完整交付。本批20工具轮收束，只保存本批状态说明；用户文件不动。

## 当前检查点：常驻启动器完整验证通过，准备安装（2026-09-07）

- 上轮progress，本轮接续97440/375b64已终态exit0：6项定向、完整pnpm test、typecheck、diff全链通过，包含打包/独立通道/wrapper烟测。代码与测试在运行期间固定，全部验证句柄终态；74200/c70108临时launchd真实SIGKILL恢复和清理此前已通过。
- 6dc8cb只读：唯一原群服务healthy；宿主ModelChannel目录、专用plist均不存在，18101无监听；OpenMausBot/LaunchAgents父目录私有。将只提交本批7文件，不push，随后安装已验证固定bundle/稳定stateFile的用户级模型通道。原群服务、账本、Owner不改。
- 单次安装入口/private/tmp/openmausbot-install-model-channel.mjs：所有目标先确认不存在、bundle摘要匹配；新建私有目录/只读固定发布副本/安装清单，校验plist后bootstrap并检查connected和拒绝协议。若安装中途失败，保留状态，不盲目bootstrap重试或清理预算。永久安装结果尚待真实回执。

## 当前接续：持久预算已提交，宿主常驻启动器验证中（2026-09-07）

- 本轮progress：84244/967c3b完整回归终态通过，a7f4e20已本地提交持久预算14文件，不push、不包含用户AGENTS.md/outputs。旧84244等句柄终态，不再轮询。
- 新增独立opencodex-launch-agent.mjs、专用plist和6项测试；固定bundle副本、稳定stateFile、env -i最小环境、30秒launchd节流/停止。已捕获配置/导入/启动/清理错误时仅静态报错并驻留停止尝试，不能把launchd的running当通道成功。SIGTERM正常退出不重启；异常死亡由launchd恢复，SSH预算仍持久。Node可执行文件缺失等发生在JS之前的错误不在驻留机制内，安装必须检查固定runtime，不能宣称任意配置错误均不重启。
- 435291测试初放packaging未被默认vitest发现，已移入server测试路径；030a6e四项缺文件红灯。e81bcc定向4通过，52053/16d268 typecheck/plutil/diff通过；扩展6项857b5c通过。97440仍运行（最新af096e），命令为6项定向→完整pnpm test→typecheck→diff；源码/测试保持固定，不重复启动。
- 临时launchd真实探测首次61428/96a84e exit1：成功启动至connected，但夹具缺JSON请求头且读错error.code，未进入SIGKILL；所有资源已清理。仅修正/private/tmp/openmausbot-launchd-channel-probe.mjs，不改生产安全校验。74200/c70108 exit0：临时launchd首次启动、SIGKILL后新PID和再次connected、前后拒绝协议探测及checkpoint清零、bootout/远端空目录/本地资源清理均通过。
- 本批按20工具轮收束。新启动器3文件及状态说明尚未提交，下一轮先取得在途测试/探测终态，再按证据提交；未安装永久LaunchAgent，未切换原群容器/账本/Owner。下一步固定bundle正式装配和恢复、唯一试点切换、真实文档/六群场景/独立supervisor/主机恢复/Owner签字仍保留，Goal active。

## 当前检查点：持久预算完整回归通过（2026-09-07）

- 84244/967c3b已终态exit0，完整pnpm test及后续broker、桌面、普通/headless打包链通过，包含独立通道和Docker wrapper启动退出。中间输出截断，不补造总数。当前代码/测试在验证期间固定，结合89940/019bd7真实五类Docker及55193/34d141类型/独立编译，满足本批本地提交条件；不代表常驻安装或真实六业务场景完成。

- 上一交接回复仅重述状态，分类为no progress；本轮已重新核验84244为真实运行中的pnpm test，6dd83b/3803bb持续返回通过项，未重新启动。下方“完整验证未启动/419待回执”均为历史记录，不再代表当前状态。
- 前轮拆开独立验证后：89940/019bd7 exit0，当前持久checkpoint版本的真实Docker五场景和临时资源清理通过；55193/34d141 exit0，typecheck、独立编译/tmp/openmausbot-checkpoint-typecheck及diff通过。84244仍须取得整个pnpm test终态，不能提前提交。
- 436c10只读核对指定context：原群容器仍Up 3 days/healthy，其余历史容器Exited；未加载宿主通道LaunchAgent，18101无监听输出。没有修改服务、账本、Owner或其他容器。
- 当前所有验证句柄终态；仅提交本批14文件，不push。随后推进固定bundle/稳定stateFile的宿主常驻通道和真实恢复验证；最终六类群场景、真实文档、独立supervisor、主机恢复及Owner人工验收不变，Goal active。

## 历史检查点：持久预算定向通过，完整验证未启动（2026-09-07）

- 本轮有实质实现进展，不是完成：9个代码/测试/脚本文件及5份状态说明保留未提交，42项/typecheck/build:server均已通过（54535/c6d111）。上次提交仍b57d8ef，用户AGENTS.md/outputs不动。
- cell417及其唯一重试cell419均为自动权限审核超时，工具明确没有启动命令。419已终态失败，无exec session；不要轮询或把它写成仍在运行。当前没有测试/探测/提交进程需要等待。此次不是测试失败，也不能据旧证据声明本批真实Docker/完整回归通过。
- 已使用允许的一次重试，不继续盲目重复同一完整命令；下一次重新发起需用户确认或执行入口状态明确恢复。请求仅涉及本机验证执行，不重新索要已授权的OpenCodex模型能力、模型文件或密钥。未标记Goal blocked：本轮改变实现且仅第一次在当前恢复批次遇到无法启动完整验证的阻碍。
- 待执行命令仍为：显式opt-in/固定缓存镜像的scripts/smoke-docker-opencodex.mjs（本批新增私有stateFile），随后pnpm test、typecheck、独立编译/tmp/openmausbot-checkpoint-typecheck及diff。通过后才提交本批14文件和开展宿主常驻安装；原服务、Owner、账本及容器权限均未改动。完整目标与全部真实验收项保留。

## 最新接续：跨进程恢复预算已实现，完整验证待回执（2026-09-07）

- 上轮progress，本轮progress。上一末尾cell409已取得4ee6b8终态，b57d8ef文档提交完成；工作区起始仅用户AGENTS.md/outputs。新增opencodex-channel-checkpoint和测试，接入原SSH状态机、bridge与CLI --state-file，真实Docker烟测显式启用私有状态文件。
- ca8fa5红灯复现重启退款/未预留/写入失败仍连接，checkpoint模块缺失；57ec75为CLI缺选项，dceb06为bridge未装配/损坏状态未释放监听。实现后54535/c6d111 exit0：42项、typecheck、build:server/diff通过；包含真实独立Node进程退出和SIGKILL后预算保留、第四次不恢复、文件权限/链接/腐败/外部改写拒绝及新代次预算。
- 当前完整命令等待functions cell419回执（先wait获取exec session或终态），依次执行带持久状态的真实五类Docker烟测、完整pnpm test、typecheck、独立编译/tmp/openmausbot-checkpoint-typecheck、diff。前次cell417仅审核超时未启动，419是唯一重试；不可重复启动，不把提交调用当运行/通过。该命令期间业务/测试保持固定。
- fc7e81只读核对：gui/501/com.openmausbot.opencodex-pilot-channel不存在；其LaunchAgents plist和Application Support/OpenMausBot/ModelChannel目录均不存在；可用Node绝对路径/opt/homebrew/Cellar/node/26.7.0/bin/node。未创建服务或目录、未启动第二个Stream、未替换原群服务。
- 下一步取419最终证据，完整通过后只提交本批9个代码/测试/脚本和5份说明，不push。随后为已验证固定bundle安装用户级常驻模型通道、实际验证重启/计数连续性，再核对原账本/租约/在途任务及备份回滚并切换唯一非生产群服务。真实文档/六场景、独立cgroup supervisor、主机恢复和Owner签字仍待验收。Goal active，用户文件不动。

## 最新接续：启动接线已提交，Docker回归脚本已固化（2026-09-07）

- 9089d71已保存18文件本地提交，不push；完整54406/773901与额外冻结中继38168/1681d8均exit0。所有旧验证句柄已终态，不能再重轮询。原ECONNRESET未复现但根因仍未知；原试点不切换，保留全部旧事项。
- 将临时五场景探测固化为scripts/smoke-docker-opencodex.mjs：显式opt-in/完整缓存摘要、固定context和既有master、当前用户路径/远端专用UID/GID、无网络/原三cap/禁用群和业务执行；清理增加事前目录不存在且本次bridge启动成功的双门禁。176ad1三项拒绝路径在任何临时资源创建前通过；66468/55d694五类真实容器复核及全部本次资源清理通过。新脚本不调用模型，不能替代真实六类业务验收。
- 本批脚本/文档不改9089d71业务代码，复用其完整回归；76770/f0173f已exit0完成类型/语法/diff及工作区核对，7f8da79已提交本批4文件，不push。用户AGENTS.md/outputs不动，所有查询/验证句柄已终态。原账本a4115b快照：唯一Owner/租约各1，无运行任务/活动节点/待发Outbox，保留5个needs_configuration运行和1个collecting事项；切换前必须再次核对。
- 下一步：常驻宿主bridge生命周期与跨进程失败预算，原试点备份/回滚与配置连续性，再切换唯一非生产群服务。真实文档/六业务场景、独立supervisor、VM/主机恢复和Owner本人签字仍未验收；Goal active。

## 最新接续：启动接线完整回归通过，准备本地提交（2026-09-07）

- 上轮progress，本轮progress。前轮cell393审核超时未启动，cell395唯一重试成功，54406/773901最终exit0：严格四类真实Docker烟测、完整pnpm test、typecheck、独立编译/tmp/openmausbot-docker-wrapper-typecheck和diff全链通过，包含普通包/9代理路径及新wrapper/父stdin通道无node_modules启动与退出。中间输出截断不补造全量统计；steer-e2e本次2项通过，历史ECONNRESET根因未知，不宣称已修复。受测代码/测试全程固定，54406已终态，不重轮询。
- 新增真实冻结relay故障注入仅改临时探测脚本：38168/1681d8 exit0，SIGSTOP使生产relay无法响应关闭，约10秒后wrapper退出1且容器State.Pid=0。原四类也通过，全部本次容器、镜像标签、通道和目录清理通过。cell397首次审核超时未启动，唯一重试完成；该句柄已终态。
- 本批业务变更已达局部验证门槛，准备只提交18个本任务文件（包括之前未提交探测批次），不push；最终提交以Git回执为准。用户AGENTS.md/outputs不动。原群容器9b9e95仍healthy；原账本只读聚合查询cell401审核超时未启动，唯一重试回执待核对，不能提前称无在途任务。
- 后续需常驻宿主bridge服务和跨进程失败预算，核对原账本/租约/在途任务及备份回滚后切换唯一非生产群服务。真实文档/六场景、独立cgroup supervisor、VM/主机恢复和Owner本人签字仍待验收；Goal active，不将此提交称全产品完成。
- 原账本唯一重试a4115b只读成功：activeOwners=1、liveInstanceLeases=1；运行记录5项needs_configuration/4项succeeded，无running；事项3项accepted/2项cancelled/1项collecting；节点无leased/running/validating；Outbox39项sent/10项superseded，无pending/claimed。仅该时刻快照，不替代切换前再次检查，不读取消息/身份值或改状态。无仍在运行的查询/验证句柄。

## 最新接续：Docker启动接线与四类真实容器验证通过（2026-09-07）

- 上轮progress，本轮progress；基线仍7a60e6f，上一批未提交。19337/2ed275最终exit1：3110通过/1失败/18跳过（3129登记），唯一失败steer-e2e排队用例fetch ECONNRESET。82679独立复测此前通过；根因未确认，未改该测试或业务队列。19337已终态，不再轮询。
- 新增docker-service-supervisor、collaboration-docker入口、父stdin生命周期、bundle/Dockerfile和无密钥Compose overlay及测试。766c94/f49e1c为缺功能红灯；fccf97复现就绪/退出竞态和取消掩盖非零退出，已修复。30186/a00885 exit0：55项、typecheck、build及无node_modules旧模式wrapper/通道父管道关闭smoke通过。47985/65531f的17失败为误在沙箱监听EPERM，非产品故障；授权宿主87818/4c4ae3 exit0：57项/typecheck及真实Docker复测通过。
- /tmp/openmausbot-docker-wrapper-probe.mjs：固定缓存镜像离线增量打包生产入口/relay/headless，指定context；四种临时无网络/只读/原三cap场景通过：正常SIGTERM、中继故障导致业务退出、业务失败导致中继退出、通道缺失阻止业务启动。禁用钉钉/执行，无原账本或凭据挂载；临时容器、镜像标签、转发/目录均清理。首次76406/bd7879超时由夹具等待默认NULL_LOGGER不会输出的日志标记导致，改为真实健康JSON后通过。随后收紧JSON app/钉钉禁用与缺通道空stdout断言，当前复核见下一项。
- b922df exit0：真实Compose用/dev/null env-file和全合成参数合并，确认六挂载、无旧auth/模型密钥、固定四角色Astra/medium、原三cap不变及20秒停止宽限。bd4419只读原群服务healthy，未替换或操作其他context。
- 当前待续句柄为functions cell393（需先wait取得exec session/终态）：命令依次重跑严格四类Docker烟测、pnpm test、typecheck、独立编译到/tmp/openmausbot-docker-wrapper-typecheck、diff。首次返回仍等待工具回执，不把已提交调用当完整测试已启动/通过；不要重复启动。后续在该命令期间保持业务/测试固定。所有其他本批句柄均已终态。未自动commit，待完整链实际通过再只提交本批文件、不push；用户AGENTS.md/outputs保持不动。
- 按goal-protocol本批20工具轮检查点收束，Goal active。下一步先取393回执并继续唯一验证；完成后补无响应relay强制容器收束故障注入与常驻宿主生命周期/失败预算持久化，再核对账本租约和在途任务/回滚并切换唯一原试点。真实文档/六场景、独立cgroup supervisor、主机重启和Owner签字仍待验收，不将临时容器启动等同群里已升级。

## 最新接续：中继启动探测已实现，完整回归在运行（2026-09-07）

- 基线7a60e6f；只修改opencodex-local-relay/model-channel及对应测试、smoke-model-channel和五份说明；用户AGENTS.md/outputs保留。未改Dockerfile/Compose或替换原服务，无新Owner/Stream、凭据或数据迁移。
- da7582 exit1为新增12项预期红灯（启动探测缺失）。实现严格私有Unix上游负向握手、1.5秒/4KiB界限与显式relay CLI选项后，6952/680a51 exit0：31项/typecheck/diff通过。
- 19337是当前唯一仍需继续读取的完整验证会话。7024dd启动命令：先bundle /tmp/openmausbot-relay-model-client.ts，再运行/tmp/openmausbot-managed-channel-probe.mjs，随后pnpm test、pnpm typecheck、git diff --check。47abcf已证实两次真实临时容器Astra/medium调用、启动探测、同master转发恢复（connections=2）和临时资源清理全部通过；原试点358123只读healthy。真实探测脚本已为relay启用probeUpstream:true。
- 完整pnpm test主集仍运行，8907c1已出现server/steer-e2e.test.ts排队用例1失败，具体最终诊断需取得19337终态；不能重跑整个未结束测试或称完整通过。82679/c8b5eb独立复测2项通过，但原因仍未知，不改既有测试/业务逻辑、不放宽断言、不自动提交。本批业务与测试代码在全量运行期间固定。全量后的打包smoke和typecheck尚不可宣称完成。
- c6e15d exit0：使用固定缓存镜像的无网络只读临时容器，沿用原CHOWN/SETGID/SETUID能力，setpriv降至501:501并清空附加组，验证Inh/Prm/Eff/Amb均零和NoNewPrivs=1。退出自动清理，无业务挂载。后续wrapper不能假设无CAP_KILL的root可直接杀死降权子进程，需同身份有界收束测试；不要无证据添加cap。
- 按goal-protocol本批工具轮检查点收束，Goal active而非complete/blocked。下一步先继续19337并分析完整终态；确认/修复既有回归失败后验证完整链，再本地提交本批明确归属文件、不push。随后实现Docker wrapper、无密钥opt-in挂载与实际镜像启动/退出，再检查账本/租约/在途任务并切换唯一非生产服务。真实六类群场景/文档、独立cgroup supervisor、主机恢复及Owner本人签字仍未验收。

## 最新接续：已有SSH转发守护恢复与完整回归均通过（2026-09-07）

- 上轮progress；本轮先取得63105/28d0d8完整终态并提交上一批24f6d01，未重启测试。随后新增SSH适配器、串行恢复状态机、独占本机端口的bridge生命周期和CLI模式。本批8个代码/测试文件及5份说明，用户AGENTS.md/outputs不动。
- 48bfef新模块不存在是初始TDD红灯；45997/257911的15项/typecheck通过。066333真实shell负例复现set-e/&&导致普通文件清理与链接父目录检查失效，显式guard修复后通过；8cdf3f复现bridge未实现/CLI不支持，8743/96891a的61项/typecheck/原打包smoke通过。0885df复现缺少内核活监听检查，已补/proc/net/unix路径限定校验。
- 69856/13f69e exit0：62项/typecheck/diff及/tmp/openmausbot-managed-channel-probe.mjs真实通过。仅本次新建私有转发：固定缓存镜像的两个无网络非root只读临时容器经生产relay/bridge分别完成Astra/medium合成请求，中间取消本次forward后守护自动重新接通（connections=2），内核监听核对与临时资源清理通过。未重启Colima或原群服务，不能当真实master/主机恢复验收。
- 1f8745新增负例复现超时/其他失败退出错误地按诊断文本当作取消成功；已改为仅完整退出255可匹配精确良性诊断，Node超时/被杀/输出超限等非正常结果编码-1。90291/1391b6 exit0：64项定向/typecheck、真实恢复复测、完整pnpm test/typecheck/独立编译至/tmp/openmausbot-managed-bridge-typecheck/diff全链通过。主集3099通过/18跳过（3117登记），含broker/桌面、普通与通道/headless打包smoke。运行期间源码/测试固定，所有句柄终态，不再轮询。本批13文件保存本地提交，不push；实际提交以Git为准。
- ff9700只读核对ssh.config为当前用户600、原试点healthy、既有master运行。上一只读核对345审核超时未启动，唯一重试已成功；不重试旧会话。下一步：收束当前完整验证并提交，再补Docker镜像/启动接线及OS服务生命周期；真实文档/六场景、独立supervisor/VM或主机恢复、Owner本人签字仍待验收。Goal active。

## 最新接续：独立通道进程/生产容器relay完整验证通过（2026-09-07）

- 上轮progress（01f29aa），本轮progress。新增opencodex-local-relay与opencodex-model-channel及测试，独立bundle入口和默认headless打包烟测。保持同UID私有socket、仅回环、无TCP回退、不自动重放；SIGTERM取消并收束。未改Docker镜像/Compose或原群服务。
- TDD3ee706为两个新增模块尚不存在；82678/c32b81的唯一失败为新增参数化测试把数组展开成实参，修复夹具后按完整参数数组测试，未放宽配置拒绝。737915预期复现发布包缺少新入口。7376/aea721 exit0：39项定向、typecheck、无node_modules两模式转发/SIGTERM、原headless健康与退出、diff通过。332审核超时未启动，唯一重试已完成，不再重试旧调用。
- 27453/1e9ed1 exit0：`OMB_PROBE_CLIENT_FILE=/tmp/openmausbot-relay-model-client.mjs node --experimental-strip-types /tmp/openmausbot-unix-channel-probe.mjs`，指定固定缓存镜像、无网络非root只读临时容器经新生产回环relay/私有Unix通道/宿主网关，真实自然模型返回合成JSON并核验Astra/medium完成元数据，错误模型拒绝；临时容器、SSH forward/socket目录、网关及relay清理通过。不是开发CLI容器执行或常驻/群内业务验收。
- 63105/28d0d8 exit0：完整pnpm test/typecheck/独立编译至/tmp/openmausbot-model-channel-typecheck/diff全链通过，包含独立通道和原headless无依赖打包启动/退出。上轮保持同一句柄等待，本轮取得终态；受测业务/测试代码保持固定，没有重启或重复验证。所有上一批会话已终态，不再轮询。本批7个代码/测试/脚本及5份说明保存本地提交，实际以Git为准；用户AGENTS.md/outputs不动，不push。
- 7bd7f1只读核对原试点healthy、既有SSH master运行；没有启停旧服务、读取或修改凭据身份、发送群消息。下一步：取得完整终态并提交本批；补常驻SSH生命周期/重连与Docker打包接线，验证后切换唯一非生产服务。随后真实文档镜像/正文、六类群场景、独立supervisor/主机恢复和Owner本人签字仍保留，Goal active。

## 最新接续：私有容器模型通道已实际验证，尚未切换旧服务（2026-09-07）

- 基线9bb2966。新增opencodex-local-gateway及21项边界/生命周期测试；开发Provider显式关闭CLI默认web_search。真实诊断747f73证实400来自工具限制，非网络不可达；保持网关限制，未加联网工具权限。41217/cfab9e为新增断言预期红灯。
- 20382/28d82e exit0：35项定向回归、typecheck/diff、宿主网关真实自然模型和CLI合成修改建议均通过，CLI原文件未改。56240/0dcf68历史失败为自然模型通过但CLI带web_search被拒；修复后的20382替代该未通过状态。
- 84932/c6a841 exit0：临时无网络非root只读容器，通过既有Colima SSH master反向Unix socket调用宿主网关，生产自然解释适配器验证Astra/medium完成元数据/合成JSON及其他模型拒绝；临时容器、forward、socket目录与网关清理均通过。脚本/tmp/openmausbot-unix-channel-probe.mjs与/tmp/openmausbot-unix-model-client.ts（先esbuild到同名.mjs）。不把fetch Unix适配探测当作容器回环relay已实现。
- 架构改用保留原Colima账本/Owner/工作区，仅加私有模型通道，替代下方优先迁移宿主控制面；ae9d2a只读核对master运行/旧容器healthy，无无关容器变更。原Owner/凭据不读取不迁移，未启动第二个Stream、未发群消息。
- 完整回归92435/28c45a exit1：3055通过/1失败/18跳过；唯一失败为不同仓库并发用例错误要求固定启动顺序，两个事项实际均已启动、仅顺序相反。已只把该用例改为无序精确相等，保留两个事项在任一释放前各启动一次和同仓库串行断言，不改生产调度。77051/906cb3 exit0：22项调度定向、完整pnpm test、typecheck、独立编译及diff全链通过，含普通和headless无node_modules打包启动/SIGTERM。运行期间业务代码/测试固定，所有会话已终态，不再轮询。本批五个代码/测试文件和五份说明保存本地提交，实际提交以Git为准；用户AGENTS.md/outputs不动，不push。
- 待完成：常驻网关入口及受控生命周期、SSH私有通道恢复、容器回环relay/装配和唯一旧服务切换；随后文档解析镜像/真实正文、六场景、独立supervisor/主机恢复及Owner签字。Goal active，不重复索要已授权本机模型能力，不宣称全产品完成。

## 最新接续：开发Provider本机路由已验证（2026-09-07）

- 上轮progress，本轮progress；基线8845dea。新增CodexReadOnlyPatchProvider.openCodexEndpoint及headless显式环境配置，私有临时CODEX_HOME、忽略用户配置、固定本机Responses provider；既有隔离路径不变。不是OpenCode，不改用户全局配置。9个本任务文件验证后本地提交，不push，实际提交以Git为准。
- TDD83962/480adf exit1：4项失败复现未传路由/未提前校验。90272/c76344 exit0（21项/typecheck/diff），扩展路径/模型/推理/临时配置清理断言后79034/aaeeb8 exit0（25项/typecheck/diff）。
- 29364/f4ce98 exit0：/tmp/openmausbot-opencodex-provider-probe.mjs通过真实宿主Codex 0.146.0和新生产Provider，显式请求Astra/medium、无原登录配置，得到准确合成文件修改建议且原文件仍before。仅建议，不是Docker应用或真实业务完成；脚本临时工作区已清理。
- 47234/c3ff86 exit0：完整pnpm test/typecheck/独立编译至/tmp/openmausbot-opencodex-provider-typecheck/diff通过，含普通和headless打包无node_modules启动。运行期间业务/测试代码固定；所有会话终态，不再轮询。
- 29548c只读inspect确认旧服务数据/仓库/工作区和既有凭据挂载在Colima虚拟机目录，不是宿主同名路径已可用的证明。下一步验证宿主访问与单账本/租约连续性、VM代次/containment引用和实际Provider环境，再切换非生产服务；不得新建Owner、复制第二个活跃账本或盲启动第二个Stream。
- Goal active。用户已授权本机模型通道，不再重复索要授权；尚未启用此路由到旧群服务，未改凭据/身份/网络、未发送群消息、未启停旧容器。真实文档/附件隔离、六场景、独立supervisor/主机恢复和Owner验收仍保留。用户AGENTS.md/outputs不动。

## 最新恢复：已授权并验证宿主OpenCodex调用（2026-09-07）

- Owner明确授权本机受限模型通道及网络问题时宿主执行；原生Goal已active，旧blocked状态失效，恢复后重新审计阻碍。仍使用OpenCodex gpt-6-astra/medium，无需密钥。本轮有真实执行证据，不重复询问同一授权。
- cell263 Docker只读首次审核超时未启动；后续唯一重试1c3b01成功，旧试点仍healthy/固定镜像2ae332cd23df。cell264模型首次审核超时未启动；唯一重试83385/659985 exit0，生产ResponsesNaturalIntakeModel在宿主回环完成真实Astra/medium结构化请求，无凭据、无工具。
- cell270/002f2d exit0：宿主直接运行已有docker-command-cancel.smoke.ts，显式colima-openmausbot-pilot和固定缓存镜像，启动门前取消、运行中父子进程停止、网络/非root/只读约束断言及本次临时容器和目录清理通过。无运行中句柄。
- 采用宿主headless控制面 + Docker隔离执行的优先路径；现有runtime明确支持darwin/docker_linux，但现有钉钉服务尚未切换。下一步核对单账本/租约/Owner、daemon共享路径、Linux VM启动代次与既有containment引用、CodexReadOnlyPatchProvider的OpenCodex模型路由，再切换非生产服务。不要把仅自然解释/验收模型配置当开发Provider也已切换；不要复制第二个Owner或盲启动第二个Stream。
- 仅记录与说明变更，无业务/测试代码修改，不重复完整回归；先前88277全量证据仍对应当前业务代码。未读模型密钥、改全局网络/认证、迁移身份/凭据、发群消息、启停旧服务或操作其他context；用户AGENTS.md/outputs保持不动。六类真实试点、文档隔离镜像与真实正文、supervisor/主机恢复、Owner签字仍保留。

## 当前暂停点：等待真实试点前置条件（2026-09-06，优先于下方）

- 原生Goal已标blocked，未完成；保留完整目标。模型容器通道待Owner明确授权在运行配置收束、验收手册审计、本次复核连续三轮存在。此前两轮有提交进展，本轮仅复核，不把状态记录当产品进展。
- 当前基线8e8465b，业务基线469de46；工作区仅用户AGENTS.md/outputs未跟踪，未改动它们。88277完整回归及43565文档批次检查均终态通过，无验证进程等待；PATH历史间歇失败根因未确认，不冒称修复。
- 最新真实环境证据仍为e4e55e指定context旧服务healthy/无解析器缓存，92084/d5d272官方镜像站DNS超时。本轮没有新网络检查或外部动作，不将旧观测宣称实时网络状态。
- 未完成：受限OpenCodex容器调用通道、真实群消息/引用/文档/表格/附件入口、隔离解析镜像验证、六类真实试点、独立cgroup supervisor/主机重启恢复、Owner本人签字；新报告证据采集与契约也未完成。它需要真实通道/事件的有效证据，不能靠继续生成可手填状态的报告替代试点推进。
- 恢复：先取得Owner对指定非生产容器调用宿主OpenCodex受限本机通道的明确批准（不开放公网、不改凭据、不放宽全局认证）；重新核对网络可达与真实入口授权后按docs/pilot/pmo-six-scenario-runbook.md继续。自动Goal续跑不是授权；恢复后重新计算blocked审计轮次，不能立即沿用此次三轮计数。

## 最新接续：完整目标验收审计（2026-09-06，优先于下方）

- 上轮progress：469de46已本地提交且全量通过；本轮progress：核对当前代码和旧报告后补齐六场景验收手册，并为旧里程碑入口标明适用边界。无业务/测试代码变化，不重复已有效的全量回归。六类真实结果仍全部待验收，Goal active。
- aacd9c默认沙箱无法访问Docker socket；e4e55e授权只读查询成功：指定colima-openmausbot-pilot旧服务healthy，无解析器缓存镜像。92084/d5d272 exit28：官方Registry匿名HEAD在DNS解析阶段约5秒超时。未拉取/构建/启停/删除容器，未改DNS/代理，未发送群消息；没有运行中会话。
- 43565/2163e7 exit0：两手册相对链接与六必测场景检查、pnpm typecheck、diff通过。仅本批六份文档保存本地提交，不push；用户AGENTS.md/outputs不动，实际提交以Git为准。
- 恢复入口：docs/pilot/pmo-six-scenario-runbook.md。仍缺真实模型容器通道的Owner明确授权、镜像网络恢复、真实群/文档入口与六场景、独立supervisor/主机恢复及Owner本人签字；不能绕过安全拒绝。本次审计还确认旧v1报告未建模当前六场景，后续可在既有范围内补真实证据采集/报告契约，但不能用手填状态或合成值宣布通过。

## 最新接续：运行配置批次完整验证通过（2026-09-06，优先于下方）

- 上轮progress，本轮progress。10722/72b0ff exit0：PATH独立复测13通过7跳过；相同权限的复测也通过。本轮未改PATH代码或测试，未放宽断言；此前33396/c41865唯一失败的根因仍未确认，不能称其已修复。
- cell238权限审核超时，未启动命令；cell239唯一重试获准，88277/a3ced9 exit0：PATH定向、完整pnpm test、typecheck、独立编译至/tmp/openmausbot-runtime-policy-typecheck及diff全部通过，含普通打包无node_modules/9代理、headless健康/运行/SIGTERM。验证期间源码与测试固定。所有句柄终态，不再轮询。
- schema29运行策略快照及双收据门禁完成本批验证；只保存本批15个代码/测试文件及四份状态文档，本地提交结果以Git为准，不push。用户AGENTS.md/outputs不动。
- Goal仍active，完整目标未达成。下一步需Owner明确授权指定Docker试点到宿主OpenCodex的受限本机模型通道；现有安全拒绝不可绕过，不伪造Host/放宽全局认证/暴露公网。继续保留真实文档/群六场景、Linux强隔离与独立supervisor、主机重启恢复和最终Owner人工验收，不能把本次自动回归当线上闭环。

## 最新接续：运行配置快照（2026-09-06，优先于下方）

- 基线302b5d8；本轮有实质实现进展，Goal active，未完成。schema29及不可变fence快照接入正常headless启动、两阶段收据和直接验收。边界详见SPEC/D-093，未变更模型、权限、网络或容器。
- 定向19926/108718 exit0：199项/typecheck/diff通过；96347已终态，不再轮询。完整回归33396/c41865 exit1，必须检查失败后再提交。
- 尚未完整验证，不提交。本批15个代码/测试文件及四份状态文档保留；下轮先完成上述验证，再按归属提交，不push。用户AGENTS.md及outputs保持不动。
- 下一步：完成当前批次收束；Docker调用宿主OpenCodex的受限本机通道仍待Owner明确授权，不伪造Host/放宽认证/暴露公网。真实文档/群六场景、Linux隔离与独立supervisor、重启恢复及最终Owner人工验收继续保留，不能据本批测试标整个目标完成。

## 当前状态

- 最新接续（2026-09-06，优先于下方）：上一轮progress，本轮progress。5cccaa最小只读权限诊断确认默认沙箱loopback bind报EPERM，未盲启全量。随后真实模型探测唯一重试获准，95749/367859 exit0：固定Git测试+实现源码经生产采集器送真实Astra/medium两角色，映射approved，SQLite收据重读及重放不新增模型调用。仅合成函数契约，无候选执行/群交付。
- 进一步复现并修复直接完成入口的Spec漂移漏洞：87080/326c27新增测试按预期失败；原直接读取不重算范围。现在v3收据在两阶段保存当前持久Spec身份并由直接读取重算，read/deny变化不等待重新verify即可拒绝低风险完成。更新合成政策夹具而未放宽门禁。84705/c06b36 exit0：7文件133项/typecheck/diff通过；此前60308/ad07de的4项失败仅旧合成v2夹具已修复。
- 完整回归27855/f1f4ee exit0：pnpm test/typecheck/独立编译至/tmp/openmausbot-source-context-v3-typecheck/diff全部通过，含普通打包无node_modules启动/9代理及headless健康/运行/SIGTERM。完整运行期间业务/测试代码固定。所有本批句柄现终态，禁止继续轮询27855/95749或旧未启动审核请求。本批16个任务文件验证后保存本地提交，不push、不部署；实际提交结果以Git为准。
- 接续审计：直接读取入口已绑定当前持久Spec/计划范围；外部命令定义、源码清单和模型策略在verify协调器之外是否被最新运行配置约束仍未证明，需要专项接线审计。不要外推为所有配置漂移已解决。Docker通道仍待Owner明确授权，真实文档/群/六类试点、隔离/supervisor/主机恢复及最终Owner验收保留；Goal active，用户AGENTS.md/outputs不动。

- 最新批次（2026-09-06，优先于下方）：上一轮progress（6a0f734已提交），本轮progress。新增受信任命令的acceptanceSourceFiles、当前验证节点read/deny范围检查、固定候选实现来源及角色约束，源码清单/范围进入验收契约哈希。配置变化使旧通过缓存失效，越界在模型调用和测试前拒绝；headless保留并验证配置。本批不跟随import扩权、不改变模型或Docker网络。
- 已取得定向终态99466/c72d70 exit0：5文件83项、pnpm typecheck和diff通过。TDD95506/bb016a的12项、96882/66ae34的2项原实现失败；首次实现68492/2a2550仅配置错误提示顺序失败（80项通过），保留原断言并修复后通过。
- 完整回归尚未启动：cell199首次exec权限审核超时；cell200唯一重试也审核超时，均CreateProcess失败，无运行进程或session。真实模型探测在cell200首次尝试同样未启动，不能视为失败拒绝或模型验证通过。cell199/200均已终态，不再轮询；完整回归不可继续盲重试，需用户指导或权限审核恢复后的明确执行安排。模型探测尚保留一次允许重试。
- 本批改动尚未提交（全量验证缺失），用户AGENTS.md/outputs不动。恢复入口：先检查当前diff，再运行完整pnpm test/typecheck/独立编译/diff及/tmp/openmausbot-astra-source-context-probe.mjs（只含临时固定Git合成源码、生产采集/两模型协调器/SQLite收据重读和重放，无钉钉发送或候选执行）。没有活跃验证句柄，不重复轮询旧回归45320或51283；两者仅属于已提交上一批。
- Goal仍active，本轮有实质实现进展，不满足blocked条件。Docker受限通道仍待Owner授权，真实文档/群/六类场景、隔离/supervisor/主机恢复、最终Owner验收继续保留。显式源码清单不是完整依赖图保证，不得据定向测试宣称产品完整闭环完成。

- 最新批次（2026-09-06，优先于下方）：继续使用 OpenCodex gpt-6-astra/medium，无需密钥。原生 Goal active；源码脱敏已实现并接入固定 Git 采集和模型请求复验，支持幂等/原证据行、动态字段和默认值保护。未执行候选代码、未读密钥、未改网络/容器。TypeScript 同版本移至运行依赖，锁文件只读一致性检查通过。
- 定向验证 66362/6d2c26 exit0：4 文件89项、pnpm typecheck、diff通过。真实合成反例34382/31219e exit0：合成Proposer提议，真实Astra独立Verifier指出缺少实际登录/界面逻辑及脱敏关键比较，返回missing，协调器rejected。只证明负例门禁，不是线上交付。
- 完整回归45320/55e815 exit0：pnpm test/typecheck/独立编译至/tmp/openmausbot-source-redaction-typecheck/diff通过，运行期间代码/测试固定。补充headless打包测试d792d1发现TypeScript初始化缺少ESM中的__filename；修复仅涉及打包脚本和默认测试脚本，未改已验证业务/测试代码。51283/3ad32f exit0：重新构建全部入口、普通打包启动/9代理、独立headless健康/运行/SIGTERM及typecheck/diff通过。headless检查已加入默认pnpm test末端，不再遗漏。所有句柄终态；保存本地批次，不push。源码采集仍只包含显式测试文件；下一批补可信读/拒绝范围内的被测依赖上下文，不得自动任意遍历仓库。
- Docker受限本机通道仍待唯一Owner明确批准，未将Goal续办当授权；真实钉钉文档/群入口、六类场景、隔离/supervisor/主机恢复和最终Owner验收继续保留。用户AGENTS.md/outputs不改动、不提交；全目标未完成。

- 最新验证收束（2026-09-06，优先于下方）：上轮progress，本轮先verified wait，现取得完整终态证据，分类progress。53277/d40579 exit0，pnpm test/typecheck/独立服务端编译至/tmp/openmausbot-mapping-explanations-typecheck/diff完整链通过；打包无node_modules启动及9代理路径通过。整个重跑期间没有改业务或测试代码。所有验证句柄现终态。
- 前一次固定版本61336/5b2f08 exit1：唯一失败是未修改的env-path等待断言（274文件/2961项通过，1项失败，18跳过，430.51秒）。19540/c94e6d独立复测13通过/7跳过，类型和独立编译通过；同代码完整重跑通过。未改路径实现、未放宽断言/超时，根因未知，保留失败历史，不宣称彻底消除偶发性。
- 已验证批次：系统向两角色提供条件校验标识、安全解释文案契约、敏感输出拒绝/收据不保留示例值及相关测试。真实模型证据仍以已记录的精确函数正例、弱断言/业务覆盖不足/脱敏缺失负例为准，不作为真实产品交付完成。完成后仅本地提交六个本任务文件，不push，提交结果以Git为准；用户AGENTS.md/outputs不动。
- 下一恢复入口：源码脱敏可能破坏比较表达式、显式测试文件采集缺少被测依赖，均未修复。先设计固定候选内、声明读取范围和禁止路径约束下的语法感知源码处理/依赖上下文，先补测试；不要继续扩大提示文案来替代实际源码支持。Docker模型受限通道仍待Owner明确批准，真实群/文档入口、隔离/六类试点和最终Owner验收仍未完成。Goal保持active。

- 最新批次（2026-09-06，优先于下方）：上一轮及本轮均 progress，原生Goal active。新增两个角色共享的安全说明契约，不复述凭据样式测试值、不还原脱敏内容；原敏感输出拒绝和失败收据不保留原文的规则不变。TDD1551/4dc256一项预期失败，42491/a065f7两文件48项/typecheck通过。
- 真实语义结果：38354/1bdc1a拒绝把局部函数当完整保存业务覆盖，说明先前正例预期过宽，未改模型让它强行通过。随后16859/e1c32b：精确函数契约由真实Proposer+Verifier批准，收据重读/重复调用不变；弱断言由合成Proposer提议、真实Verifier判missing并rejected。该脚本末尾脱敏负例60秒传输超时，整次exit1，不把超时当拒绝通过；单独重试73694/ad7e5f exit0，真实Verifier判uncertain并rejected。
- 尚未解决的实质产品缺口：faf403证明自然文本脱敏会破坏源码中的password比较运算符；acceptance-source.ts仅采集显式Node测试文件，不提供被测实现/依赖。精确函数合成正例只验证映射机制，不替代真实保存流程/界面或完整交付；后续需在固定候选、只读、禁密钥/符号链接/越界的边界内补依赖上下文与语法感知脱敏。
- 完整验证：旧11392/e5e1b5 exit1（274文件通过/1失败/1跳过，2961项通过/1失败/18跳过，357.27秒），该运行期间新增TDD捕获旧模型说明，不能代表当前固定版本。最终重跑61336仍活跃，最近6aad6e有session_id无退出码；cell149首次审批超时未启动，唯一重试成功。下次先轮询61336，勿重复启动或套用旧结果。
- 本批六个任务文件未提交未部署；真实探测脚本/tmp/openmausbot-astra-mapping-cases.mjs保留（无参三例或redacted单例），所有真实模型句柄已终态，只有完整回归61336在运行。其完整命令是pnpm test/typecheck/独立编译到/tmp/openmausbot-mapping-explanations-typecheck/diff。全量通过后再本地提交，不push、不包含用户AGENTS.md/outputs。Docker受限模型通道仍待Owner明确批准；真实群/文档、隔离和六场景验收继续保留，Goal不标完成。

- 最新接续（2026-09-06）：容器受限模型通道尚无 Owner 明确答复，未执行。本轮转向原授权内真实验收映射验证，上一轮/本轮均为 progress，Goal active，不因单个待授权事项停止所有安全本地工作。
- 发现并修复映射身份缺失：生产端要求 conditionHash 但原请求只提供条件文本；合成模型端口 89644/913f87 复现失败，真实 Astra 26471/95404e 自行生成了错误标识。现为 Proposer/Verifier 同时附加由主程序计算的条件标识，不改 canonical request、哈希算法、来源和候选门禁。2626/45b798 exit0，三文件50项及typecheck通过。
- 真实复测 7823/cae783 exit1：Proposer 使用正确 conditionHash，但仍未完成整条映射。其 rationale 含“错误密码 \"wrong\"”，会触发既有敏感输出判定；下一步核对并解决模型说明文案与防泄漏约束的契约，不删敏感检查，不把合成口令外推为允许输出真实凭据。此运行未取得独立 Verifier 返回，不可声称独立映射通过。
- 全量运行 session 11392 已启动，最近 cfe8dc 仍有 session_id/无退出码；首次 cell139 审批超时未启动，唯一重试 cell140 成功。下次轮询原句柄，勿重启全量。命令 pnpm test/typecheck/独立编译到 /tmp/openmausbot-mapping-identities-typecheck/diff。本批到工具轮预算收束，保留未提交改动，真实映射仍失败，不自动commit。
- 临时 /tmp/openmausbot-astra-mapping-probe.mjs 使用生产工厂/协调器与临时SQLite，只有合成需求和测试源码，不执行测试代码或发送群消息。两次真实探测终态；其他运行仅上述全量句柄。后续需增加合成弱断言反例复核，随后恢复 Docker/真实文档与六场景完整验收；全目标不缩减、不标complete。

- 最新验证收束（2026-09-06，优先于下方）：接续原 session 57677，d17126 确认 exit 0；主集 275 文件通过/1 跳过、2958 项通过/18 跳过，457.59 秒；broker/桌面/打包无 node_modules 启动、9 代理路径、pnpm typecheck、独立服务端编译和 diff 全通过。原完整运行已终态，不再轮询或重启。上轮为 progress，本轮完成终态验证并查明 Docker 拒绝原因，原生 Goal active。
- 自然需求原文契约与可回答问题 schema 修复已由完整回归及前轮真实模型/SQLite 入账、重放、重启、澄清回答证据覆盖。保存本地批次，不 push；以 Git 实际提交结果为准。此前真实调用偶发失败原因仍未知，不据成功重试宣称稳定性问题永久消失。
- Docker 只读核实 d2a44a：已授权 colima-openmausbot-pilot 中主 pilot healthy，其他历史容器已退出，未动任何容器。93213d：模型目录 HTTP403/error.code=origin_rejected，正文 cross-origin data-plane request blocked。已安装 OpenCodex auth-cors.ts 的无认证策略检查 Host 为 loopback；host.docker.internal 不符合。health 可达不代表数据 API 有权限。
- 下一恢复入口：需唯一 Owner 明确允许为指定非生产 Colima 试点增加受限本机模型通道，使该容器可调用当前 OpenCodex；不伪造 Host 绕过检查、不开放公网、不改密钥/身份或全局访问权限。获得批准后设计并验证通道隔离与生命周期，再接入指定 Astra/medium。未获批准不自行开通，也不把自动 Goal 续办视作授权。当前首次提出此边界审批，不满足 blocked 连续三轮条件。
- 全目标仍未完成：Docker 数据通道、真实文档/群事件入口、固定镜像隔离及六类真实场景、独立 supervisor/主机恢复与 Owner 最终验收继续保留。没有部署本批；用户 AGENTS.md/outputs 不修改、不提交。

- 最新接续（2026-09-06，优先于下方）：上一轮为 progress，本轮原生 Goal active，新增生成 schema 与运行时共享的可回答问题判定；当前业务问题才进入枚举，无符合项时 answers.maxItems=0。保留系统完整性上下文与独立拒绝门禁。自然目标原文契约一并保留，未放宽权限或改群关联规则。
- 本地定向 65676/3d1419 exit 0：两文件 56 项及 pnpm typecheck 通过。真实模型/SQLite 7852/210e45 exit 0：明确需求入账、重放不变、另一合成群模糊需求在重启后恢复并追问两项。追加自然回答 77404/cf8ad5 exit 0：准确回答原 natural-page 与 natural-pain-point、无新问题、原疑问消除、重放不变。均无钉钉发送/执行器，不等于六类群试点通过。
- 失败记录：97481/29d1d0 中明确需求已通过，但脚本误假定同群模糊消息必然立即创建 intake job，读到 undefined；改为独立合成群后通过，未绕开产品关联逻辑。21522/6121fd 的追加回答 job=pending，未捕获传输原因；同一事项第二次尝试通过，原因未知，不能称永久解决模型稳定性。
- 正在运行的唯一操作：完整验证 session 57677，最近 7fd199 返回 session_id、无退出码，仍活跃；前序 comms 用时 176 秒但通过，不因长等待重启。命令为 pnpm test 后接 typecheck、独立服务端编译到 /tmp/openmausbot-natural-answer-contract-typecheck 和 diff 检查。下次首先轮询这个句柄取得终态，不能重新启动整套测试或套用旧完整结果。
- 当前六个任务文件仍未提交；全量通过后仅提交这六个文件，不 push，不混入用户 AGENTS.md/outputs。真实探测脚本 /tmp/openmausbot-astra-durable-probe.mjs、/tmp/openmausbot-astra-followup-probe.mjs 与临时合成库保留。按每批 20 工具轮上限预留收束；本批未部署，Goal 继续 active。之后仍需 Docker 模型访问（先前 API403）、真实文档/群入口、隔离和六类真实场景与 Owner 最终验收。

- 最新批次（2026-09-06，优先于下方）：本轮原生 Goal 为 active。上一检查点仅状态汇报，分类 no progress；本轮完成原文确认契约修复、测试及新的真实模型证据，分类 progress。明确需求真实解释已成功，模糊需求给出两个关键问题；没有放宽原文/权限校验。完整本地链 61494/6ee015 exit 0，所有测试/类型/独立编译/打包检查终态。
- 仍未通过的真实接线测试：临时 /tmp/openmausbot-astra-durable-probe.mjs 使用生产服务、真实 Astra 和临时 SQLite（无钉钉发送或执行器）。52884/555cbf exit 1 仅见 pending，原因未知；加错误分类后 89311/9d33a6 exit 1 明确为 natural_intake_answer_not_pending，模型错误回答了系统 natural-input-pending 标记。目标原文和两条验收正确，不能据此把入账流程记通过；未绕过门禁。
- 恢复入口：先为系统 natural-input-pending / natural-context-incomplete 不可回答的模型输出契约补测试，明确区分业务澄清与系统状态，保留现有强校验；复测真实持久化/重放/重启，再完整回归。当前六个任务文件未提交，因为真实接线测试仍失败；用户 AGENTS.md/outputs 不动。临时脚本保留，所有会话终态，无需重启或轮询旧句柄。
- Docker 上一探索证据仍仅 health 200、模型目录接口 403；不能宣布模型已接入容器，也不拓宽无认证网络。实际群/文档入口、固定解析镜像隔离、六类试点及 Owner 人工验收仍待完成，未部署本批。按每批最多 20 工具轮收束，Goal 不标 complete 或 blocked。

- 最新实现批次（2026-09-06，最高优先）：原生 Goal 本轮查询为 active；上一轮真实无密钥连通为 progress，本轮完成产品流式适配并通过完整验证。自然解释及独立 Proposer/Verifier 工厂现可显式选 opencodex_local，不要求凭据文件，限定字面本机回环；请求发送指定模型与 medium，返回核对精确模型/强度和完整事件证据，不使用部分文本。旧凭据模式保留，配置混用/拼写错误/非法端点不降级。
- 实际证据：生产 ResponsesNaturalIntakeModel 对本机 OpenCodex 的 schema 请求在 86269/3d52ac exit 0 返回 {result:OK}，Astra/medium 由适配器完成门禁检查。新旧模式相关三文件 44 项通过；完整链 27697/c3c563 exit 0，主集 275 文件通过/1 跳过、2949 项通过/18 跳过，448.03 秒；类型检查、独立服务端编译、broker/桌面/打包启动及 9 代理路径全部通过。所有命令终态，观察存 opencodex-adapter-full-output/last 与 opencodex-production-adapter-live。
- 本批增加有界 SSE 解析及取消/迟到响应清理、配置和独立上下文测试、四份状态文档/模型配置说明；验证通过后仅本地提交本任务九个文件，不 push，用户 AGENTS.md/outputs 保留。没有实际启用/重建钉钉试点、修改全局客户端/身份/凭据或替换模型。新增模式通过既有工厂接线，但尚未在运行容器启用。
- 恢复入口：先核实本批提交，再用真实模型核对自然需求/归并/验收映射语义，解决 Docker 到宿主模型的受控连接；不能把容器回环当宿主地址，也不能放开无密钥远程访问。真实文档/群事件授权、固定解析镜像及强隔离、六类群聊、独立 supervisor/主机重启和 Owner 验收仍未完成，Goal 不标 complete。无需再请求 OpenCode 修复或模型密钥。

- 最新用户纠正（2026-09-06，最高优先）：使用的是 **OpenCodex，不是 OpenCode**。OpenCode 启动器认证修复属于误走方向，撤销该修复计划和授权请求，不修改启动器/全局包、不再以其报错阻塞本任务。模型固定 `gpt-6-astra`、推理 `medium`、无需用户提供密钥。原生 Goal 本轮查询仍返回 blocked（旧状态），没有可用于手工 resume 的状态工具，未虚称已修改原生状态；后续续办应按此新输入和真实进展重新审计，不延用旧认证阻塞。
- 真实 OpenCodex 连通已验证：`opencodex access endpoints --json` 确认本机 `http://127.0.0.1:10100/v1/responses`；36610/239e91 对外模型清单含 Astra/medium。无 Authorization、无密钥读取、无业务数据、无工具的最小真实请求在 85096/8c9cba 返回 HTTP 200，流式 delta/done 文本均为 OK，response.completed 指明 model=gpt-6-astra、effort=medium。此前 56403/855bcf 已确认成功终态，但 completed.output 为空，不能仅靠该字段提取正文。
- 当前真正的产品接入缺口：已有 ResponsesNaturalIntakeModel 强制 credential 文件、默认非流式 JSON，也没有发送 reasoning.effort；OpenCodex 实测要求 input 为列表和 stream=true。下一实现批次需先补测试：显式且仅受信任 loopback 的无密钥 OpenCodex 模式、有界增量 SSE 读取及真实 done/completed 语义、严格 medium 请求、取消/错误/截断/非文本工具事件拒绝，保留现有 HTTPS+凭据路径和独立验收上下文，不把目录或最小 OK 测试当产品闭环通过。
- 本轮没有改业务代码/凭据/身份/网络/运行容器，所有命令终态；原本地完整回归仍对应 2df0387。模型通道阻碍已解除，但产品工厂与 Docker 接线、真实文档/群事件授权、固定解析镜像、六类试点及 Owner 验收仍未完成。宿主回环地址不能直接视作 Docker 容器中的宿主地址，容器接入另需验证，不拓宽无密钥远端地址。

- 最新阻塞收束（2026-09-06，覆盖下方 active/旧模型缺项结论）：原生 Goal 已标 blocked，非 complete。用户提供模型名称后的核查轮、只读诊断轮及本轮，连续三轮存在同一 OpenCode 启动器管理认证阻碍，修复授权尚未获得；前两轮取得新证据，本轮仅复核无进展，当前无进一步安全验证可打通该通道。不是模型名称未知：`gpt-6-astra`/medium 已由 0e9e55 确认，无需再次索取名称或模型密钥。
- 只读诊断恢复入口：已安装启动器 `fetchOpencodeProxyModels` 向 `/api/models` 传入 `opencodeApiKey` 的普通服务准入凭证；成功的 `inspect catalog` 走 `runtimeRequest`→`runningProxyUpdateHeaders`，后者使用现有管理认证。服务端 `/api/*` 明确要求管理身份，符合 5c2073 拒绝结果。源码证据 10fcf0/b89768/5ac063，未读取令牌值或改装全局包。最小后续动作是获 Owner 明确授权后修正管理目录查询与模型子进程的凭据分离，不把管理令牌传给模型、不新增密钥、不放宽权限，再重跑原启动器及实际 medium 验证。安装包在产品仓库范围外，不能靠自动续跑推定修改授权。
- 保存状态：业务提交 2df0387、完整回归 11501/f42bdf 及模型核查提交 6229912 保留；无运行中的命令或部署。真实文档/群事件授权、固定解析镜像、六类真实试点、独立 supervisor/主机恢复及 Owner 验收仍未完成。恢复后重新审计阻塞，不延用本次三轮计数。

- 最新 Owner 输入与核查（2026-09-06，覆盖下方模型名未知结论）：用户明确模型 `gpt-6-astra`，无需密钥，继续使用中等推理。原生 Goal 已随新输入恢复 active，旧 blocked 审计不沿用。07f331 显示直接 OpenCode 仅有 OpenAI OAuth 且其目录没有 Astra；随后发现本机另有 OpenCodex 专用 `opencode` 启动入口。2a4cf2 确认代理 healthy，0e9e55 从当前有效 catalog 精确确认 `gpt-6-astra`、supported_in_api=true、支持 medium。此前根据直接 OpenCode 清单索取模型名的结论不完整，不再重复索取名称或截图。
- 本轮 progress 为找到模型和实际接入阻碍：`opencodex opencode models opencodex` 在 5c2073 exit 1，入口被现有代理拒绝，提示管理认证缺失。独立 inspect catalog 可读，但 launcher 不能取得模型目录；没有真实模型调用，不能把目录声明当 medium 已执行证明。未启动/重启代理、未改登录/密钥/全局或项目配置、未部署。下一步需要唯一 Owner 明确授权修复 OpenCode 与本机代理的认证衔接，优先复用现有身份，不新增模型 API 密钥、不替换模型。完整六场景及镜像/文档/主机验收边界仍保留。

- 阻塞收束（2026-09-06，最高优先）：原生 Goal 已标 blocked，不是 complete。环境复核、上一轮状态核对及本轮连续三轮仍缺指定 OpenCode GPT-6 Astra 的实际渠道/medium 证明、真实入口必要授权及可用可信解析镜像来源；本轮与上一轮均无实现进展，不将重复检查或记录计作 progress。已核实 HEAD 5513fb1，业务提交 2df0387 和完整回归 11501/f42bdf 保留，工作区仅用户 AGENTS.md/outputs；所有已知命令终态，无测试/构建待等待。
- 恢复入口：Owner 提供 OpenCode 模型选择截图或完整 provider/model 标识（无需密钥）；固定解析镜像/依赖来源可用或网络恢复后继续真实隔离验证；新增文档/群事件通道仍需相应授权。恢复后重新审计阻塞，保留完整六场景、独立监督/主机恢复和最终 Owner 验收，不因本地通过缩小目标。不换模型、不改凭据/身份/网络、不操作其他容器、不重复无进展续跑。

- 最新环境复核（2026-09-06，优先于下方）：已确认上批九文件成功提交为 2df0387；工作区仅用户 AGENTS.md/outputs 未跟踪。专用 context 只读检查 430447 确认试点 healthy、仍为旧镜像 2ae332cd23df、无解析镜像，其他历史容器 exited。官方站沙箱外 curl 为 TLS 错误；独立 Node HTTPS 对官方 registry 返回 ECONNRESET，对公开 ECR/PyPI 超时，26654/45bddd 已终态（脚本捕获错误后 exit 0，不代表网络通过）。没有构建、拉取、部署或改 DNS/代理。
- 本轮分类 no progress：重新核实了真实前置阻碍，未解除模型渠道、真实入口授权或镜像来源阻碍；上一目标轮是完整验证并提交的 progress，不满足连续三轮无可推进的 blocked 阈值，Goal active。所有检查终态，不存在需等待的构建/测试句柄。恢复需 OpenCode GPT-6 Astra 完整渠道标识/medium 能力证据，以及可达可信固定镜像及依赖来源；此前六场景、真实授权和人工验收要求保持不变，不重复无变化本地回归替代验收。

- 最新接续（2026-09-06，优先于下方历史）：上一轮仅复述检查点，分类 no progress；本轮重新核对实际工作区，并接续仍有效的测试 session 11501，没有重启测试。该命令已在 f42bdf exit 0 终态：新增两文件 41 项、完整 pnpm test（主集 274 文件通过/1 跳过，2919 项通过/18 跳过，333.85 秒）、pnpm typecheck、独立服务端编译及 diff 检查全部通过。原生 Goal 当前 active，完整产品验收仍未完成。
- 本批修改完成：旧实例文档容器丢失创建回执时，按精确预留名称验证身份，原子保存发现的完整 ID 后再清理并独立查缺；未知、冲突、过期、取消或三次耗尽均保留证据，不盲删、不重新解析。生产提取器到重建恢复器的联通测试通过，但 Docker 端口为受控夹具，不是实际 Docker 强杀证据。schema 保持 28，没有操作真实容器、模型、凭据或群消息。
- 保存与恢复：本批四个代码/测试文件、四份状态文档及解析器 README 共九个任务文件，验证通过后仅创建本地提交，不 push；提交是否成功以 Git 后续回执为准。用户 AGENTS.md/outputs 保留。所有已启动测试终态，证据存 document-discovery-full-output/last。下次先核实提交状态，然后推进指定 OpenCode GPT-6 Astra/medium 的实际通道确认和真实试点入口，不再运行无变化的本批回归。
- 尚待完成：OpenCode 完整 provider/model 标识及实际 medium 验证、真实文档/群事件必要授权、固定解析镜像及 Linux 隔离 smoke、六类非生产群聊场景、耗尽后的唯一 Owner 恢复动作、独立 cgroup supervisor/主机重启和 Owner 人工验收。模型目录缺项问题仍等待用户渠道信息，不猜测替换模型。本轮有已验证修复进展，不满足真正无可推进事项的 blocked 条件。

### 以下为前序记录，不覆盖上述最新状态

- 最新Owner指示（2026-09-06，覆盖前述待提供API配置要求）：百炼与.env方向已由用户撤回，本轮没有实施该方向的代码或配置，无需回滚业务文件。明确改用OpenCode上的GPT-6 Astra、推理强度medium；不再索取百炼密钥文件，也不擅自替换为其他模型。原生Goal已恢复active。
- 当前接入核查：本机OpenCode 1.18.15支持run --variant；4349b8/8d1e46模型清单读取完成，66458/389a0c刷新目录成功后openai列表仍只有gpt-5.3至gpt-5.6系列，没有GPT-6 Astra；现有opencode.json无自定义provider。未调用付费模型、未修改认证或全局模型配置。需要确认用户所指OpenCode渠道及该模型的完整provider/model标识，不能猜测别名或把Codex工具可用模型当作本机OpenCode已可用。
- 本轮分类progress为取得刷新后权威目录证据并排除旧配置方案，不是模型接入成功。全部本轮命令终态，业务HEAD6e9d243不变，用户AGENTS.md/outputs保留；真实文档/隔离/六场景验收仍未完成。后续从确认实际可用的模型通道继续，之前blocked审计不沿用。

- 交接保存状态：本轮PROGRESS.md与VERIFY.md仅有记录变更；本地提交请求cell1303在权限审查阶段超时、未启动，未形成新提交。两文件保持未提交，业务HEAD仍6e9d243；无运行中命令。不要将下面收束前的干净工作区快照当作当前两份文档已提交。

- 当前收束（2026-09-06，优先于下方历史）：业务批次已实际保存为6e9d243，完整验证80357/bd32bb有效；工作区仅用户AGENTS.md/outputs未跟踪，无运行中的测试或部署。本轮与上轮分类no progress，不将重复状态核对记作实现进展。原生Goal已按连续三轮真实试点依赖未解除标为blocked，不是complete。
- 阻塞依据：完整验证并提交的轮次已请求模型配置，下一轮复核及本轮仍没有Owner提供已授权模型服务/模型名/凭据文件引用或真实文档与事件入口授权。最近专用Docker只读结果fc667d：旧试点healthy、镜像2ae332cd23df，无解析镜像；其他历史容器exited且未动。匿名镜像站检查cell1299在权限审查阶段超时、未启动子进程，不能断言本次DNS失败，也不存在可继续等待的测试句柄。未借用其他登录身份或通过改全局网络绕过。
- 恢复入口：Owner提供此次非生产试点可使用的模型配置文件位置（服务地址、模型名、凭据引用；不在聊天贴密钥），确认真实文档/群事件入口的必要授权；固定解析镜像和网络前置条件具备后继续真实隔离与六场景验证。尚未完成的未知资源创建回执、独立supervisor、主机恢复及人工验收继续保留，不能因阻塞删减目标。新的授权输入到达后重新审计阻塞，不沿用旧计数。

- 最新完整验收（2026-09-06，优先于以下历史）：80357/bd32bb exit0，完整pnpm test、pnpm typecheck、独立服务端编译/tmp/openmausbot-query-reconciliation-typecheck及diff全部通过。主集274文件通过/1跳过，2907项通过/18跳过（2925注册），347.65秒；broker7、updater15、viewer5、package-link2、save-file10、打包无node_modules启动及9路代理通过。记录保存于reconciliation-final-full-output/last，所有执行句柄终态。
- 本轮分类progress：关闭本批完整验证门禁，没有改PATH实现、测试断言或超时。上一轮PATH等待失败在隔离复测和本次完整链均未重现，但尚未确定根因，不能宣称永久消除。测试按独立临时HOME、文件串行执行，未发现与本批改动的直接因果证据。
- 保存范围：schema28自动只查询核查、异步租约时效保护、相关测试及四份状态文档共20个任务文件；提交结果以Git实际状态为准，不push。用户AGENTS.md/outputs不提交不修改。无真实钉钉、模型、凭据、容器或部署操作。
- 下一恢复入口：核对本批本地提交后转向真实试点前置条件，不能继续以本地通过替代产品验收。仍缺已授权真实模型服务/模型名/安全凭据文件位置、真实文档读取及群事件入口授权、解析镜像隔离验证、六类非生产群聊证据和Owner最终验收；未知容器创建回执、独立cgroup监督及主机恢复也未完成。Goal保持active而非complete，本轮没有再次构成连续三轮同一真实环境阻塞。

### 前序执行记录（以下失败与权限状态不覆盖上述最新结果）

- 最新执行结果（2026-09-06，优先于以下历史）：Owner明确回复“运行”后已获得执行权限，原生Goal实际为active。完整本地回归16187/28528b已终态exit1：273文件通过/1失败/1跳过，2906项通过/1失败/18跳过，423.58秒。之前五项失败及本批钉钉恢复/时效测试均通过；唯一失败是未修改的server/env-path.test.ts登录shell路径等待断言，不能因此把全量结果记通过。
- 隔离复测19519/4c744e exit0：env-path为13通过/7平台跳过（972ms），随后pnpm typecheck、独立服务端编译/tmp/openmausbot-query-reconciliation-typecheck、git diff --check通过。该失败可能具有时序偶发性，尚未确认根因，没有改用例或放宽断言。完整命令中后续broker/打包启动检查因前段失败未执行。
- 当前恢复入口：权限阻塞已解除，不沿用下方历史blocked/等待授权结论。继续核查完整套件下的PATH等待失败并取得新的完整pnpm test终态；在全量通过前不提交本批。HEAD2445b52，schema28及租约修复保持未提交、未部署；用户AGENTS.md/outputs保留。所有本轮命令已终态，原始观察存approved-full-regression-output，终态approved-full-regression-last，隔离复测approved-full-regression-followup。真实钉钉/Docker六场景与Owner验收仍未通过，总目标不标complete。

### 历史检查点（以下状态不覆盖上述最新结果）

- 阻塞收束（2026-09-06，最高优先）：原生Goal已标记blocked，非complete。本轮仅复核，分类no progress；工作区与2445b52及上一轮未提交改动一致。完整回归所需沙箱外执行权限的自动审查超时，在接续验证、异步租约修复和本轮连续存在；允许的一次重试已耗尽，没有新的Owner明确回复。前两轮曾推进局部验证/修复，但当前交付关卡仍无法跨越；不继续扩大未验证变更，不用无关实现或重复局部测试替代全量门禁。
- 已确认的终态：80343/934f41为12文件220项/typecheck/独立编译通过；37204/a7c432为旧完整链失败（所报5项已由后续局部验证覆盖修正，但当前代码尚无完整重跑通过）；cell1252/1255均审批超时、未启动子进程，其他已知句柄均终态。本轮未发新权限申请、未启动测试或部署，无Secret/身份/容器改动。
- 恢复所需输入：Owner明确允许沙箱外完整本地回归或修复执行权限。获得后先核对工作区，再运行完整pnpm test/typecheck/独立编译/diff，成功后仅本地提交任务文件，排除用户AGENTS.md/outputs，不push。之后仍需真实模型/文档及事件入口授权、解析镜像/隔离验证、六类真实群聊和Owner最终验收；全目标保持原范围，不因受阻视为完成。恢复后按新一轮阻塞审计计数。

- 本轮最新（2026-09-06，最高优先）：在未取得新的外部执行授权时继续了安全本地工作，发现并修复真实租约时效漏洞。TDD 9b69f3为4项失败，d3d338为1项失败；修复Stream维护后/发送后/后台维护后的当前租约检查、普通发送落账时效，及需求整理认领时间。80343/934f41 exit0：12文件220项（28.10秒）、typecheck、独立服务端编译/tmp/openmausbot-live-lease-time-typecheck与diff通过。全部本轮句柄终态，分类progress，Goal active。
- 当前阻碍与恢复：没有重试已耗尽的沙箱外权限申请，也没有把自动Goal续办当Owner同意。完整回归仍待授权/权限处理；HEAD2445b52不变，schema28自动核查及本轮时间修复均未提交未部署，用户AGENTS.md/outputs保留。下一步取得权限后运行完整pnpm test/typecheck/独立编译/diff，通过后仅提交任务文件。真实钉钉入口/文档/模型/解析镜像及六场景保持未验收；本轮相关证据live-lease-time-related，不可宣称产品整体完成。

- 最新接续核验（2026-09-06，最高优先）：cell1252 已终态失败，权限自动审查超时，exec_command 未创建测试进程；按工具许可唯一重试 cell1255 也在同一审批阶段超时，未运行，不再重复申请。此前 37204/a7c432 的完整链失败仍是真实完整结果，不能当作已通过。
- 已验证修正：现有权限内 41964/f3c810 exit 0，9 文件 / 168 项（16.61 秒）、pnpm typecheck、独立服务端编译 /tmp/openmausbot-query-reconciliation-typecheck 和 diff 通过，覆盖此前五项失败，断言仍保留不重复发送和后续回复继续。无新增业务代码；本轮分类 progress 为完成了修正后的实际验证。HEAD2445b52，本批自动核查/schema28仍未提交，用户 AGENTS.md/outputs 保留。
- 恢复入口：完整本地回归与打包启动仍需沙箱外测试用套接字权限；当前连续审批超时不代表安全拒绝，不无限重试，也不通过改测试绕过。向 Owner 请求明确执行授权/权限处理后再启动完整链，不复用已终态cell1252/1255。真实模型/入口/文档/镜像/六类试点仍待授权和实测；Goal active，不能缩减验收。本批并行离线检查输出见 outbox-query-reconciliation-offline-checks，相关验证终态见 outbox-query-reconciliation-recovery-validation。

- 本批最终检查点（2026-09-06，最高优先）：自动 query-only 核查实现尚未提交。完整链 37204 在 a7c432 exit 1 结束：272 文件通过/2 失败/1 跳过，2897 项通过/5 失败/18 跳过，354.76 秒；后续打包/typecheck串联未执行。失败来自 runtime-lifecycle-recovery 的四项旧调用流程期望和 runtime-repository-serialization 的 v15 迁移夹具漏删 schema28表，现已修改这两个测试，保留原消息不重发与后续消息可继续断言。
- 当前恢复调用：functions.exec cell 1252 尚未返回（两次 wait 无新输出），内部 exec_command 请求定向4文件→typecheck→完整 pnpm test→typecheck→独立编译/diff；不能确认子进程已启动，也没有可用 write_stdin session ID。下次先 functions.wait(cell_id=1252) 取得同次请求状态，若返回 session 再轮询该 session；不得重复申请或另启同测试。与之前已终止 37204 区分。工具状态 outbox-query-reconciliation-full-output 保存第一条失败链观察（部分 verbose 截断），outbox-query-reconciliation-last 为 a7c432。
- 本轮20工具轮收束，分类 progress，Goal active。HEAD仍2445b52（上一批私有回执已提交）；本批 schema28/自动核查/测试/四份状态文档为未提交任务改动，用户 AGENTS.md/outputs 未触碰。无真实身份/凭据/容器/部署变更。必须等待最终完整回归通过后，才提交本批任务文件；不能沿用上批成功结果替代本批失败。

- 本轮最新（优先）：上一批十文件已在 b4486d 成功保存为本地 2445b52，原 index.lock 限制已通过授权工具解除，没有 push。本轮从该版本推进 schema 28 自动 query-only 核查；追加独立三次预算、退避、过期查询接续、旧实例/内容漂移拒绝、正常发送交替和运行时重启验证。12 文件 / 220 项及 typecheck/diff 通过；追加运行时测试后 2 文件 / 30 项通过。完整链 37204 正在运行，不先记通过或提交。用户 AGENTS.md/outputs 保留，无部署或实际凭据/容器修改。
- 本轮恢复入口：先核实完整测试句柄 37204（输出 outbox-query-reconciliation-full-output），不重跑仍活跃进程；终态通过再保存任务提交。下一阶段验证真实平台回执与引用映射、三次耗尽后的唯一 Owner 安全恢复、未知发送/容器创建回执，以及真实模型/文档/解析镜像及六类试点授权。旧投递记录无回执不可重发；目标仍 active。

- 提交状态纠正（2026-09-06，最高优先）：上批完整链已在 14423/7d662f exit 0 结束，但随后 32c850 的 git add 因 index.lock 写权限失败（exit 128），没有形成本地提交。下方提前写入“形成本地提交”为记录错误；本轮恢复先纠正并在授权范围内完成本地保存，绝不 push。工作区十个任务文件仍在，用户 AGENTS.md/outputs 保留。

- 本批最终检查点（最高优先）：完整链 14423/7d662f exit 0，pnpm test、typecheck、独立服务端编译和 diff 全通过。Test Files 273 passed | 1 skipped (274) Tests 2891 passed | 18 skipped (2909) Start at 14:54:20 Duration 343.80s (transform 1.90s, setup 7.26s, import 4.47s, tests 312.82s, environment 13ms) 本轮 20 工具轮收束，分类 progress；受理回执存储和只查询入口已实现，后台调度未接入，Goal active。全部原始观察保存在工具状态 durable-group-receipts-full-output，最后结果 durable-group-receipts-full-terminal；此前两次初始观察另见 4019f1/75007d。本批仅十个任务文件形成本地提交，不 push。 用户 AGENTS.md/outputs 保留；schema 27、实际身份凭据和容器不变。下一步先核实终态/提交，然后接入有界 query-only 队列恢复。

- 本轮最新（优先于下方历史）：从 b0d8927 继续，上一轮仅检查点为 no progress。本轮已实现加密不可变受理回执及真实运输 query-only reconcile，已有回执优先于 session，路由移除/身份或内容漂移不重发；尚无后台调度。相关 10 文件 / 193 项及 typecheck/diff 通过；完整链 14423 正在运行，未提交、未部署，schema 27 不变。用户 AGENTS.md/outputs 未触碰。
- 下一恢复入口：完整回归终态后保存本批；继续为待核查队列接入持久次数/退避、三次停止、失效 fence 和认领时效保护的 query-only 调度，处理与 Owner 手动核查/补发竞争。不得把缺回执或 PROCESSING 分类成已确认未发送。真实平台/模型/文档/解析隔离及六类场景的未验收边界保留。

- 最新批次（优先）：普通主动群消息发送后增加一次有界状态查询；仅无矛盾 SUCCESS 标记发送成功，PROCESSING/RECALLED/查询失败不重发而进入待核查。9 文件 / 185 项及完整链通过，23002 在 fa2b11 exit 0：272 文件通过 / 1 跳过，2883 项通过 / 18 跳过，520.63 秒，全部后续类型/编译/打包检查通过。schema 27 不变，未部署，Goal active，本轮 progress。
- 当前恢复入口：接下来实现持久受理回执和后台查询恢复，避免已受理但仍处理中的消息永久依赖人工核查；本批仅单次查询、不存 processQueryKey、不持续对账，不是完整投递闭环。群文件/引用消息/主动 @ 的真实平台限制、真实模型配置、镜像及新通道授权仍未解决，不能据本地通过标记总目标完成。
- 最新前置复核（2026-09-06）：本轮分类 no progress，重新核实但未解除真实环境阻塞。显式 colima-openmausbot-pilot 中原试点 healthy、镜像仍 2ae332cd23df、无解析镜像，其他容器 exited 且未动。官方 registry 匿名 HEAD 在 6979/07acf7 exit 28，DNS 10008ms 超时；manifest inspect 的权限审查超时，进程未启动，未重复提交。所有已启动命令终态，没有构建/解析/部署。模型配置与新增接入授权仍无 Owner 回复，保留 Goal active；不得把记录更新计为实现进展。
- 当前环境恢复入口：不要据钉钉文档域名可达推断 Docker registry 可达，也不要无新证据反复拉取。需要可核验来源的固定 Python 基础镜像/离线包及依赖，或镜像站连通恢复后再构建两个解析目标并运行正式 smoke。未授权更改 DNS/代理或借用凭据；入口权限问题沿上一批审计继续，不默认接入个人账号。
- 最新批次：完成官方真实接入契约审计，发现群文件接收与现有入口假设矛盾、主动 API 不支持 @、引用原消息 ID 和出站回执映射没有已核对契约。不是业务代码修复，也不是平台所有能力的否定。详见 packaging/collaboration/dingtalk-capability-audit.md；本轮 progress 是新证据改变后续优先级，停止继续堆叠内部附件细节。
- 当前恢复入口（优先）：先验证真实测试群 @/普通消息/引用/文件事件及授权在线文档入口；新个人事件通道仅为待评估方案，身份/权限需要 Owner 授权，不自动接入。官方文档沙箱外访问已成功，因此不能继续沿用“所有外网不可用”的泛化判断；Docker registry 未在本轮复测。真实模型配置仍待 Owner 提供。业务基线 943a0ed 完整回归有效，本批仅文档变更，无部署或真实群操作，Goal active。
- 最新批次（优先于下方历史）：附件选择定向澄清已实现；显示原序号/文件名并向持久来源中的材料提供者提问，避免等待选择时又索要重复上传。9 文件 / 243 项相关回归通过，完整链 2535 在 41f6db exit 0：272 文件通过 / 1 跳过，2870 项通过 / 18 跳过，371.09 秒，类型/独立编译/打包全部通过。schema 27 未变，未部署。
- 当前恢复入口：attachment-replacements 派生有界来源问题，attachment-completeness 用依赖顺序安排提问，现有 clarification-recipients 校验实际 staff 身份。仅明确的新材料选择场景；复杂冲突改选、多个新材料、已用事实变更仍未完成。真实模型配置已向 Owner 询问服务地址/模型名/凭据文件路径，不要求在聊天贴密钥；尚无新配置证据。真实文档授权、解析镜像及六类群聊仍待验收。Goal active，本轮 progress。
- 最新批次（优先于下方历史）：多附件原序号/唯一文件名选择及单独后续回复选择已实现，确认回复明确原消息第几份、原文件保留和尚未开始修改。相关 8 文件 / 223 项与补充单文件 51 项/typecheck 通过；完整链 34020 在 35105c exit 0，272 文件通过 / 1 跳过，2866 项通过 / 18 跳过，332.08 秒，后续全部类型/编译/打包验证通过。schema 27 不变，未部署。
- 当前恢复入口：附件选择现支持单份新材料对同条原消息的指定旧附件；选择来源哈希与原序号进入 Spec 应用收据。继续补多个新文件、冲突后的改选、已用事实变更与更广泛自然表达；真实模型/在线文档授权、固定解析镜像和六类群聊仍未验收。AGENTS.md/outputs 保留不提交，当前批次分类 progress，Goal active。
- 最新批次：可读附件替代来源关联已实现，原提供者/原消息引用/单份完整正文校验，保留双方来源和旧错误，防止他人或含糊替代跳过材料门禁。相关 8 文件 / 205 项及完整链通过；59762 在 8c4f9f exit 0，272 文件通过 / 1 跳过、2847 项通过 / 18 跳过，后续类型/编译/打包验证全通过。schema 27 不变，未部署。
- 本批恢复入口：attachment-replacements.ts 提供来源派生关系，attachment-completeness 与 natural-intake 共同核对并记录。后续继续补多文件/多个有效替代的明确选择与广义自然表达、已使用材料变更的受控确认；不能要求用户按本批支持的短语作为产品唯一协议。真实模型/文档/Docker 六类群聊仍未验收，不将本地关联成功当群内已上线。
- 当前批次：附件正文已读取后，需求整理的过期认领已接入持久失败/退避/三次停止机制。先行两项行为失败已修复，7 文件 / 181 项与 typecheck 通过；中断后的 Owner 恢复/重放/不重下载覆盖通过。完整链 79813 在 a89bcd exit 0：272 文件通过 / 1 跳过，2835 项通过 / 18 跳过，全部后续验证通过。schema 27 不变，未部署或改实际凭据。
- 上一批次：schema 27 文档资源安全恢复已实现；13 文件 / 218 项相关回归通过。完整链 99898 在 db403f exit 0，272 文件通过 / 1 跳过、2833 项通过 / 18 跳过，类型检查、独立服务端编译和打包验证全通过。恢复只面向旧实例已知 ID，不能当作真实文档或主机重启验收。
- 恢复入口（优先于历史）：document-resource-recovery 已接入 headless 附件批次。继续处理未知创建回执、三次耗尽后的授权恢复和实际容器隔离验证；真实模型仍需 Owner 提供已授权配置的安全文件位置，在线文档需实际读取授权，不能借用其他登录身份。用户 AGENTS.md/outputs 不动。真实试点仍是旧版本，解析器未启用；不得据本地代码称群内已修好。
- 阶段：2026-09-05 新 Goal，先修复连接与运行状态，再实现语义协作和证据闭环。
- 总状态：进行中；历史局部回归不能证明产品目标达成，六类真实试点均需按新标准验收。
- 当前恢复入口：读取本节及 `SPEC.md`、`DECISIONS.md`、`VERIFY.md`。禁止只根据下方历史“已完成”标签判断全产品就绪。
- 预算来源：当前续办目标要求每批最多 20 工具轮 / 4 小时，按目标执行；这不是 goal-protocol 的默认硬限制。未指定 token 预算。分批保存证据，不能将未完成 Goal 标记完成。

## 新 Goal 分阶段验收

1. 可靠性：单一重连调度、注册等待、退避、连接恢复后的 intake/outbox 解锁；排队任务重启恢复另行验证。
2. 自然协作：受限结构化解释、多轮确认、自然关联、引用机器人回复、定向澄清；不增加固定格式要求。
3. 文档：复杂格式隔离提取、完整性提示、真实在线正文授权读取、Bug 结构化来源。
4. 交付：断言级覆盖、独立复测、语义风险门禁、证据生成简练业务结论。
5. 六类真实 Docker 试点；每类留存事件、Spec、候选、测试和回复证据，人工 Owner 动作不得模拟冒充。

## 本批执行记录

### 主动群消息实际发送确认（2026-09-06，完整回归通过）

- 从 db8fdc0 干净任务工作区接续，上一轮 no progress。检查发现还有不需新增身份的实质实现：当前主动发送拿到查询标识即写 sent。先行 e7aaa1 exit 1：7 失败 / 35 跳过；实现查询后 87284/ab791d exit 0：6 文件 / 126 项/typecheck/diff。
- 新增查询可能突破默认认领时间，先行 6bddef exit 1：2 失败 / 17 跳过；查询限定四秒，共用请求器仅允许缩短原八秒上限。扩展 9542/6b4a99 exit 0：9 文件 / 185 项（5.23 秒）、typecheck/diff 通过。覆盖不一致/未知/撤回/处理中的状态、固定 app/群参数、无回执泄露、头和正文挂起、实际生产运输+Outbox 重建不重发。
- 完整命令 pnpm test/typecheck/独立服务端编译 /tmp/openmausbot-group-delivery-confirmation-typecheck/diff：23002 在 fa2b11 exit 0。272 文件通过 / 1 跳过，2883 项通过 / 18 跳过（2901 注册），520.63 秒；broker 7、updater 15、viewer 5、package-link 2、save-file 10、打包脱离 node_modules 启动/9 路代理全通过。输出工具状态 group-delivery-confirmation-full-output；部分 verbose 输出截断，汇总和终态完整可见。所有句柄终态。
- 十一个任务文件保存本地提交，不 push、不部署、不操作真实凭据/群消息/容器。真实 SQLite/生产运输装配，HTTP 使用受控合成回执；不是实际钉钉投递证明。待核查仍用原队列和 Owner 流程，本批没有持久自动查询恢复能力。

### 附件选择定向澄清（2026-09-06，完整回归通过）

- 从 c9d5adb 的干净任务工作区继续，用户 AGENTS.md/outputs 未触碰。先行 3d3280 exit 1：1 失败 / 51 跳过，实际卡片没有文件选项和答复路径。实现后 55686 在 ec77e3 exit 0：4 文件 / 99 项及 typecheck/diff。
- 扩展不同事项创建者/材料提供者、实际 Markdown/at 列表、未读门禁继续存在、回答后选择问题消失、部分正文/他人材料不冒充可用替代。21199 在 42b0d7 exit 0，主输出 023358：9 文件 / 243 项（12.34 秒）、typecheck/diff 全通过。
- 完整 pnpm test/typecheck/独立服务端编译/diff：2535 在 41f6db exit 0，272 文件通过 / 1 跳过，2870 项通过 / 18 跳过（2888 注册），371.09 秒；broker 7、updater 15、viewer 5、package-link 2、save-file 10、无 node_modules 打包启动/9 路代理全部通过。原始输出工具状态 attachment-question-full-output。所有句柄终态。
- 七个任务文件形成本地提交，不 push、不部署，不修改真实身份/配置/容器。测试为真实 SQLite/生产协调器/真实消息渲染加合成材料；不是实际钉钉投递、真实模型、在线文档授权或解析容器隔离证明。按当前恢复入口继续，不将局部澄清完成替代产品目标。

### 多附件精确选择与后续确认（2026-09-06，完整回归通过）

- 从 895089a 接续三个未提交任务文件。先前 81794 在 eff51a exit 1：7 失败 / 42 通过；初修相关三文件 115 项通过，扩展相关八文件 223 项通过。后续加强实际回复断言，30f140 exit 1：3 失败 / 47 跳过，证明单独选择回复没有明确确认。
- 补充基于持久 selectionSources 的反馈，模型入口和兼容入口共用来源核对；70624 在 4772b3 exit 0：8 文件 / 223 项及 typecheck/diff。新增自然解释待处理时即时确认和重放不增 revision 的覆盖，29490 在 cfc8f3 exit 0：51 项及 typecheck/diff。
- 沙箱外权限审查首次超时，测试进程未启动；按工具许可重试一次成功。完整 pnpm test/typecheck/独立服务端编译/diff：34020 在 35105c exit 0；272 文件通过 / 1 跳过，2866 项通过 / 18 跳过（2884 注册），332.08 秒。broker 7、updater 15、viewer 5、package-link 2、save-file 10、打包无 node_modules 启动和 9 路代理全通过。原始输出保存在工具状态 attachment-selection-full-output；所有句柄终态。
- 真实 SQLite、生产协调器、合成材料与受控解释器验证来源/剩余门禁/并发历史/重建及 Spec 收据；不是实际群聊或文档解析容器证据。七个任务文件保存本地提交，不 push、不部署，不改真实配置或其他容器。停止扩展本批范围，后续从当前恢复入口继续。

### 可读附件替代来源（2026-09-06，完整回归通过）

- 上轮 7280398 已提交且全量通过，分类 progress；用户 AGENTS.md/outputs 保留。新模块从同群同事项入站原消息和完整正文推导原提供者的单份未读材料替代，保留新旧附件与错误；无 schema/真实配置修改。
- 33249 在 fad711 exit 1：3 行为失败 / 26 通过；98494 在 2b8d57 exit 0：3 文件 / 95 项/typecheck/diff。58787 在 510665 exit 0：8 文件 / 203 项/typecheck/diff。42042 在 674823 exit 1：2 行为失败 / 30 通过，后修正纠错门禁和多个有效替代的歧义。
- 最终相关 8 文件 / 205 项（11.05 秒）通过。完整链 59762 在 8c4f9f exit 0：主集 272 文件通过 / 1 跳过，2847 项通过 / 18 跳过（2865 注册），311.84 秒；broker 7、updater 15、viewer 5、package-link 2、save-file 10、打包无 node_modules 启动/9 路代理、全仓 typecheck、独立编译及 diff 通过。所有句柄终态，10 个任务文件保存本地提交，不 push、不部署。
- 已测：否定/引用/他人/多附件/部分正文不跳门禁，原提供者后续纠错可继续，两个有效替代不选最新；来源关系进入自然模型应用收据和指纹，源状态漂移恢复门禁，重放/重建无新副作用，过时失败回复不再发送，业务回复明确原文件保留且尚未修改。
- 边界：当前只有有界明确表达、原消息引用、单份未读旧材料与完整新材料路径；多文件/多版本选择、自由语义扩展、已用事实变更仍未完成。真实模型/在线正文权限、解析镜像隔离、六类群聊和系统重启/Owner 验收保持待办。Goal active，本轮分类 progress。

### 附件需求整理中断恢复（2026-09-06，完整回归通过）

- 上轮 da9dda7 已提交且全量通过，分类 progress。当前仅用户 AGENTS.md/outputs 原有未跟踪，保持不动。只修改附件投影认领/结算及相关测试和四个状态文件，不改 schema/权限/实际配置。
- 先行 86896 在 b4aa93 exit 1：2 行为失败 / 44 通过，确认旧 token 过期被静默替换且不记录尝试。修复后 6804 在 db30db exit 0：7 文件 / 181 项/typecheck/diff 通过。后补 Owner 恢复链后定向 46 项通过。
- claim 在同一事务结算旧过期 token、记录失败/必要通知并设置退避，连续三次同类不可用后停止；不重下正文，不抹掉历史，迟到原回调不能覆盖。首次/第三次通俗通知、写失败整体回滚、活跃认领不抢占和 Owner 恢复重放一次均已验证。
- 完整链 79813 在 a89bcd exit 0；主集 272 文件通过 / 1 跳过，2835 项通过 / 18 跳过（2853 注册），418.20 秒；broker 7、updater 15、viewer 5、package-link 2、save-file 10、打包无 node_modules 启动/9 路代理、全仓 typecheck、独立编译及 diff 全通过。较慢的 comms 测试实际通过，未重启或放宽超时。所有句柄终态，本批 6 文件保存本地提交，不 push、不部署。
- 仍待：真实模型授权/文档镜像隔离及在线正文权限、六类群聊、真实出站引用/送达和主机重启/Owner 验收。另确认旧失败附件在重新上传成功后仍参与完整性门禁，当前没有“新材料明确替代旧材料”的安全关联机制；后续应保留双方来源、明确替代意图和完整性证据，不能仅凭同名文件或一句已读完绕过。Goal active，本轮分类 progress；本批未处理真实附件或冒充实际进程强杀。

### 文档资源实例绑定恢复（2026-09-06，完整回归通过）

- 从 8b1c8f7 之后已有未提交恢复代码继续；补齐 v26 真实行迁移、headless 实例绑定和恢复先于新摄取的测试。schema 27 保留旧行空归属，不回填历史权限。只查旧 fence/同 context/已知 ID，并核对实际身份后按 ID 清理、独立查缺；每条预算最多三次且不可倒退。
- 先行 46761 在 dcd7b3 exit 1，5 行为失败 / 14 通过，发现末条资源的取消/租约失效被吞掉；修复传播。39467 在 7995fe 两文件 53 项通过。90098 在 fced42 13 文件 / 218 项、typecheck/diff 通过。
- 完整链 99898 在 db403f exit 0：主集 272 文件通过 / 1 跳过，2833 项通过 / 18 跳过（2851 注册），262.12 秒；broker 7、updater 15、viewer 5、package-link 2、save-file 10、打包无 node_modules 启动/9 路代理、typecheck、独立编译及 diff 通过。所有已跟踪验证句柄终态。保存本任务本地提交，不 push、不部署。
- 只读指定 Colima context 的现有试点 healthy，历史容器仍 exited；未操作真实模型、群消息、凭据或文档。未知 ID/旧版归属仍留存；稍后已知 ID 入账才可参与后续恢复。本批不证明真实强杀、创建永久无回执、独立 supervisor 或完整主机重启，六类群聊和 Owner 验收保持未完成。Goal active，本轮分类 progress。

### 文档资源持久归属（2026-09-06，完整回归通过）

- 上轮 a681eb9 已提交且全量通过，分类 progress。本轮确认没有持久容器身份，新增 schema 26 主账本记录并接到 headless 实际工厂。初始只有用户 AGENTS.md/outputs，保持不动，不部署、不改实际凭据或容器。
- TDD 72516 exit 1（0da3f2）：4 项行为失败 / 39 通过，新增 journal 模块缺失导致 1 文件无法收集。初修 13698 exit 0（41e50c）：4 文件 / 67 项/typecheck/diff。扩展标签测试 27460 exit 1（c5d9c3）：3 标签行为失败及 2 启动/版本问题；12000 exit 1（df8336）仅剩参数属性不兼容 strip-only 与旧 user_version 断言，已修正。
- 35221 exit 0（528216）：11 文件 / 173 项、typecheck/diff。覆盖生产工厂创建前入账、ID 先落库再 start、记录重建、清理/回执丢失、各写入点故障、不可篡改及 v25 升级不造历史归属。没有用模块缺失或夹具问题冒充行为证据。
- 完整链 11909 在 d861b2 exit 0：271 文件通过 / 1 跳过，2808 项通过 / 18 跳过（2826 注册），440.34 秒；broker 7、updater 15、viewer 5、package-link 2、save-file 10、打包脱离 node_modules 启动及 9 路代理、typecheck、独立服务端编译及 diff 全通过。所有句柄终态，17 个任务文件保存本地提交；用户 AGENTS.md/outputs 不动，不 push、不部署。
- 恢复入口：document-resource-journal 已在 headless 使用，schema 26；readUnresolved 只读最多 100 条且仅当前 context。下一批应绑定失效运行实例、核对实际容器 name/label/image/ID 并处理创建迟到后，才接入自动回收。现有记录本身不证明实例已死或无遗留，清理 acknowledgement 不是独立 inspect。真实隔离/文档/模型/六类群聊和 Owner 验收保持未完成。

### 文档解析停止传播（2026-09-06，完整回归已验证）

- 上轮 6afc5d6 已提交/完整回归通过，分类 progress；初始仅用户 AGENTS.md/outputs，保持不动。本轮用受信任生命周期上下文连接协调器、配置工厂、解析器与 Docker CLI；不改 Owner 权限、身份凭据或实际试点。
- TDD 8468 exit 1（dcee4c）：6 项行为失败及 2 项 ESM spy 夹具失败。修正夹具为透传真实 spawn 后，34754 exit 1（8aec05）复现已取消仍启动和运行中取消被忽略直到超时；没有用夹具失败冒充功能证据。
- 初修 57925 exit 0（838723）：3 文件 / 59 项与 typecheck/diff。扩展 58471 exit 0（1e0575）：8 文件 / 126 项及 typecheck/diff，覆盖真实本地 CLI close/SIGKILL/监听释放、headless 信号传播、创建后认领失效不 start、清理期间取消不交付正文及清理失败优先。
- 完整链 30505 在 20751d 已终态 exit 0：270 文件通过 / 1 跳过，2801 项通过 / 18 跳过（2819 注册），390.25 秒；broker 7、updater 15、viewer 5、package-link 2、save-file 10、打包脱离 node_modules 启动及 9 路代理、typecheck、独立服务端编译和 diff 均通过。所有句柄终态，本批 12 个任务文件保存本地提交，不 push、不部署。
- 实际 Node 子进程取消和受控 Docker 端口不等于真实文档容器验证。create 仍使用原 30s 超时，不随普通 abort 打断创建回执；强杀后持久清理、创建迟到和 daemon 失联恢复尚待实现/验证，不能宣称无遗留。接续先检查资源持久记录/认领和独立清理机制，不能按名称前缀批量删除未知容器。
- 本轮未重复镜像站 DNS 检查、未拉取或构建镜像、未变更现有容器。Goal active；真实隔离 smoke、在线正文授权、模型配置、六类群聊与完整重启/Owner 验收仍待完成。

### 文档解析 headless 装配（2026-09-06，完整回归已验证）

- 接续轮分类 progress：上一轮已实现接线且获得真实失败证据。本轮获准沙箱外运行同一完整链，72315 在 92ea6e 已终态 exit 0：270 文件通过 / 1 跳过，2793 项通过 / 18 跳过（2811 注册），314.68 秒；broker 7、updater 15、viewer 5、package-link 2、save-file 10、打包脱离 node_modules 启动及 9 路代理、typecheck、独立服务端编译、diff 均通过。未修改失败测试或跳过门禁，原失败已重验清除。

- 上一轮仅检查点回复，分类 no progress；本轮核对 HEAD 053f055 和干净任务工作区后推进实际装配。仅用户 AGENTS.md/outputs 原有未跟踪，保持不动；本批代码/测试/状态文档尚未提交，不 push、不部署、不变更真实凭据/配置。
- TDD 57962 exit 1（eae2b0）：5 失败 / 45 通过，复现 PDF 没有进入 headless 配置解析器、失败/取消路径未到达，以及仅设置镜像会启用配置函数。生产工厂注入 extract，新增严格显式开关、固定镜像及命名 context 前置要求。
- 修复后 59221 exit 0（af0598）：3 文件 / 61 项、pnpm typecheck、git diff --check 通过。实际 headless 工厂/协调器/SQLite 加受控 Docker 与下载端口验证完整、部分、失败、禁用、停止后迟到结果和重建去重，来源哈希/固定解析版本/位置/不可信与不完整标记保留。不是实际 Docker 解析或群聊通过。
- 历史沙箱内完整链 95895 在 07d0f1 exit 1：29 文件失败 / 241 通过 / 1 跳过，28 项失败 / 2536 通过 / 247 跳过，16 未处理错误，623.21 秒。包含端口/socket listen EPERM 和超时，后续串联命令未执行；以上沙箱外同候选完整通过为新验证结果，保留失败记录，不再轮询这两个已终态句柄。
- 本轮显式 context 只读检查 d67187 确认现有试点 healthy、镜像仍 2ae332cd23df，无 Python/解析器镜像；其他旧容器保持退出不动。官方 registry 匿名 HEAD 会话 40559 在 620e88 exit 28，DNS 10010ms 超时。未拉取、构建、修改网络或重建服务，不能启用真实附件解析。
- 本批 10 个任务文件保存本地提交，不包含用户 AGENTS.md/outputs，不 push、不部署。所有测试和网络检查句柄终态。下一步优先补文档解析停止/清理恢复边界；网络恢复后执行固定镜像构建和真实隔离 smoke。仍需在线文档与模型授权、六类群聊、真实回复引用/送达、历史恢复及完整主机重启/Owner 人工验收。Goal active。


### 普通直接控制与回复原子化（2026-09-06，已验证）

- 上轮 e6ce86e 已提交/完整链通过，分类 progress；本轮按 goal-protocol 接续，初始只有用户 AGENTS.md/outputs，保持不动。schema 25 不变，无外部配置/身份/凭据或群消息变更。
- TDD 47504 exit 1（ff4398）：7 失败 / 48 通过，六类控制回复写失败不回滚已提交动作/审计，且入站事件可被再当控制。初修 62107 exit 0（bd15aa）：5 文件 / 118 项、typecheck/diff 通过。反向事件复用先行 84067 exit 1（b04e53）：1 失败 / 13 通过，控制事件可另建任务；补入站拦截。
- 扩展真实候选批准的 Outbox 故障回滚/再试成功及双向冲突后，49469 exit 0（24cf06）：7 文件 / 142 项/typecheck/diff 通过。控制器原事务内新增受信任回复 opt-in；旧核心调用默认不发消息，runtime 兼容入口不改历史收据/来源。
- 完整链 77419 已 exit 0：270 文件通过 / 1 跳过，2786 项通过 / 18 跳过（2804 注册），366.70 秒；broker 7、updater 15、desktop-viewer 5、package-link 2、save-file 10、打包脱离 node_modules 启动及 9 路代理、typecheck、独立服务端编译、diff 全通过。所有句柄终态。新增 owner-command-reply.ts、六个修改代码/测试文件与四个状态文档共 11 文件保存本地提交。
- 只读确认下一阶段装配缺口：headless 的 attachmentIngestionFactory 创建协调器时没有传 extract；协调器已有可注入 extract 端口，固定镜像提取器已有受控测试。后续可先测试先行补显式装配和配置边界，不在真实镜像/隔离 smoke 未完成前启用处理真实附件，不把本地接线当文档试点通过。
- 后续仍需历史缺回复的可核查恢复、卡片真实群来源/送达证据、旧输入/下载恢复、真实文档解析装配与验证、已授权模型及六类真实群聊、完整主机重启与 Owner 人工验收。Goal active，不 push、不部署。

### Token 审批事件与文本回复原子化（2026-09-06，已验证）

- 上轮 d6471b3 已提交/全量通过，分类 progress；本轮按 goal-protocol 接续。初始只有用户 AGENTS.md/outputs，保持不动；schema 25 不变，无真实身份/凭据/配置/钉钉/Docker 变更。
- TDD 9740 exit 1（5158fb）：3 失败 / 49 通过，复现文本来源缺失、拒绝重放未去重及 Outbox 写失败不能撤销已提交控制。实现原控制器事务内 token_action 收据与文本回复，runtime 传递规范化来源、不再另行入队该文本回复。
- 初修 86895 exit 0（684535）：5 文件 / 94 项/typecheck/diff 通过；扩展改群/身份/入口拒绝、拒绝不随后续合法动作变成功、卡片不猜群后 39221 exit 0（2d7d29）：7 文件 / 119 项/typecheck/diff 通过。
- 验证实际 SQLite 控制/token 消费/收据/Outbox 整体回滚，重复事件无新动作/回复，规范化文本经 runtime 重建和生产发送器/受控 fetch 回到原群；卡片仅记录无群结果，不新增消息。独立旧 OwnerCardActionBridge 未在 headless 装配中使用，本批不迁移其独立库。
- 完整链 54142 已 exit 0（64ea61）：pnpm test 全部子命令、typecheck、独立服务端编译与 diff 全通过；打包脱离 node_modules 启动及 9 路代理通过。主集汇总在 5f7c8d 输出截断区，本批不补造数量/耗时。后续临时 JSON 定位 d9cf8a 未找到文件而退出 1，属于只读报告检索失败，不是测试失败，也未重启完整测试。
- 所有句柄终态。核心新模块 token-action-receipt.ts、八个修改代码/测试文件及四个状态文档共 13 文件保存本地提交；AGENTS.md/outputs 不动，不 push、不部署。
- 剩余：普通直接控制的动作/回复跨事务恢复、卡片真实来源与送达回执、历史输入/下载恢复、真实文档/模型六类试点及完整主机重启/Owner 人工验收。Goal active，不部署、不 push。

### 状态查询与刷新审批收据（2026-09-06，已验证）

- 上轮 c029190 已提交且全量通过，分类 progress；本轮按 goal-protocol 接续。初始只有用户 AGENTS.md/outputs，保持不动；schema 25 不变，无真实钉钉/模型/凭据/Docker 变更。
- TDD 37157 exit 1（29f7c1）：4 失败 / 29 通过，复现缺收据、刷新拒绝重放变成功、无原子回滚。新增 owner-query-receipt，生产 runtime 持久化查询原始结果和群；入队 savepoint 支持外层事务；入站/token 路径拒绝查询事件复用。
- 初修 16946 exit 0（64e3c4）：4 文件 / 85 项/typecheck/diff。扩展成功刷新与 supersession 回滚、旧无收据回复不补来源后，49945 exit 0（b922e8）：6 文件 / 109 项；清除旧错误重放分支后 67067 exit 0（493286）：同 109 项、typecheck/diff 通过。
- 覆盖真实 SQLite + runtime 重建 + 生产发送器/受控 fetch：状态/拒绝结果重放不变，改群/事项/身份/命令冲突，旧回复不猜成功，不重复刷新，写收据失败不遗留回复或 supersession。不是线上试点或完整主机重启证明。
- 完整链 15574 已 exit 0（712852）：270 文件通过 / 1 跳过，2774 项通过 / 18 跳过（2792 注册），354.11 秒；broker 7、updater 15、desktop-viewer 5、package-link 2、save-file 10、打包脱离 node_modules 启动与 9 路代理、typecheck、独立服务端编译及 diff 全通过。所有句柄终态；本批 9 个任务文件保存本地提交，不 push、不部署。
- 后续仍需 token 文本/卡片回复来源、直接控制动作与回复跨事务恢复、旧输入/下载恢复、真实文档解析与模型授权、六类群聊及主机重启/人工验收。Goal active，不缩小完成标准。

### 直接文本控制回复来源（2026-09-06，已验证）

- 上轮 e86de44 获得新的 Docker/DNS 前置证据，分类 progress；本轮按 goal-protocol 转向无需外部模型/网络的控制回复来源。初始只有用户 AGENTS.md/outputs，保持不动。
- TDD 74645 exit 1（7ea8f1）：7 失败 / 29 通过，证明来源未由解析器/控制决定保留。修复后 48696 exit 0（843998）：6 文件 / 94 项、typecheck/diff 通过；增加允许控制、旧收据不补来源及收据写失败回滚后，18489 exit 0（4597e9）：6 文件 / 97 项、typecheck/diff 通过。
- 覆盖暂停/恢复/重试/取消/批准/退回被拒绝仍按请求群回复、Owner 允许暂停、发送器重建、改群重放拒绝、旧审批收据不按目标事项猜群、来源写失败回滚控制/审计。均为生产装配+SQLite+受控 fetch，无真实钉钉或 Owner 身份变更。
- 完整链 16925 exit 0（0b5f70）：270 文件通过 / 1 跳过，2769 项通过 / 18 跳过，2787 注册，421.03 秒；broker 7、updater 15、desktop-viewer 5、package-link 2、save-file 10、打包脱离 node_modules 启动及 9 路代理、typecheck、独立服务端编译、diff 均通过。所有句柄终态；本批 12 个任务文件本地保存，不 push、不部署。
- 剩余：状态查询/刷新审批/token 卡片回复来源、控制动作已提交但回复未入账的恢复、真实回执映射、旧输入/下载恢复、真实文档/模型六类试点及主机重启/人工验收。Goal active，不部署、不 push。

### 文档解析 Docker 前置复核（2026-09-06，未构建）

- 前一轮仅交接摘要，分类 no progress；本轮重新读取目标、技能和当前工作区，基于 4b20d9c 接续。初始只有用户 AGENTS.md/outputs 未跟踪，保持不动。
- 首次沙箱 Docker 查询 671e66 被套接字权限拒绝；cell 951 权限审查超时，未启动沙箱外 Docker 进程。按提示重试一次，cell 954 / 8a6d98 exit 0：指定 colima-openmausbot-pilot 的现有服务 Up 2 days (healthy)，其余历史容器为 Exited；没有文档解析镜像。未重启、删除或替换容器。
- Docker 有内置 manifest inspect，不必为清单查询安装 buildx。上一续办 buildx 缺失没有触发网络请求；本轮另行匿名检查官方 registry-1.docker.io/v2/，沙箱内 c164b2 无法解析，沙箱外 55383 / 859561 exit 28 为 Resolving timed out after 10011 milliseconds。这是 DNS 超时，不是镜像不存在或解析器测试失败。
- 因无法取得可信基础镜像清单、且本地没有 Python 解析镜像，本轮未启动构建、拉取或文档 smoke。未改 DNS/代理、安装插件、借用凭据或在宿主机解析真实附件。所有命令/cell 均终态，无待轮询句柄。
- 只读确认 configuredDocumentExtractor 尚未由主服务工厂使用。隔离 smoke 日后通过后，仍需测试先行完成显式装配、正文来源/恢复与真实群验收，不能只设置环境变量宣称上线。本轮仅更新文档，未重跑未变业务代码的完整回归。
- 接续：网络恢复后取得固定 Python 镜像，分别构建 runtime/parser-tests 并执行正式 Docker smoke；网络受阻期间可推进普通 Owner 控制回复的持久化来源。模型授权、六类真实试点、主机重启及人工验收仍未完成，Goal active，未将网络前置阻碍认定为全目标无路可进。

### 自然需求/附件恢复回复来源（2026-09-06 当前批）

- 上批 ab92f12 已提交且全量通过，分类 progress。本批读取 goal-protocol 接续，初始仅用户 AGENTS.md/outputs 未跟踪，保持不动；schema 25 不变。
- TDD 70865 exit 1（5e50ba）：17 通过 / 2 失败，恢复请求无可用备用路由。扩展成功恢复来源断言后 48909 exit 1（20b862）：68 通过 / 4 失败，确认需求和附件允许恢复的收据同样缺来源。
- 两类恢复结果新增可选 conversationId 并在原事务持久化；路由从现有不可变收据读取。55508 exit 0（5a50ad）：6 文件 / 123 项、typecheck/diff 通过。追加真实 Outbox dispatch 和发送器重建不重发后，60598 exit 0（582add）：同 123 项/typecheck/diff 通过；随后补来源插入失败整体回滚断言。
- 覆盖真实生产装配+SQLite+受控 fetch、改群重放拒绝、旧收据不补造路由、拒绝恢复仍正确回原群、允许恢复/原证据和权限不变、发送成功后不重复。此为本地受控数据，不是真实钉钉/主机重启证明。
- 15995 exit 0（043cd2）：新增回滚用例后路由 21 项及 typecheck/diff 通过。完整链 64739 exit 0（a8c966）：270 文件通过 / 1 跳过，2760 项通过 / 18 跳过，2778 注册，314.01 秒。附属测试、打包无 node_modules 启动与 9 路代理、typecheck、独立服务端编译及 diff 全通过；所有句柄终态。本批 11 个任务文件按规则保存本地提交，不 push、不部署。
- docker-helper 只读核查 b64fcf：指定 colima-openmausbot-pilot 中现有 openmausbot-collaboration-pilot running/healthy、restart=unless-stopped，镜像 local 的本地 ID 2ae332cd23df；其他现有容器均保留，未重启/删除/替换。镜像列表未见专用文档解析镜像；此检查不是新代码已运行、真实 Stream 已连接或文档试点通过的证明。后续可从 packaging/collaboration/document-parser/Dockerfile 与 server/collaboration/operations/document-extractor.smoke.ts 继续准备隔离解析试点。
- 仍无真实模型授权配置答复。恢复入口为本批 Git 提交、本节及 VERIFY；普通 Owner 文本/卡片回复的来源、真实文档/模型六类试点、历史输入回补、下载恢复和完整主机重启/人工验收仍未完成。Goal active，按 20 工具轮内收束，不把全量本地回归当产品最终验收。

### 多群路由与测试隔离完整验收收束（2026-09-06 当前批）

- 上轮分类 progress；恢复核对 8 个任务文件及用户原有 AGENTS.md/outputs，未覆盖他人修改。目标仍为完整 PMO 自然协作闭环，不缩为路由或测试修复。
- 完整链 13203 已 exit 0（9e00ed）：270 文件通过 / 1 跳过，2756 项通过 / 18 跳过，2774 注册，343.32 秒。broker 7、updater 15、desktop-viewer 5、package-link 2、save-file 10 通过；打包服务无可访问 node_modules 启动及 9 路代理通过；typecheck、独立服务端编译、diff 全通过。原 Chief 用例约 430ms，88 项 API 全通过，不调整断言/时限。
- 已无运行中验证/当前候选测试失败，可按仓库规则将这 8 个任务文件保存为本地提交；不 push、不部署。下方历史未提交/验证失败状态已由本节取代，保留诊断历史而不伪称从未失败。其他 comms 用例本轮仍有接近 20 秒的耗时但均通过，不声明所有测试环境延迟均已消除。
- 只读核查确认：普通 Owner 命令/卡片文本动作类型尚无 conversationId，需求/附件恢复收据也没有保存来源群。未来应随持久化响应原子保存新请求来源，历史缺失来源不可由目标事项猜测；尚未实现这些后续改动。
- 已向 Owner 异步询问真实试点的已授权模型地址、模型名和凭据文件位置（禁止贴密钥），当前尚无答复/授权配置。本轮无真实模型/文档调用、无真实钉钉发送/运行配置变更。
- 恢复入口：核对本批 Git 提交与本节，继续完善控制回复来源/重启路由及真实模型/文档六类试点。卡片消息回执映射、旧输入回补、下载停止恢复、完整主机重启和最终 Owner 人工验收仍未完成。Goal active；本批按 20 工具轮内收束，不将完整本地回归当作产品线上验收。

### 完整回归超时根因定位与测试环境隔离（2026-09-06 当前批）

- 上轮分类 progress：已实现多群路由并得到可重复的 gate 超时证据。本轮按 goal-protocol / diagnosing-bugs 接续，不把工具观察超时当进程终止，不放宽原 20 秒测试时限。
- 临时请求计时 43610 exit 1（868336）显示前两次 POST /api/bots 各 8040/8031ms，尚未进入 Chief 断言；此为第三次同超时，随后停止重复原用例，改用只读探测。模拟 CLI 直接 --version/auth 各 60/55ms（eaae09），排除模拟 CLI 固定挂起假设。
- 94704 / 58337 / 85713 均终态通过，但没有提供完整诊断输出，不能据其偶然通过宣称根因解决。临时诊断 63079 exit 1（e98cb9）为主动抛出时序记录：实际服务除 fake Claude 外还探测多个非模拟 CLI。config.ts 的 instanceConfigs 在配置含 claude 时自动补齐 cursor/openaiCompat/qwen/hermes/pi；原 API 夹具未封住该入口，导致开发机工具安装状态影响测试耗时。此为测试环境泄漏，不是 Chief 规则或钉钉路由变更引起的已证实业务故障。
- 仅修正 index.test.ts：从正式配置装配计算补齐项，显式替换为未知驱动 shadow，保留真实模拟 Claude/HTTP/全部原断言/20 秒时限；新增断言保证其余实例都是 unavailable shadow。生产 config/procs/权限实现未改；临时计时和主动失败诊断已删除。
- 原完整 API 套件 + config + delivery-routing，53158 exit 0（046931）：3 文件 / 146 项通过，总 9.62 秒，typecheck/diff 通过。包含原失败用例和全部 88 项 HTTP 测试，不用单测筛选代替原场景。
- 按 20 工具轮批次收束：尚未重跑完整 pnpm test 及被前轮中断的附属/打包检查，故本批和多群路由仍未提交。当前 8 个任务文件，用户 AGENTS.md/outputs 保留；无运行中测试，最新提交仍 0c6ef68，不 push、不部署。
- 接续优先：获沙箱外本地端口权限后运行完整 pnpm test → typecheck → 独立服务端编译 → diff，全部通过再保存任务专属提交；然后回到真实来源群/控制回复、文档/自然群聊和六类试点剩余项。Goal active，不把测试环境修复当产品目标完成。

### 多群备用投递来源绑定（2026-09-06 当前批）

- 已恢复并保存上批 Owner 查询本地提交 0c6ef68，用户 AGENTS.md/outputs 未动，不 push。此前提交权限超时已如实记录。
- TDD 0184f9：4 项中 3 失败，已复现多群共用默认备用地址和非白名单来源错误发送。新增可信映射、持久化来源查询、单群兼容和配置冲突校验；不猜测 conversationId 与 openConversationId 等价。
- 初修 66998 exit 0（2092b7）：5 文件 / 60 项、typecheck/diff 通过。扩展 20073 exit 0（a7568b）：8 文件 / 124 项、typecheck/diff 通过，包含 Owner 查询重启路由和回执不明禁止回退。
- 沙箱全量 89823 已 exit 1（c631ea）：29 文件失败、28 测试失败、247 跳过，伴随明确 listen EPERM 本地端口/套接字权限错误，不算通过。沙箱外 67552 exit 1（462572）：269 文件通过 / 1 失败 / 1 跳过，2755 项通过 / 1 失败 / 18 跳过；唯一失败是现有 index.test.ts 的分组 Chief 测试超过 20 秒。独立复测 36115 exit 1（df1b73）再次同样超时，不改断言/延时，不继续盲目重复。失败导致后续附属/打包检查未执行。
- 当前本批 7 个任务文件仍未提交；按仓库规则有未解决测试失败不提交。最新已提交版本仍为上批 0c6ef68；用户 AGENTS.md/outputs 保留。未部署、未修改真实配置/身份/凭据。一次文档补丁标题上下文不匹配未应用，已按实际标题修正。
- 接续先定位 index.test.ts:688 的连续请求超时（观察到多个 API 用例约 8 秒等待，尚无根因证据），保留 20 秒原断言，不以提高超时消除红灯。之后补齐附属测试/打包与全量验证，再保存本批本地提交。独立 typecheck/服务端编译/diff 检查 22873 exit 0（9ac09c），所有命令均终态，无后台测试等待。
- 剩余：旧控制回复的持久化来源群、消息级核查/安全恢复、真实回执映射、原输入回补/下载恢复、真实模型/文档及六类群聊、完整主机重启和人工验收。Goal 保持 active。

### Owner 自然查询待核查回复（2026-09-06 当前批）

- 提交恢复：前轮权限审查超时，未创建 git 进程，未执行暂存/提交；已通过的代码仍完整保留。本轮核对后仅重试一次任务专属本地提交，不 push。
- 上批 52f13a5 已提交且完整回归通过，分类 progress。本轮按 goal-protocol 接续，schema 25 不变，用户 AGENTS.md/outputs 保留。
- 新查询解析、Owner/同群筛选、有限清单/投递指纹、不可变收据/审计/回复事务、Stream ACK、headless/runtime 接线及过期清单发送前抑制已实现；查询事件不转新任务或 Owner 其他动作。不更改原消息、投递状态、Spec、Owner，不补发。
- 初始新增模块未实现时 5f1910 exit 1（无测试执行）；初实现 024f59 exit 1：3 通过 / 7 夹具缺 displayName 失败。补齐后 28222 测试 10 通过，typecheck 因新 headline 未加入类型失败。扩展 3020：72 通过 / 1 失败，定位未归属回复错误按外部事件号关联；改为正式内部 id 并补 headline 类型。两次多文件补丁因上下文/顺序校验失败而未应用，随后分拆并成功应用，没有回滚用户文件。
- 扩展验证 67393 exit 0（d51d92）：8 文件 / 142 项、typecheck/diff 通过。完整回归 8602 已 exit 0（186f50），主集 269 文件通过 / 1 跳过、2,739 项通过 / 18 跳过；附属测试、打包启动和 9 路代理、typecheck、独立服务端编译/diff 全通过。所有验证句柄终态。本批 16 个任务文件保存本地提交、不 push、不部署；用户 AGENTS.md/outputs 保留。
- 按本批 20 工具轮收束；恢复入口为本批最新 Git 提交、本节和 VERIFY。下一批优先补核查清单显示来源时间/同一事项多条回复区分，以及固定消息/当前 Owner 绑定的核查结果协议；不能把只读清单当补发授权。真实回执/机器人引用、原输入回补/下载恢复、真实模型/在线文档和六类群聊、完整主机重启及人工验收仍未完成；Goal active。

### 回复投递待核查的后台可见性（2026-09-06 当前批）

- 上批 848b61b 已提交/全仓通过，分类 progress。本轮读取 goal-protocol 接续；用户 AGENTS.md/outputs 保留，无真实钉钉/凭据/运行配置变更。
- TDD fff00d exit 1：5 项失败，证明健康接口无投递状态。实现后 43040 exit 0（1186a9）：4 文件 / 43 项、typecheck/diff 通过。扩展命令行健康检查与到期边界后，55022 exit 0（13a27f）：5 文件 / 69 项、typecheck/diff 通过。
- 新只读聚合接入 runtime health 和现有 --health，区分待发送、发送中、安全重试、待核查；无法读取显示不可确认，不泄露正文/消息或群标识/错误内容。待核查不封锁 readiness，不重发、不改账本，重启仍可见；schema 25 不变。
- 完整验证 80516 已 exit 0（707063）：268 文件通过 / 1 跳过，2,725 项通过 / 18 跳过；附属测试、打包无 node_modules 启动与 9 路代理、typecheck、独立服务端编译及 diff 检查通过。所有验证句柄终态，任务文件按仓库规则本地提交，不 push、不部署；Goal active。
- 恢复入口：核对本批最新提交，优先实现唯一 Owner 对具体回复的只读定位与有证据核查，再做显式、固定消息绑定的安全恢复；不要把统计接口当补发授权，也不通过设置全局 reason 阻断正常协作。后续卡片回执/机器人引用、旧输入回补/下载恢复、真实模型/文档和六类真实群聊、完整主机重启及人工 Owner 验收仍未完成。当前可见性仅本机后台健康查询，不冒充已通知群用户。

### 钉钉业务回执冲突保护（2026-09-06 当前批）

- 上批 2559f86 本地提交且全仓通过，分类 progress。本批读取 goal-protocol 接续，用户 AGENTS.md/outputs 不动；不改变凭据/Owner/运行配置，不向真实群发送。
- TDD a6f78d exit 1：25 项中 18 失败 / 7 通过；已修复冲突 session 成功误报、普通消息错误码忽略、异常令牌缓存使用。初修 37235 exit 0（b2324a）：7 文件 / 104 项、typecheck/diff 通过。扩展异常字段和生产装配持久化回归后，14024 exit 0（b45969）：7 文件 / 116 项、typecheck/diff 通过。
- 本批复用统一状态检查但不把 clear 当送达证明，普通消息仍要求查询回执；查询码不是消息 ID，卡片具体送达回执仍待证据。明确拒绝可正常回退，冲突只保留未确认，不写 sent_at、不在重启后自动重发。
- 完整回归 45428 已 exit 0（4a040c）：267 文件通过 / 1 跳过，2,718 项通过 / 18 跳过；附属测试、打包无 node_modules 启动和 9 路代理、typecheck、独立服务端编译、diff 检查全通过。所有验证句柄终态，任务文件本地提交、不 push、不部署，Goal active。
- 等待时只读核查 runtime health/performDrain/private-alert：健康接口目前没有 Outbox 待核查/失败统计，未发现投递未确认的专用查询或 Owner 核查协议；不将代码搜索本身当真实线上监控证明。恢复入口：核对本批提交，优先补可见但不泄露群内容的投递待核查状态、与服务就绪分离，避免为显示异常反而封锁正常队列；再设计唯一 Owner 固定消息/证据绑定的核查和恢复，不直接清空 dead_letter 或盲目重发。
- 后续完整范围保留：卡片真实回执/机器人引用映射、旧输入回补/附件下载恢复、真实模型和文档、六类真实群聊及主机重启/Owner 人工验收均未完成。本批没有修改运行配置或使用真实凭据。

### 回复超时与有界正文读取（2026-09-06 当前批）

- 上轮 f33f040 已提交，分类 progress；本轮读取 goal-protocol 后在该版本接续。初始仅用户 AGENTS.md/outputs 未跟踪，保持不动。范围为发送器、受控测试和状态文档，不涉及真实凭据/钉钉/Docker/部署。
- 先行 26d27c exit 1：10 项失败，证明 header/body 卡住、超限正文无 EOF 及迟到响应无法收束。实现统一 8 秒期限和流式字节限制后 39095 exit 0：71 项/typecheck/diff 通过。扩展测试 56412 中 79 项通过但 typecheck exit 2（新夹具缺 workItemVersion/association）；补齐夹具后 30719 exit 0：79 项/typecheck/diff 通过。
- 真实生产 headless 装配 + SQLite + 受控 fetch 验证：第一条回复正文挂起后转待核查，第二条继续成功，重建 dispatcher 不重发前条。覆盖令牌前失败分类、响应头/正文共用期限、取消操作不结束、迟到响应丢弃、多字节实际大小/拆包与计时器清理。无真实线上送达证明。
- 完整 pnpm test → typecheck → 独立服务端编译 → diff 检查首次权限审查超时，进程未启动；按返回提示仅重试一次成功，31815 最终 exit 0（1ae167）：266 文件通过 / 1 跳过，2,681 项通过 / 18 跳过；附属测试、打包启动、类型/独立编译/diff 全通过。所有测试句柄已终态。本批任务专属文件保存本地提交，不 push、不部署；Goal active。
- 恢复入口：核对本批最新本地提交及本节。默认 8 秒探测等待仍在部分 index API 测试出现，但 88 项全通过；这不是旧间歇性超时根因修复证明。无需重跑本批同一候选测试；优先继续下面业务回执和真实群聊剩余项，缺少正式消息 ID 映射证据时不得猜测。
- 后续仍需业务响应冲突字段/卡片具体回执校验、未确认投递人工核查及安全重发、机器人引用映射、旧输入回补、附件下载恢复、真实模型/文档与六类群聊试点、主机重启及人工 Owner 验收。

### 非幂等钉钉投递的回执丢失保护（2026-09-06 当前批）

- 上批 8873831 已提交/全仓通过，分类 progress。本批 goal-protocol 恢复原目标，初始用户 AGENTS.md/outputs 保留。dingtalk-chat 精确说明和只读 DWS help 确认发送查询码与消息 ID 不同，且 Bot/Webhook 不承诺幂等键；没有真实群读取、发送或凭据操作。
- 修复 session 不确定后切主动通道重发、Outbox unknown 自动重试、重启重放过期认领三条重复风险；旧版无明确未发送分类的待重试记录也停为待核查。明确未发送仍可持久化有界重试，unknown 不写 sent_at、不生成已送达选择题证明。生产 headless 已接线，schema 25 不变。
- TDD 8766dc exit 1：5 失败 / 9 通过。初修 82639 exit 0：39 项/typecheck。旧待重试回归 fadb8a exit 1：1 失败 / 8 通过；分类标记首修误用固定长度，62150 exit 1（1 失败 / 45 通过），改用 SQL length 后 94981 exit 0：46 项/typecheck/diff。
- 完整回归 82059 已 exit 1（4d104e）：264 文件通过 / 1 失败 / 1 跳过，2,659 项通过 / 4 失败 / 18 跳过。失败均在 server/index.test.ts：三项 20 秒超时，随后团队导入名称期望 Mira 2、实际 Mira 4。其余协作/钉钉通过。完整命令后续 typecheck/编译因 && 未执行，不能当作绿灯。
- 同一 HTTP 组独立复测 13711 exit 0：88 项通过，未改源码、超时值或断言；怀疑超时后操作污染共享夹具，但根因未确认。第二次无排除完整回归 40092 已 exit 0（d40202）：265 文件通过 / 1 跳过，2,663 项通过 / 18 跳过；后续附属测试链、类型检查、独立服务端编译及 diff 检查全部通过。独立检查 97112 亦 exit 0。所有验证句柄已结束，无需重新启动。
- 检查点恢复后复用同一实现的完整成功证据，更新文档并按仓库规则提交本批 14 个任务文件；用户 AGENTS.md/outputs 保留，不 push、不部署。首次失败仍作为间歇性稳定性问题保留，不宣称超时根因已修复；若复现优先定位固定 8 秒探测延迟及共享 HTTP 夹具，不放宽测试、不清理用户或历史容器。
- 本批没有 Docker 或线上投递证明。后续仍需未确认投递的人工核查/安全重发协议、机器人远端引用映射、旧输入回补、下载停止恢复、真实模型/文档与六类钉钉试点、完整主机重启及人工 Owner 验收；Goal active。

### 引用上下文保护与迟到原消息续办（2026-09-06 当前批）

- 上批 30dce3e 已提交且全仓通过，分类 progress。初始仅用户 AGENTS.md/outputs 未跟踪。goal-protocol 按目标每批 20 工具轮 / 4 小时执行，Goal 维持 active。
- 已复现并修复未知引用被关键词/新任务语言/模型或其他序号选择错误关联的问题；原引用保持持久澄清，不新建/修改别的事项。原消息迟到或归属后补齐时，后台按同群持久关系自动续办，保留完整贡献与来源证明，可重启恢复；跨群、循环、终态和重放受测试覆盖。
- 先行 26823 exit 1：4 失败 / 32 通过；初修 61624 exit 0：36 项/typecheck。新增回复说明测试 44000 exit 1：1 失败 / 34 通过；文案修正后 17641 exit 0：64 项/typecheck。最终边界补充 77377 exit 0：68 项/typecheck/diff。
- 完整 pnpm test → typecheck → 服务端编译 → diff 检查 86281 exit 0（1dccad）：265 文件通过 / 1 跳过，2,648 项通过 / 18 条件跳过；全部附加测试与打包启动通过。运行较慢，持续复用原句柄而未重启；只读 ps 检查被本机权限拒绝，不把它当作测试失败。所有验证句柄已终态，本批任务专属本地提交、不推送，用户文件保留。
- sender/reply-router 不传远端消息编号，processQueryKey 与 originalMsgId 无对应证明；机器人出站引用映射仍待接口证据，不把已知原消息续办当作完整机器人引用支持。本批未调用真实模型/钉钉/文档/Docker，未部署。后续还需旧输入安全回补、下载停止恢复、真实模型/文档与六类试点、整机重启及人工 Owner 验收。
- 恢复入口：核对最新本地提交和本节，优先核实远端回执契约/非敏感样本后实现出站引用映射；无法取得证据时继续其他安全待办，不能猜编号。按目标 20 工具轮收束，完整 Goal 保持 active。

### Owner 需求整理恢复与通知版本绑定（2026-09-06 当前批）

- 上轮读取运行句柄 20188，确认 62 项/typecheck/diff 检查 exit 0，取得改变后续动作的验证证据，分类 progress。本轮在 1e12fe1 基线上接续未提交业务变更；用户 AGENTS.md/outputs 保留，不创建新 Goal。
- 已实现 schema 25、专用自然短句恢复、唯一 Owner/同群定位、失败窗口不可变归档、跨入口重放保护、Stream 持久化后 ACK 与 headless/runtime 接线；只恢复需求解释，不启动代码执行。多个事项先追问，原消息和 Spec 不改动。
- 定向测试已覆盖恢复后重启、全事项失败补充、再次三次停止、旧授权不重开新窗口、原记录不变、权限/暂停/终态/跨群/认领拒绝、回复持久化失败回滚、迁移不虚构授权。新通知按当前 Spec 和恢复代次绑定，实际 dispatcher 不发送恢复前旧提醒。
- 完整验证 29394 已 exit 0：无排除的 pnpm test → typecheck → 服务端编译 → diff 检查全部通过。主集 265 文件通过 / 1 文件跳过，2,638 项通过 / 18 项条件跳过；broker、Electron 辅助模块及 packaged-server 启动亦通过。先行红灯和最终结果详见 VERIFY。
- 本批 Docker 恢复探针 aec269 exit 0：schema 25 当前源码、真实 Linux service/SQLite、15 条合成输入、durable 后 SIGKILL、新进程恢复及重放防重、无 Owner 变化；容器隔离实际 inspect，临时资源已清理。原试点检查 healthy，未替换服务或删除历史容器。
- 所有验证句柄已终态；本批任务文件本地提交、不推送，核对最新 Git 提交即可续办。下批优先机器人出站引用映射：sender 当前只保留业务成功布尔值，reply-router 不传递远端消息回执，不能猜测回复机器人消息的归属。旧输入安全回补、下载停止恢复，以及真实模型/文档/六类钉钉试点、整机重启和人工 Owner 验收仍未完成。Goal active。

### 全仓回归恢复与真实 Linux 进程崩溃续办（2026-09-06 最新）

- 上一批 030f09c 有已验证提交，分类 progress；本批只增加真实 Linux 验证入口和状态记录，不修改业务逻辑。初始用户 AGENTS.md/outputs 保留。
- docker-helper 指引下只读检查 colima-openmausbot-pilot：原 openmausbot-collaboration-pilot 仍 healthy，只有 Node 固定镜像缓存，没有文档解析镜像。公开 registry-1.docker.io 和 pypi.org 匿名 HEAD 各一次均 DNS 超时（15152/60645 exit 28）；未修改网络、借用凭据、重复拉取或构建解析镜像。
- 本机监听权限定向验证这次实际成功：natural-intake-model.test.ts 9 项通过（496a0a exit 0）。随后完整 `pnpm test && pnpm typecheck && pnpm exec tsc -p tsconfig.server.build.json --noEmit false --outDir /tmp/openmausbot-goal-full-regression && git diff --check` 68403 exit 0；包含测试数量底线、broker、Electron 辅助模块和 packaged-server 启动，无排除模型文件。它验证 030f09c 业务版本；本批最终新增探针另有实际 Docker 和编译证据。
- 缓存固定 Node 镜像真实 Docker reporter/cancel smoke 83726 exit 0：passed/failed/skipped 断言分别映射 passed/missing/missing，取消前不执行、运行后子进程 heartbeat 停止。只清理本次资源。
- 新 natural-intake-recovery.smoke.ts/probe 实际生产服务+SQLite WAL+两个 Linux 子进程：15 条同时间戳/三位合成成员发言，一条解释完成后父进程收到 durable 回执并 SIGKILL 服务进程；新进程确认 1 applied/14 pending，再恢复全部 15 条验收且原消息重放不新增事件，Owner 仍为空。运行器实际 inspect 无网络/只读根/非 root/资源限制、零退出/非 OOM，并确认只清理本次容器。模型与消息明确 controlled/synthetic，不冒充真实群聊。
- 探针调试顺序：根目录 docker cp 失败；改 stdin 放进容器自有 tmpfs 后，fork 继承 eval 参数导致 produce 失败；清空 execArgv 后到达 recover，修正 Node SQLite 空原型记录的夹具比较后通过（bce00d exit 0）。最终类型/服务端编译/diff 检查 50206 exit 0。原始试点容器与全部历史退出容器仍在，无临时残留。
- 无运行中验证句柄。恢复入口：本批允许任务文件本地提交、不推送；下一批补真实 parser 基础镜像/依赖可达条件，或在权限和凭据明确后做六类真实钉钉/模型试点。机器人出站引用、旧输入回补、解释失败 Owner 恢复等代码待办继续保留。整机重启、在线正文、独立生产 supervisor 与人工 Owner 验收仍未通过，Goal active。

### 长会话与突发补充不丢失（2026-09-06 最新）

- 上一批 147db49 为真实本地提交，本轮分类为 progress 后继续；工作区初始仅用户 AGENTS.md/outputs 未跟踪。检查引用回复链路确认只有入站消息匹配，没有机器人出站回执映射；没有凭空声明已支持。
- 本批修复实际影响多人自然交互的三处缺陷：当前文本 2,000 字符截断、总历史超过 12 条永久缺上下文、后来发言使尚未处理任务被 supersede。现在每条新输入保留任务、同事项串行处理；完整当前文本与相关引用放入有界上下文，已应用且摘要匹配的历史由持久 Spec 承接。未处理或失败输入不放行执行，最后完成后才解除相应门禁。
- 先行自然整理测试 2 失败 / 16 通过（4752 exit 1），修复后 18 项/typecheck 通过（30981 exit 0）。突发队列测试先失败（39744 exit 1，1 失败 / 17 通过）；逐条队列、门禁和时间相同按源插入排序修复后相关三文件 59 项/typecheck 通过（59177 exit 0）。较早失败未通知再复现（12633 exit 1），修复为同事项失败来源而不是最后群消息。
- 最终 70 文件 / 616 项、pnpm typecheck、服务端编译及 git diff --check 通过（13822 exit 0）。明确排除需要监听端口的 natural-intake-model.test.ts；没有运行全仓 pnpm test，没有真实模型/钉钉/Docker/在线文档调用。所有验证句柄终态。
- 验证包含 15 条逐次多人补充+重启、15 条同时间戳突发发言逐条完整入账、长消息尾部验收、同事项解释互斥和剩余队列重启、已改写旧来源不能沿用覆盖收据、旧失败不会被后续成功掩盖。仅为受控解释器测试，不能替代真实模型准确性验收。
- 本批业务文件与四状态文件保存本地提交，不推送；用户文件保留。恢复入口：先核对最新 Git 提交，然后补历史已 supersede/无覆盖收据的安全补偿、三次需求解释失败的 Owner 恢复、机器人消息引用回执和真实自然群聊评估。不得把附件投影恢复误当成需求解释失败恢复。原真实模型/文档/解析镜像、主机重启、全仓和六类 Docker 试点仍缺证据，Goal active。

### Owner 自然语言恢复附件整理（2026-09-06 最新）

- 在 5543efc 基础上接续未提交的恢复入口，实现 schema 24 不可变授权边界与请求去重；Stream → headless → runtime 接线完成。“继续整理附件”仅恢复同群、已停止的需求投影，不重下附件、不直接重跑代码，不改变 Owner 或丢弃失败证据。多附件先追问，再按原消息/序号选择。
- 修复接续代码的类型语法问题、遗漏 headless 转发；新增回归发现测试误用审计表名，已修正。将测试外部群标识与 Ledger 标识分离后复现四项失败（42568 exit 1），修复为正式群别名映射；恢复事件被改写后转入普通任务/Owner 命令时拒绝。
- 最终相关回归 70 文件 / 611 项、pnpm typecheck、服务端编译、git diff --check 通过（18332 exit 0）。明确排除需要监听端口的 natural-intake-model.test.ts，未运行完整 pnpm test；不可复用旧全仓通过声明。此前 75587 通过对应映射修复前版本，最终证据以 18332 为准。
- 覆盖：唯一 Owner/伪管理员拒绝、保留正文和失败历史、幂等/改写重放、再次三次停止、原消息及序号、多候选/跨群/终态/活动认领拒绝、回复入账失败回滚、v23 升级不虚构恢复授权、短句与文档指令区分、runtime 控制入口防串流。未进行真实群投递或部署。
- 当前业务改动均属本批，用户 AGENTS.md/outputs 保留。所有验证句柄已终态；按仓库约定尝试本地提交，不推送。恢复入口：先检查 Git 最新提交和本节；继续补真实群 @ 文本与机器人回复关联、下载三次停止后的恢复、自然语义评估及原六类试点。真实凭据/模型/在线正文/解析容器、完整主机重启仍待授权或真实验证，Goal active。

### 需求投影失败持久收束（2026-09-06 最新）

- 上一轮 fbbda63 为实际测试提交，分类为 progress。本批恢复 Goal/工作区，在默认权限运行一次 loopback 监听预检，明确 EPERM（569e5c exit 1）；这是本机权限阻碍，未启动全仓 pnpm test，也未重复上轮两次超时的全仓权限申请。
- schema 23 已实现独立投影失败收据、每次新认领标识、短退避和三次同类分类停止。保留提取正文/来源，不重新下载；首次和停止后的通俗反馈与失败事务一起提交，恢复后的旧提示不发送。停止和接管后的迟到结果不能写记录。50 个已停止附件不会占满待处理批次而饿死正常附件。
- 先行 2 失败 / 18 通过（27545 exit 1）复现无限回调重试和缺少退避。初实现暴露 owner/expiry 必须成对空值的数据库约束（41976 exit 1，3 失败 / 24 通过）；改将 retry_after 写入独立收据，原租约约束保留，2 文件 27 项/typecheck 通过（91999 exit 0）。补并发/取消/事务/批次等验证后 5 文件 69 项/typecheck 通过（26677 exit 0）。
- 最终默认权限下 70 文件 / 594 项、typecheck、服务端编译和 diff 检查通过（85915 exit 0）；明确排除需要端口的 natural-intake-model.test.ts，未运行全仓 pnpm test。新增 v22 升级保留下载失败及原回复、不虚构投影失败的验证已包含在最终整组。所有验证句柄终态。
- 只修改相关实现/测试和四份状态记录，用户 AGENTS.md/outputs 保留；未调用真实模型、钉钉、在线文档或 Docker，未更改网络、身份/凭据。通过批次按仓库要求保存本地提交，不推送。
- 恢复入口：需要许可后才能补全仓与模型端口测试；安全可继续项为三次停止后的唯一 Owner 有证据恢复协议、自然追问/任务归并评估和现有待办。真实解析镜像/在线正文/模型、完整主机重启及六类真实试点仍未完成，Goal active。

### 附件 ACK 生产装配验证；全仓执行请求未启动（2026-09-06 最新）

- 上一轮有 fc2033f 本地提交及相关整组终态，分类为 progress。本批先恢复当前 Goal/工作区，业务源码保持不变。
- 完整 pnpm test → typecheck → 服务端编译请求：原请求和允许的一次重试都在自动权限审核超时，未取得运行句柄，命令没有启动。未继续重试/绕过；这是执行权限检查阻碍，不是全仓测试失败，不复用旧绿灯冒充当前全仓证据。
- 转向默认权限下可进行的组合验证：生产 Stream adapter/runtime/Ledger/Vault/coordinator 串联，受控 SDK/下载。覆盖确认前能力可恢复、Vault 保存失败不确认、ACK 失败/重复重放不新增事项或回复、确认后重启无需重发、挂起读取单批/续租/回复队列，以及停止后迟到结果无失败/证据写入。
- 初版三种组合都因维护时钟停在旧 fixture 日期而未开始下载（86399 exit 1，3 失败 / 10 通过）；源码确认 normalizer 使用真实收到时间，修正测试时钟对齐并保留 next_attempt_at 到期断言。13 项/typecheck/diff 通过（49162 exit 0）。最终增加服务重启场景后，四文件 73 项、typecheck、服务端编译和 diff 检查通过（20610 exit 0），无运行中句柄。
- 仅新增测试与四份状态记录；不改运行服务、生产代码、网络/身份或容器，用户 AGENTS.md/outputs 保留。本批结果按仓库约定保存本地提交，不推送。
- 恢复入口：取得本机完整测试执行许可后重新申请全仓验证，不复用已超时的调用或假设旧进程运行；未获得许可期间仍可推进证据投影回调失败的持久收束、无网络故障注入等安全工作。真实文档容器/在线正文/模型、主机重启和六类真实试点尚未完成，Goal active。

### 附件三次失败收束与来源化反馈（2026-09-06 最新）

- 上一轮有 30890ec 实际提交和终态验证，分类为 progress。本批恢复 Goal 和干净业务工作区，用户 AGENTS.md/outputs 保留。目标/权限边界不变。
- schema 22 保存不可变逐尝试失败收据；下载、能力读取、文件保存连续三个相同已确认失败后停止，不把不同原因或崩溃次数混算。首次失败与终态简练反馈持久化；失败状态、收据和回复原子提交。永久/未支持终态通知可补回，既有重复消息不重新下载。
- 出站在发送前检查当前附件尝试/状态、事项版本/控制状态，已恢复的旧失败提示不发送；真实 headless 回复装配使用原附件 source session 而不是同事项更新消息。未添加卡片模板/凭据/身份变更。
- TDD 新增三项先失败（20231 exit 1，3 失败 / 13 通过），实现后 16 项/typecheck 通过（85148 exit 0）。数据库/服务/恢复/备份 5 文件 60 项/typecheck 通过（22544 exit 0）。新增路由测试曾因引用不存在的模块失败，修正为实际 reply-router；最终定向 2 文件 25 项/typecheck 通过（11796 exit 0）。
- 整组执行请求等待工具返回后确认实际句柄 59374，未重复启动；该句柄终态 exit 0，71 文件 / 592 项、typecheck、服务端编译和 diff 检查全部通过。本批没有运行全仓 pnpm test，不能把相关整组当全仓验证。现无运行中验证句柄；仅任务文件本地提交，不推送。
- 恢复入口：优先在固定新版本执行全仓 pnpm test；再补真实 coordinator 与 Stream ACK 组合故障、证据投影失败的持久收束及退出进程证明。历史正文修复、真实 Docker 文档镜像/在线正文/模型、主机重启与六类真实试点仍未完成。Goal active，按 20 工具轮批次收束。

### 附件后台读取与迟到结果保护（2026-09-06 最新）

- 上一轮仅检查状态，分类为 no progress；本批重新核对工作区，继续已有未提交测试和实现，没有重新建 Goal。按 goal-protocol 保存证据，不改变完整产品验收范围。
- 入站只持久化下载能力；维护单批后台摄取，不占用 ACK/续租/Outbox 等待。下载默认 15 秒总超时，支持外部取消，覆盖 token、地址和正文的请求及流；迟到 token 不缓存、不继续访问文件，响应 body 尽力取消且不等待失控 cancel。
- 新增异步返回及提取事务内当前租约/attempt 校验。停止和失租后拒绝投影，旧 download/extract 成败不写 evidence 或删除当前 capability。关机等待未收束时保留租约、拒绝同对象重启；不把 Promise 取消冒充容器进程结束。
- TDD 下载器先复现 8 失败 / 13 通过（15722 exit 1）；实现后运行时原测试暴露后台单批尚未结束的时序假设，改为明确维护批次，不降低断言。针对性最终 54 项及 typecheck 通过（16278 exit 0）。相关整组 71 文件 / 586 项、typecheck、服务端编译和 diff 检查通过（36561 exit 0）；最后增补 Outbox 挂起同行断言，运行时 20 项/typecheck/diff 再通过（72400 exit 0）。本批未重新执行全仓 pnpm test。
- 未读真实凭据、调用真实模型/钉钉/在线文档、构建或替换 Docker，用户 AGENTS.md/outputs 保留。现验证句柄均终态，代码/测试及四状态文件允许本地提交，不推送。
- 恢复入口：先在固定新版本执行全仓回归，再优先补附件连续失败三次后的持久停重试/简练群反馈，以及真实 coordinator 与 Stream ACK 的组合故障注入；目前单独的持久化、Stream 次序和后台生命周期已测，不宣称已完成真实组合验收。复杂解析器隔离进程生命周期、历史正文恢复、在线正文/模型、主机重启和六类真实试点仍未完成，Goal active。

### 时序夹具修正与完整回归恢复（2026-09-06 最新）

- 上一轮有完整失败和定点复测证据，分类为 progress。本批先保持原源码，完整运行 index/steer-e2e 两文件 90 项通过（5769 exit 0），说明原顺序也可以通过，未据此宣称稳定顺序缺陷或环境根因。
- 对 steer 用例保留原断言，增加超过假 CLI 固定 800 ms 窗口的 1,200 ms 观察延迟，复现相同 steered=undefined 失败（15930 exit 1）。改为 E2E 专用 wait-for-steer 夹具：收到真实补充输入才结束，原 slow 模式、测试时限、转录/单回复断言均保留。产品消息和权限代码未改。
- 修复后相关 52 项通过 / 1 既有跳过、typecheck 和 diff 检查通过（31289 exit 0）。随后正式 pnpm test → typecheck → 服务端编译 → diff 检查完整通过（36219 exit 0）；原两失败均在整套内通过，打包无 node_modules 启动及九个代理路径通过。主套件总数字所在输出截断，不编造精确总数。
- Chief 分区用例本次全仓 690 ms 通过，20 秒时限未改；历史超时根因仍未证明，不能以测试夹具修复声称永久消除所有不稳定。现无未解决失败或运行中验证句柄；旧失败记录作为历史证据保留。
- 仅本地测试夹具/测试与状态文件变化，可按仓库要求本地提交，不推送；AGENTS.md/outputs 保留。未读真实凭据、未调用真实模型/钉钉或部署 Docker。
- 恢复入口：下一批优先 D-048，先补“慢下载不阻塞维护/ACK、持久化失败不确认、停止/失租迟到结果无副作用”的测试，再拆分能力持久化与后台摄取，增加取消和当前尝试校验。历史截断/乱码恢复、真实文档镜像/在线文档/模型、完整主机重启及六类真实试点仍未完成。Goal active，按每批最多 20 工具轮/4 小时收束。

### 固定版本全仓复测与附件响应性审查（2026-09-06 最新）

- 上一轮 5db6a79 有实际代码提交及终态相关验证，分类为 progress。本批保持业务源码/测试不变，对该固定版本执行正式 pnpm test。主套件 2561 通过 / 2 失败 / 18 跳过（265 文件；15254 exit 1），失败为 index 的 Chief 分区用例超时及 steer-e2e 的 steered 未为 true；不能标全仓通过。
- 原进程终止后只定向复测两个失败用例，2 项通过（20997 exit 0），没有增大超时或改断言；其余 88 项按名字过滤未运行，这是局部诊断，不替代全仓。原因尚未证明，应查共享状态/执行顺序或时序，不能直接断言是环境故障。
- 因 pnpm test 在首段失败而未启动的 broker、Electron 四套件及打包 smoke 已单独补跑，加 typecheck、服务端编译与 diff 检查全部通过（26259 exit 0）。源码未再改，当前验证进程均终态；未新建容器、调用真实模型/钉钉或改配置。
- 同步只读审查确认另一个响应性缺口：Stream ACK 等待附件 process，维护 drain 也等待 process；默认租约 30 秒，下载 token/地址/正文及 reader.read 无明确超时或取消。因此在全仓失败定位后，应先做能力持久化后及时确认 + 可取消后台摄取 + 迟到结果 fencing，再处理历史截断投影。详细边界见 D-048，尚未实现。
- 当前只修改四份状态文档；按仓库“测试失败不得自动 commit”要求暂不提交。AGENTS.md/outputs 保留。恢复入口：先读本节和 VERIFY，核对 git diff 仅状态文件；定向复测通过不是全仓恢复，继续定位两处失败后再推进 D-048。真实文档镜像、在线正文/模型、完整重启及六类试点仍待验收；Goal active。按每批最多 20 工具轮/4 小时收束。

### 正文完整分段与 Unicode 来源保持（2026-09-06 最新）

- 上一轮 a0e5910 有实际提交和终态验证，分类为 progress。本批发现完整正文每 chunk 仅投影前 2,000 字，导致普通稍长文件永久卡在“需求未读全”。改为来源标注的有界完整分段，完整性门禁逐段匹配，不扩大现有 12 chunk/100 事实/模型 48 KiB 限制。
- 长行原始切块复现表情符号被拆成半个字符，UTF-8/SQLite 替换后正文乱码；改为避开 surrogate pair。新增用例检查正文尾部精确保留，而非只比哈希。二次分段同样保护 Unicode 和边界空白。
- 受控 Docker 解析结果经真实生产适配器、下载能力 vault、摄取数据库、来源投影、Spec 和服务重建：三格式尾部/原始位置/解析器镜像版本可追溯，重放不再解析或新增投影，未确认目标不规划。表格尾部条件可进入带正文收据的自然验收，不将材料内命令作为权限；三格式实际 partial 标记不能因切段被清除，删除 Spec 尾部再次阻塞。
- 最终相关整组 71 文件 / 570 项、typecheck、服务端编译及 diff 检查通过（31434 exit 0）；此前针对性 4 文件 / 49 项及 typecheck 通过（83059 exit 0）。本批未运行全仓 pnpm test，未执行真实 Python/Docker/在线文档/钉钉；未更改现有试点、Owner、凭据或全局网络。
- 当前限制：旧已投影截断记录不会因重复事件自动覆盖修复；旧乱码须后续受控重提取。大文档容量超限、模型上下文溢出仍阻塞，不能声称任意长文档已支持。Docker 基础镜像下载失败是上一轮真实证据，本批未重复网络尝试。
- 恢复入口：下一批先在固定源码运行全仓 pnpm test/typecheck/服务端编译，再推进历史正文的有版本来源修复与完整协作场景。真实镜像准备后仍须执行 parser smoke 并按授权接入 headless；在线文档、真实模型、主机重启及六类真实试点缺口保持。验证句柄已终止；AGENTS.md/outputs 未动、不提交。Goal active，按每批最多 20 工具轮/4 小时收束。

### 文档容器验证与误判防护（2026-09-06 最新）

- 上一检查点已核实 41946 终态 exit 0，本批接续未提交文档验证文件，属于实际实现进展，不重复建立目标。按每批最多 20 工具轮/4 小时收束；本批没有启动真实模型、在线文档或钉钉交互。
- 新增七份自生成 Word/Excel/PDF 内存夹具、Python 夹具验证、固定镜像的 Docker smoke。拒绝须验证实际进程退出 2 和固定错误 JSON；超时须观察 CLI 超时及运行中容器，随后确认适配器完成清理。跟踪本次随机名称/ID，覆盖丢失创建回执、单个清理失败继续清理其他本次容器，不操作现有用户容器。
- 先行受控端口测试实际复现八类假通过：create/inspect/start 故障、错误进程退出、错误拒绝正文和两类假超时。修复后补清理、场景重复、回执丢失、检查失败和原有容器保留覆盖。最终相关整组 71 文件 / 561 项、typecheck、服务端编译、diff 检查通过（79314 exit 0）；Python 13 项通过（5725c8 exit 0）。本批未运行全仓 pnpm test。
- 实际 Docker ps 核实原 pilot 仍 healthy，其他历史容器未动。前段官方清单 EOF/Colima DNS 超时；本批备用 public.ecr.aws 只读连通检查也 DNS 超时（83823 exit 28）。第一次权限审查超时并未启动，只重试一次。未改 DNS/代理，未再次拉取、部署或借用凭据。
- 容器 smoke 只在受控端口执行，真实 Python 镜像未构建/运行，headless 未启用该解析器。Goal 保持 active；尚缺正文 Ledger 摄取及来源/恢复端到端、真实在线文档/模型、完整重启和六类真实试点。
- 恢复入口：先取得可访问且已确认来源/digest 的 Python 基础镜像（或由 Owner 授权网络修复），按 parser README 构建两镜像并执行真实 smoke；同时可继续在受控输入下测试正文摄取到来源/完整性门禁，不能将其标成真实 Docker 成功。运行中验证句柄已结束，用户 AGENTS.md/outputs 保留且不提交。

### 全仓回归与恢复通知投递门禁（2026-09-06 最新）

- 上一批 18f4176 为实际进展。本批先保持源码不变，运行正式 pnpm test → typecheck → 服务端编译 → diff 检查全链，通过（51696 exit 0）；包括主 Vitest/test-floor、broker、Electron 子套件和打包无 node_modules 启动/九个代理路径检查。工具输出有截断，未保留精确主套件数量，不推算或编造计数。
- 审查和先行测试确认：旧恢复通知在暂停、取消、新贡献、退出已确认后仍被投递；合成 source event 无法匹配真实 session，旧版本积压同样失败。新增开始投递前的当前 session/事项版本/计划/快照/控制/结算门禁，含重试、过期认领和后续同仓库活动。过时通知标 superseded，而非 sent。
- 恢复通知改为从实际任务消息选择回复通道，并兼容旧 work_item 类型积压；受控 fetch 走真实 headless 装配及 session sender，不需要新卡片模板或真实凭据。前期 30 项针对性测试及 typecheck 通过（63751），最后三项边界和旧格式兼容后的最终证据见 VERIFY。
- 最终相关测试启动曾遇一次自动权限审查超时，命令未开始；只重试一次后实际启动 54390，沿同一句柄验证：34 项针对性、544 项相关整组、typecheck、编译及 diff 检查均通过（exit 0）。没有运行中的测试或遗留失败，详见 VERIFY。
- 尚待：当前最终修改后的全仓复跑、已退出但仍 running 的 Run 收束、无生命周期 legacy 隔离/启动恢复；主动发送等待及在途请求的更晚校验、session 丢失与多群主动路由；真实模型/在线正文授权和 Docker 六场景。未改真实容器、群、凭据或 Owner，Goal active。按 goal-protocol 收束，AGENTS.md、outputs/ 不纳入提交。

### 后台恢复、通知及安全续排（2026-09-06 最新）

- 上一批 5b32f47 为已验证进展。本批把恢复 API 接到 runtime running 后的一次性后台任务；四个仓库并发、同仓库串行，每项五秒超时；关机取消被动权威读取，失租/暂停/取消/生命周期失效均不得继续发旧通知或启动新工作。
- 未知情况保持仓库占用，排队通俗中文说明和负责人下一步；业务通知隐藏 WI/内部控制字段，恢复不是“修改完成”。按 session/结果去重，退出结算已落库但通知未入队的崩溃缺口从收据补回；相关候选/Spec/Owner 门禁保持原样。
- 安全释放后继续独立复核和新待办；孤立 execution session 计入预算且不得被当成从未启动的任务。针对性新测试发现 canonical session 路径与历史候选符号链接路径不匹配而漏排复核，统一路径比较后该用例通过。
- 新增 runtime 恢复九项、仓库调度一项、零命令复核续排一项。先行五项复现未启动恢复/无通知，另测复现等待队列不释放、无检查超时、跨仓库阻塞及结算后漏发；已分别修复。最终相关回归 70 文件 / 533 项、typecheck、diff 检查和服务端编译通过（41694 exit 0），详见 VERIFY；当前无运行中验证命令或未解决测试失败。
- 下一批：先跑全仓 pnpm test，再审查已确认退出但 Run 仍 running 的安全收束、没有生命周期记录的旧版本运行隔离/启动阻塞，以及通知在投递前发生 Spec/控制变化的时效性。这些边界本批没有宣称完成。真实模型/在线正文授权、Docker 强制重启及六类群聊试点仍待验收；未部署现有容器、未变更凭据或 Owner。
- 按 goal-protocol 本批收束并保存本地提交，不 push；用户 AGENTS.md、outputs/ 不纳入。Goal 继续 active。

### 被动恢复的证据与收束边界（2026-09-06 最新）

- 延续已提交 2537cff 的实际进展。schema 21 新增执行/复核的不可变 finalization intents；原协调完成后的 settle 入口冻结命令数、后续命令和证明插入。缺标记的执行（包括未完成的 native prepare）不能仅凭进程为空解除占用。
- 新增 recoverLifecycleSession 底层 API：新租约必须有效且替换原实例，每项证明重新独立校验和确认 empty fingerprint；每次等待后与结算事务重新校验 fence/取消/账本。仅记录退出结算，不把任务说成完成，不改候选/复核/尝试状态，也不杀进程或自动重试。
- 验证覆盖执行/复核幂等、两 SQLite 连接竞争、活进程/未知/缺证明/拒绝证明/指纹不匹配、旧租约/中途失租/取消/关库、零命令复核例外、冻结触发器和 v20→v21 无伪造回填；针对性 4 文件 / 90 项、typecheck 和 diff 检查已通过（50811 exit 0）。首轮新夹具类型收窄失败已修复，不削弱断言。最终相关回归 69 文件 / 522 项、typecheck、服务端编译及 diff 检查通过（13581 exit 0），详见 VERIFY；未跑本批全仓 pnpm test。
- 下一步优先：把该 API 接入 runtime 的一次性后台扫描，纳入关机取消/限时等待和生命周期 fence；对已安全释放的仓库重新检查现有待办门禁，不自动重做失败修改；对未知状态持久排队一次中文提醒，避免群里无反馈。该调用目前尚未接入 runtime，不能声称自动恢复已经完成。
- 当前批次未部署 schema、Docker、真实群或模型/文档配置；真实授权模型与在线正文、六类非生产试点及安全完整恢复仍未验收。按 goal-protocol 保留证据并收束本批，Goal 保持 active；AGENTS.md 和 outputs/ 继续排除在提交外。

### 执行层持久仓库占用与自测清理（2026-09-06 最新）

- 上一批 7331c53 为已验证进展。本批 schema 20 增加 execution sessions/commands/proofs/settlements，不再依靠运行记录的终态标签释放占用。从 prepare 前同步事务预留固定仓库、事项/计划、base SHA、attempt 和实例 fence；同事项 attempt 不可重复使用。
- Agent 与每条自测命令调用前预留、独立证明登记成功后保存证明；执行结束重验全部证明和 empty fingerprint，再以当前 lease 原子结算。失败但进程仍 active、缺证明、清理未知、lease 丢失或关库均保留占用；自测 CommandCleanupError 不再被降为普通配置结果。
- 修改和复核预留互查，headless 调度/直接执行及完成门禁查询两类未结算记录；底层 CandidateExecutor 同样参与互斥。真实第二连接/独立 Node 子进程检查 prepare 期间占用，另有失败活进程、自测未知、新执行器接管、双向修改/复核互斥、v19→v20 升级及不可变记录测试。
- 相关整组 68 文件 / 490 项、typecheck、服务端编译和 diff 检查通过（72596 exit 0）。随后仅补充“不同事项、同仓库”竞争测试断言，针对性测试及 typecheck/diff 检查通过（69868 exit 0），生产代码未再改；详见 VERIFY。未运行本批全仓 pnpm test，没有部署 schema 20 或修改原 Docker/群聊/模型/凭据。
- 按 goal-protocol 保存本批验证边界及 16 个任务文件的本地提交，用户 AGENTS.md、outputs/ 不纳入；无运行中验证命令或未解决测试失败。
- 下一步：遗留 v19 及更早运行的迁移隔离/受控恢复，schema 20 未结算 session 的安全清理与续办，崩溃/强制重启和真实 Docker 六场景。当前只持久防止不明运行被重放；没有宣称旧历史运行自动回填安全或重启已自动恢复成功。Goal active。

### 底层复核持久占用与迟到结果（2026-09-06 最新）

- 上一批 deeb2f2 及完整回归是已验证进展。本批检查发现 schema 19 生命周期只在 runtime 包装层，独立 CandidateVerificationCoordinator 可以绕过持久占用；先将同一机制下沉，避免创建第二套复核状态。
- 所有公开复核调用先验证账本及实例租约；复核器自身负责预留、命令/证明登记和退出结算，runtime 仅跟踪 promise、取消和降级。失去租约、缺少证明、清理不明或关库不能结算；租约接管不解除遗留占用。单实例去重键包含 owner/fence，旧实例不能复用新实例调用。
- 新增三项测试：第二 SQLite 连接及真实独立 Node 子进程在命令等待期间都不能再次复核；缺进程证明的记录在租约接管后仍占用；旧 lease 在 runner 返回前失效时不写 Verifier/Meta 结论。先行测试分别复现无占用与迟到后写入两条记录，再修复。针对性 52 项和 typecheck 通过，独立子进程测试另行通过。
- 最终相关回归 68 文件 / 485 项、typecheck、服务端编译和 diff 检查全链通过（62528 exit 0），详见 VERIFY。本批没有运行全仓 pnpm test，上一批全仓证据不代替本批验证。没有改 schema、Docker 服务或真实群/模型/文档配置。
- 按 goal-protocol 保存本批验证边界，提交七个任务文件，用户 AGENTS.md 和 outputs/ 不纳入；当前没有运行中验证命令或未解决测试失败。
- 未完成的下层执行边界：CandidateExecutor 仍在 prepare 后才登记运行，失败返回可进入 finalized 而没有统一确认进程为空，自测清理异常可能转为配置报告。下一批应先为这些路径补测试，再做统一持久仓库预留/结算，不能只增加一次 SELECT 检查来冒充原子互斥；遗留恢复及六类真实试点继续待办。Goal active。

### 混合队列与直接执行入口（2026-09-06 最新）

- 上一批 bbc9daf 已完成并提交；本批从干净任务工作区恢复，用户 AGENTS.md、outputs/ 保留。
- 两个先行测试复现直接 runtime 执行绕过进程内仓库占用：自动任务仍在 prepare 时直接启动同仓库，或直接任务 prepare 期间调度再次启动工作。公开入口现同步占用 canonical repository 和事项调度标记；内部已占用的调度入口走独立私有方法，避免重复锁定。结束时受生命周期保护地释放，并继续排队工作。
- 新增复核/修改同仓库串行和不同仓库并行、停止后不启动后续候选、Owner 复核重试等待直接修改结束的测试。前五项与既有 runtime 测试共 56 项通过；第六项单独通过。测试 spy 的 this 类型缺失已补齐；最终证据见 VERIFY。
- 全仓 pnpm test → typecheck → 服务端编译 → diff 检查全链通过（83130 exit 0）：主测试 261 文件通过 / 1 文件跳过，2475 项通过 / 18 项跳过；broker 7 项、Electron 32 项和打包启动/9 个代理路径检查通过。第一次权限审查超时未启动，一次重试后获确认运行；保留同一句柄直至完成。未部署或调用真实群/模型/在线文档。
- 本批按 goal-protocol 的 Goal 分批约定收束，保存七个任务文件的本地提交；用户 AGENTS.md、outputs/ 不纳入。无运行中验证命令、无未解决测试失败。下批先为底层 executor/coordinator 的持久仓库预留补跨连接竞争测试，再实现，不把本批进程内队列当成跨进程安全证据。
- 当前修改只统一 headless runtime 入口的进程内调度，不能宣称底层 CandidateExecutor / 独立 Coordinator 已获得跨进程互斥。待继续：统一持久仓库预留、遗留复核安全恢复、真实强制重启和六类群聊试点。Goal active。

### 启动复核后台化与仓库队列（2026-09-06 最新）

- 恢复 cc4abcf 基线及先行测试。启动不再等待独立复核结束：先从持久候选建立待办，再在服务 running 后后台调度，维护循环可续租、接收消息及投递 Outbox。
- 复核与修改共用 canonical repository 调度占用；同仓库复核排队、不同仓库并行。复核队列仅处理候选，不因自动执行关闭而启动新的代码修改；普通失败出队，不在每次 drain 自动重试。未结算的持久复核继续阻止该仓库。
- 先行测试复现 startup 阻塞。共享会话的第二条准备消息被保守归属为 ambiguous，改用独立会话夹具，不改变产品归属规则；补齐 teardown 对后来启动 runner 的释放。针对性 3 文件 / 51 项及 typecheck、diff 检查通过（39813 exit 0）。
- 最终协作/钉钉/headless 68 文件 / 476 项、typecheck、服务端编译和 diff 检查通过（22034 exit 0）。首轮唯一失败是 loopback 监听被沙箱拒绝，授权后重跑全部通过。未部署、未调用真实模型、群聊或在线文档，不借用历史试点结果。
- 按 goal-protocol/当前 Goal 的每批 20 工具轮约定收束，仅提交本任务六个文件，不包含用户 AGENTS.md 和 outputs/；本批无运行中命令，无未解决测试失败。完整产品目标仍进行中。
- 下一步：验证复核与修改混合队列及强制重启；遗留未结算记录的受控恢复、全入口统一占用、完整 pnpm test 和六类真实试点仍未完成。Goal active，不将后台启动等同于完整重启恢复或自然群聊验收通过。

### 持久复核运行与仓库占用（2026-09-06 最新）

- 先恢复上一批同一 91577 验证句柄，确认 470 项/类型/编译 exit 0，补齐记录并提交 2ce14fc；未重复运行已经通过的上一批验证。
- schema 19 追加不可变 verification sessions/commands/proofs/settlements。复核开始及每条测试命令启动前事务登记，包含固定候选、计划/快照、仓库和实例 fence；原隔离验证回调通过后才保存证明，随后 runner 才可打开启动门。
- 结算重验每条命令的隔离证明并 inspect empty；缺证明、身份变化、进程非空、失去租约、关闭期间无法安全落库或 CommandCleanupError 均保留未结算记录。旧实例不能借迟到结果解除占用。
- 未结算仓库阻止 headless 调度和直接执行入口、启动复核扫描及最终完成门禁；新实例可正常启动，但跳过受阻仓库，不把它当空闲继续写入。测试覆盖租约过期后的新 runtime、第二 SQLite 连接争抢、证明不可变，以及普通测试失败但进程已退出后 Owner 显式重试。
- 新增 v18→v19 升级保留旧映射预留测试；旧 v15 升级夹具需同时移除新增表并更新版本断言，已修正。最终 68 文件 / 473 项、全仓类型检查、服务端编译和补丁检查通过（53653 exit 0），详见 VERIFY。未运行本批全仓 pnpm test、真实 Docker/模型/群消息或部署 schema 19，没有凭据/身份变化；用户 AGENTS.md、outputs/ 不提交。
- 尚未完成：遗留记录的受控清理和结算入口、无命令/无证明记录的安全恢复、跨进程真实竞争压力测试、执行与复核全入口统一仓库锁、startup 后台化、六类真实试点。当前是持久安全阻止重复执行，不是自动恢复成功；既有直接底层 service/coordinator API 尚未统一接入该生命周期，不能扩大为所有入口均受控。Goal active。

### Docker 测试取消与退出确认（2026-09-05 最新）

- 上批 3566eb5 为已提交进展。本批把 signal 从质量门禁传递到 Docker runner：已取消不创建，create 返回后取消不 start，隔离登记或 wait 期间取消会退出等待并清理本次容器。
- finally 通过完整 create ID + 当前 binding/host-generation 标签核查身份，确认 Running=false 后才删除交换目录。登记拒绝也会清理启动门前容器；身份/退出无法确认则抛 CommandCleanupError 并保留交换材料，不回显原始 Docker stderr、不猜测名字杀容器。正常 exited 容器不自动删除。
- runtime 对 verifier 清理未确认降级，禁止同一对象重启，关机不释放租约。此标记当前仅内存，不能防止租约过期后的其他实例接管；持久化 verifier run/containment/recovery 仍为下一优先项。
- 8 项 Docker runner 新测试及 runtime 清理失败保护已通过；针对性 21 项与 typecheck 通过。最终整组 68 文件 / 470 项、全仓类型检查、服务端编译和补丁检查通过（91577 exit 0，本轮先恢复同一验证句柄确认）。第一轮发现自然对话夹具未先送达旧提问的时序问题，修正夹具后重跑通过；详见 VERIFY。未运行本批全仓 pnpm test。
- 真实 Docker smoke exit 0：固定缓存 Node 镜像，before_gate 未执行测试；running_tree 在观察到子进程 heartbeat 后取消，确认容器 Running=false 且 heartbeat 不再更新。两个临时容器/自有目录已清理，前后 ps 核对现有试点仍 Up 2 days healthy，历史退出容器保留；无拉镜像/部署/凭据或群消息操作。
- 按 docker-helper 检查隔离资源、无网络、只读根目录、非 root 与挂载边界；按 goal-protocol 本批最多 20 工具轮保存证据。下一步须补 verifier 持久运行记录、未知清理后的受控恢复和跨实例竞争，再后台化 startup。不能将本次容器取消测试说成六类真实群聊或完整主机重启验收。

### 复核取消与运行期保护（2026-09-05 最新）

- 上批已提交 fa35a53，是实质进展。本批增加外部取消信号：提议/独立模型等待可及时退出；模型忽略取消或超时后迟到返回，不启动下一阶段模型、不写收据。已预留尝试保留，既不伪造失败结果也不清零预算。
- CandidateVerification 与目标测试入口传递取消；未开始的下一命令不启动，迟到结果不进入 review/Meta。已进入 runner 的隔离登记继续完成，不中断其清理握手；这不等于已启动的操作系统进程被终止。
- runtime 停止/关闭时取消本生命周期复核，Owner 后台 retry 捕获异常并隔离旧生命周期回调。跟踪未结束复核；关机限时未收束时明确 shutdown_verification_unsettled，不释放实例租约，同一 runtime 对象禁止立即重启。测试复现旧代码 database is not open 未处理异常，已修复。
- 针对性三文件 51 项和类型检查通过；最终整组 67 文件 / 461 项、全仓类型检查、服务端编译和补丁检查通过（89949 exit 0）。本批没有运行全仓 pnpm test，不借用上批证据。无部署、真实模型/钉钉/在线文档调用或凭据/身份变化。
- 尚未后台化 startup：真实 verifier 进程的可验证终止和跨进程持久恢复仍是前置缺口。当前进程内跟踪不能防止租约自然过期后的其他实例竞争，不能据此宣称并发/关机强隔离已经达标。需要 verifier 持久 run/containment 证据、取消时受限进程终止、后台启动和重扫一起补齐。
- 模型取消不写结果时，认领窗口内仍显示 pending；窗口到期及三次预算按原协调器规则处理，尚未补后台自动续办。真实六类试点、模型授权、文档与测试生成缺口继续保留，Goal active；用户 AGENTS.md、outputs/ 不提交。

### 复核反馈与过期通知保护（2026-09-05 最新）

- 等待核对、复核受阻、执行失败分开展示，缺少覆盖和服务不可用分别说明原因；三类 session 回复不附内部状态、WI、代码、SHA 或路径。pending 使用独立幂等键，失败沿用旧键兼容历史去重。
- 同事务检查实例租约、当前计划/最新 Spec、未投影贡献、控制状态、最新执行/复核尝试及验证契约。暂停/取消/换计划/新贡献后的旧失败不入队；替换实例的旧租约通知静默丢弃。
- 相关回归 67 文件 / 454 项、全仓类型检查、服务端编译和补丁检查全部通过（92132 exit 0）。新增 9 项，详见 VERIFY。没有运行本批全仓 pnpm test。
- 测试使用真实临时 Git/SQLite 与受控执行端口；状态变化直接设置夹具，不冒充真实 Owner 群操作。pending 为运行时通知边界测试，不证明模型调用一开始就有主动进度，也不保证待核对自动续办。
- 下一重点：runtime.start 仍等待启动候选复核后才启动 Stream，长模型等待可能阻塞接收/租约维护。需同时处理后台 verifier 的 promise catch、关机任务跟踪和安全清理，再验证异步恢复。本批没有解决重启沉默。
- 未部署 Docker、未调用真实模型/钉钉/在线文档、未改凭据/身份；真实模型授权、复杂解析镜像、在线文档、补测试和六类真实试点仍待办，Goal 保持 active。用户 AGENTS.md、outputs/ 不提交。

### 模型显式配置、状态变化保护与收据复核（2026-09-05 最新）

- 前批为已提交进展。新增 headless proposer/verifier 显式配置，默认关闭，拒绝缺项、危险 URL、相对凭据路径及隐式凭据回退；配置变化自动派生新的策略身份，健康探针不读模型凭据/不调用模型。
- 最终完成判定现在重读并验证映射持久收据，而非只信任 verifier verdict 中的 mapping 引用。缺失、过时、条件不匹配或实际测试绑定不一致不通过；正常自动映射完成路径保留。
- 映射等待期间 pause/cancel/Spec/候选 HEAD/dirty worktree 五项保护回归通过，后续测试启动数为 0。Owner 控制变化在该测试中直接设置持久状态，未冒充真实 Owner 群消息。
- 最终 pnpm test、类型检查、服务端编译和补丁检查全链通过（66111 exit 0）：主测试 2438 passed / 18 skipped，附加 broker 7 项、Electron 32 项及打包启动/代理路径检查通过。四文件 23 项此前通过；TS object 属性收窄问题已修正。详见 VERIFY 最新节。
- 新增可选 Compose 模型配置模板及内部说明。按 docker-helper 检查只读挂载边界；首次只读 ps 授权审查超时、未启动，一次重试确认原试点 Up 2 days healthy，历史容器未动。没有构建/部署、无真实模型或群调用。
- 已异步请求用户提供获授权的非生产模型地址、型号和凭据文件引用，不要求密钥正文。仍需真实授权/配置以及语义效果评测；不能因 headless 装配通过或容器 healthy 就说自然协作已启用。
- 本批按 goal-protocol 20 轮收束，之后只完成最终验证/记录/本地提交。后续重点：真实 Compose 合并检查和授权试点、映射失败/等待时的自然回复、独立复核所需依赖源码上下文与新增缺失测试、长文档/在线文档、跨进程竞争及六类真实群聊场景。Goal 保持 active。


### 有来源的自动验收对应与独立复核（2026-09-05 最新）

- 前一批有已提交实现、全仓回归及真实 Docker 证据，属于进展。本批新增固定 Git blob 测试源码采集、双模型上下文映射/复核和 schema 18 不可变收据；不从当前可变文件或文档指令生成控制权限。
- 映射前预留持久尝试；跨重启最多三次，忽略晚于后续认领的结果，模型忽略取消时仍在 90 秒超时。假引文、额外指令字段、旧候选/Spec/策略、重复或遗漏条件与 uncertain 复核不被认可。
- 已接入候选复核和运行时可注入配置；reporter 支持先采集未绑定条件的自测结果。映射生成局部契约，不能仅凭映射 approved 完成，仍须自测和独立复测断言通过。不修改全局命令注册表。
- 最终相关回归 65 文件 / 433 项、全仓类型检查、服务端编译和补丁检查全部通过（8560 exit 0）。针对性 31 项此前通过。第一次整组的直接启动 TS 参数属性兼容问题和旧 schema 断言已修正；详见 VERIFY 最新节。本批未运行全仓 pnpm test，不沿用上批完整回归冒充本批证据。
- 测试失败记录：新增模块先行导入失败；初版夹具误把 ledger 包装器当数据库导致 5 项失败，改为打开真实 DatabaseSync 后通过；接入测试先复现 reporter 必须手动契约导致失败，支持先采集断言并动态映射后通过。一次整批补丁上下文不符未应用，核对后重新应用，无部分改动遗失。
- 下一步：headless 显式映射模型配置与策略身份管理、从映射 receipt 重新验证最终完成记录、映射等待期间 Owner/Spec/候选漂移专测、跨进程并发认领专测、缺失用例自动补充及依赖源码上下文。当前只有受控模型输出通过，尚未验证真实语义准确性，不能宣称自然语言到研发交付已完整上线。
- 未部署 schema 18、未替换 Docker、未调用真实模型/钉钉/在线文档、未更改用户凭据或身份。按 goal-protocol 本批最多 20 工具轮收束；Goal 仍 active。


### Node 测试报告器与真实 Docker 断言采集（2026-09-05 最新）

- 上批为实质进展：已提交断言级门禁。本批接入 Node test 报告器，从框架事件生成本次 run/nonce 报告；headless 保留配置，Docker 只读挂载，Verifier 要求 runner 证明已启用，不再要求测试业务代码自行输出内部 JSON。
- 本地报告器 6 项、headless 9 项及类型检查通过。相关整组 63 文件 / 421 项、类型检查、服务端编译和 diff 检查通过（85172）；后补缺少 reporter attestation 的回归，由最终全仓测试覆盖。
- 真实 Colima smoke exit 0：固定缓存 Node 24 镜像中通过→验收通过，失败/跳过→验收缺失；试点测试断言读取文件真实值，验证只读报告器不可写及普通日志伪报告被忽略。3 个自有临时容器及目录已清理，未拉取镜像或替换当前健康钉钉服务。
- 本批完整 pnpm test、类型检查、服务端编译与补丁检查全链通过（82423 exit 0）：主测试 2415 passed / 18 skipped，附加 broker 7 项、Electron 32 项及打包启动/代理路径检查通过。无真实群消息/模型/在线文档调用，无凭据或身份变化。临时随机测试密钥仅为自有隔离证明，不涉及用户配置。
- 按 goal-protocol 本批 20 工具轮内收束，不扩展功能；保存经过验证的本任务文件为本地提交，不 push，用户 AGENTS.md 和 outputs/ 保持不动。完整 Goal 仍 active。
- 下一步：自动生成并独立复核验收条件与具体用例绑定；防止候选弱化测试或恶意同 UID 旁路干扰；自然引用/多人语义、在线文档、复杂解析镜像与六类真实试点仍未完成。本批没有把工程人员配置 reporter/hash 的步骤交给普通群用户；完整自然到交付闭环尚需补齐。


### 断言级业务验收门禁（2026-09-05 最新）

- 去掉验收文本包含测试命令名即覆盖的规则；绑定当前条件哈希与可信断言 ID，校验本次 run/nonce，开发自测和独立复测都须有对应通过证据。当前候选、Spec 与验证契约继续绑定，旧/裸 passed 记录不能通过完成门禁。
- 新测试复现额外测试失败被局部通过忽略；补齐所有选定命令及报告失败断言检查。未改变 Owner 边界，也未放松不可变证据。
- 最终 62 文件 / 414 项相关回归、全仓类型检查、服务端编译和补丁检查通过（73209 exit 0）。此前针对性 55 项及类型检查通过；详见 VERIFY 最新节。
- 失败记录：先行测试复现命令名误覆盖、缺失报告和被忽略失败；两次夹具误用 UPDATE 触发不可变证据保护，已改为初始 INSERT，不修改保护规则。按 goal-protocol 达 20 工具轮后停止功能扩展，仅完成验证、状态与本地提交。
- 未部署、未调用真实模型或发送群消息、未更换配置/凭据。仍缺可信 reporter 与自动验收用例映射/独立语义核对，不能声称本门禁已解决需求正确性或群内自然体验。
- 下一步：先补可信测试适配及 Spec-to-case 流程，再验证 headless 配置与 Docker 报告环境变量传递；继续真实模型授权配置、在线/长文档、机器人引用与复杂多人指代、安全解除中断执行，以及 Docker 六类真实试点。旧无断言配置不能直接升级后宣称自动交付可用。Goal 保持 active。


### 已发送选项的自然选择与迟到失败通知（2026-09-05 最新）

- 修复准备过程中取消或更新计划后，旧 catch 通用错误仍发送的问题；事务内核对实例租约、当前计划/Spec、控制状态和最新尝试，迟到失败不覆盖当前任务。
- schema 17 记录实际发送成功的选项载荷、完成时间和持久发送序号；不是按当前候选排序解释“第二个”。自然关联启用时，归属提示允许直接说序号，不再要求填写标题模板。
- 同群同一提问人的一条未解决归属问题、30 分钟内、选项真实发送完成且没有后续机器人提问时，序号可直接选择；原待归属需求与选择消息在同一事务关联，各自保留投影任务和来源。跨重启、排序变化和消息重放有覆盖。
- 未发送/发送失败、跨人/跨群、过期、多条并存、关闭目标、越界序号、回答早于发送完成以及后续提问均不猜测。仅改变需求归属，不赋予审批/控制权限。
- 最终 61 文件 / 398 项回归、pnpm typecheck、服务端编译和 diff 检查通过。20 轮后停止新增功能，仅完成最终验证、记录和本地提交；未部署或发送真实群消息。
- 接续重点：实际机器人出站引用仍缺稳定消息 ID 映射；中间人工提问、跨人代答、超过 30 分钟或多个归属问题需更丰富的上下文确认，不能宣称通用指代已完成。标题/“这是新问题”的选择也尚未有与序号相同的原消息回填闭环。
- 全目标仍 active：异常未确认状态的安全解除、长文档/在线文档、真实模型与断言级验收、Docker 更新及六类真实群聊验收仍待完成。

### 执行准备异常通知与 Owner 恢复（2026-09-05 最新）

- schema 16 增加不可变准备结果：已确认失败、旧实例中断、进程清理未确认。结果与 Outbox 通知同事务写入，跨重启不重复通知；旧计划和已取消/完成事项不进入中断通知扫描。
- 已确认失败只允许唯一 Owner 的新重试决策；每次新预留消费该授权，后续失败需要重新决策。决策入账后、调度前重启可续办；冻结失败时的尝试上限，三次失败后不继续。
- 进程退出无法确认单独抛出 CommandCleanupError，不再视为普通失败允许重试；旧实例中断同样保持停止，尚未提供经隔离证据确认的解除入口。
- 最终 61 文件 / 385 项回归、全仓类型检查、服务端编译和 diff 检查通过。第一次整组执行授权审查超时、命令未启动；允许的一次重试成功。20 工具轮后停止功能扩展，仅轮询最终验证、保存状态及本地提交；无容器部署、群消息或凭据变更。
- 下一批优先：验证执行准备期间取消/换计划后，catch 的通用 enqueueExecutionFailure 是否仍会覆盖当前状态（本批启动扫描已排除取消，但此竞态未覆盖）；再建立 interrupted/unsettled 的独立安全清理证据与 Owner 恢复协议，不能仅靠文字确认放行。
- 当前真实试点仍是旧版本；真实模型、复杂解析镜像与在线文档、业务断言覆盖和六类自然群聊验收继续未完成。Goal 保持 active。

### 排队未启动任务重启恢复（2026-09-05 最新批次）

- 启动和健康维护从持久化计划重建未启动任务；同仓库保持串行，不同仓库保留并发。暂停、过期 Spec、运行过或已预留的任务不被后台当作新任务重试。
- schema 15 在工作区准备前不可变预留尝试，重启不清零预算；校验当前实例租约。Owner 暂停/恢复/重试的每个版本变化必须有控制事件证明，未投影的新贡献继续拦截旧 Spec。
- 禁用自动执行、probe-only 和低磁盘均不自动启动；低磁盘解除后维护恢复。准备失败准确提示检查环境，不承诺普通重试一定可恢复。
- 协作、钉钉、headless 整组回归、pnpm typecheck、服务端编译和 diff 检查均通过；详见 VERIFY 最新节。20 轮批次收束，Goal 保持 active，未部署或发送群消息。
- 恢复入口：下一批补齐已预留但无 run 的崩溃通知与明确 Owner 恢复协议（当前安全停止、不会自动重试），验证版本 14 数据库升级、大队列与仓库别名、完成任务重放。手动 executeCurrentPlan 仍是独立入口，不能宣称所有入口均受新预留预算约束。
- 外部缺口保持：真实模型配置、Python 固定镜像构建/headless 装配、在线文档、业务断言验收及六类真实钉钉试点。本地通过不能当作自然群聊或 Docker 最新版本已验收。

### DOCX/XLSX/PDF 解析源码与构建入口（最新批次）

- 最终增加 Word 表格/行/单元格来源和文本框去重；两项先行失败经修复，本地 Python 共 12 项通过，相关 TypeScript 17 项和全仓类型检查通过。解析源码、锁文件、构建入口及文档保存本地提交，不推送；构建入口尚未被真实 Docker 构建验证，不能描述为运行镜像已完成。

- 核对工作区：上一批 9ff1e26 已提交，用户 AGENTS.md、outputs/ 保持不动。现有试点容器仍健康运行，未停止或替换。
- 新增可追溯的四项 Python wheel 版本/SHA256 锁、分阶段 Dockerfile、专用测试目标和运行边界说明。解析源码与夹具从未验证草稿推进到本地单元测试通过。
- 本地 Python 11 项通过：Word 段落/表格、Excel 多工作表/隐藏表/公式不执行、PDF 页码/空页/间接资源/加密拒绝、ZIP 路径/宏/实体/压缩限制、截断、外链/字段以及错误不回显。先复现 Word 简单字段误报完整后修复。
- 真实 Docker 受阻：基础镜像拉取在 Colima DNS 超时；宿主机清单查询和备用 GitHub 下载入口也失败。所有相关进程已终止，无活构建进程；未改全局网络或运行服务。headless 尚未启用复杂文档解析。
- 临时 venv 为 /tmp/omb-parser-verification-20260905，只运行自生成夹具，不可用作真实附件解析回退。模型/钉钉/凭据未调用或变更。
- 下一步：恢复或提供可达的已授权公共镜像下载环境后，构建固定镜像并完成 Docker 实测；并行目标方向仍包括长文档分段完整覆盖、在线文档、业务断言验收和六类真实试点。整体 Goal active，不把本地测试当作 Linux 验收。

### 账本完整性与正文需求解释（最新批次）

- 已实现根级不完整标志恢复、完整投影片段/行位置校验，以及每版 Spec 从账本重算未读/部分/摘要遗漏门禁；确认消息不能绕过，未支持附件不能视为已读。
- 同事项正文进入自然解释器，验收可引用正文；来源消息、文件和片段哈希保存在解释收据。模型等待期间附件变动会拒绝旧结果。读取过程中不消耗模型尝试，读取完成后原后台任务自动续办。
- 61 文件 / 369 项协作、钉钉、headless 回归与类型检查/服务端编译通过；之后补充指纹竞态和调整等待提示，11 项完整性测试及全仓类型检查再次通过。最后整组复测请求的授权审查超时，命令未启动，不冒充又一次整组通过。
- 上批 loopback EPERM 已获准复测消除。Python 草稿、真实 Docker 解析、headless 复杂格式启用、真实模型配置及六类群聊试点仍未完成；未更新容器、未发送消息、未动凭据或身份。
- 本批按 goal-protocol 20 工具轮内收束，验证通过的 TypeScript 与状态文档保存本地提交，不推送；packaging/collaboration/document-parser 的未运行草稿不提交。整体 Goal 仍 active。
- 下一步优先：长文档分段覆盖与可恢复完整性解除；固定依赖 Python 镜像及 Docker 验证；复杂格式真实摄取和真实群聊闭环。保持现有 Owner 边界，不用人工确认强行清除未读门禁。

### 隔离文档提取接口（当前批次，未提交）

- 已实现异步提取注入、解析器版本入证据、复杂格式的持久化投影；受控 PDF 结果跨重启保留页来源和部分读取标志。headless 未启用，默认文本处理不变。
- Docker 适配器使用固定摘要、无网络/主机挂载、非 root、资源限制及临时容器清理；补测并修复创建确认丢失时漏清理、stdin 提前关闭产生未捕获 EPIPE、失败被错标文本解析器三项问题。
- Python 解析草稿和测试位于 packaging/collaboration/document-parser，尚无 Dockerfile、依赖锁和真实运行；联网版本查询两次审批超时，未再重复尝试。没有更新试点容器或发送群消息。
- 广泛回归 59 文件 / 358 项通过，1 项真实 loopback HTTP 测试因 listen EPERM 失败；不删断言、不跳过它冒充全部通过。本批保留工作区，不自动提交。最终局部回归/类型检查见 VERIFY.md。
- 优先接续：构建并验证固定依赖解析镜像；修正部分附件、未支持附件和事实截断的不可绕过 Spec 完整性阻塞；将正文带来源送入自然解释器，再接 headless。PDF indirect resources、DOCX 重复段落及 daemon 创建超时竞态需实测审查。
- 整体 Goal active；本批按 goal-protocol 20 工具轮收束，不将本地接口实现当作真实六类试点完成。用户原有 AGENTS.md、outputs/ 保持不动。

### 测试子进程隔离修复（当前批次）

- 上批已取得完整回归及基线对照证据，属于进展。本批核对代码后，在 `server/index.test.ts` 的显式子进程环境补入 `VITEST=true` 和 `OPENMAUSBOT_PROBE_LOCAL_INJECT=0`；未修改生产代码、timeout、测试选择或断言。
- 原失败文件全部 88 项通过（18:24:25 开始，56.13 秒），全仓类型检查通过。说明丢失测试标识造成环境相关行为；VITEST 同时关闭既有本机模型探测和登录 shell PATH 探测，因此未对二者各自耗时作独立归因。之前的 4 个失败均在该文件复测中消失。
- 正式 `pnpm test && pnpm typecheck && git diff --check` 已全部通过，句柄 `55000` 已以 0 退出。主 Vitest 252 文件 / 2344 项通过、18 项跳过（共 2362，数量门禁通过）；broker 7 项、Electron 独立套件 32 项通过，打包服务脱离 node_modules 启动及 9 个代理路径检查通过。
- 人员定向与测试隔离作为已验证批次保存本地提交，不推送。历史 4 项失败已在本批复测和完整测试链中消除。测试跳过项仍按测试平台条件保留，不能宣称跨平台全覆盖。
- 下一阶段附件实现入口已核对：`AttachmentIngestionCoordinator.processClaimed()` 仍同步调用文本提取器；复杂格式需改为可注入的隔离提取端口并在 Docker 中无网络、只读文件系统、无凭据运行。当前不会因为扩展文件名支持就宣称已读取正文。

### 有来源的人员定向批次（随当前批次提交）

- 移除最近十条消息中随意收集 @ 人员的策略，改为逐问题确定回答人。目标确认找原需求提出人；专业问题仅使用同事项已有发言中的人员、来源事件及逐字引文，不根据昵称、最近发言或被 @ 推断职责。
- 自然解释 schema 的每个问题新增必填 nullable `respondent`；未知人员必须为 null。结构校验和落卡前再次核对同事项来源，拒绝群外/其他事项/伪造引文。角色和来源保存到当前 Spec，重启后仍可生成相同定向问题。
- 只有唯一可解析的已观察 staff 身份可以形成通知目标；跨企业别名歧义、无可靠 staff 身份时只保留角色提示。不会修改身份记录、Owner 或控制权限。
- 钉钉文案将 @ 人员放在对应问题旁，通知列表去重；无问题的中断通知不再要求用户“补充关键信息”。
- 验证：351 项协作回归、27 项身份歧义补查、类型检查和服务端编译通过。最初全仓回归的 4 个失败及对照诊断保留下节；当前测试隔离修复后正式项目测试链全部通过，以本页顶部结果为准。
- 未验收：实际模型是否正确识别职责、真实群聊 @ 效果；人员关联来自受控模型测试，不是完整成员目录或组织角色授权。当前自然解释只读同事项近期消息，跨事项角色记忆/引用机器人消息/复杂附件仍待实现。
- 已向 Owner 非阻塞询问可用于试点的现有授权模型服务与配置位置，未要求粘贴密钥、未更换凭据或容器。
- goal-protocol 前批到限保留了代码与证据，本批完成验证后提交明确的本批文件。`AGENTS.md`、`outputs/` 仍为用户原有未跟踪内容，不得提交。

### 全仓回归对照诊断（历史失败，当前批次已修复）

- 上批属于实现进展；本批保持原全仓句柄直至结束，未因无输出重启。发现 `server/index.test.ts` 三项 20 秒超时（Chief 任命、团队导出导入、项目团队导入），另有一次名称期待 Mira 2 实际 Mira 4；后者可能是前序超时留下状态，尚未单独证明。
- Chief 案例在当前工作区单独复现失败，又在未包含人员定向改动的 HEAD 临时 worktree `/tmp/openmausbot-directed-review-baseline` 中复现同样 20 秒超时。两个定向进程 `84138`、`77991` 均已结束。这只证明该超时不是本次人员定向改动引入，不能把其余三项直接判为基线问题。
- 已定位优先假设：HTTP 测试子进程 `server/index.test.ts:213` 使用显式环境，不传 VITEST；`registry.describe()` 每次等待 `refreshModels()`，Claude 模型合并仅在 VITEST=true 且非显式探测时跳过本机模型探测。启动和多次新建机器人可能等待真实本机服务。下一步用受控测试验证该路径，再修复测试隔离，不能简单扩大 timeout 或删除断言。
- 只做只读进程/监听端口诊断及独立测试 worktree；未改业务代码、未变更凭据、未部署。未执行 `pnpm test` 后续 broker/Electron/打包验证；完整 Vitest 的失败使串联类型检查/编译命令未在该次运行中执行，之前独立通过结果仍保留。

### 异常收束与重启通知批次（已提交）

- 只读核对 `colima-openmausbot-pilot` 中的试点：容器运行，但自然解释模型开关、地址、模型、凭据文件引用均未配置。仅输出布尔元数据，未读取或输出凭据，未更换容器。
- schema 14 新增归并后投影的独立持久化尝试计数；最多三次，带认领租约，重启不重置预算、不重复归并或贡献入账。三次失败或最后一次认领过期后停止，原消息仍保留。
- 投影失败通知可恢复且按来源去重，不回显异常正文；不把“已保存”说成“已用于修改”。需求解释最后一次认领崩溃后，也会恢复原本漏发的失败提示；旧消息、已取消/完成事项不新发过时提示。
- 最终验证：59 文件 / 345 项相关回归、全仓类型检查、服务端编译及补丁检查通过。无真实模型或钉钉调用。只保存本地提交，不推送。
- 失败记录：测试先行复现无限投影重试和崩溃后漏通知；首次修复中通用计划卡丢弃摘要，改用保留上下文的通知卡后通过。第一次完整测试启动遇权限审查超时，获准重试后完成。
- 本批按 goal-protocol 20 工具轮收束，Goal 保持 active。仍缺归并模型最终失败的专门通知（目前保留原归属澄清）、通知交互文案进一步打磨、角色定向和真实试点。

### 真实模型适配与自然归并批次（已提交）

- 已实现 Responses HTTP 模型适配器和 headless 配置装配；显式模型、地址、权限受限凭据文件必须由受信任配置提供。禁用工具、响应存储和重定向；输入/输出有界，错误不回显提供商正文或凭据。
- 已实现 schema 13 归并队列：无可靠引用的消息先按同群事项摘要和近期上下文归并，再进入需求解释。开启后旧的“补充/继续”关键词不再抢先猜测归属；显式有效 WI、有效原消息引用和明确新任务仍走确定性路径。
- 支持普通“就是这个意思”归入同一事项、自然新问题另建事项、队列重启恢复、原消息贡献入账与重复投影防护；模型只能选择同群候选并通过版本和认领校验。
- 真实 fetch 到本机 HTTP 测试服务已通过；未调用真实模型、未配置新凭据、未更新 Docker。**装配代码已完成不等于试点已启用或模型效果已验收。**
- “第二个”尚未接入原始已发送选项记录，因此保持澄清，不按当前排序猜测。超过候选数上限或关键文本被截断也不能自动归并。
- 仍需补齐：多人角色定向、机器人出站回复映射、原选项指代、路由投影连续失败的收束通知，以及真实模型样本回归。真实模型调用需要已有授权配置；不能临时冒用 Codex OAuth 或改走未授权付费服务。
- 验证：59 文件 / 341 项相关回归、全仓类型检查、服务端编译和补丁检查通过；保存本地提交，不推送。新增后台 Spec 漂移保护已通过先失败后修复的测试。goal-protocol 本批 20 工具轮收束，完整 Goal 仍 active。

### 自然需求解释批次（已提交）

- 新增持久化需求解释队列和 schema 12；解释读取当前 Spec、最近来源消息和待确认问题，结构化建议经过逐字引用、版本、认领和字段白名单校验后原子落库。
- 已接入服务与运行时后台处理接口，模型等待不阻塞 Stream/租约/其他入站；重放读取原始已入账消息，不信任重放携带的改写文本。
- 已提供无工具的模型请求构造器和可注入模型端口；**headless 启动配置尚未装配真实模型适配器，Docker 仍未启用该路径**。测试中的模型回复为受控夹具，不能证明真实语言理解质量。
- 新问题优先展示且最多 3 个；角色仅作为追问文案提示，尚未实现可靠的角色到真实人员映射。无回复引用的自然归并、机器人出站引用和“第二个”选择仍待实现。
- 连续三次正常解释失败持久化失败状态并排队发送“尚未开始修改”；进程反复崩溃耗尽认领预算后的通知恢复仍需补测。
- 修正“密码错误”“空 token 时显示反馈”被误当凭据的脱敏问题；这不等于完成所有 Secret 入账防护。
- 未更换容器、未调用真实模型、未发送群消息、未变更凭据或身份。
- 最终验证：57 文件 / 323 项协作回归与全仓类型检查通过；本批 20 工具轮收束，保存本地提交，不推送。Goal 仍 active。

### 连接可靠性批次（已提交）

- 新增回归已复现四项失败：初始注册被误报已连接、注册等待被反复重连打断、失败连接无统一退避、启动重连后服务无法恢复健康。
- 连接可靠性修改完成：协作与钉钉回归 56 文件 / 311 项通过，全仓 `pnpm typecheck` 和服务端类型检查通过；未更换 Docker 服务、未发送群消息、未变更凭据或身份。
- 修复本地 React 类型包链接后，修正协作测试的回调返回值、联合类型收窄和测试夹具类型；未删断言、未放宽产品权限或业务类型。
- 本批收束：20 工具轮内完成连接可靠性与验证基线修复；新 Goal 仍为 active，不将预算收束等同产品完成。

## 接续入口（优先于历史下一步）

1. 已核对：试点没有配置 Responses 兼容模型地址/模型/凭据引用。需确认已有授权配置的提供方式；新增真实凭据、付费或改变权限前请求 Owner 授权，不借用其他登录身份。HTTP 装配代码已完成，实际模型未启用。
2. 人员定向已新增同事项来源和唯一 staff 身份校验；继续实现“第二个”的已发送选项来源、机器人出站引用及真实人员定向验收。不能用受控模型测试冒充多人真实群聊验收。
3. 复杂附件目前未送入自然解释器正文上下文；长对话截断会显式阻塞，但完整上下文续读/压缩尚未实现，不能人为清掉 completeness 门禁。
4. 对排队未启动事项实现重启重建，保持同仓库串行和暂停/取消/失败预算边界；不重新执行历史完成事项。
5. 完成复杂文档/在线文档来源与完整性，以及断言级业务证据门禁后，进行 Docker 六类真实试点。当前容器仍为旧版本，不能据本地回归宣称群里已修好。
6. 连接残余验证：真实 SDK 注册与断线恢复、独立健康探针的活连接状态，以及 endpoint 请求长期悬挂的超时边界，均未由本批证明。

## 历史阶段（局部实现记录，不是新 Goal 的验收结果）

| 阶段 | 状态 | 结果 |
| --- | --- | --- |
| 0. 固化目标、约束和验证基线 | 已完成 | 四个 Meta 状态文件已建立；现有能力与缺口已核对 |
| 1. 结构化 Spec 与澄清门禁 | 已完成 | 首条自由文本不再自动执行；目标、验收和疑问必须明确确认 |
| 2. 独立 Verifier 与 Meta 验收 | 已完成 | 候选必须经过独立复核和确定性验收；历史或孤立通过记录不能绕过 |
| 3. 上下文隔离与可恢复调度 | 已完成 | 执行上下文有界；每个任务生成不可变状态包；同仓库写入自动串行 |
| 4. 完整回归与 Docker 真实验证 | 已完成 | 50 个测试文件、229 项通过；试点容器健康，Stream 已连接，执行模式正常 |
| 5. PMO 式自然会话入口 | 已完成 | 明确补充自动归并；换题自动新建；不确定时展示业务标题，不要求 WI |
| 6. 钉钉直接附件安全摄取 | 自动化通过 | 文件能力加密隔离；TXT/Markdown/CSV 可下载、脱敏、提取、追溯并恢复 |
| 7. 新版本 Docker 与真实钉钉验收 | 进行中 | 试点已重建，schema 11 / migrations 11，容器健康且 Stream 已连接；待发送非敏感附件 |

## 已完成基础能力

- 真实钉钉 Stream、群白名单、唯一 Owner、Ledger 和 Outbox 已运行。
- Docker 强隔离执行和目标测试证据已接通。
- 普通低风险任务验证通过后可自动完成；高风险任务才进入审批。
- 钉钉完成消息已改为通俗结果，不展示内部 token、diff 或 SHA。

## 历史失败记录（以新 Goal 记录为准）

- 无代码或自动化测试失败。
- DOCX、XLSX、PDF 和私有在线文档尚未支持，不能宣称已读取这些格式。

## 下一步

1. 重建并替换非生产试点容器，确认 schema 11、Stream、附件后台恢复均健康。
2. 在真实钉钉群发送一个不含敏感信息的 TXT/Markdown/CSV 缺陷附件，验证“收到 → 读取 → 带来源澄清”。
3. 增加隔离的 DOCX/XLSX/PDF 解析器；私有在线文档另走显式 DWS 用户授权，不与机器人凭据混用。
4. 用新的真实低风险任务验证“附件/自然沟通 → 澄清 → 修改 → 独立复核 → 自动完成”的纵向闭环。
