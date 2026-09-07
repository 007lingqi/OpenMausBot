import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chmodSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {createServer} from 'node:http';
import {join} from 'node:path';

// Called against the dependency-free staged bundle by the headless smoke.
// Only synthetic local peers; never calls the real model or DingTalk.
export async function smokeModelChannel(entry,environment,cwd){
 const children=[],servers=[];let socketRoot;
 async function launch(args){
  const child=spawn(process.execPath,[entry,...args],{cwd,env:environment,stdio:['ignore','pipe','pipe']});
  const exit=new Promise((resolve,reject)=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',reject);});
  void exit.catch(()=>{});children.push({child,exit});let output='',errors='';
  child.stdout.on('data',chunk=>{output=(output+chunk).slice(0,4096);});
  child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(0,4096);});
  const deadline=Date.now()+5000;
  while(!output.includes('\n')&&child.exitCode===null&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(child.exitCode,null,'channel exited before readiness');
  assert.equal(errors,'','channel emitted unexpected startup diagnostics');
  const ready=JSON.parse(output.trim());assert.equal(ready.event,'model_channel_ready');
  assert.equal(new URL(ready.url).hostname,'127.0.0.1');
  return {url:ready.url,async stop(){
   const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.kill('SIGTERM');
   try{assert.deepEqual(await exit,{code:0,signal:null});}finally{clearTimeout(timer);}
  }};
 }
 const peer=()=>createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const input=JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(input.model,'gpt-6-astra');assert.equal(input.reasoning.effort,'medium');
  assert.equal(req.url,'/v1/responses');
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: synthetic\n\n');
 });
 const request=async url=>{
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({model:'gpt-6-astra',reasoning:{effort:'medium'},store:false,stream:true,input:[],tools:[]}),
   signal:AbortSignal.timeout(5000)});
  assert.equal(response.status,200);assert.equal(await response.text(),'data: synthetic\n\n');
 };
 try{
  const upstream=peer();servers.push(upstream);upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const host=await launch(['--mode','host','--port','0','--endpoint',`http://127.0.0.1:${upstream.address().port}/v1/responses`]);
  await request(host.url);await host.stop();
  if(process.platform!=='win32'){
   socketRoot=mkdtempSync(join(realpathSync('/tmp'),'omb-mcs-'));chmodSync(socketRoot,0o700);
   const socket=join(socketRoot,'model.sock'),unixPeer=peer();servers.push(unixPeer);
   unixPeer.listen(socket);await once(unixPeer,'listening');chmodSync(socket,0o600);
   const relay=await launch(['--mode','relay','--port','0','--socket',socket]);
   await request(relay.url);await relay.stop();
  }
  console.log('packaged model channel host/available relay starts, forwards synthetic requests and exits on SIGTERM ✓');
 }finally{
  for(const {child,exit} of children){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exit.catch(()=>{});}
  for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(()=>resolve()));}
  if(socketRoot)rmSync(socketRoot,{recursive:true,force:true});
 }
}
