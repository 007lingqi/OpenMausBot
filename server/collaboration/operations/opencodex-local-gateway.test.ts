import {afterEach, expect, it, vi} from 'vitest';
import {request} from 'node:http';
import {startLocalOpenCodexGateway} from './opencodex-local-gateway.ts';

const closers: Array<() => Promise<void>>=[];
afterEach(async()=>{for(const close of closers.splice(0)) await close();});
const payload=()=>({model:'gpt-6-astra',reasoning:{effort:'medium'},stream:true,store:false,input:[],tools:[]});
async function gateway(fetcher: typeof fetch, timeoutMs=2000) {
 const value=await startLocalOpenCodexGateway({endpoint:'http://127.0.0.1:10100/v1/responses',fetch:fetcher,timeoutMs});
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
 const url=await gateway(upstream);const aborters=Array.from({length:4},()=>new AbortController());
 const calls=aborters.map(controller=>post(url,payload(),controller.signal).catch(()=>undefined));
 await vi.waitFor(()=>expect(upstream).toHaveBeenCalledTimes(4));
 expect((await post(url)).status).toBe(429);
 aborters.forEach(controller=>controller.abort());await Promise.all(calls);
 await vi.waitFor(()=>expect(signals.every(signal=>signal.aborted)).toBe(true));
 upstream.mockImplementation(async()=>sse());
 await vi.waitFor(async()=>{const response=await post(url);expect(response.status).toBe(200);await response.text();});
});
it('times out a fetch that ignores abort and cancels its late body',async()=>{
 let resolve!:(response:Response)=>void;const cancelled=vi.fn();
 const url=await gateway(()=>new Promise(done=>{resolve=done;}),100);
 expect((await post(url)).status).toBe(504);
 resolve(new Response(new ReadableStream({cancel:cancelled}),{headers:{'content-type':'text/event-stream'}}));
 await vi.waitFor(()=>expect(cancelled).toHaveBeenCalledTimes(1));
});
it('cancels a stalled stream at the deadline without a successful complete response',async()=>{
 const cancelled=vi.fn();
 const url=await gateway(async()=>new Response(new ReadableStream({
  start(controller){controller.enqueue(new TextEncoder().encode('data: partial\n\n'));},cancel:cancelled,
 }),{headers:{'content-type':'text/event-stream'}}),100);
 const response=await post(url);await expect(response.text()).rejects.toThrow();
 await vi.waitFor(()=>expect(cancelled).toHaveBeenCalledTimes(1));
});
it('close aborts active work and is idempotent',async()=>{
 let signal:AbortSignal|undefined;
 const value=await startLocalOpenCodexGateway({endpoint:'http://127.0.0.1:10100/v1/responses',
  fetch:(_url,init)=>{signal=init?.signal??undefined;return new Promise(()=>{});}});
 closers.push(value.close);const pending=post(value.url).catch(()=>undefined);
 await vi.waitFor(()=>expect(signal).toBeDefined());
 await Promise.all([value.close(),value.close()]);await pending;expect(signal?.aborted).toBe(true);
});
it.each(['text/plain','application/json'])('rejects non-SSE %s and cancels the body',async contentType=>{
 const cancel=vi.fn();const url=await gateway(async()=>new Response(new ReadableStream({cancel}),{headers:{'content-type':contentType}}));
 expect((await post(url)).status).toBe(502);expect(cancel).toHaveBeenCalledTimes(1);
});
it('destroys an oversized response instead of presenting truncated success',async()=>{
 const cancel=vi.fn();const url=await gateway(async()=>new Response(new ReadableStream({
  start(controller){controller.enqueue(new Uint8Array(8*1024*1024+1));},cancel,
 }),{headers:{'content-type':'text/event-stream'}}));
 await expect(post(url).then(response=>response.text())).rejects.toThrow();
 expect(cancel).toHaveBeenCalledTimes(1);
});
it('rejects chunked oversized input without calling upstream',async()=>{
 const upstream=vi.fn<typeof fetch>();const url=await gateway(upstream);
 const status=await new Promise<number>((resolve,reject)=>{
  const req=request(url,{method:'POST',headers:{'Content-Type':'application/json'}},response=>{
   response.resume();response.on('end',()=>resolve(response.statusCode!));
  });
  req.on('error',reject);req.write('x'.repeat(600000));req.end('x'.repeat(600000));
 });
 expect(status).toBe(413);expect(upstream).not.toHaveBeenCalled();
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
