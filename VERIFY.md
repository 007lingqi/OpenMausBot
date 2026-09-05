# Meta 协作验证记录

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
