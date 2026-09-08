import {createServer, type Server} from 'node:http';
import {once} from 'node:events';
import {chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, expect, it, vi} from 'vitest';
import {probeLocalOpenCodexSocket,startLocalOpenCodexRelay} from './opencodex-local-relay.ts';

const cleanup:Array<()=>void|Promise<void>>=[];
const unixIt=it.skipIf(process.platform==='win32');
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
function directory(){const root=mkdtempSync(join(realpathSync('/tmp'),'omb-relay-'));chmodSync(root,0o700);
 cleanup.push(()=>rmSync(root,{recursive:true,force:true}));return root;}
async function listen(server:Server,path:string){server.listen(path);await once(server,'listening');chmodSync(path,0o600);
 cleanup.push(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));}
const body=()=>({model:'gpt-6-astra',reasoning:{effort:'medium'},store:false,stream:true,input:[],tools:[]});
const post=(url:string,signal?:AbortSignal)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body()),signal});
async function relay(path:string){const result=await startLocalOpenCodexRelay({socketPath:path,timeoutMs:1000});cleanup.push(result.close);return result;}

unixIt('forwards only approved requests from loopback over a private Unix socket',async()=>{
 const socket=join(directory(),'model.sock');const requests:unknown[]=[];
 await listen(createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);
  requests.push({path:req.url,body:JSON.parse(Buffer.concat(chunks).toString()),authorization:req.headers.authorization});
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: synthetic\n\n');}),socket);
 const value=await relay(socket);expect(new URL(value.url).hostname).toBe('127.0.0.1');
 expect(await (await post(value.url)).text()).toBe('data: synthetic\n\n');
 expect(requests).toEqual([{path:'/v1/responses',body:body(),authorization:undefined}]);
 const bad=await fetch(value.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body(),model:'other'})});
 expect(bad.status).toBe(400);expect(requests).toHaveLength(1);
});
unixIt('passes the optional gateway diagnostic observer through without exposing the private socket',async()=>{
 const socket=join(directory(),'model.sock'),diagnostic=vi.fn();
 await listen(createServer((_req,res)=>{res.writeHead(429,{'Content-Type':'application/json'});res.end('private upstream diagnostics');}),socket);
 const value=await startLocalOpenCodexRelay({socketPath:socket,onDiagnostic:diagnostic});cleanup.push(value.close);
 const response=await post(value.url);expect(response.status).toBe(502);expect(await response.text()).not.toContain('private');
 expect(diagnostic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({stage:'upstream',outcome:'upstream_http_rejected',
  inputBytes:Buffer.byteLength(JSON.stringify(body())),outputBytes:0,firstByteMs:null,upstreamStatus:429,durationMs:expect.any(Number)}));
 expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(socket);expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private');
});
unixIt('passes the independent idle deadline through and closes a stalled Unix stream',async()=>{
 const socket=join(directory(),'model.sock'),diagnostic=vi.fn();let closed=false;
 await listen(createServer((_req,res)=>{res.on('close',()=>{closed=true;});res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: initial\n\n');}),socket);
 const value=await startLocalOpenCodexRelay({socketPath:socket,timeoutMs:1500,idleTimeoutMs:200,onDiagnostic:diagnostic});cleanup.push(value.close);
 await expect(post(value.url).then(response=>response.text())).rejects.toThrow();
 expect(diagnostic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({stage:'stream',outcome:'timeout',timeoutKind:'idle'}));
 await vi.waitFor(()=>expect(closed).toBe(true));
});
unixIt('reconnects after the private upstream stops and is recreated',async()=>{
 const socket=join(directory(),'model.sock');
 const upstream=()=>createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: ready\n\n');});
 const first=upstream();await listen(first,socket);const value=await relay(socket);
 expect((await post(value.url)).status).toBe(200);
 await new Promise<void>(resolve=>first.close(()=>resolve()));
 expect((await post(value.url)).status).toBe(502);
 await listen(upstream(),socket);
 expect(await (await post(value.url)).text()).toBe('data: ready\n\n');
});
unixIt('rechecks socket permissions before every request',async()=>{
 const socket=join(directory(),'model.sock');const calls=vi.fn((_req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end();});
 await listen(createServer(calls),socket);const value=await relay(socket);
 chmodSync(socket,0o666);expect((await post(value.url)).status).toBe(502);expect(calls).not.toHaveBeenCalled();
 chmodSync(socket,0o600);expect((await post(value.url)).status).toBe(200);
});
unixIt('cancels the Unix upstream when the client disconnects',async()=>{
 const socket=join(directory(),'model.sock');let closed=false,received=false;
 await listen(createServer((_req,res)=>{received=true;res.on('close',()=>{closed=true;});}),socket);
 const value=await relay(socket);const controller=new AbortController();
 const pending=post(value.url,controller.signal).catch(()=>undefined);
 await vi.waitFor(()=>expect(received).toBe(true));controller.abort();await pending;
 await vi.waitFor(()=>expect(closed).toBe(true));
});
unixIt('masks private upstream diagnostics and supports idempotent shutdown',async()=>{
 const socket=join(directory(),'model.sock');await listen(createServer((_req,res)=>{res.writeHead(403);res.end('private detail');}),socket);
 const value=await relay(socket);const response=await post(value.url);expect(response.status).toBe(502);
 expect(await response.text()).not.toContain('private detail');await Promise.all([value.close(),value.close()]);
});
unixIt('rejects missing sockets, symlinks and unprotected parent directories',async()=>{
 const root=directory(),socket=join(root,'model.sock');
 await expect(startLocalOpenCodexRelay({socketPath:socket})).rejects.toThrow('local_relay_socket_unavailable');
 await listen(createServer(),socket);const link=join(root,'link.sock');symlinkSync(socket,link);
 await expect(startLocalOpenCodexRelay({socketPath:link})).rejects.toThrow('local_relay_socket_unavailable');
 chmodSync(root,0o777);await expect(startLocalOpenCodexRelay({socketPath:socket})).rejects.toThrow('local_relay_socket_unavailable');
 chmodSync(root,0o700);
});

unixIt('probes the actual Unix upstream before opening the relay without invoking a model',async()=>{
 const socket=join(directory(),'model.sock'),requests:unknown[]=[];
 await listen(createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);
  requests.push({method:req.method,path:req.url,body:Buffer.concat(chunks).toString(),authorization:req.headers.authorization,cookie:req.headers.cookie});
  res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'local_gateway_request_denied'}}));
 }),socket);
 const value=await startLocalOpenCodexRelay({socketPath:socket,probeUpstream:true});cleanup.push(value.close);
 expect(requests).toEqual([{method:'POST',path:'/v1/responses',body:'{}',authorization:undefined,cookie:undefined}]);
});
unixIt.each([
 [200,'application/json','{"error":{"code":"local_gateway_request_denied"}}'],
 [400,'application/json','{"error":{"code":"other"}}'],
 [400,'text/html','{"error":{"code":"local_gateway_request_denied"}}'],
 [400,'application/json','private-upstream-diagnostic'],
 [302,'application/json','{"error":{"code":"local_gateway_request_denied"}}'],
 [400,'application/json','x'.repeat(4097)],
])('rejects an unrecognized upstream response (%s, %s)',async(status,contentType,body)=>{
 const socket=join(directory(),'model.sock');
 await listen(createServer((_req,res)=>{res.writeHead(status,{'Content-Type':contentType});res.end(body);}),socket);
 await expect(startLocalOpenCodexRelay({socketPath:socket,probeUpstream:true}).then(value=>{
  cleanup.push(value.close);return value;
 })).rejects.toThrow('local_relay_probe_failed');
});
unixIt.each(['headers','body'])('bounds a hanging %s probe and closes its connection',async(stage)=>{
 const socket=join(directory(),'model.sock');let closed=false;
 await listen(createServer((_req,res)=>{res.on('close',()=>{closed=true;});if(stage==='body'){
  res.writeHead(400,{'Content-Type':'application/json'});res.write('{');
 }}),socket);
 await expect(probeLocalOpenCodexSocket(socket,{timeoutMs:100})).rejects.toThrow('local_relay_probe_failed');
 await vi.waitFor(()=>expect(closed).toBe(true));
});
unixIt('fails the probe on disconnect, never exposes upstream errors, and does not retry',async()=>{
 const socket=join(directory(),'model.sock');let calls=0;
 await listen(createServer((req)=>{calls++;req.socket.destroy(new Error('private detail'));}),socket);
 await expect(probeLocalOpenCodexSocket(socket)).rejects.toThrow('local_relay_probe_failed');expect(calls).toBe(1);
});
unixIt('revalidates socket privacy before a probe and bounds its timeout configuration',async()=>{
 const socket=join(directory(),'model.sock'),calls=vi.fn();await listen(createServer(calls),socket);
 chmodSync(socket,0o666);
 await expect(probeLocalOpenCodexSocket(socket)).rejects.toThrow('local_relay_socket_unavailable');
 chmodSync(socket,0o600);
 for(const timeoutMs of [0,-1,5001,NaN,Infinity,1.5])await expect(probeLocalOpenCodexSocket(socket,{timeoutMs})).rejects.toThrow('local_relay_probe_failed');
 expect(calls).not.toHaveBeenCalled();
});
