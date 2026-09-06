# 钉钉真实协作入口能力核对

核对日期：2026-09-06。代码基线：943a0ed。本记录是官方契约和当前实现的对照，不是真实群试点通过记录。

后续实现更新：普通主动群消息已加入同次发送后的单次状态查询，只有无矛盾 SUCCESS 才作为已发送；PROCESSING/RECALLED/未知走待核查，不重发。下表“发送器丢弃回执”是审计时基线；当前会在内存中使用该标识查询，但仍不持久化、不持续对账、不做入站引用映射。其他平台入口限制未因此解决。

## 结论

应用机器人当前通道尚不能证明完整产品目标。不能把内部合成事件测试成功等同于钉钉实际投递该类型事件，也不能用扩大关键词识别来解决上游缺少消息的问题。保持原目标不变，优先验证/补齐输入通道后再扩展附件交互。

| 产品要求 | 官方契约与代码证据 | 判定 |
| --- | --- | --- |
| 多人自然群聊持续归并 | 官方接收指南说明群内 @机器人触发；当前使用机器人 Stream topic | 未证明可接收未 @ 的一般群聊，不能当全群监听 |
| 群内直接发送 Bug 文件 | 消息类型文档明确：群成员 @机器人时不支持接收文件消息；单聊文件是另一场景 | 与当前群附件入口假设矛盾；内部解析能力仍可保留，但真实入口必须另行解决 |
| 回复机器人消息自动关联事项 | 当前 normalizer 读取 originalMsgId，association 只匹配入站 external_events；所读官方接收字段没有 originalMsgId | 引用字段实际形态与出站映射未验证，不等于平台绝对不支持 |
| 发送后持续定向 @提醒 | 官方回复文档：Webhook 支持 @；群消息服务端 API 暂不支持 @。当前 proactive 只发送 sampleMarkdown 的 title/text | session 渲染测试不证明备用主动发送会通知到人 |
| 消息送达可核查 | 群消息发送返回 processQueryKey；查询返回 sendStatus=SUCCESS/RECALLED/PROCESSING | 当前发送器丢弃该回执；受理与送达核查未形成持久闭环 |

## 消息标识边界

官方将 processQueryKey 称为“加密消息 id”，可用于查询和撤回。这个描述不能证明它等于用户引用消息回调中的标识，也没有提供到 originalMsgId 的转换契约。不得把它直接作为入站事件别名写入。

群消息查询接口为 POST https://api.dingtalk.com/v1.0/robot/groupMessages/query，使用企业内部应用 App Token 和 qyapi_robot_sendmsg 权限；processQueryKey 必填，robotCode/openConversationId 必须与发送时一致，maxResults 最大 200，nextToken 用于已读人员分页。返回 sendStatus/readUserIds/nextToken/hasMore，不返回引用消息 ID。这里只记录文档，不生成或执行实际业务调用。

## 后续执行顺序

1. 先获取真实测试群事件证据，核对 @/未 @、引用机器人、文件及文档链接的实际投递；仅保存脱敏且必要的字段证据，下载能力和 sessionWebhook 不进日志。
2. 若应用机器人无法交付群文件/一般群聊，新增接入通道涉及新的身份或授权，应由唯一 Owner 明确批准后再接入。个人事件通道只是待评估方案，不能默认复用本机已登录账号，更不能冒充已支持附件下载。
3. 保留应用机器人通道可用于 @文本和已授权在线文档链接，但不能把此路径替代原“群聊或附件”完整目标并宣告完成。
4. 发送回执先按独立的不可信远端回执记录并核查送达；引用映射必须有真实回调字段证据。缺映射时不按最近任务猜归属。
5. 真实模型、在线正文授权、解析镜像隔离、六类非生产场景、系统恢复与 Owner 人工验收仍独立待办。

## 官方来源

- 总索引：https://open.dingtalk.com/llms.txt
- 产品索引：https://open.dingtalk.com/llms-docs/zh-CN/llms-robots-and-messaging.txt
- 消息类型与接收字段：https://open.dingtalk.com/document/development/robot-message-type.md
- 当前接收指南：https://open.dingtalk.com/document/dingstart/robot-receive-message.md
- 当前回复/发送指南：https://open.dingtalk.com/document/dingstart/robot-reply-and-send-messages.md
- 群发送：https://open.dingtalk.com/document/development/the-robot-sends-a-group-message.md
- 群发送状态查询：https://open.dingtalk.com/document/development/chatbot-queries-the-read-status-of-a-message.md

访问证据：沙箱内 d82665 DNS 失败；授权只读公开文档后 b75c75/8fef76/d146b5/87208f/b7d718/e687c3/2f5ae9 均 exit 0。首次发送文档输出截断，随后单独读取响应章节；没有据被截断的章节猜参数。DWS 只查询 devdoc search 的本地 schema/help（ec70a1/b470bb），未登录、未刷新业务身份、未搜索用户内容、未发消息。
