/** Non-production cancellation proof using only explicitly selected cached images and self-created containers. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTargetTests } from "../quality-gate.ts";
import { DockerSandboxedCommandRunner } from "./docker-command-runner.ts";
import { DockerCliContainmentSupervisor, NodeDockerCommandPort, type DockerCommandPort } from "./docker-containment.ts";

const context=process.env.OMB_CANCEL_SMOKE_CONTEXT;
const image=process.env.OMB_CANCEL_SMOKE_IMAGE;
if(!context || !image || !/^sha256:[a-f0-9]{64}$/u.test(image)) throw new Error("explicit_context_and_fixed_cached_image_required");
const root=mkdtempSync(join(process.cwd(),".omb-cancel-smoke-"));
const realDocker=new NodeDockerCommandPort({context});
const containers:string[]=[];
let cleaned=true;
try {
  for(const mode of ["before_gate","running_tree"] as const) {
    const worktree=join(root,mode); mkdirSync(worktree);
    const controller=new AbortController();
    const docker:DockerCommandPort={async run(args,options){
      const result=await realDocker.run(args,options);
      if(args[0]==="create" && result.exitCode===0) {
        const id=result.stdout.toString("utf8").trim();
        assert.match(id,/^[a-f0-9]{64}$/u); containers.push(id);
      }
      return result;
    }};
    const containment=new DockerCliContainmentSupervisor({docker,hostGeneration:`cancel-${randomUUID()}`,verifierKey:randomBytes(32)});
    const actual=new DockerSandboxedCommandRunner({docker,containment,image,exchangeRoot:join(root,`exchange-${mode}`)});
    writeFileSync(join(worktree,"parent.mjs"),`import {spawn} from 'node:child_process';
      spawn(process.execPath,['child.mjs'],{stdio:'ignore'});setInterval(()=>{},1000);`);
    writeFileSync(join(worktree,"child.mjs"),`import {writeFileSync} from 'node:fs';
      setInterval(()=>writeFileSync('heartbeat',String(Date.now())),20);`);
    const runner={run: (request:Parameters<typeof actual.run>[0]) => actual.run({...request,registerContainment:async proof=>{
      await request.registerContainment(proof);
      if(mode==="before_gate") controller.abort();
    }})};
    const watchdog=setTimeout(()=>controller.abort(),15000);
    const observer=mode==="running_tree" ? setInterval(()=>{
      if(existsSync(join(worktree,"heartbeat"))) controller.abort();
    },25) : undefined;
    try {
      await assert.rejects(runTargetTests({worktree,environment:{PATH:"/usr/local/bin:/usr/bin:/bin"},commandIds:["long-test"],
        commands:{"long-test":{argv:["node","parent.mjs"],timeoutMs:20000,maxOutputBytes:1000}},
        runner,deniedPaths:[],containment,signal:controller.signal,
        containmentContext:{runId:`cancel-${randomUUID()}`,canonicalWorktreePath:worktree,instanceOwner:"smoke",instanceFence:1}}),/docker_command_cancelled/);
    } finally {clearTimeout(watchdog);clearInterval(observer);}
    const id=containers.at(-1)!;
    const inspection=await realDocker.run(["inspect",id],{timeoutMs:5000});
    const state=JSON.parse(inspection.stdout.toString("utf8"))[0];
    assert.equal(state.State.Running,false);
    const heartbeat=join(worktree,"heartbeat");
    if(mode==="before_gate") assert.equal(existsSync(heartbeat),false);
    else {
      assert.equal(existsSync(heartbeat),true);
      const last=readFileSync(heartbeat,"utf8");
      await new Promise(resolve=>setTimeout(resolve,150));
      assert.equal(readFileSync(heartbeat,"utf8"),last);
    }
    assert.equal(state.HostConfig.NetworkMode,"none");
    assert.equal(state.HostConfig.ReadonlyRootfs,true);
    assert.notEqual(state.Config.User,"0:0");
    console.log(JSON.stringify({scenario:mode,containerStopped:true,childHeartbeatStopped:mode==="running_tree"}));
  }
} finally {
  for(const id of containers) {
    const removed=await realDocker.run(["rm",id],{timeoutMs:10000});
    if(removed.exitCode!==0) cleaned=false;
  }
  if(cleaned) rmSync(root,{recursive:true,force:true});
  else throw new Error("cancel_smoke_cleanup_unconfirmed");
}
