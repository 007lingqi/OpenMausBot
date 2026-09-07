import {expect,it} from 'vitest';
import {parseModelChannelArgs} from './opencodex-model-channel.ts';
it('requires an explicit role and listener port',()=>{
 expect(parseModelChannelArgs(['--mode','host','--port','12345','--endpoint','http://127.0.0.1:10100/v1/responses']))
  .toEqual({mode:'host',port:12345,endpoint:'http://127.0.0.1:10100/v1/responses'});
 expect(parseModelChannelArgs(['--mode','relay','--port','0','--socket','/run/channel/model.sock']))
  .toEqual({mode:'relay',port:0,socketPath:'/run/channel/model.sock'});
});
it('only enables the upstream probe explicitly on the relay role',()=>{
 expect(parseModelChannelArgs(['--mode','relay','--port','0','--socket','/run/channel/model.sock','--probe-upstream','1']))
  .toEqual({mode:'relay',port:0,socketPath:'/run/channel/model.sock',probeUpstream:true});
 for(const args of [
  ['--mode','relay','--port','0','--socket','/run/channel/model.sock','--probe-upstream','0'],
  ['--mode','host','--port','0','--endpoint','http://127.0.0.1/v1/responses','--probe-upstream','1'],
  ['--mode','bridge','--port','1234','--endpoint','http://127.0.0.1/v1/responses','--ssh-config','/private/colima-openmausbot-pilot/ssh.config','--probe-upstream','1'],
 ])expect(()=>parseModelChannelArgs(args)).toThrow('model_channel_configuration_invalid');
});
it('supports a parent lifetime pipe only on the relay role',()=>{
 expect(parseModelChannelArgs(['--mode','relay','--port','18100','--socket','/run/channel/model.sock','--probe-upstream','1','--parent-stdin','1']))
  .toEqual({mode:'relay',port:18100,socketPath:'/run/channel/model.sock',probeUpstream:true,parentStdin:true});
 for(const args of [
  ['--mode','host','--port','0','--endpoint','http://127.0.0.1/v1/responses','--parent-stdin','1'],
  ['--mode','relay','--port','0','--socket','/run/channel/model.sock','--parent-stdin','0'],
 ])expect(()=>parseModelChannelArgs(args)).toThrow('model_channel_configuration_invalid');
});
it('supports an explicit existing-pilot bridge but never an ephemeral bridge port',()=>{
 const base=['--mode','bridge','--endpoint','http://127.0.0.1:10100/v1/responses','--ssh-config','/private/colima-openmausbot-pilot/ssh.config'];
 expect(parseModelChannelArgs([...base,'--port','12345'])).toEqual({mode:'bridge',port:12345,endpoint:'http://127.0.0.1:10100/v1/responses',sshConfig:'/private/colima-openmausbot-pilot/ssh.config'});
 expect(()=>parseModelChannelArgs([...base,'--port','0'])).toThrow('model_channel_configuration_invalid');
});
it('supports durable state only for an explicitly configured bridge',()=>{
 const base=['--mode','bridge','--endpoint','http://127.0.0.1:10100/v1/responses','--ssh-config','/private/colima-openmausbot-pilot/ssh.config','--port','18101'];
 expect(parseModelChannelArgs([...base,'--state-file','/private/channel/state.json'])).toMatchObject({mode:'bridge',stateFile:'/private/channel/state.json'});
 for(const args of [[...base,'--state-file','relative'],[...base,'--state-file','/private/../state'],
  ['--mode','host','--port','0','--endpoint','http://127.0.0.1/v1/responses','--state-file','/private/state'],
  ['--mode','relay','--port','0','--socket','/run/model.sock','--state-file','/private/state']])
  expect(()=>parseModelChannelArgs(args)).toThrow('model_channel_configuration_invalid');
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
