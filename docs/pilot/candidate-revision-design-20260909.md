# 原需求不变的补测修订：实现已验证，待发布

状态：工作区实现及最终完整回归20930已通过，准备固定提交和发布。真实服务仍2342251/schema39。不得把已测能力当作当前运行事实或新的Owner授权。

## 已确认问题与范围

- 本机页面c31已上线，原WI-5C68D17B361E、version3/Spec4/plan2和成功run保留。
- 引用修复通过完整回归及真实模型只读诊断；独立模型确认优先级和交集条件覆盖，但空态只测源码正则/空数组，缺实际页面渲染断言。
- 固定候选补测只能运行该SHA Git对象中的已有测试；重试不会生成新版。拒绝/会话补充会改Spec，不是本次保留Spec的修订。旧执行恢复/删除工具均不适用。
- 原command镜像700873…中无React、TSX编译器或DOM环境，现有SSR缺dist失败，直接TSX导入失败。原候选无可注入空态的页面参数。不能靠新增一个脚本就宣称修复，亦不得伪造原测试回执。

目标：保留原需求、既有成果和证据，在明确范围内生成补测新版，然后真正重新执行两级验证及送达完成。非目标：重发/重建原需求、篡改原run、清预算、生产部署、身份凭据变化、依赖下载或默认分支合并。

## 推荐执行模型

受信本机操作请求是独立的候选修订意图，不伪装钉钉消息、不复用旧“第4次恢复”。请求绑定唯一Owner、当前事项/Spec/plan/范围、parent run/SHA、原总体base、精确允许路径、一次操作ID、TTL及授权证据引用。证据引用是来源，不是身份认证。

正常runtime在持久预留后执行，使用既有lease、同仓库互斥、隔离监督和结算；同WI下一attempt连续增加，预留后不退款。待修订的旧候选在各重验、批准、完成及Outbox入口统一阻断，不能等新run出现才失效，不能在新执行失败后自动恢复旧结果为通过。

构建从c31起步，新SHA应单父=c31；run/session/candidate的base_sha仍为原0837。新增buildParent/source身份用于工作树起点及Provider读取；原总体base用于完整变更、质量、风险、Spec和结果验收，不能缩短到c31→new隐藏既有功能改动。revision delta另对精确路径校验，旧测试不得删除或削弱。

只以提示词要求从原base重建旧功能不满足“保留成果”保证。虽可用第二份完整参考及全树等价门禁补强，但未比双基线方案更小，暂不选。

## 已关闭的实现选择

1. 渲染运行时：已隔离验证现有React19.2.6/ReactDOM19.2.6/scheduler0.27.0/TypeScript5.9.3纯JS包，无下载。只给完整页面增加可选initialQuery入口，默认空字符串，priority/status初始化不改；真实ReactDOM SSR的3项与原10项共13/13通过，默认HTML逐字相同，删除/hidden空态两个变异均使新增断言失败。只证明初始化HTML，不声称覆盖hydration/CSS或浏览器点击。原型镜像e6166341…、总依赖artifact eafee07f…；完整报告在本机`.codex/omb-empty-render-ssr-20260909.VMYYH8/REPORT.md`。这仍不是正式业务候选通过。
2. 持久与旧版兼容：采用正式schema40不可变request/stage两表，audit只展示。旧39正常启动会拒绝40，但已有连接或仅检查最低版本的类不会失效；因此迁移前必须停止所有旧写入者，并在迁移中拒绝活跃租约/未结清活动。额外窄DB触发器阻断旧父候选的新验证session和接受SHA。不能声称schema40撤销了旧连接或已在途消息。

## 冻结接口和边界

- `CandidateRevisionRequest`固定requestId、workItemId、expectedOwnerGeneration/workItemVersion/planRevision/snapshotRevision、expectedParentRunId/parentSha/baseSha、instructions、authorizationReferenceHash和allowedChanges。引用hash只作来源，入口权限来自受信本机操作和私有0600请求文件。
- headless私有文件入口限制整个编码JSON不超过16KiB，且拒绝符号链接/错误所有者；请求hash不是可执行权限令牌，不输出完整指令。
- 每项allowedChanges固定path、add/modify、父blob（add为null）；modify必须固定结果blob。不得用glob，不修改原测试，单独pin最小app入口。整次修订指令也纳入请求hash，不能在执行时替换。
- `authorizeCandidateRevisionLocally`检查当前Owner、Spec、scope、最新成功且结清父run、总体base与连续预算。grant固定buildParentSha/parentSha、nodeId、attempt和maxAttempts=3。正常运行配置若不匹配则拒绝，不借旧第四次特批。
- `reserveCandidateRevision`在同事务dispatch插入后预留；`markCandidateRevisionStarted`在同事务session插入后消费，DB检查实际绑定。预留即占次数，不退款。
- `candidateIsSupersededByRevision`是各消费者共享门：有效issued或任何reserved/started均阻断父结果；预留后过期、Owner变更、启动失败不能恢复旧候选。
- `readCandidateRevisionForAttempt`读取固定构建输入；`pendingCandidateRevisionWorkItems`只返回可启动项，所有校验在预留/开始重新执行。新run的quality_json由host记录lineage，不能采信Agent自报。
- 已预留失败不得原request重放；只有绑定本次revision的失败且已结清证据，才能在正常剩余次数内登记新的明确修订请求。真实测试失败保留生成SHA，不通过清空证据换取重试；失败SHA不能作为新的已通过父候选。
- 40迁移明确不兼容“未知旧准备自动带入新版本”：活跃或未证实结束的旧dispatch必须阻断40。此前的15→39迁移可已完成，原dispatch保留，不能凭租约过期伪造失败/结清记录。该兼容变化在旧版本重建测试中明确验证。
- 主线程接headless/runtime；Lagrange独占请求/存储；Curie独占worktree/executor/lifecycle/provider；Herschel独占验证/审批/Outbox消费者。实施后安排非作者核验。

## 责任与验证

| 不变量 | 实现责任 | 风险与验证 |
|---|---|---|
| 请求仅受信本机进入 | 独立请求模块与headless入口 | 私有文件/参数/Owner和范围CAS，broker、模型、普通群消息不可调用；hash不当认证 |
| 一次请求只启动一次 | 请求预留、dispatch/session、runtime | 重放/并发/取消/期限/租约变化；同WI连续预算，未知进程不重跑 |
| 旧结果不抢先完成 | 共用候选阻断predicate及全部完成消费者 | issued、reserved无run、started未知、旧Outbox正在发/对账等竞态 |
| 两种基线不混用 | worktree/executor/provider及验证门 | 父提交错误、scope越界、Source HEAD漂移、仅测试delta与总体diff同时核对 |
| 测试确实证明结果 | 新候选、新自测/Verifier/真实模型映射 | 默认页面、无匹配提示/0条目、反向破坏显示后测试失败，不倒填旧证据 |
| 数据与重启恢复 | 存储/运行时/发布 | 私有副本迁移旧行保持、旧二进制拒启、停机备份、各阶段崩溃，失败保持CURRENT |

成功与失败信息均使用现有真实序列化/Outbox/业务送达确认。没有新的完成证据前，不把页面已上线等同于整个产品已验收。

## 实施顺序

先关闭离线渲染可行性与持久兼容选择，再冻结共享接口并按文件独占拆分：请求/存储；构建与Provider双基线；验证/旧候选各消费者；主线程负责headless/runtime集成。先红绿测试与独立审查，冻结后完整回归、本地commit、固定镜像和私有副本演练，再切换唯一试点服务。当前mapping-only发布脚本不适用于已改变身份/策略的新修订，不得放宽旧gate直接套用。
