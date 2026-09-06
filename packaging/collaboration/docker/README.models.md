# 非生产模型配置（显式启用）

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
