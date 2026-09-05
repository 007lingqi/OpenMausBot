import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandCleanupError } from "../execution-limits.ts";
import type { SandboxedCommandRequest } from "../quality-gate.ts";
import { DockerSandboxedCommandRunner } from "./docker-command-runner.ts";
import { DockerCliContainmentSupervisor, type DockerCommandPort, type DockerCommandResult } from "./docker-containment.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const result = (stdout = "", exitCode = 0): DockerCommandResult => ({ stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), exitCode });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omb-command-cancel-")); roots.push(root);
  const controller = new AbortController();
  const calls: string[][] = []; const id = "a".repeat(64);
  let running = false; let gate = ""; const labels: Record<string,string> = {};
  let onWait = async () => { running = false; return result("0"); };
  let onCreate = () => {};
  let refuseKill = false;
  const docker: DockerCommandPort = { async run(args) {
    calls.push([...args]);
    if (args[0] === "create") {
      for (let i=0;i<args.length;i++) if (args[i] === "--label") { const [key,value]=args[i+1].split("="); labels[key]=value; }
      const mount=args.find(arg => arg.includes("dst=/run/openmausbot,"))!;
      gate=join(mount.split("src=")[1].split(",")[0],"start");
      onCreate(); return result(id);
    }
    if (args[0] === "start") { running=true; return result(id); }
    if (args[0] === "inspect") return result(JSON.stringify([{ Id:id,Config:{Labels:labels},State:{Running:running} }]));
    if (args[0] === "wait") return onWait();
    if (args[0] === "logs") return result();
    if (args[0] === "kill") { if(refuseKill) throw new Error("kill unavailable"); running=false; return result(id); }
    throw new Error("unexpected docker command");
  } };
  const containment=new DockerCliContainmentSupervisor({docker,hostGeneration:"test-host",verifierKey:Buffer.alloc(32,9)});
  const runner=new DockerSandboxedCommandRunner({docker,containment,image:"cached-test-image",exchangeRoot:join(root,"exchange")});
  const request: SandboxedCommandRequest={commandId:"test",argv:["node","test.mjs"],cwd:root,environment:{},timeoutMs:1000,maxOutputBytes:1000,
    sandbox:{writableRoot:root,deniedPaths:[],network:"deny"},containmentBinding:{runId:"test-run",canonicalWorktreePath:root,instanceOwner:"owner",instanceFence:1,nonce:"n".repeat(32)},
    signal:controller.signal,registerContainment:async () => { expect(existsSync(gate)).toBe(false); }};
  return {root,runner,request,controller,calls,labels,id,get running(){return running;},get gate(){return gate;},
    set onWait(value:typeof onWait){onWait=value;},set onCreate(value:typeof onCreate){onCreate=value;},set refuseKill(value:boolean){refuseKill=value;}};
}

describe("Docker command cancellation and cleanup", () => {
  it("does not create anything when already cancelled", async () => {
    const h=fixture(); h.controller.abort();
    await expect(h.runner.run(h.request)).rejects.toThrow(); expect(h.calls).toHaveLength(0);
  });
  it("does not start a container when cancelled during create", async () => {
    const h=fixture(); h.onCreate=()=>h.controller.abort();
    await expect(h.runner.run(h.request)).rejects.toThrow();
    expect(h.calls.some(c=>c[0]==="start")).toBe(false);
    expect(readdirSync(join(h.root,"exchange"))).toEqual([]);
  });
  it.each(["reject","cancel"])("stops a gated container when registration %s occurs", async mode => {
    const h=fixture(); h.request.registerContainment=async()=>{
      expect(existsSync(h.gate)).toBe(false);
      if(mode==="reject") throw new Error("registration rejected");
      h.controller.abort(); await new Promise(()=>{});
    };
    await expect(h.runner.run(h.request)).rejects.toThrow();
    expect(h.running).toBe(false); expect(existsSync(h.gate)).toBe(false);
    expect(h.calls.filter(c=>c[0]==="kill")).toEqual([["kill",h.id]]);
  });
  it("cancels docker wait and confirms the owned process is stopped", async () => {
    const h=fixture(); let entered=false;
    h.onWait=async()=>{ entered=true; expect(existsSync(h.gate)).toBe(true); return new Promise(()=>{}); };
    const pending=h.runner.run(h.request); const settled=expect(pending).rejects.toThrow();
    await vi.waitFor(()=>expect(entered).toBe(true)); h.controller.abort(); await settled;
    expect(h.running).toBe(false); expect(readdirSync(join(h.root,"exchange"))).toEqual([]);
  });
  it("retains recovery material and raises cleanup uncertainty if termination fails", async () => {
    const h=fixture(); h.refuseKill=true;
    h.request.registerContainment=async()=>{throw new Error("registration rejected");};
    await expect(h.runner.run(h.request)).rejects.toBeInstanceOf(CommandCleanupError);
    expect(h.running).toBe(true); expect(readdirSync(join(h.root,"exchange"))).toHaveLength(1);
  });
  it("does not kill a container whose binding no longer matches", async () => {
    const h=fixture(); h.request.registerContainment=async()=>{
      h.labels["com.openmausbot.collaboration.binding"]="different"; throw new Error("changed binding");
    };
    await expect(h.runner.run(h.request)).rejects.toBeInstanceOf(CommandCleanupError);
    expect(h.calls.some(c=>c[0]==="kill")).toBe(false);
  });
  it("keeps normal completed evidence and removes only the exchange directory", async () => {
    const h=fixture(); const completed=await h.runner.run(h.request);
    expect(completed.attestation.processTreeReaped).toBe(true);
    expect(h.calls.some(c=>c[0]==="kill" || c[0]==="rm")).toBe(false);
    expect(readdirSync(join(h.root,"exchange"))).toEqual([]);
  });
});
