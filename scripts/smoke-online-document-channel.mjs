import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** An isolated CLI fixture proves the packaged host entry, not real DWS authorization or document content. */
export async function smokeOnlineDocumentChannel(entry, environment, staging) {
  const executable = join(staging, "fixture-dws.mjs"), config = join(staging, "fixture-documents.json");
  writeFileSync(executable, '#!/usr/bin/env node\nconsole.log(JSON.stringify({contractVersion:"doc.content.v1",status:"success",complete:true,target:{product:"doc",canonicalId:"fixture-node"},content:"登录失败后保留用户名"}));\n', { mode: 0o700 });
  writeFileSync(config, JSON.stringify({ version: 1, grants: [{ id: "fixture", profile: "fixture:reader", conversationId: "fixture-group", node: "fixture-node", product: "doc" }],
    transport: { kind: "host_dws", executable, configDirectory: staging, home: staging, cwd: staging, path: `${dirname(process.execPath)}:/usr/bin:/bin` } }), { mode: 0o600 });
  const child = execFile(process.execPath, [entry, "--mode", "host", "--config", config, "--port", "0"], {
    cwd: staging, env: { ...environment, OMB_DINGTALK_ENABLED: "1", OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "fixture-group" }, timeout: 20000,
  });
  let output = "";
  child.stdout?.on("data", chunk => { output += chunk; });
  const exit = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    const deadline = Date.now() + 10000;
    while (!output.includes("\n") && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    const ready = JSON.parse(output.trim().split(/\r?\n/).at(-1) || "null");
    if (ready?.event !== "online_document_channel_ready" || child.exitCode !== null) throw new Error("packaged document channel did not start");
    const invoke = source => fetch(ready.url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, source }), signal: AbortSignal.timeout(5000) });
    const source = { conversationId: "fixture-group", node: "fixture-node", sourceEventId: "fixture-event", normalizedHash: "a".repeat(64) };
    if ((await invoke({ ...source, conversationId: "unapproved" })).status !== 400) throw new Error("packaged document channel accepted an unapproved group");
    const result = await (await invoke(source)).json();
    if (result.version !== 1 || result.status !== "success" || result.cleanupConfirmed !== true || result.receipt?.sourceEventId !== source.sourceEventId ||
      result.receipt?.records?.[0]?.text !== "登录失败后保留用户名") throw new Error("packaged document channel did not return bound fixture evidence");
    child.kill("SIGTERM"); const ended = await exit;
    if (ended.code !== 0) throw new Error("packaged document channel did not shut down cleanly");
    console.log("packaged document host channel validates grants, reads a synthetic CLI and exits cleanly ✓");
  } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await exit; } }
}
