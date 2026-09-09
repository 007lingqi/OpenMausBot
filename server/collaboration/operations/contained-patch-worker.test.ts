import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runContainedPatchWorker, superviseContainedProposal } from "./contained-patch-worker-core.ts";
import { ProviderFailure } from "./provider-failure.ts";
import { CodexReadOnlyPatchProvider } from "./docker-patch-agent.ts";
import { renderDingTalkSessionMessage } from "../../integrations/dingtalk/session-message.ts";
import { gitBlobSha } from "../worktree-manager.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "contained-worker-")), control = join(root, "control"), candidate = join(root, "candidate");
  mkdirSync(control, { mode: 0o711 }); mkdirSync(candidate); mkdirSync(join(candidate, "src"));
  writeFileSync(join(candidate, "src/main.ts"), "old");
  const write = (name: string, value: unknown) => writeFileSync(join(control, name), JSON.stringify(value), { mode: 0o600 });
  write("heartbeat.json", 1);
  const request = { runId: "run", threadId: "thread", turnId: "turn", workItemId: "WI-test", nodeId: "modify", planRevision: 1,
    objective: "Change main", instructions: "Change only src/main.ts", inputEvidence: ["request"], expectedArtifacts: ["src/main.ts"], completionDefinition: "Main changed",
    cwd: "/workspace/view", environment: {}, capabilities: { network: false, dependencyInstallation: false, arbitraryCommands: false, gitCommit: false },
    sandbox: { filesystemRoot: "/workspace/view", readOnlyPaths: [], denyGitMetadata: true, network: "deny" }, writeScope: ["src/**"], denyScope: [], readScope: ["src/**"] };
  write("request.json", { request, files: [{ path: "src/main.ts", automaticReplacementAllowed: true, contentHash: createHash("sha256").update("old").digest("hex") }] });
  const propose = vi.fn(async (): Promise<unknown> => ({ status: "completed", summary: "updated", changes: [{ path: "src/main.ts", contents: "new" }] }));
  const controller = new AbortController();
  return { root, control, candidate, request, write, propose, controller,
    run: () => runContainedPatchWorker({ controlDirectory: control, candidateRoot: candidate, propose, signal: controller.signal, pollMs: 5, heartbeatTimeoutMs: 200 }) };
}
describe("trusted contained worker gates", () => {
  it("rejects content outside the host-pinned revision result before opening the applier", async () => {
    const f = fixture(), sourceSha = "a".repeat(40);
    f.write("request.json", { request: { ...f.request, sourceSha,
      allowedChanges: [{ path: "src/main.ts", operation: "modify", parentBlobSha: gitBlobSha("old", sourceSha), resultBlobSha: gitBlobSha("authorized", sourceSha) }] },
      files: [{ path: "src/main.ts", blobSha: gitBlobSha("old", sourceSha), automaticReplacementAllowed: true, contentHash: createHash("sha256").update("old").digest("hex") }] });
    f.write("proposal.start", { start: true });
    try {
      await f.run();
      expect(JSON.parse(readFileSync(join(f.control, "proposal.json"), "utf8"))).toMatchObject({ status: "failed", changes: [] });
      expect(readFileSync(join(f.candidate, "src/main.ts"), "utf8")).toBe("old");
      expect(existsSync(join(f.control, "applied.json"))).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it("applies an exact pinned revision only after both gates with actual old bytes checked", async () => {
    const f = fixture(), sourceSha = "a".repeat(40);
    f.write("request.json", { request: { ...f.request, sourceSha,
      allowedChanges: [{ path: "src/main.ts", operation: "modify", parentBlobSha: gitBlobSha("old", sourceSha), resultBlobSha: gitBlobSha("new", sourceSha) }] },
      files: [{ path: "src/main.ts", blobSha: gitBlobSha("old", sourceSha), automaticReplacementAllowed: true, contentHash: createHash("sha256").update("old").digest("hex") }] });
    f.write("proposal.start", { start: true });
    const pending = f.run();
    try {
      await vi.waitFor(() => expect(existsSync(join(f.control, "proposal.json"))).toBe(true));
      expect(f.propose).toHaveBeenCalledWith(expect.objectContaining({ sourceSha,
        allowedChanges: [{ path: "src/main.ts", operation: "modify", parentBlobSha: gitBlobSha("old", sourceSha), resultBlobSha: gitBlobSha("new", sourceSha) }] }));
      expect(readFileSync(join(f.candidate, "src/main.ts"), "utf8")).toBe("old");
      f.write("apply.json", { changes: [{ path: "src/main.ts", contents: "new" }] }); f.write("apply.start", { start: true });
      await pending;
      expect(readFileSync(join(f.candidate, "src/main.ts"), "utf8")).toBe("new");
    } finally { f.controller.abort(); await pending.catch(() => {}); rmSync(f.root, { recursive: true, force: true }); }
  });
  it.each([
    { exit: 0, expected: "模型临时状态清理未完成，本次改动建议未采用，项目尚未修改。" },
    { exit: 7, expected: "模型执行程序异常结束，项目尚未修改。模型临时状态清理未完成。" },
  ])("carries real provider cleanup failure through supervision, worker and actual reply serialization (CLI exit $exit)", async ({ exit, expected }) => {
    const f = fixture(), launcher = join(f.root, "launcher.mjs"), invoked = join(f.root, "invocations");
    writeFileSync(launcher, `import {appendFileSync,writeFileSync} from 'node:fs';
      const args=process.argv.slice(3);
      if(args.includes('--eval')){appendFileSync(${JSON.stringify(invoked)},'cleanup\\n');process.stderr.write('token=private-cleanup-detail /private/fixture-path');process.exit(1);}
      for await(const chunk of process.stdin){};
      appendFileSync(${JSON.stringify(invoked)},'provider\\n');
      writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({status:'completed',summary:'untrusted successful proposal',changes:[{path:'src/main.ts',contents:'new'}]}));
      process.stderr.write('token=private-provider-detail');process.exit(${exit});`, { mode: 0o600 });
    const provider = new CodexReadOnlyPatchProvider({ executable: "fixture-codex", exchangeRoot: join(f.root, "exchange"),
      model: "test-model", openCodexEndpoint: "http://127.0.0.1:18100/v1/responses",
      providerUid: process.getuid!(), providerGid: process.getgid!(), providerHome: f.root,
      launcher: { executable: process.execPath, args: [launcher] } });
    let sequence = 1; const pulse = setInterval(() => f.write("heartbeat.json", ++sequence), 50);
    try {
      f.write("proposal.start", { start: true });
      await runContainedPatchWorker({ controlDirectory: f.control, candidateRoot: f.candidate, signal: f.controller.signal,
        pollMs: 5, heartbeatTimeoutMs: 2000, propose: request => {
          let stop!: () => void; const exited = new Promise<number>(resolve => { stop = () => resolve(0); });
          return superviseContainedProposal({ signal: request.signal,
            startRelay: () => ({ ready: Promise.resolve(), exited, stop }),
            propose: () => provider.propose(request), interrupt: () => provider.interrupt(request.runId) });
        } });
      const receipt = JSON.parse(readFileSync(join(f.control, "proposal.json"), "utf8"));
      expect(receipt).toEqual({ status: "failed", summary: expected, changes: [] });
      const serialized = JSON.stringify(renderDingTalkSessionMessage({ type: "plan_status_card", status: "execution_failed", failures: [receipt.summary] }));
      expect(serialized).toContain(expected);
      expect(serialized).not.toMatch(/private-cleanup-detail|private-provider-detail|fixture-path|untrusted successful|provider_|模型未能完成本次修改建议|修改完成/u);
      expect(readFileSync(invoked, "utf8")).toBe("provider\ncleanup\n");
      expect(readFileSync(join(f.candidate, "src/main.ts"), "utf8")).toBe("old");
      expect(existsSync(join(f.control, "applied.json"))).toBe(false);
    } finally { clearInterval(pulse); rmSync(f.root, { recursive: true, force: true }); }
  });

  it.each([
    ['provider_timeout', '模型调用超时'],
    ['provider_launch_failed', '模型执行程序未能启动'],
    ['provider_input_failed', '需求未能完整交给模型'],
    ['provider_process_failed', '模型执行程序异常结束'],
    ['provider_output_invalid', '模型未返回格式完整的改动建议'],
  ] as const)("preserves trusted %s through supervision, the receipt and actual reply formatting", async (code,summary) => {
    const f=fixture(),invoke=vi.fn(async()=>{throw new ProviderFailure(code,'private-upstream-detail');});
    let stop!:()=>void;
    const relayExit=new Promise<number>(resolve=>{stop=()=>resolve(0);});
    f.propose.mockImplementation(()=>superviseContainedProposal({signal:f.controller.signal,
      startRelay:()=>({ready:Promise.resolve(),exited:relayExit,stop}),propose:invoke,interrupt:async()=>{}}));
    f.write('proposal.start',{start:true});await f.run();
    const receipt=JSON.parse(readFileSync(join(f.control,'proposal.json'),'utf8'));
    expect(receipt).toEqual({status:'failed',summary:`${summary}，项目尚未修改。`,changes:[]});
    const message=JSON.stringify(renderDingTalkSessionMessage({type:'plan_status_card',status:'execution_failed',failures:[receipt.summary]}));
    expect(message).toContain(summary);expect(message).not.toMatch(/private-upstream-detail|provider_|修改完成/u);
    expect(invoke).toHaveBeenCalledTimes(1);expect(readFileSync(join(f.candidate,'src/main.ts'),'utf8')).toBe('old');
  });

  it("reports an unavailable relay without starting or retrying the provider", async()=>{
    const f=fixture(),invoke=vi.fn(async()=>({}));
    f.propose.mockImplementation(()=>superviseContainedProposal({signal:f.controller.signal,
      startRelay:()=>({ready:Promise.reject(Error('private-upstream-detail')),exited:Promise.resolve(1),stop(){}}),
      propose:invoke,interrupt:async()=>{}}));
    f.write('proposal.start',{start:true});await f.run();
    expect(JSON.parse(readFileSync(join(f.control,'proposal.json'),'utf8'))).toEqual({status:'failed',summary:'模型通道未能正常完成本次调用，项目尚未修改。',changes:[]});
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not turn cancellation into a failure receipt or invoke the provider", async()=>{
    const f=fixture(),invoke=vi.fn();f.controller.abort();
    await expect(superviseContainedProposal({signal:f.controller.signal,startRelay:vi.fn(),propose:invoke,interrupt:async()=>{}})).rejects.toThrow('cancelled');
    expect(invoke).not.toHaveBeenCalled();expect(existsSync(join(f.control,'proposal.json'))).toBe(false);
  });

  it("a late start with a permanently denied gate never calls the provider or writes", async () => {
    const f = fixture(); f.write("proposal.start", { start: false, reason: "aborted_before_activation" });
    await expect(f.run()).rejects.toThrow("contained_gate_invalid");
    expect(f.propose).not.toHaveBeenCalled();
    expect(readFileSync(join(f.candidate, "src/main.ts"), "utf8")).toBe("old");
    expect(existsSync(join(f.control, "proposal.json"))).toBe(false);
  });
  it("does not call the provider or write the candidate until separate gates open", async () => {
    const f = fixture(), pending = f.run();
    await new Promise(resolve => setTimeout(resolve, 20)); expect(f.propose).not.toHaveBeenCalled();
    f.write("proposal.start", { start: true });
    await vi.waitFor(() => expect(existsSync(join(f.control, "proposal.json"))).toBe(true));
    expect(readFileSync(join(f.candidate, "src/main.ts"), "utf8")).toBe("old");
    f.write("apply.json", { root: "ignored-untrusted-path", writeScopes: ["**"], changes: [{ path: "src/main.ts", contents: "new" }] });
    f.write("apply.start", { start: true });
    await pending;
    expect(readFileSync(join(f.candidate, "src/main.ts"), "utf8")).toBe("new");
    expect(JSON.parse(readFileSync(join(f.control, "applied.json"), "utf8"))).toEqual({ status: "applied", paths: ["src/main.ts"] });
  });
  it("writes a bounded failure receipt when provider execution throws, with no candidate write", async () => {
    const f = fixture(); f.propose.mockRejectedValue(Error("private upstream detail")); f.write("proposal.start", { start: true });
    await f.run();
    expect(JSON.parse(readFileSync(join(f.control, "proposal.json"), "utf8"))).toEqual({ status: "failed", summary: "模型未能完成本次修改建议。", changes: [] });
    expect(readFileSync(join(f.candidate, "src/main.ts"), "utf8")).toBe("old");
  });
  it("ends a lost-coordinator task before the provider starts", async () => {
    const f = fixture();
    await expect(f.run()).rejects.toThrow("heartbeat"); expect(f.propose).not.toHaveBeenCalled();
  });
  it("distinguishes a rejected proposal from an unknown model failure without writing", async () => {
    const f=fixture();
    f.propose.mockResolvedValue({status:'completed',summary:'untrusted success',changes:[{path:'.env',contents:'private-upstream-detail'}]});
    f.write('proposal.start',{start:true});await f.run();
    const receipt=JSON.parse(readFileSync(join(f.control,'proposal.json'),'utf8'));
    expect(receipt).toEqual({status:'failed',summary:'改动建议未通过格式或范围检查，项目尚未修改。',changes:[]});
    expect(readFileSync(join(f.candidate,'src/main.ts'),'utf8')).toBe('old');
    expect(existsSync(join(f.candidate,'.env'))).toBe(false);
  });

  it("does not trust a diagnostic code attached to an arbitrary upstream exception", async () => {
    const f=fixture();f.propose.mockRejectedValue(Object.assign(Error('private-upstream-detail'),{diagnosticCode:'provider_timeout'}));
    f.write('proposal.start',{start:true});await f.run();
    expect(JSON.parse(readFileSync(join(f.control,'proposal.json'),'utf8'))).toEqual({status:'failed',summary:'模型未能完成本次修改建议。',changes:[]});
  });
  it("does not accept an apply payload different from the validated proposal", async () => {
    const f = fixture(); f.write("proposal.start", { start: true });
    const pending = f.run(), rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(existsSync(join(f.control, "proposal.json"))).toBe(true));
    f.write("apply.json", { changes: [{ path: "src/main.ts", contents: "different" }] }); f.write("apply.start", { start: true });
    await rejected; expect(readFileSync(join(f.candidate, "src/main.ts"), "utf8")).toBe("old");
  });
});
