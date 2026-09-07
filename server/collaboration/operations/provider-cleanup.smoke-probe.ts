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
console.log(JSON.stringify({evidenceSource:'linux_setpriv',providerUid:10001,privateStateRemoved:true,outsideSymlinkTargetUnchanged:true,modelCalls:0}));
