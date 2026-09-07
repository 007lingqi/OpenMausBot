/** Trusted synthetic CLI; no models, DingTalk, host mounts or user repositories. */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,chmodSync,existsSync} from 'node:fs';
import {CodexReadOnlyPatchProvider} from './docker-patch-agent.ts';
import type {AgentRunRequest} from '../provider-runner.ts';

const root='/tmp/provider-cleanup-proof';
mkdirSync(root,{mode:0o755});chmodSync(root,0o755);
mkdirSync(root+'/outside',{mode:0o755});chmodSync(root+'/outside',0o755);
writeFileSync(root+'/outside/keep','unchanged');
// /tmp remains noexec, just as in production. This root-owned fixture-only
// executable mount represents the installed CLI; the provider cannot write it.
const executable='/opt/omb-test-bin/fake-cli.mjs';
writeFileSync(executable,`#!/usr/bin/env node
import{mkdirSync,writeFileSync,chmodSync,symlinkSync}from'node:fs';
for await(const chunk of process.stdin){};
const home=process.env.CODEX_HOME;
mkdirSync(home+'/private',{mode:0o700});writeFileSync(home+'/private/state','synthetic');chmodSync(home+'/private',0);
symlinkSync('${root}/outside',home+'/link');
const args=process.argv.slice(2);
writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({status:'completed',summary:'synthetic proposal',changes:[]}));
`,{mode:0o755});chmodSync(executable,0o755);
const provider=new CodexReadOnlyPatchProvider({executable,exchangeRoot:root+'/exchange',model:'gpt-6-astra',
  openCodexEndpoint:'http://127.0.0.1:18100/v1/responses',providerUid:10001,providerGid:10001,providerHome:root,
  launcher:{executable:'/usr/bin/setpriv',args:['--reuid=10001','--regid=10001','--clear-groups','--no-new-privs','--']}});
const request:AgentRunRequest={runId:'cleanup-linux',threadId:'synthetic-thread',turnId:'synthetic-turn',workItemId:'synthetic-item',planRevision:1,nodeId:'node',cwd:root,
  containmentBinding:{runId:'cleanup-linux',canonicalWorktreePath:root,instanceOwner:'synthetic-instance',instanceFence:1,nonce:'n'.repeat(32)},
  objective:'synthetic cleanup probe',instructions:'read-only proposal',inputEvidence:[],readScope:['app/**'],writeScope:['app/**'],denyScope:['.git/**'],expectedArtifacts:[],completionDefinition:'synthetic',environment:{},
  capabilities:{network:false,dependencyInstallation:false,arbitraryCommands:false,gitCommit:false},
  sandbox:{filesystemRoot:root,readOnlyPaths:[],denyGitMetadata:true,network:'deny'},signal:new AbortController().signal,async registerContainment(){},emit(){}};
const proposal=await provider.propose(request);assert.equal(proposal.status,'completed');
assert.equal(existsSync(root+'/exchange/omb-cleanup-linux-provider'),false);
assert.equal(readFileSync(root+'/outside/keep','utf8'),'unchanged');
// Real cross-UID cancellation, under the exact original capability set.
for(const mode of ['term','kill','abort','timeout'] as const){
 const cli='/opt/omb-test-bin/'+mode+'.mjs';
 // Marker is in a per-case provider-writable directory; unrelated sentinel is read-only.
 const markerRoot=root+'/'+mode;mkdirSync(markerRoot,{mode:0o777});chmodSync(markerRoot,0o777);
 const ready=markerRoot+'/ready',ended=markerRoot+'/ended';
 writeFileSync(cli,`#!/usr/bin/env node
import{writeFileSync}from'node:fs';
for await(const c of process.stdin){};
const args=process.argv.slice(2);writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({status:'completed',summary:'must reject late success',changes:[]}));
process.on('SIGTERM',()=>{${mode==='kill'||mode==='timeout'?'':`setTimeout(()=>{writeFileSync('${ended}','done');process.exit(0);},80);`}});
writeFileSync('${ready}','ready');setInterval(()=>{},1000);
`,{mode:0o755});chmodSync(cli,0o755);
 const controlled=new CodexReadOnlyPatchProvider({executable:cli,exchangeRoot:root+'/exchange-'+mode,model:'gpt-6-astra',openCodexEndpoint:'http://127.0.0.1:18100/v1/responses',providerUid:10001,providerGid:10001,providerHome:root,timeoutMs:mode==='timeout'?500:10000,forceKillGraceMs:200,
 launcher:{executable:'/usr/bin/setpriv',args:['--reuid=10001','--regid=10001','--clear-groups','--no-new-privs','--']}});
 const controller=new AbortController(),runId='stop-'+mode;
 const result=controlled.propose({...request,runId,signal:controller.signal}).then(()=> 'unexpected_success',error=>error.message);
 const deadline=Date.now()+2000;while(!existsSync(ready)){assert.ok(Date.now()<deadline,'synthetic CLI did not become ready');await new Promise(r=>setTimeout(r,10));}
 let watchdog:ReturnType<typeof setTimeout>|undefined;
 try{
  const stop=mode==='timeout'?result:mode==='abort'?(controller.abort(),result):Promise.all([controlled.interrupt(runId),controlled.interrupt(runId)]);
  await Promise.race([stop,new Promise((_,reject)=>{watchdog=setTimeout(()=>reject(Error('cross_uid_stop_deadline')),3000);})]);
  if(mode==='term'||mode==='abort')assert.equal(existsSync(ended),true,'interrupt must wait for CLI exit');
  assert.equal(await result,'codex_patch_provider_failed:interrupted');
  assert.equal(existsSync(root+'/exchange-'+mode+'/omb-'+runId+'-provider'),false);
 }finally{clearTimeout(watchdog);}
}
console.log(JSON.stringify({evidenceSource:'linux_setpriv',providerUid:10001,privateStateRemoved:true,outsideSymlinkTargetUnchanged:true,crossUidTermWaited:true,crossUidForceKill:true,crossUidAbort:true,crossUidTimeout:true,modelCalls:0}));
