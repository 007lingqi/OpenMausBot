import {chmodSync,mkdtempSync,readFileSync,realpathSync,rmSync,statSync,symlinkSync,writeFileSync,linkSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {afterEach,expect,it} from 'vitest';
import {createChannelCheckpoint} from './opencodex-channel-checkpoint.ts';
const roots:string[]=[];const posixIt=it.skipIf(process.platform==='win32');
function path(){const root=mkdtempSync(join(realpathSync('/tmp'),'omb-checkpoint-'));chmodSync(root,0o700);roots.push(root);return join(root,'channel.json');}
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
posixIt('durably roundtrips a private checkpoint bound to the fixed channel port',()=>{
 const file=path(),store=createChannelCheckpoint({path:file,port:18101});expect(store.read()).toBeNull();
 store.write({generation:'master-1',attempts:1});expect(statSync(file).mode&0o777).toBe(0o600);
 expect(createChannelCheckpoint({path:file,port:18101}).read()).toEqual({generation:'master-1',attempts:1});
 expect(()=>createChannelCheckpoint({path:file,port:18102})).toThrow('ssh_channel_checkpoint_unavailable');
 store.write({generation:'master-1',attempts:0});expect(store.read()?.attempts).toBe(0);
});
posixIt('fails closed on malformed, oversized and unsafe checkpoints rather than resetting their budget',()=>{
 const file=path();
 for(const content of ['broken','x'.repeat(4097),JSON.stringify({version:1,port:18101,generation:'master-1',attempts:-1}),
  JSON.stringify({version:1,port:18101,generation:'master-1',attempts:4}),
  JSON.stringify({version:1,port:18101,generation:'master-1',attempts:1,secret:'unexpected'})]){
  writeFileSync(file,content,{mode:0o600});expect(()=>createChannelCheckpoint({path:file,port:18101})).toThrow('ssh_channel_checkpoint_unavailable');
 }
 rmSync(file);const store=createChannelCheckpoint({path:file,port:18101});store.write({generation:'master-1',attempts:1});
 chmodSync(file,0o644);expect(()=>createChannelCheckpoint({path:file,port:18101})).toThrow('ssh_channel_checkpoint_unavailable');
});
posixIt('rejects aliases, shared parents and hardlinks without modifying the target',()=>{
 const file=path(),target=path();writeFileSync(target,'kept',{mode:0o600});symlinkSync(target,file);
 expect(()=>createChannelCheckpoint({path:file,port:18101})).toThrow('ssh_channel_checkpoint_unavailable');
 expect(readFileSync(target,'utf8')).toBe('kept');rmSync(file);linkSync(target,file);
 expect(()=>createChannelCheckpoint({path:file,port:18101})).toThrow('ssh_channel_checkpoint_unavailable');rmSync(file);
 chmodSync(join(file,'..'),0o755);expect(()=>createChannelCheckpoint({path:file,port:18101})).toThrow('ssh_channel_checkpoint_unavailable');
});
posixIt('refuses external replacement or removal after opening the store',()=>{
 const file=path(),store=createChannelCheckpoint({path:file,port:18101});store.write({generation:'master-1',attempts:1});
 writeFileSync(file,'external');expect(()=>store.write({generation:'master-1',attempts:0})).toThrow('ssh_channel_checkpoint_unavailable');
 expect(readFileSync(file,'utf8')).toBe('external');rmSync(file);
 expect(()=>store.write({generation:'master-1',attempts:0})).toThrow('ssh_channel_checkpoint_unavailable');
});
posixIt('preserves the recovery limit across real process exits',()=>{
 const file=path(),module=new URL('./opencodex-channel-checkpoint.ts',import.meta.url).href,channel=new URL('./opencodex-ssh-channel.ts',import.meta.url).href;
 for(let index=0;index<4;index++){
  const code=`import {createChannelCheckpoint} from ${JSON.stringify(module)};import {createPrivateSshChannel} from ${JSON.stringify(channel)};
   const checkpoint=createChannelCheckpoint({path:${JSON.stringify(file)},port:18101});let mutations=0;
   const channel=createPrivateSshChannel({master:async()=> 'master-1',prepare:async()=>{mutations++;},connect:async()=>{throw Error('synthetic');},disconnect:async()=>{},cleanup:async()=>{},inspect:async()=>false},{checkpoint});
   await channel.tick();await channel.close();console.log(mutations);`;
  expect(execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',code],{encoding:'utf8',timeout:5000}).trim()).toBe(index<3?'1':'0');
 }
 expect(createChannelCheckpoint({path:file,port:18101}).read()?.attempts).toBe(3);
});
posixIt('does not refund an attempt when the process is killed during preparation',()=>{
 const file=path(),module=new URL('./opencodex-channel-checkpoint.ts',import.meta.url).href,channel=new URL('./opencodex-ssh-channel.ts',import.meta.url).href;
 const code=`import {createChannelCheckpoint} from ${JSON.stringify(module)};import {createPrivateSshChannel} from ${JSON.stringify(channel)};
  const checkpoint=createChannelCheckpoint({path:${JSON.stringify(file)},port:18101});
  const channel=createPrivateSshChannel({master:async()=> 'master-1',prepare:async()=>{process.kill(process.pid,'SIGKILL');},connect:async()=>{},disconnect:async()=>{},cleanup:async()=>{},inspect:async()=>true},{checkpoint});
  const state=await channel.tick();if(state.status!=='failed')process.exit(2);await channel.close();`;
 for(let count=1;count<=4;count++){
  const result=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',code],{encoding:'utf8',timeout:5000});
  if(count<4)expect(result.signal).toBe('SIGKILL');else expect(result.status).toBe(0);
  expect(createChannelCheckpoint({path:file,port:18101}).read()?.attempts).toBe(Math.min(count,3));
 }
});
