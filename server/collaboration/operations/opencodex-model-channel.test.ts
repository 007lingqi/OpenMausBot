import {expect,it} from 'vitest';
import {parseModelChannelArgs} from './opencodex-model-channel.ts';
it('requires an explicit role and listener port',()=>{
 expect(parseModelChannelArgs(['--mode','host','--port','12345','--endpoint','http://127.0.0.1:10100/v1/responses']))
  .toEqual({mode:'host',port:12345,endpoint:'http://127.0.0.1:10100/v1/responses'});
 expect(parseModelChannelArgs(['--mode','relay','--port','0','--socket','/run/channel/model.sock']))
  .toEqual({mode:'relay',port:0,socketPath:'/run/channel/model.sock'});
});
it('supports an explicit existing-pilot bridge but never an ephemeral bridge port',()=>{
 const base=['--mode','bridge','--endpoint','http://127.0.0.1:10100/v1/responses','--ssh-config','/private/colima-openmausbot-pilot/ssh.config'];
 expect(parseModelChannelArgs([...base,'--port','12345'])).toEqual({mode:'bridge',port:12345,endpoint:'http://127.0.0.1:10100/v1/responses',sshConfig:'/private/colima-openmausbot-pilot/ssh.config'});
 expect(()=>parseModelChannelArgs([...base,'--port','0'])).toThrow('model_channel_configuration_invalid');
});
it.each([
 [],['--mode','host'],['--mode','other','--port','1'],
 ['--mode','host','--port','1','--port','2','--endpoint','http://127.0.0.1/v1/responses'],
 ['--mode','host','--port','NaN','--endpoint','http://127.0.0.1/v1/responses'],
 ['--mode','host','--port','1','--endpoint','http://remote.invalid/v1/responses'],
 ['--mode','host','--port','1','--endpoint','http://127.0.0.1/v1/responses','--socket','/x'],
 ['--mode','relay','--port','1','--socket','relative'],
 ['--mode','relay','--port','1','--socket','/tmp/../x'],
 ['--mode','relay','--port','1','--socket','/x','--endpoint','http://127.0.0.1/v1/responses'],
 ['--mode','host','--port','65536','--endpoint','http://127.0.0.1/v1/responses'],
].map(args=>[args]))('fails closed on unsupported or ambiguous configuration %j',args=>{
 expect(()=>parseModelChannelArgs(args)).toThrow('model_channel_configuration_invalid');
});
