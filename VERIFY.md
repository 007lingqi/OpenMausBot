# Meta 协作验证记录

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
