import {afterEach, expect, it, vi} from 'vitest';
import {request} from 'node:http';
import {once} from 'node:events';
import {startLocalOpenCodexGateway, type LocalOpenCodexDiagnostic} from './opencodex-local-gateway.ts';

const closers: Array<() => Promise<void>>=[];
afterEach(async()=>{vi.useRealTimers();for(const close of closers.splice(0)) await close();});
const payload=()=>({model:'gpt-6-astra',reasoning:{effort:'medium'},stream:true,store:false,input:[],tools:[]});
async function gateway(fetcher: typeof fetch, timeoutMs=2000,
 onDiagnostic?:(event:Readonly<LocalOpenCodexDiagnostic>)=>void|Promise<void>,idleTimeoutMs?:number) {
 const value=await startLocalOpenCodexGateway({endpoint:'http://127.0.0.1:10100/v1/responses',fetch:fetcher,timeoutMs,onDiagnostic,idleTimeoutMs});
 closers.push(value.close);return value.url;
}
it('binds loopback and forwards only a bounded, stateless approved model request',async()=>{
 const upstream=vi.fn<typeof fetch>(async()=>new Response('data: synthetic\n\n',{headers:{'content-type':'text/event-stream'}}));
 const url=await gateway(upstream);
 expect(new URL(url).hostname).toBe('127.0.0.1');
 const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload())});
 expect(await response.text()).toBe('data: synthetic\n\n');
 expect(upstream).toHaveBeenCalledTimes(1);
 const [endpoint,init]=upstream.mock.calls[0];
 expect(endpoint).toBe('http://127.0.0.1:10100/v1/responses');
 expect(init?.redirect).toBe('error');
 expect(init?.headers).toEqual({'Content-Type':'application/json'});
 expect(JSON.parse(String(init?.body))).toEqual(payload());
});
const post=(url:string, body:unknown=payload(), signal?:AbortSignal)=>fetch(url,{
 method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal,
});
const sse=()=>new Response('data: synthetic\n\n',{headers:{'content-type':'text/event-stream'}});
it('accepts an omitted tools field as no tools without accepting malformed declarations',async()=>{
 const upstream=vi.fn<typeof fetch>(async()=>sse());const url=await gateway(upstream);
 const {tools:_,...withoutTools}=payload();
 const response=await post(url,withoutTools);
 expect(response.status).toBe(200);await response.text();
 expect(JSON.parse(String(upstream.mock.calls[0][1]?.body))).toEqual({...withoutTools,tools:[]});
 for(const tools of [null,{},'none'])expect((await post(url,{...withoutTools,tools})).status).toBe(400);
 expect(upstream).toHaveBeenCalledTimes(1);
});
it('accepts only client-side function, custom and one-level namespace tools',async()=>{
 const upstream=vi.fn<typeof fetch>(async()=>sse());const url=await gateway(upstream);
 const result=await post(url,{...payload(),tools:[{type:'function',name:'read'},{type:'custom',name:'patch'},
  {type:'namespace',name:'tools',tools:[{type:'function',name:'read'}]}]});
 expect(result.status).toBe(200);await result.text();
 for(const tools of [[{type:'namespace',tools:[{type:'mcp'}]}],[{type:'namespace',tools:[{type:'namespace',tools:[]}]}]]){
  expect((await post(url,{...payload(),tools})).status).toBe(400);
 }
 expect(upstream).toHaveBeenCalledTimes(1);
});
it('caps active calls at four and releases them on client disconnect',async()=>{
 const signals:AbortSignal[]=[];
 const upstream=vi.fn<typeof fetch>((_url,init)=>{signals.push(init!.signal!);return new Promise(()=>{});});
 const diagnostic=vi.fn();const url=await gateway(upstream,2000,diagnostic);const aborters=Array.from({length:4},()=>new AbortController());
 const calls=aborters.map(controller=>post(url,payload(),controller.signal).catch(()=>undefined));
 await vi.waitFor(()=>expect(upstream).toHaveBeenCalledTimes(4));
 expect((await post(url)).status).toBe(429);
 expect(diagnostic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({stage:'request',outcome:'busy',inputBytes:0,outputBytes:0}));
 aborters.forEach(controller=>controller.abort());await Promise.all(calls);
 await vi.waitFor(()=>expect(signals.every(signal=>signal.aborted)).toBe(true));
 await vi.waitFor(()=>expect(diagnostic).toHaveBeenCalledTimes(5));
 expect(diagnostic.mock.calls.slice(1).map(([event])=>event.outcome)).toEqual(Array(4).fill('client_disconnected'));
 upstream.mockImplementation(async()=>sse());
 await vi.waitFor(async()=>{const response=await post(url);expect(response.status).toBe(200);await response.text();});
});
it('times out a fetch that ignores abort and cancels its late body',async()=>{
 let resolve!:(response:Response)=>void;const cancelled=vi.fn();
 const diagnostic=vi.fn();const url=await gateway(()=>new Promise(done=>{resolve=done;}),100,diagnostic);
 expect((await post(url)).status).toBe(504);
 expect(diagnostic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({stage:'upstream',outcome:'timeout',timeoutKind:'total',upstreamStatus:null,firstByteMs:null,outputBytes:0}));
 resolve(new Response(new ReadableStream({cancel:cancelled}),{headers:{'content-type':'text/event-stream'}}));
 await vi.waitFor(()=>expect(cancelled).toHaveBeenCalledTimes(1));
 expect(diagnostic).toHaveBeenCalledTimes(1);
});
it('cancels a stalled stream at the deadline without a successful complete response',async()=>{
 const cancelled=vi.fn(),diagnostic=vi.fn();
 const url=await gateway(async()=>new Response(new ReadableStream({
  start(controller){controller.enqueue(new TextEncoder().encode('data: partial\n\n'));},cancel:cancelled,
 }),{headers:{'content-type':'text/event-stream'}}),100,diagnostic);
 const response=await post(url);await expect(response.text()).rejects.toThrow();
 await vi.waitFor(()=>expect(cancelled).toHaveBeenCalledTimes(1));
 expect(diagnostic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({stage:'stream',outcome:'timeout',upstreamStatus:200,firstByteMs:expect.any(Number),outputBytes:Buffer.byteLength('data: partial\n\n')}));
});
it('close aborts active work and is idempotent',async()=>{
 let signal:AbortSignal|undefined;const diagnostic=vi.fn();
 const value=await startLocalOpenCodexGateway({endpoint:'http://127.0.0.1:10100/v1/responses',
  fetch:(_url,init)=>{signal=init?.signal??undefined;return new Promise(()=>{});},onDiagnostic:diagnostic});
 closers.push(value.close);const pending=post(value.url).catch(()=>undefined);
 await vi.waitFor(()=>expect(signal).toBeDefined());
 await Promise.all([value.close(),value.close()]);await pending;expect(signal?.aborted).toBe(true);
 expect(diagnostic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({stage:'upstream',outcome:'stopping'}));
});
it.each(['text/plain','application/json'])('rejects non-SSE %s and cancels the body',async contentType=>{
 const cancel=vi.fn(),diagnostic=vi.fn();const url=await gateway(async()=>new Response(new ReadableStream({cancel}),{headers:{'content-type':contentType}}),2000,diagnostic);
 expect((await post(url)).status).toBe(502);expect(cancel).toHaveBeenCalledTimes(1);
 expect(diagnostic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({stage:'upstream',outcome:'upstream_protocol_rejected',upstreamStatus:200,outputBytes:0}));
});
it('destroys an oversized response instead of presenting truncated success',async()=>{
 const cancel=vi.fn(),diagnostic=vi.fn();const url=await gateway(async()=>new Response(new ReadableStream({
  start(controller){controller.enqueue(new Uint8Array(8*1024*1024+1));},cancel,
 }),{headers:{'content-type':'text/event-stream'}}),2000,diagnostic);
 await expect(post(url).then(response=>response.text())).rejects.toThrow();
 expect(cancel).toHaveBeenCalledTimes(1);
 expect(diagnostic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({stage:'stream',outcome:'output_limit',upstreamStatus:200,outputBytes:8*1024*1024+1}));
});
it('rejects chunked oversized input without calling upstream',async()=>{
 const upstream=vi.fn<typeof fetch>(),diagnostic=vi.fn();const url=await gateway(upstream,2000,diagnostic);
 const status=await new Promise<number>((resolve,reject)=>{
  const req=request(url,{method:'POST',headers:{'Content-Type':'application/json'}},response=>{
   response.resume();response.on('end',()=>resolve(response.statusCode!));
  });
  req.on('error',reject);req.write('x'.repeat(600000));req.end('x'.repeat(600000));
 });
 expect(status).toBe(413);expect(upstream).not.toHaveBeenCalled();
 expect(diagnostic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({stage:'request',outcome:'input_limit',outputBytes:0,firstByteMs:null,upstreamStatus:null}));
 expect(diagnostic.mock.calls[0][0].inputBytes).toBeGreaterThan(1024*1024);
});
it.each(['model','effort','stored','previous','tool','origin','authorization','path','method'])('rejects %s before upstream I/O',async fault=>{
 const upstream=vi.fn<typeof fetch>();const url=await gateway(upstream);const body:any=payload();
 const headers:Record<string,string>={'Content-Type':'application/json'};
 if(fault==='model')body.model='other';if(fault==='effort')body.reasoning.effort='high';
 if(fault==='stored')body.store=true;if(fault==='previous')body.previous_response_id='old';
 if(fault==='tool')body.tools=[{type:'web_search'}];
 if(fault==='origin')headers.Origin='https://untrusted.invalid';
 if(fault==='authorization')headers.Authorization='Bearer synthetic';
 const result=await fetch(fault==='path'?url+'?query=1':url,{method:fault==='method'?'GET':'POST',headers,
  ...(fault==='method'?{}:{body:JSON.stringify(body)})});
 expect(result.status).toBeGreaterThanOrEqual(400);expect(upstream).not.toHaveBeenCalled();
});
it('bounds input and never returns upstream error bodies',async()=>{
 const upstream=vi.fn<typeof fetch>(async()=>new Response('private upstream diagnostics',{status:403}));
 const url=await gateway(upstream);
 const large=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(1048577)});
 expect(large.status).toBe(413);expect(upstream).not.toHaveBeenCalled();
 const error=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload())});
 expect(error.status).toBe(502);expect(await error.text()).not.toContain('private');
});
it('refuses nonlocal upstream configuration before listening',async()=>{
 await expect(startLocalOpenCodexGateway({endpoint:'http://remote.invalid/v1/responses'})).rejects.toThrow('local_gateway_configuration_invalid');
});

