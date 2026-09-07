// Trusted synthetic provider for the isolated smoke image only. Not a runtime
// entrypoint and never copied into the product Dockerfile.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { runContainedPatchWorker } from "./contained-patch-worker-core.ts";

runContainedPatchWorker({ controlDirectory: "/run/omb-control", candidateRoot: "/run/omb-private/candidate", signal: new AbortController().signal,
  propose: async request => {
    writeFileSync("/run/omb-control/provider-called", "1", { mode: 0o600 });
    const program = `
      const assert=require('node:assert/strict'),fs=require('node:fs'),cp=require('node:child_process');
      assert.equal(process.getuid(),10001);
      assert.match(fs.readFileSync('/proc/self/status','utf8'),/CapEff:\\s+0+\\n/);
      assert.match(fs.readFileSync('/workspace/view/src/main.ts','utf8'),/P1/);
      for(const path of ['/run/omb-private/candidate/src/main.ts','/run/omb-private/candidate/.env','/run/omb-control/request.json','/run/omb-control/apply.json','/run/omb-channel/private-marker'])
        assert.throws(()=>fs.readFileSync(path), e=>['EACCES','ENOENT'].includes(e.code));
      assert.throws(()=>fs.writeFileSync('/workspace/view/src/main.ts','bad'));
      assert.throws(()=>fs.chmodSync('/run/omb-control/view/src/main.ts',0o777));
      assert.throws(()=>fs.writeFileSync('/run/omb-control/proposal.json','bad'));
      const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();
      process.stdout.write(JSON.stringify({detachedPid:child.pid,readOnly:true,privateDenied:true,uid:process.getuid()}));
    `;
    const observed = JSON.parse(execFileSync("/usr/bin/setpriv", ["--reuid=10001", "--regid=10001", "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs",
      process.execPath, "-e", program], { env: { PATH: "/usr/local/bin:/usr/bin:/bin" }, timeout: 5000, encoding: "utf8" }));
    assert.ok(observed.detachedPid > 1);
    writeFileSync("/run/omb-control/observation.json", JSON.stringify(observed), { flag: "wx", mode: 0o600 });
    if (request.objective === "provider-failure") throw Error("synthetic provider failure");
    if (request.objective === "cancel-provider") await new Promise(() => {});
    return { status: "completed", summary: "默认优先级已调整。", changes: [{ path: "src/main.ts", contents: "export const priority = 'P2';\n" }] };
  },
}).then(() => process.exit(0), () => { process.stderr.write("synthetic_worker_failed\n"); process.exit(1); });
