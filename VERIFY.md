# Meta 协作验证记录

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
- Docker 服务：健康。
- 钉钉 Stream：已连接。
- 最新低风险真实任务：已自动完成并成功发送通俗结果。

## 本轮待验证

- 结构化 Spec 和关键疑问门禁。
- 文档/表格提取内容的来源边界和指令隔离。
- Execution 与独立 Verifier 的证据分离。
- Meta 验收对必需证据的完整性检查。
- 并发写入范围冲突防护。
- 重启后的任务状态和验证结果恢复。

