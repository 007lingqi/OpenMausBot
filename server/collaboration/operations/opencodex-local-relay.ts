import {lstatSync, realpathSync} from 'node:fs';
import {request} from 'node:http';
import {dirname, isAbsolute, resolve} from 'node:path';
import {Readable} from 'node:stream';
import {startLocalOpenCodexGateway, type LocalOpenCodexDiagnosticObserver} from './opencodex-local-gateway.ts';

function privateSocket(path:string):void {
  try {
    if(!isAbsolute(path)||resolve(path)!==path||Buffer.byteLength(path)>100||!process.getuid)throw new Error();
    const parent=dirname(path),directory=lstatSync(parent),socket=lstatSync(path),uid=process.getuid();
    if(realpathSync(parent)!==parent||!directory.isDirectory()||directory.uid!==uid||
      (directory.mode&0o777)!==0o700||!socket.isSocket()||socket.uid!==uid||(socket.mode&0o777)!==0o600)throw new Error();
  }catch{throw new Error('local_relay_socket_unavailable');}
}

/** Negative protocol handshake with the host gateway, not with this relay's
 * local filter. An empty request is rejected before any model call. This
 * checks transport/protocol availability, NOT model or business health. */
export async function probeLocalOpenCodexSocket(socketPath:string,options:{timeoutMs?:number}={}):Promise<void> {
  privateSocket(socketPath);
  const timeoutMs=options.timeoutMs??1500;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000)throw new Error('local_relay_probe_failed');
  await new Promise<void>((resolveProbe,reject)=>{
    let settled=false;
    const finish=(ok=false)=>{
      if(settled)return;settled=true;clearTimeout(timer);call.destroy();
      if(ok)resolveProbe();else reject(new Error('local_relay_probe_failed'));
    };
    const call=request({socketPath,path:'/v1/responses',method:'POST',agent:false,maxHeaderSize:4096,
      headers:{'Content-Type':'application/json','Content-Length':'2'}},response=>{
      const chunks:Buffer[]=[];let size=0;
      response.on('error',()=>finish());response.on('aborted',()=>finish());
      if(response.statusCode!==400||String(response.headers['content-type']??'').split(';')[0].trim()!=='application/json'){
        response.destroy();finish();return;
      }
      response.on('data',(chunk:Buffer)=>{
        size+=chunk.length;
        if(size>4096){response.destroy();finish();return;}chunks.push(chunk);
      });
      response.on('end',()=>{
        try{
          const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          finish(result?.error?.code==='local_gateway_request_denied');
        }catch{finish();}
      });
    });
    const timer=setTimeout(()=>finish(),timeoutMs);
    call.on('error',()=>finish());call.end('{}');
  });
}

/** Relay identity must own the private mounted socket. It has no remote TCP
 * fallback, credentials, tool dispatcher, retry queue, or request-body logs.
 * Each connection rechecks the trusted socket directory; after upstream
 * restart a new request reconnects rather than reusing a stale connection. */
export async function startLocalOpenCodexRelay(options:{socketPath:string;port?:number;timeoutMs?:number;idleTimeoutMs?:number;probeUpstream?:boolean;
  onDiagnostic?:LocalOpenCodexDiagnosticObserver}) {
  privateSocket(options.socketPath);
  if(options.probeUpstream)await probeLocalOpenCodexSocket(options.socketPath);
  const fetcher:typeof fetch=async(_url,init)=>{
    privateSocket(options.socketPath);
    return new Promise<Response>((resolveResponse,reject)=>{
      const call=request({socketPath:options.socketPath,path:'/v1/responses',method:'POST',agent:false,
        headers:{'Content-Type':'application/json'},signal:init?.signal??undefined},response=>{
        try {
          resolveResponse(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>,{
            status:response.statusCode,headers:{'Content-Type':String(response.headers['content-type']??'')},
          }));
        }catch{response.destroy();reject(new Error('local_relay_response_unavailable'));}
      });
      call.on('error',()=>reject(new Error('local_relay_transport_unavailable')));
      call.end(init?.body);
    });
  };
  // The endpoint is a local protocol identifier only. The injected transport
  // always connects to the validated Unix socket and never resolves this URL.
  return startLocalOpenCodexGateway({endpoint:'http://127.0.0.1/v1/responses',
    port:options.port,timeoutMs:options.timeoutMs,idleTimeoutMs:options.idleTimeoutMs,fetch:fetcher,onDiagnostic:options.onDiagnostic});
}