it('emits one bounded terminal diagnostic with byte counts and relative timing only',async()=>{
 const diagnostic=vi.fn(),output='data: 私有输出\n\n';const url=await gateway(async()=>new Response(output,{headers:{'content-type':'text/event-stream'}}),2000,diagnostic);
 const body={...payload(),input:'私有需求 /private/task-file'};const response=await post(url,body);
 expect(await response.text()).toBe(output);expect(diagnostic).toHaveBeenCalledTimes(1);
 const event=diagnostic.mock.calls[0][0];
 expect(event).toEqual({stage:'stream',outcome:'completed',inputBytes:Buffer.byteLength(JSON.stringify(body)),outputBytes:Buffer.byteLength(output),
  durationMs:expect.any(Number),firstByteMs:expect.any(Number),upstreamStatus:200});
 expect(event.durationMs).toBeGreaterThanOrEqual(event.firstByteMs);expect(event.firstByteMs).toBeGreaterThanOrEqual(0);
 expect(JSON.stringify(event)).not.toMatch(/私有|private|http|headers|body|message/u);
});

it.each(['route_denied','headers_denied','json_invalid','request_denied','input_limit'] as const)('observes %s locally without forwarding request data',async outcome=>{
 const diagnostic=vi.fn(),upstream=vi.fn<typeof fetch>();const url=await gateway(upstream,2000,diagnostic);
 const headers:Record<string,string>={'Content-Type':'application/json'};
 if(outcome==='headers_denied')headers.Authorization='Bearer private-diagnostic-fixture';
 const body=outcome==='json_invalid'?'private malformed text':outcome==='input_limit'?'x'.repeat(1024*1024+1):'{}';
 const response=await fetch(outcome==='route_denied'?url+'?private-path':url,{method:'POST',headers,body});await response.text();
 expect(diagnostic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({stage:'request',outcome,outputBytes:0,firstByteMs:null,upstreamStatus:null}));
 expect(upstream).not.toHaveBeenCalled();expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/private|Bearer/u);
});

