# 非生产模型配置（显式启用）

默认 `compose.yaml` 不启用自然解释或验收映射；新增 `compose.models.yaml` 是可选叠加模板，不会自行部署。只有取得唯一 Owner 对所用模型服务、费用和凭据使用的明确授权后，才可以在非生产试点使用。不要借用其他功能或 Codex 登录的凭据。

headless 验收映射配置：`OMB_ACCEPTANCE_MAPPING_ENABLED=1`、`OMB_ACCEPTANCE_MAPPING_POLICY_REVISION`，以及 `PROPOSER` 和 `VERIFIER` 各自的 `OMB_ACCEPTANCE_MAPPING_<ROLE>_MODEL`、`_ENDPOINT`、`_CREDENTIAL_FILE`。端点默认仅 HTTPS，无凭据的 URL；凭据通过绝对路径指向已有、受信任所有者且 mode `0600` 的文件，不通过 API_KEY 环境变量传正文。

两阶段可使用同一型号，但始终构造不同无历史上下文，不能把开发会话原样作为独立复核。有效策略身份由两端模型名、地址、凭据文件引用及规则版本共同派生；变更这些配置后旧缓存不会当作新策略结果。原位轮换密钥而涉及权限/身份改变时也必须更新规则版本并取得 Owner 授权，系统不读取密钥来计算身份。

Compose 叠加模板同时显式启用自然解释及映射，要求配置三个模型角色，并分别提供 `OMB_NATURAL_INTAKE_HOST_CREDENTIAL_FILE`、`OMB_ACCEPTANCE_MAPPING_PROPOSER_HOST_CREDENTIAL_FILE`、`OMB_ACCEPTANCE_MAPPING_VERIFIER_HOST_CREDENTIAL_FILE`。即使使用同一份已授权凭据，也应由操作者显式填写这三个引用，不提供隐式回退。

三个文件仅只读挂载到各自固定目标，`create_host_path: false` 防止路径错误变成新目录；不会挂载整个 Secret 目录或更改其他服务的身份。该模板继承主服务原有权限，不额外授予容器权限。健康探针只构造客户端、不读模型凭据或发请求，因此探针健康不证明授权、网络、模型输出或自然协作效果可用。

当前自动映射只支持显式 Node 测试文件及受保护报告器。映射收据获认可并不代表业务验收通过；最终仍须当前 Spec、固定候选、自测和独立复测证据一致。缺少测试、依赖上下文或语义不确定时保持未完成，不能要求群用户填内部哈希绕过。

此模板尚需真实 Compose 合并、授权配置、模型语义评测和六类群聊试点验证。只做模板测试不等于已启用或部署。
