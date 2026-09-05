# Meta 协作验证记录

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