it.each(['http','transport','stream'] as const)('observes upstream %s failure without exposing its diagnostics',async mode=>{
 const diagnostic=vi.fn();const url=await gateway(async()=>{
  if(mode==='transport')throw Error('private upstream error at http://127.0.0.1/private');
  if(mode==='http')return new Response('private response body',{status:429,headers:{'X-Private':'private header'}});
  return new Response(new ReadableStream({start(controller){controller.error(Error('private stream error'));}}),{headers:{'content-type':'text/event-stream'}});
 },2000,diagnostic);
 await post(url).then(response=>response.text()).catch(()=>undefined);
 expect(diagnostic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({stage:mode==='stream'?'stream':'upstream',
  outcome:mode==='http'?'upstream_http_rejected':'upstream_error',upstreamStatus:mode==='transport'?null:mode==='http'?429:200,outputBytes:0}));
 expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/private|http:\/\//u);
});

it.each([false,true])('does not let a throwing diagnostic observer change a successful request (async=%s)',async asynchronous=>{
 const diagnostic=vi.fn(()=>{if(asynchronous)return Promise.reject(Error('observer failed'));throw Error('observer failed');});
 const url=await gateway(async()=>sse(),2000,diagnostic);const response=await post(url);
 expect(response.status).toBe(200);expect(await response.text()).toBe('data: synthetic\n\n');expect(diagnostic).toHaveBeenCalledTimes(1);
});

