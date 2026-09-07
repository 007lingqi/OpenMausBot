import {cpSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {afterEach,expect,it} from 'vitest';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function probe(source?:string,args=['--mode','bridge','--state-file','/private/state.json']){
 const root=mkdtempSync(join(tmpdir(),'omb-launch-agent-'));roots.push(root);
 cpSync(new URL('../../../packaging/collaboration/opencodex-launch-agent.mjs',import.meta.url),join(root,'launcher.mjs'));
 if(source!==undefined)writeFileSync(join(root,'opencodex-model-channel.mjs'),source);
 const child=spawn(process.execPath,[join(root,'launcher.mjs'),...args],{stdio:['ignore','pipe','pipe']});
 const exited=once(child,'exit');let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 try{
  const deadline=Date.now()+3000;
  while(!stderr&&!stdout&&child.exitCode===null&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
  expect(child.exitCode).toBeNull();expect(stderr).toBe('model_channel_service_failed\n');expect(stdout).toBe('');
  // An error stays quiescent: it neither retries the import nor exits into launchd's restart loop.
  await new Promise(r=>setTimeout(r,100));expect(child.exitCode).toBeNull();expect(stderr).toBe('model_channel_service_failed\n');
  child.kill('SIGTERM');expect(await exited).toEqual([0,null]);
 }finally{if(child.exitCode===null)child.kill('SIGKILL');await exited;}
}
it('parks on a missing immutable bundle without an import diagnostic or a restart loop',()=>probe());
it('parks on invalid mode or missing durable configuration without running the channel',async()=>{
 const source="export function parseModelChannelArgs(){return {mode:'host'};} export async function runModelChannel(){console.log('must not run');}";
 await probe(source,[]);
});
it('does not leak a channel startup or cleanup error and waits for operator shutdown',()=>probe(
 "export function parseModelChannelArgs(){return {mode:'bridge',stateFile:'/private/state.json'};} export async function runModelChannel(){throw Error('private diagnostic');}"));
it('requires durable configuration even when the channel mode is bridge',()=>probe(
 "export function parseModelChannelArgs(){return {mode:'bridge'};} export async function runModelChannel(){console.log('must not run');}"));
it('runs a valid channel once and leaves successful shutdown to its lifecycle',async()=>{
 const root=mkdtempSync(join(tmpdir(),'omb-launch-ok-'));roots.push(root);
 cpSync(new URL('../../../packaging/collaboration/opencodex-launch-agent.mjs',import.meta.url),join(root,'launcher.mjs'));
 writeFileSync(join(root,'opencodex-model-channel.mjs'),"export function parseModelChannelArgs(){return {mode:'bridge',stateFile:'/private/state.json'};} export async function runModelChannel(){console.log('called once');}");
 const child=spawn(process.execPath,[join(root,'launcher.mjs')],{stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 expect(await once(child,'exit')).toEqual([0,null]);expect(stdout).toBe('called once\n');expect(stderr).toBe('');
});
it('pins private state and a fixed bundle, strips inherited environment, and uses bounded launchd shutdown',()=>{
 const source=readFileSync(new URL('../../../packaging/collaboration/com.openmausbot.opencodex-pilot-channel.plist',import.meta.url),'utf8');
 for(const required of ['<string>/usr/bin/env</string>','<string>-i</string>','__NODE__','__RELEASE__/opencodex-launch-agent.mjs',
  '__ROOT__/state/channel.json','<string>18101</string>','<string>bridge</string>','colima-openmausbot-pilot/ssh.config'])expect(source).toContain(required);
 expect(source).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
 expect(source).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
 expect(source).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>30<\/integer>/);
 expect(source).toMatch(/<key>Umask<\/key>\s*<integer>63<\/integer>/);
 expect(source).not.toMatch(/NODE_OPTIONS|API_KEY|CLIENT_SECRET|dist-server|StartInterval|WatchPaths/);
});
