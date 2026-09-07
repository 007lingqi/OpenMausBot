export interface PrivateSshOperations {
  master():Promise<string|null>;
  prepare():Promise<void>;
  connect():Promise<void>;
  disconnect():Promise<void>;
  inspect():Promise<boolean>;
  cleanup():Promise<void>;
}
export interface SshChannelState {
  status:'waiting'|'connected'|'retrying'|'failed'|'stopped';
  attempts:number;
}

/** Serialized reconciliation, not a model-request retry queue. A missing
 * existing SSH master is only observed; this layer never creates one. */
export function createPrivateSshChannel(operations:PrivateSshOperations){
  let state:SshChannelState={status:'waiting',attempts:0},master:string|null=null;
  let attached=false,owned=false,closing=false,running:Promise<SshChannelState>|undefined,stopping:Promise<void>|undefined;
  const snapshot=():SshChannelState=>({...state});
  async function reconcile():Promise<SshChannelState>{
    if(closing)return snapshot();
    let current:string|null;try{current=await operations.master();}catch{current=null;}
    if(closing)return snapshot();
    if(!current){state.status='waiting';return snapshot();}
    if(current!==master){master=current;attached=false;state.attempts=0;}
    if(state.attempts>=3){state.status='failed';return snapshot();}
    try{
      if(attached&&await operations.inspect()){state.status='connected';return snapshot();}
      if(closing)return snapshot();
      await operations.prepare();owned=true;
      if(closing)return snapshot();
      // Cancel this exact deterministic forward before removing its private
      // socket. Failed cancellation must never be followed by unlink/connect.
      await operations.disconnect();
      if(closing)return snapshot();
      await operations.cleanup();
      if(closing)return snapshot();
      await operations.connect();attached=true;
      if(closing)return snapshot();
      if(!await operations.inspect())throw new Error('not_confirmed');
      state={status:'connected',attempts:0};
    }catch{
      attached=false;state.attempts++;state.status=state.attempts>=3?'failed':'retrying';
    }
    return snapshot();
  }
  return {snapshot,tick:()=>{
    running??=reconcile().finally(()=>{running=undefined;});return running;
  },close:()=>{
    closing=true;
    stopping??=(async()=>{
      await running;
      try{
        if(owned){
          if(!await operations.master())throw new Error('master_missing');
          await operations.disconnect();await operations.cleanup();
        }
        state.status='stopped';
      }catch{state.status='failed';throw new Error('ssh_channel_cleanup_unconfirmed');}
    })();
    return stopping;
  }};
}