it('allows a progressing stream to complete across multiple idle periods',async()=>{
 const diagnostic=vi.fn();let timer:ReturnType<typeof setInterval>|undefined;
 const url=await gateway(async()=>new Response(new ReadableStream({
  start(controller){let count=0;controller.enqueue(new TextEncoder().encode('data: start\n\n'));
   timer=setInterval(()=>{controller.enqueue(new TextEncoder().encode('data: progress\n\n'));if(++count===11){clearInterval(timer);controller.close();}},40);},
  cancel(){clearInterval(timer);},
 }),{headers:{'content-type':'text/event-stream'}}),2000,diagnostic,200);
 try{const response=await post(url);expect((await response.text()).match(/data:/gu)).toHaveLength(12);
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({stage:'stream',outcome:'completed'}));
  expect(diagnostic.mock.calls[0][0].durationMs).toBeGreaterThan(400);
 }finally{clearInterval(timer);}
});

it.each(['headers','stream','empty_chunks'] as const)('stops an idle upstream at %s without waiting for the total deadline',async stage=>{
 const diagnostic=vi.fn(),cancelled=vi.fn();let timer:ReturnType<typeof setInterval>|undefined;
 const url=await gateway(async()=>{
  if(stage==='headers')return new Promise(()=>{});
  return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: initial\n\n'));
   if(stage==='empty_chunks')timer=setInterval(()=>controller.enqueue(new Uint8Array()),40);},
   cancel(){clearInterval(timer);cancelled();},
  }),{headers:{'content-type':'text/event-stream'}});
 },1500,diagnostic,200);
 try{
  if(stage==='headers')expect((await post(url)).status).toBe(504);
  else await expect(post(url).then(response=>response.text())).rejects.toThrow();
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({stage:stage==='headers'?'upstream':'stream',outcome:'timeout',timeoutKind:'idle'}));
  if(stage!=='headers')expect(cancelled).toHaveBeenCalledTimes(1);
 }finally{clearInterval(timer);}
});

