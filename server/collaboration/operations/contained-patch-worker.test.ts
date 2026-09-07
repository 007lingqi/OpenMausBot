import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runContainedPatchWorker } from "./contained-patch-worker-core.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "contained-worker-")), control = join(root, "control"), candidate = join(root, "candidate");
  mkdirSync(control, { mode: 0o711 }); mkdirSync(candidate); mkdirSync(join(candidate, "src"));
  writeFileSync(join(candidate, "src/main.ts"), "old");
  const write = (name: string, value: unknown) => writeFileSync(join(control, name), JSON.stringify(value), { mode: 0o600 });
  write("heartbeat.json", 1);
  const request = { runId: "run", cwd: "/workspace/view", environment: {}, capabilities: { network: false, dependencyInstallation: false, arbitraryCommands: false, gitCommit: false },
    sandbox: { filesystemRoot: "/workspace/view", readOnlyPaths: [], denyGitMetadata: true, network: "deny" }, writeScope: ["src/**"], denyScope: [], readScope: ["src/**"] };
  write("request.json", { request, files: [{ path: "src/main.ts", automaticReplacementAllowed: true, contentHash: createHash("sha256").update("old").digest("hex") }] });
  const propose = vi.fn(async () => ({ status: "completed", summary: "updated", changes: [{ path: "src/main.ts", contents: "new" }] }));
  const controller = new AbortController();
  return { root, control, candidate, request, write, propose, controller,
    run: () => runContainedPatchWorker({ controlDirectory: control, candidateRoot: candidate, propose, signal: controller.signal, pollMs: 5, heartbeatTimeoutMs: 200 }) };
}
describe("trusted contained worker gates", () => {
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
  it("does not accept an apply payload different from the validated proposal", async () => {
    const f = fixture(); f.write("proposal.start", { start: true });
    const pending = f.run(), rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(existsSync(join(f.control, "proposal.json"))).toBe(true));
    f.write("apply.json", { changes: [{ path: "src/main.ts", contents: "different" }] }); f.write("apply.start", { start: true });
    await rejected; expect(readFileSync(join(f.candidate, "src/main.ts"), "utf8")).toBe("old");
  });
});
