import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {abortable} from './opencodex-stream.ts';

const INPUT_LIMIT=1024*1024, OUTPUT_LIMIT=8*1024*1024, MAX_ACTIVE=4;
const object=(value:unknown):value is Record<string,unknown> => !!value && typeof value==='object' && !Array.isArray(value);
function localTool(value:unknown, nested=false):boolean {
  if(!object(value))return false;
  // Only client-executed tool definitions; never give the upstream service a
  // built-in browser, hosted shell, code interpreter, or remote MCP capability.
  if(value.type==='function'||value.type==='custom')return true;
  return !nested && value.type==='namespace' && Array.isArray(value.tools) && value.tools.length<=64 &&
    value.tools.every(tool=>localTool(tool,true));
}
function permitted(body:unknown):boolean {
  return object(body) && body.model==='gpt-6-astra' && object(body.reasoning) && body.reasoning.effort==='medium' &&
    body.stream===true && body.store===false && !('previous_response_id' in body) && !('conversation' in body) &&
    (!('background' in body)||body.background===false) && (typeof body.input==='string'||Array.isArray(body.input)) &&
    Array.isArray(body.tools) && body.tools.length<=64 && body.tools.every(tool=>localTool(tool));
}
function fail(response:ServerResponse,status:number,code:string):void {
  if(response.destroyed)return;
  if(response.headersSent){response.destroy();return;}
  response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});
  response.end(JSON.stringify({error:{code}}));
}

/** Explicit opt-in host gateway. It never listens on a non-loopback address,
 * forwards caller headers, executes tools, or logs request/response bodies.
 * Access from the pilot must be separately restricted to its private channel. */
export async function startLocalOpenCodexGateway(options:{
  endpoint:string; port?:number; fetch?:typeof globalThis.fetch; timeoutMs?:number;
}):Promise<{url:string;close:()=>Promise<void>}> {
  let endpoint:URL;
  try {endpoint=new URL(options.endpoint);}catch{throw new Error('local_gateway_configuration_invalid');}
  const timeoutMs=options.timeoutMs??60000, port=options.port??0;
  if(endpoint.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(endpoint.hostname)||
    endpoint.pathname!=='/v1/responses'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||
    !Number.isSafeInteger(port)||port<0||port>65535||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)
    throw new Error('local_gateway_configuration_invalid');
  const fetcher=options.fetch??globalThis.fetch;
  const controllers=new Set<AbortController>();
  let closing=false;
  const handle=async(request:IncomingMessage,response:ServerResponse)=>{
    if(closing){fail(response,503,'local_gateway_stopping');return;}
    if(request.method!=='POST'||request.url!=='/v1/responses'){
      fail(response,404,'local_gateway_route_denied');request.resume();return;
    }
    if(request.headers.origin!==undefined||request.headers.authorization!==undefined||request.headers.cookie!==undefined||
      request.headers['sec-fetch-site']!==undefined||request.headers['content-type']?.split(';')[0].trim()!=='application/json'){
      fail(response,400,'local_gateway_headers_denied');request.resume();return;
    }
    if(Number(request.headers['content-length'])>INPUT_LIMIT){fail(response,413,'local_gateway_input_limit');request.resume();return;}
    if(controllers.size>=MAX_ACTIVE){fail(response,429,'local_gateway_busy');request.resume();return;}
    const controller=new AbortController();controllers.add(controller);
    const timer=setTimeout(()=>{controller.abort();if(!request.complete)request.destroy();},timeoutMs);
    const disconnected=()=>{if(!response.writableFinished)controller.abort();};
    response.on('close',disconnected);
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    try {
      const chunks:Buffer[]=[];let inputBytes=0;
      for await(const chunk of request){
        controller.signal.throwIfAborted();inputBytes+=chunk.length;
        if(inputBytes>INPUT_LIMIT){fail(response,413,'local_gateway_input_limit');return;}
        chunks.push(Buffer.from(chunk));
      }
      let body:unknown;
      try {body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
      catch{fail(response,400,'local_gateway_json_invalid');return;}
      if(!permitted(body)){fail(response,400,'local_gateway_request_denied');return;}
      const upstream=await abortable(fetcher(endpoint.href,{method:'POST',redirect:'error',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal}),controller.signal,
        late=>{void late.body?.cancel().catch(()=>undefined);});
      if(!upstream.ok||!upstream.body||upstream.headers.get('content-type')?.split(';')[0].trim()!=='text/event-stream'){
        void upstream.body?.cancel().catch(()=>undefined);fail(response,502,'local_gateway_upstream_unavailable');return;
      }
      reader=upstream.body.getReader();let outputBytes=0;
      response.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      for(;;){
        const chunk=await abortable(reader.read(),controller.signal);
        if(chunk.done)break;
        outputBytes+=chunk.value.byteLength;
        if(outputBytes>OUTPUT_LIMIT)throw new Error('output_limit');
        if(!response.write(chunk.value))await abortable(once(response,'drain'),controller.signal);
      }
      response.end();
    }catch{fail(response,controller.signal.aborted?504:502,'local_gateway_request_unavailable');}
    finally{
      controller.abort();if(reader){void reader.cancel().catch(()=>undefined);reader.releaseLock();}
      clearTimeout(timer);response.off('close',disconnected);controllers.delete(controller);
    }
  };
  const server=createServer((request,response)=>{void handle(request,response).catch(()=>fail(response,502,'local_gateway_request_unavailable'));});
  server.headersTimeout=10000;server.requestTimeout=timeoutMs;server.maxHeadersCount=32;
  const listening=once(server,'listening');server.listen(port,'127.0.0.1');await listening;
  const address=server.address();if(!address||typeof address==='string')throw new Error('local_gateway_listen_failed');
  let stop:Promise<void>|undefined;
  return {url:`http://127.0.0.1:${address.port}/v1/responses`,close:()=>{
    stop??=new Promise<void>(resolve=>{closing=true;for(const controller of controllers)controller.abort();
      server.close(()=>resolve());server.closeAllConnections();});return stop;
  }};
}