it('does not refresh the explicit total deadline when stream progress refreshes idle',async()=>{
 const diagnostic=vi.fn(),cancelled=vi.fn();let timer:ReturnType<typeof setInterval>|undefined;
 const url=await gateway(async()=>new Response(new ReadableStream({start(controller){
  controller.enqueue(new TextEncoder().encode('data: start\n\n'));
  timer=setInterval(()=>controller.enqueue(new TextEncoder().encode('data: progress\n\n')),40);
 },cancel(){clearInterval(timer);cancelled();}}),{headers:{'content-type':'text/event-stream'}}),350,diagnostic,200);
 try{await expect(post(url).then(response=>response.text())).rejects.toThrow();
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({stage:'stream',outcome:'timeout',timeoutKind:'total',firstByteMs:expect.any(Number)}));
  expect(cancelled).toHaveBeenCalledTimes(1);
 }finally{clearInterval(timer);}
});

it('keeps default progressing streams past one minute and enforces the fixed fifteen-minute ceiling',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
 let source!:ReadableStreamDefaultController<Uint8Array>;const diagnostic=vi.fn(),cancelled=vi.fn(),chunk=new TextEncoder().encode('data: progress\n\n');
 const value=await startLocalOpenCodexGateway({endpoint:'http://127.0.0.1:10100/v1/responses',onDiagnostic:diagnostic,
  fetch:async()=>new Response(new ReadableStream({start(controller){source=controller;controller.enqueue(chunk);},cancel:cancelled}),{headers:{'content-type':'text/event-stream'}})});
 closers.push(value.close);const response=await post(value.url),reader=response.body!.getReader();await reader.read();
 for(let index=0;index<29;index++){
  await vi.advanceTimersByTimeAsync(30000);expect(diagnostic).not.toHaveBeenCalled();source.enqueue(chunk);await reader.read();
 }
 const ended=expect(reader.read()).rejects.toThrow();await vi.advanceTimersByTimeAsync(30000);await ended;
 expect(diagnostic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({stage:'stream',outcome:'timeout',timeoutKind:'total'}));
 expect(cancelled).toHaveBeenCalledTimes(1);
});

it('keeps the default admission deadline at one minute even while a client trickles input',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
 const diagnostic=vi.fn(),upstream=vi.fn<typeof fetch>();
 const value=await startLocalOpenCodexGateway({endpoint:'http://127.0.0.1:10100/v1/responses',fetch:upstream,onDiagnostic:diagnostic});closers.push(value.close);
 const req=request(value.url,{method:'POST',headers:{'Content-Type':'application/json','Expect':'100-continue'}});
 const closed=new Promise<void>(resolve=>{req.on('error',()=>resolve());req.on('close',()=>resolve());});
 const ready=once(req,'continue');req.flushHeaders();await ready;
 req.write('{');await vi.advanceTimersByTimeAsync(30000);req.write(' ');await vi.advanceTimersByTimeAsync(29999);
 expect(diagnostic).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1);await closed;
 expect(upstream).not.toHaveBeenCalled();expect(diagnostic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({stage:'request',outcome:'timeout',timeoutKind:'admission',upstreamStatus:null}));
});

it.each([{timeoutMs:900001},{idleTimeoutMs:0},{idleTimeoutMs:60001},{idleTimeoutMs:NaN}])('rejects invalid independent deadlines before listening (%j)',async limits=>{
 await expect(startLocalOpenCodexGateway({endpoint:'http://127.0.0.1:10100/v1/responses',...limits}).then(value=>{
  closers.push(value.close);return value;
 })).rejects.toThrow('local_gateway_configuration_invalid');
});
