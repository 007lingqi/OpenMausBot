import {posix} from 'node:path';
import {pathToFileURL} from 'node:url';
import {realpathSync} from 'node:fs';
import {startLocalOpenCodexGateway} from './opencodex-local-gateway.ts';
import {startLocalOpenCodexRelay} from './opencodex-local-relay.ts';

type Configuration={mode:'host';port:number;endpoint:string}|{mode:'relay';port:number;socketPath:string};
export function parseModelChannelArgs(args:readonly string[]):Configuration {
  const invalid=():never=>{throw new Error('model_channel_configuration_invalid');};
  const values=new Map<string,string>();
  for(let i=0;i<args.length;i+=2){
    const key=args[i],value=args[i+1];
    if(!['--mode','--port','--endpoint','--socket'].includes(key)||values.has(key)||!value)invalid();
    values.set(key,value);
  }
  const portText=values.get('--port')??'',port=Number(portText),mode=values.get('--mode');
  if(!/^\d+$/.test(portText)||!Number.isSafeInteger(port)||port>65535||values.size!==3)invalid();
  if(mode==='host'){
    const endpoint=values.get('--endpoint');if(!endpoint)invalid();
    let url:URL;try{url=new URL(endpoint!);}catch{return invalid();}
    if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.pathname!=='/v1/responses'||
      url.username||url.password||url.search||url.hash)invalid();
    return {mode,port,endpoint:endpoint!};
  }
  const socketPath=values.get('--socket');
  if(mode!=='relay'||!socketPath||!socketPath.startsWith('/')||posix.normalize(socketPath)!==socketPath||
    socketPath.includes('\0')||Buffer.byteLength(socketPath)>100)invalid();
  return {mode:'relay',port,socketPath:socketPath!};
}

export async function runModelChannel(args:readonly string[]):Promise<void> {
  const config=parseModelChannelArgs(args),stop=new AbortController();
  const terminate=()=>stop.abort();
  process.once('SIGTERM',terminate);process.once('SIGINT',terminate);
  let channel:Awaited<ReturnType<typeof startLocalOpenCodexGateway>>|undefined;
  try {
    channel=config.mode==='host'?await startLocalOpenCodexGateway(config):await startLocalOpenCodexRelay(config);
    if(!stop.signal.aborted){
      // Readiness means the local listener exists, not model/business success.
      process.stdout.write(JSON.stringify({event:'model_channel_ready',mode:config.mode,url:channel.url})+'\n');
      await new Promise<void>(resolve=>stop.signal.addEventListener('abort',()=>resolve(),{once:true}));
    }
  }finally{
    await channel?.close();process.off('SIGTERM',terminate);process.off('SIGINT',terminate);
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){
  runModelChannel(process.argv.slice(2)).catch(()=>{
    // Never print upstream messages or caller configuration on startup errors.
    process.stderr.write('model_channel_start_failed\n');process.exitCode=1;
  });
}
