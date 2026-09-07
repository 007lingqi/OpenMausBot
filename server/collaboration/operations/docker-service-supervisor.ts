import {posix} from 'node:path';

export interface ManagedService {
  ready?:Promise<void>;
  exited:Promise<number>;
  stop():void;
}

/** Process lifecycle only; no model retries, business replay or new authority.
 * A shutdown timeout returns failure to the Docker entrypoint, which exits
 * its PID-namespace main process so Docker tears down any remaining peers. */
export async function superviseDockerService(options:{startRelay?:()=>ManagedService;startDocumentRelay?:()=>ManagedService;startHeadless:()=>ManagedService;
  signal:AbortSignal;startupMs?:number;shutdownMs?:number}):Promise<number> {
  if(options.signal.aborted)return 0;
  const startupMs=options.startupMs??5000,shutdownMs=options.shutdownMs??10000;
  if(![startupMs,shutdownMs].every(ms=>Number.isSafeInteger(ms)&&ms>0&&ms<=30000))return 1;
  const children:ManagedService[]=[];let code=1,startTimer:ReturnType<typeof setTimeout>|undefined;
  let onAbort!:()=>void;
  const aborted=new Promise<'abort'>(resolve=>{onAbort=()=>resolve('abort');options.signal.addEventListener('abort',onAbort,{once:true});});
  try{
    let canStart=true;
    const relays:ManagedService[]=[];
    for(const start of [options.startRelay,options.startDocumentRelay]){
      if(!start||!canStart||options.signal.aborted)continue;
      const relay=start();relays.push(relay);
      children.push(relay);
      if(!relay.ready)throw new Error('relay_readiness_missing');
      let relayExited=false;
      const ready=await Promise.race([relay.ready.then(()=>'ready' as const),...relays.map(peer=>peer.exited.then(()=>{relayExited=true;return 'exit' as const;})),aborted,
        new Promise<'timeout'>(resolve=>{startTimer=setTimeout(()=>resolve('timeout'),startupMs);})]);
      clearTimeout(startTimer);
      if(ready!=='ready'||relayExited||options.signal.aborted){code=options.signal.aborted?0:1;canStart=false;}
    }
    if(options.signal.aborted)code=0;
    else if(canStart){
      const headless=options.startHeadless();children.push(headless);
      const result=await Promise.race([headless.exited,aborted,...relays.map(relay=>relay.exited.then(()=>1))]);
      code=result==='abort'?0:result;
    }
  }catch{code=1;}
  finally{
    clearTimeout(startTimer);options.signal.removeEventListener('abort',onAbort);
    for(const child of children)try{child.stop();}catch{code=1;}
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const stopped=await Promise.race([Promise.all(children.map(child=>child.exited)).then(codes=>codes.every(value=>value===0)),
        new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),shutdownMs);})]);
      if(!stopped&&code===0)code=1;
    }catch{code=1;}finally{clearTimeout(timer);}
  }
  return code;
}

export function documentRelayLaunchConfiguration(environment:NodeJS.ProcessEnv){
  const flag=environment.OMB_DOCUMENT_RELAY_ENABLED;
  if(flag===undefined||flag==='0')return undefined;
  const base=relayLaunchConfiguration({...environment,OMB_OPENCODEX_RELAY_ENABLED:flag,
    OMB_OPENCODEX_RELAY_UID:environment.OMB_DOCUMENT_RELAY_UID,OMB_OPENCODEX_RELAY_GID:environment.OMB_DOCUMENT_RELAY_GID,
    OMB_OPENCODEX_RELAY_PORT:environment.OMB_DOCUMENT_RELAY_PORT,OMB_OPENCODEX_RELAY_SOCKET:environment.OMB_DOCUMENT_RELAY_SOCKET})!;
  if(environment.OMB_OPENCODEX_RELAY_ENABLED==='1'&&environment.OMB_OPENCODEX_RELAY_PORT===environment.OMB_DOCUMENT_RELAY_PORT)
    throw new Error('docker_document_relay_port_conflict');
  return {...base,channelArgs:['--port',environment.OMB_DOCUMENT_RELAY_PORT!,'--socket',environment.OMB_DOCUMENT_RELAY_SOCKET!,'--parent-stdin','1'],
    url:`http://127.0.0.1:${environment.OMB_DOCUMENT_RELAY_PORT}/v1/documents/read`};
}

export function relayLaunchConfiguration(environment:NodeJS.ProcessEnv){
  const flag=environment.OMB_OPENCODEX_RELAY_ENABLED;
  if(flag===undefined||flag==='0')return undefined;
  const fail=():never=>{throw new Error('docker_relay_configuration_invalid');};
  if(flag!=='1')fail();
  const integer=(name:string,max:number)=>{const text=environment[name]??'',value=Number(text);
    if(!/^[1-9]\d*$/.test(text)||!Number.isSafeInteger(value)||value>max)fail();return value;};
  const uid=integer('OMB_OPENCODEX_RELAY_UID',2147483647),gid=integer('OMB_OPENCODEX_RELAY_GID',2147483647),
    port=integer('OMB_OPENCODEX_RELAY_PORT',65535),socket=environment.OMB_OPENCODEX_RELAY_SOCKET;
  if(uid===Number(environment.OMB_PROVIDER_UID??10001)||gid===Number(environment.OMB_PROVIDER_GID??10001)||port<1024||
    !socket||!socket.startsWith('/')||posix.normalize(socket)!==socket||socket.includes('\0')||Buffer.byteLength(socket)>100)fail();
  return {args:[`--reuid=${uid}`,`--regid=${gid}`,'--clear-groups','--inh-caps=-all','--ambient-caps=-all','--no-new-privs'],
    environment:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',NODE_ENV:'production'},
    channelArgs:['--mode','relay','--port',String(port),'--socket',socket!,'--probe-upstream','1','--parent-stdin','1'],
    url:`http://127.0.0.1:${port}/v1/responses`};
}
