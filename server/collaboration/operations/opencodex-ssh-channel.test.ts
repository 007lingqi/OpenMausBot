import {expect,it,vi} from 'vitest';
import {createPrivateSshChannel, type PrivateSshOperations} from './opencodex-ssh-channel.ts';

function fixture(){
 const operations={master:vi.fn<PrivateSshOperations['master']>(async()=> 'master-1'),prepare:vi.fn(async()=>{}),connect:vi.fn(async()=>{}),
  disconnect:vi.fn(async()=>{}),inspect:vi.fn(async()=>true),cleanup:vi.fn(async()=>{})} satisfies PrivateSshOperations;
 return {operations,channel:createPrivateSshChannel(operations)};
}
it('attaches once and only checks an already healthy channel',async()=>{
 const {operations,channel}=fixture();
 expect((await channel.tick()).status).toBe('connected');await channel.tick();
 expect(operations.connect).toHaveBeenCalledTimes(1);expect(operations.disconnect).toHaveBeenCalledTimes(1);
 expect(operations.prepare.mock.invocationCallOrder[0]).toBeLessThan(operations.cleanup.mock.invocationCallOrder[0]);
 expect(operations.disconnect.mock.invocationCallOrder[0]).toBeLessThan(operations.connect.mock.invocationCallOrder[0]);
 await channel.close();expect(operations.disconnect).toHaveBeenCalledTimes(2);
});
it('does not create a connection while no existing SSH master is available',async()=>{
 const {operations,channel}=fixture();operations.master.mockResolvedValue(null);
 expect((await channel.tick()).status).toBe('waiting');await channel.tick();
 expect(operations.prepare).not.toHaveBeenCalled();expect(operations.connect).not.toHaveBeenCalled();await channel.close();
});
it('recovers on a new master generation without replaying model requests',async()=>{
 const {operations,channel}=fixture();await channel.tick();operations.master.mockResolvedValue(null);
 expect((await channel.tick()).status).toBe('waiting');operations.master.mockResolvedValue('master-2');
 expect((await channel.tick()).status).toBe('connected');expect(operations.connect).toHaveBeenCalledTimes(2);await channel.close();
});
it('repairs a missing socket but does not attach again while it remains healthy',async()=>{
 const {operations,channel}=fixture();await channel.tick();operations.inspect.mockResolvedValueOnce(false);
 await channel.tick();await channel.tick();expect(operations.connect).toHaveBeenCalledTimes(2);await channel.close();
});
it('stops mutations after three failures in one master generation and resets only on a new generation',async()=>{
 const {operations,channel}=fixture();operations.connect.mockRejectedValue(new Error('synthetic'));
 await channel.tick();await channel.tick();expect((await channel.tick()).status).toBe('failed');
 await channel.tick();expect(operations.connect).toHaveBeenCalledTimes(3);
 operations.master.mockResolvedValue('master-2');operations.connect.mockResolvedValue();
 expect((await channel.tick()).status).toBe('connected');expect(operations.connect).toHaveBeenCalledTimes(4);await channel.close();
});
it('coalesces overlapping ticks and waits for in-flight work before cleanup',async()=>{
 const {operations,channel}=fixture();let finish!:()=>void;
 operations.connect.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const first=channel.tick(),second=channel.tick();await vi.waitFor(()=>expect(finish).toBeDefined());
 const closing=channel.close();finish();await Promise.all([first,second,closing,channel.close()]);
 expect(operations.connect).toHaveBeenCalledTimes(1);expect((await channel.tick()).status).toBe('stopped');
});
it('does not report connected when forwarding was not confirmed',async()=>{
 const {operations,channel}=fixture();operations.inspect.mockResolvedValue(false);
 expect((await channel.tick()).status).toBe('retrying');await channel.close();
});
it('keeps unsafe existing paths untouched when preparation fails',async()=>{
 const {operations,channel}=fixture();operations.prepare.mockRejectedValue(new Error('unsafe'));
 await channel.tick();await channel.close();expect(operations.cleanup).not.toHaveBeenCalled();expect(operations.disconnect).not.toHaveBeenCalled();
});
it('reports unconfirmed cleanup when an owned channel loses its master during shutdown',async()=>{
 const {operations,channel}=fixture();await channel.tick();operations.master.mockResolvedValue(null);
 await expect(channel.close()).rejects.toThrow('ssh_channel_cleanup_unconfirmed');
});
