# Node test 验收报告器（内部配置）

适用于已采用 Node 内置 `node:test` 的非生产目标仓库，不要求产品、测试或项目经理在群聊中填写测试协议。自然语言到验收用例的自动映射和独立语义核对仍未完成；不要把本适配器单独当作完整交付能力。

受信任目标命令配置保留原来的 `argv: ["node", "--test", "tests/example.test.mjs"]`，增加 `assertionReporter: "node-test-v1"` 和 `assertionContract`。条件哈希使用 `acceptanceConditionHash({ description, observation })`；用例 ID 使用 `nodeTestAssertionId("tests/example.test.mjs", "用例名称")`。映射必须由可信开发/验证流程核对，不从附件里的指令自动接纳，不按名称相似直接放行。

自动模式的运行时接口现可注入 `acceptanceMapping: {proposer, verifier, policyId}`，两个端口必须使用独立上下文；此时 reporter 可暂不带静态 assertionContract，先采集自测断言，由固定候选源码映射与独立复核生成本候选专用契约。没有映射端口或映射不通过仍不能完成。headless 的真实模型配置尚未装配，不应手工借用其他模型凭据或启用未授权付费服务；变更模型/复核规则时需改变可信 policyId。

- 只接受显式相对测试文件，不接受 npm 包装、glob、额外 Node 参数、自定义 reporter 或进程内执行。其他测试框架需另建适配器，不能把任意 stdout 强转为报告。
- 相对文件路径基于整个候选工作区，不是命令 cwd；名称在同文件必须唯一。改文件路径或用例名称会使旧绑定失效；重名保守拒绝，后续可增加可追溯的完整套件身份。
- Docker 从控制面源码生成报告器，放在候选外的只读交换挂载中；每次报告绑定 run/nonce。测试 stdout/stderr 事件不构成验收证据，所需用例被跳过不算通过。
- 配置模式纳入复核契约哈希；未提供 reporter attestation 的 runner 不被接受。任一目标命令失败或已报告断言失败仍会阻止完成。
- 默认不启用，不修改现有服务配置、Owner 身份或凭据。旧命令无断言契约时保持未完成，不提示普通用户输入哈希来绕过。

本地回归：`pnpm vitest run server/collaboration/node-test-reporter.test.ts server/collaboration/candidate-verification.test.ts server/collaboration-headless.test.ts`。

可显式运行 `operations/node-test-reporter.smoke.ts`，必须提供 `OMB_REPORTER_SMOKE_CONTEXT` 与 `OMB_REPORTER_SMOKE_IMAGE=sha256:<已缓存固定镜像 ID>`。脚本在当前工作目录生成自有临时夹具，用无网络、非 root、只读报告器的容器验证通过/失败/跳过，最后只删除本次创建且已退出的容器。清理无法确认则保留临时目录并报错；不停止/替换现有服务，不拉镜像。

安全边界：这是可靠采集框架结果的适配器，并非测试正确性的证明。候选可能弱化断言；同 UID 恶意进程还可能干扰父进程或使用旁路。需要独立验证上下文与语义核对后才能对完整产品目标宣称验收完成。
