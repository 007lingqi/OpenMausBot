import {spawn} from 'node:child_process';
import {describe,expect,it} from 'vitest';
import {signalProviderProcess} from './provider-process-signal.ts';

describe('provider process signalling',()=>{
  it.each([0,1,-5,1.5,NaN])('rejects invalid process-group identity %s',async pid=>{
    await expect(signalProviderProcess({pid,signal:'SIGTERM'})).rejects.toThrow('provider_stop_signal_failed');
  });
  it('does not signal when the trusted launcher did not establish the expected UID',async()=>{
    const child=spawn(process.execPath,['-e','console.log("ready");setTimeout(()=>{},300)'],{detached:true,stdio:['ignore','pipe','pipe']});
    const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
    await new Promise(resolve=>child.stdout.once('data',resolve));
    try{
      await expect(signalProviderProcess({pid:child.pid!,signal:'SIGTERM',uid:process.getuid!()+1,gid:process.getgid!(),
        launcher:{executable:'/usr/bin/env',args:[]}})).rejects.toThrow('provider_stop_signal_failed');
      expect(child.exitCode).toBeNull();expect(child.signalCode).toBeNull();
    }finally{await closed;}
  });
});
