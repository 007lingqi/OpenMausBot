# 在线文档读取：非生产试点装配契约

本说明是操作员配置契约，不是已部署或已通过真实验收的记录。实际状态以项目 PROGRESS/VERIFY 顶部为准。不得将以下占位符直接作为真实身份、材料授权或试点成功证据。

## 授权与配置

`OMB_ONLINE_DOCUMENTS_CONFIG_FILE` 指向操作员控制、绝对路径、当前用户或root持有、无组/其他用户权限的普通JSON文件。未设置时不启用读取；设置但无效时启动失败，不回退其他身份。只允许Stream群白名单内的精确目标，不会自动发现或切换DWS账号。

配置结构：`version: 1`、非空 `grants`（至多32项）及 `transport`。每条grant包含 `id`、明确的 `profile`（corpId:userId）、`conversationId`、`node`（精确链接/节点）、`product`（doc或sheet）；URL还须提供已核实的 `canonicalId`。不接受密码链接、私人凭据、额外字段或含糊的多个相同目标。

宿主的transport为 `host_dws`，显式指定 `executable`、`configDirectory`、`home`、`cwd` 与仅含绝对目录的 `path`。调用环境仅包含这些固定路径及必要语言变量，不继承项目Secret。宿主只调用现有DWS `doc +fetch`、`sheet +list-sheets`、`sheet +read`；不开放shell、写入或账号选择。

控制面的transport为 `private_socket`，只指定 `socketPath`。配置中仍需相同grants以核对授权指纹；DWS登录配置和凭据不进入Docker。socket与真实父目录必须由进程同UID持有，权限分别为0600/0700；无HTTP或其他网络回退。健康探针只验证配置，不触发材料读取或socket连接。

## 独立宿主通道

打包入口为 `collaboration/operations/online-document-bridge.js`（开发入口同名.ts）。启动参数要求显式 `--config`、`--mode`、`--port`，并设置 `OMB_DINGTALK_ENABLED=1` 和当前群白名单环境变量。入口配置必须是host_dws，不能把private_socket再套一层代理。

- `host`模式只在127.0.0.1监听，用于受控本机集成；它不开放公网。
- `bridge`模式另需现有指定试点的 `--ssh-config`（路径以 `/colima-openmausbot-pilot/ssh.config` 结束）和私有目录内的 `--state-file`。必须指定非零独立端口，不能复用模型端口。
- bridge只使用现有指定试点SSH master，不创建新连接；远端目录固定为 `/tmp/omb-documents-channel-<port>`，socket为 `documents.sock`。控制容器只挂载这一私有目录，不挂DWS配置或整个宿主HOME。
- 取得固定监听端口后才操作SSH/状态文件；同一启动代次连续三次转发失败后停止，重启不会刷新预算。读取任务的持久三次预算仍由headless账本管理，bridge不重发业务请求。

未确认远端读取已结束（断连、超时、未知协议、错误来源回执）时，任务进入清理未确认；不能通过服务重启或重放消息再次发出同一读取。关闭通道会等在途宿主读取收束。接口“ready”只证明入口已监听，不证明SSH就绪、真实文档可读或研发交付成功。

## 实际验收尚需

完成固定镜像与私有配置装配、宿主通道自启动/重启恢复、明确获准的非生产文档和表格读取、来源进入当前Spec、六类真实群场景，以及Owner本人验收。模拟CLI、socket转发测试与打包smoke只验证软件链路，不代替这些条件。未经Owner明确授权，不安装服务、不选择真实账号、不扩大文件或群范围、不读私人文档。
