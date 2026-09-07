import {startLocalOpenCodexGateway} from './opencodex-local-gateway.ts';
import {createPilotSshOperations} from './opencodex-pilot-ssh.ts';
import {createPrivateSshChannel,type PrivateSshOperations,type SshChannelState} from './opencodex-ssh-channel.ts';

/** One fixed local port owns one deterministic private pilot socket. Acquire
 * the listener before any SSH mutation, and release it only after cleanup.
 * This prevents two live bridge processes from fighting over that forward. */
export async function startLocalOpenCodexBridge(options:{
  endpoint:string;port:number;sshConfig:string;intervalMs?:number;
  operations?:PrivateSshOperations;onState?:(state:SshChannelState)=>void;
}){
  const intervalMs=options.intervalMs??10000;
  if(!Number.isSafeInteger(options.port)||options.port<1||options.port>65535||
    !Number.isSafeInteger(intervalMs)||intervalMs<10||intervalMs>60000)throw new Error('ssh_channel_configuration_invalid');
  const operations=options.operations??createPilotSshOperations(options);
  const gateway=await startLocalOpenCodexGateway({endpoint:options.endpoint,port:options.port});
  const channel=createPrivateSshChannel(operations);
  let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,closing:Promise<void>|undefined,last='';
  const pump=async()=>{
    try{
      const state=await channel.tick(),serialized=JSON.stringify(state);
      if(!stopped&&serialized!==last){last=serialized;try{options.onState?.(state);}catch{/* observation cannot change control */}}
    }finally{if(!stopped)timer=setTimeout(()=>{void pump();},intervalMs);}
  };
  void pump();
  return {url:gateway.url,socketPath:`/tmp/omb-model-channel-${options.port}/model.sock`,snapshot:channel.snapshot,close:()=>{
    stopped=true;clearTimeout(timer);
    closing??=(async()=>{try{await channel.close();}finally{await gateway.close();}})();
    return closing;
  }};
}
