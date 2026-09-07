import {createServer} from 'node:net';
import {once} from 'node:events';
import {afterEach,expect,it,vi} from 'vitest';
import {startLocalOpenCodexBridge} from './opencodex-local-bridge.ts';
import type {PrivateSshOperations} from './opencodex-ssh-channel.ts';
const cleanup:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of cleanup.splice(0))await close().catch(()=>{});});
async function available(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();if(!address||typeof address==='string')throw new Error('address');
 await new Promise<void>(resolve=>server.close(()=>resolve()));return address.port;}
function operations(){return {master:vi.fn<PrivateSshOperations['master']>(async()=> 'master-1'),prepare:vi.fn(async()=>{}),connect:vi.fn(async()=>{}),
 disconnect:vi.fn(async()=>{}),inspect:vi.fn(async()=>true),cleanup:vi.fn(async()=>{})};}
async function fixture(){const ops=operations(),port=await available();const bridge=await startLocalOpenCodexBridge({
 port,endpoint:'http://127.0.0.1:1/v1/responses',sshConfig:'/synthetic',operations:ops,intervalMs:20});
 cleanup.push(bridge.close);return {ops,bridge};}
it('owns the local listener and cleans its SSH channel before stopping',async()=>{
 const {ops,bridge}=await fixture();await vi.waitFor(()=>expect(bridge.snapshot().status).toBe('connected'));
 expect(bridge.socketPath).toBe(`/tmp/omb-model-channel-${new URL(bridge.url).port}/model.sock`);
 await bridge.close();const count=ops.master.mock.calls.length;await new Promise(resolve=>setTimeout(resolve,50));
 expect(ops.master).toHaveBeenCalledTimes(count);expect(bridge.snapshot().status).toBe('stopped');
});
it('observes a missing master and attaches when it appears',async()=>{
 const {ops,bridge}=await fixture();ops.master.mockResolvedValue(null);await vi.waitFor(()=>expect(bridge.snapshot().status).toBe('waiting'));
 ops.master.mockResolvedValue('master-2');await vi.waitFor(()=>expect(bridge.snapshot().status).toBe('connected'));
});
it('releases the listener even when remote cleanup cannot be confirmed',async()=>{
 const {ops,bridge}=await fixture();await vi.waitFor(()=>expect(bridge.snapshot().status).toBe('connected'));
 ops.disconnect.mockRejectedValue(new Error('unavailable'));await expect(bridge.close()).rejects.toThrow('ssh_channel_cleanup_unconfirmed');
 await expect(fetch(bridge.url)).rejects.toThrow();
});
it('refuses a busy listener before touching an existing SSH channel',async()=>{
 const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');cleanup.push(()=>new Promise(resolve=>server.close(()=>resolve())));
 const address=server.address();if(!address||typeof address==='string')throw new Error('address');const ops=operations();
 await expect(startLocalOpenCodexBridge({port:address.port,endpoint:'http://127.0.0.1:1/v1/responses',sshConfig:'/synthetic',operations:ops})).rejects.toThrow();
 expect(ops.master).not.toHaveBeenCalled();expect(ops.disconnect).not.toHaveBeenCalled();
});
