import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProviderReadView, assertProviderReadViewCurrent, disposeProviderReadView } from "./provider-read-view.ts";

assert.equal(process.platform, "linux"); assert.equal(process.getuid?.(), 0);
const root = mkdtempSync("/tmp/omb-provider-view-"); chmodSync(root, 0o711);
const source = join(root, "candidate"), destination = join(root, "view"); mkdirSync(source, { mode: 0o700 });
const git = (...args: string[]) => execFileSync("git", ["-C", source, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Probe", "-c", "user.email=probe@example.invalid", ...args],
  { env: { PATH: "/usr/local/bin:/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
git("init", "-q"); writeFileSync(join(source, "README.md"), "safe source\n"); writeFileSync(join(source, ".env"), "TOKEN=private-fixture\n");
git("add", "."); git("commit", "-qm", "fixture");
const view = createProviderReadView({ source, destination, baseSha: git("rev-parse", "HEAD"), readScope: ["**/*"], denyScope: [] });
const program = `const fs=require('node:fs'),assert=require('node:assert/strict');
const [view,source]=process.argv.slice(1);assert.equal(process.getuid(),10001);
assert.equal(fs.readFileSync(view+'/README.md','utf8'),'safe source\\n');
for(const operation of [()=>fs.writeFileSync(view+'/README.md','tamper'),()=>fs.writeFileSync(view+'/new.txt','new'),()=>fs.chmodSync(view,0o777),()=>fs.readFileSync(source+'/README.md'),()=>fs.readFileSync(source+'/.env')])assert.throws(operation);
assert.equal(fs.existsSync(view+'/.env'),false);assert.equal(fs.existsSync(view+'/.git'),false);
console.log(JSON.stringify({providerUid:process.getuid(),readViewReadable:true,viewWritesDenied:true,candidateReadDenied:true,credentialsExcluded:true}));`;
const result = JSON.parse(execFileSync("/usr/bin/setpriv", ["--reuid=10001", "--regid=10001", "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs", "--", process.execPath, "-e", program, destination, source],
  { cwd: "/", env: { PATH: "/usr/local/bin:/usr/bin:/bin" }, encoding: "utf8", timeout: 10000, maxBuffer: 4096 }));
assertProviderReadViewCurrent(view);
disposeProviderReadView(view); assert.equal(existsSync(destination), false);
console.log(JSON.stringify({ ...result, provenanceStillCurrent: true, readOnlyViewCleaned: true, modelCalls: 0, productionFiles: 0 }));
