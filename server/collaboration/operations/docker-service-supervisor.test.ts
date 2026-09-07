import {expect,it,vi} from 'vitest';
import {superviseDockerService,relayLaunchConfiguration,type ManagedService} from './docker-service-supervisor.ts';

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
function child(){const exit=deferred<number>(),ready=deferred<void>();return {
 exited:exit.promise,ready:ready.promise,stop:vi.fn(()=>exit.resolve(0)),exit,readyGate:ready,
};}
it('starts headless only after relay readiness and closes the relay when headless exits',async()=>{
 const relay=child(),headless=child(),start=vi.fn(()=>headless),stop=new AbortController();
 const pending=superviseDockerService({startRelay:()=>relay,startHeadless:start,signal:stop.signal});
 await Promise.resolve();expect(start).not.toHaveBeenCalled();relay.readyGate.resolve();
 await vi.waitFor(()=>expect(start).toHaveBeenCalledOnce());headless.exit.resolve(0);
 expect(await pending).toBe(0);expect(relay.stop).toHaveBeenCalledOnce();
});
it('stops headless and fails when the relay unexpectedly exits even with code zero',async()=>{
 const relay=child(),headless=child(),start=vi.fn(()=>headless);relay.readyGate.resolve();
 const pending=superviseDockerService({startRelay:()=>relay,startHeadless:start,signal:new AbortController().signal});
 await vi.waitFor(()=>expect(start).toHaveBeenCalledOnce());relay.exit.resolve(0);
 expect(await pending).toBe(1);expect(headless.stop).toHaveBeenCalledOnce();
});
it('never starts headless if the relay dies before readiness',async()=>{
 const relay=child(),start=vi.fn();const pending=superviseDockerService({startRelay:()=>relay,startHeadless:start,signal:new AbortController().signal});
 relay.exit.resolve(1);expect(await pending).toBe(1);expect(start).not.toHaveBeenCalled();
});
it('does not start headless when ready and exit are both already observable',async()=>{
 const relay=child(),start=vi.fn();relay.readyGate.resolve();relay.exit.resolve(0);
 expect(await superviseDockerService({startRelay:()=>relay,startHeadless:start,signal:new AbortController().signal})).toBe(1);
 expect(start).not.toHaveBeenCalled();
});
it('reports failure if shutdown returns an unclean child exit',async()=>{
 const headless=child(),stop=new AbortController();headless.stop.mockImplementation(()=>headless.exit.resolve(1));
 const pending=superviseDockerService({startHeadless:()=>headless,signal:stop.signal});stop.abort();expect(await pending).toBe(1);
});
it('does not hide a shutdown timeout behind cancellation during startup',async()=>{
 const relay=child(),stop=new AbortController(),start=vi.fn();relay.stop.mockImplementation(()=>{});
 const pending=superviseDockerService({startRelay:()=>relay,startHeadless:start,signal:stop.signal,shutdownMs:20});
 stop.abort();expect(await pending).toBe(1);expect(start).not.toHaveBeenCalled();
});
it('bounds startup failure and does not retry',async()=>{
 const relay=child(),start=vi.fn();expect(await superviseDockerService({startRelay:()=>relay,startHeadless:start,
 signal:new AbortController().signal,startupMs:20})).toBe(1);expect(start).not.toHaveBeenCalled();expect(relay.stop).toHaveBeenCalledOnce();
});
it('supports cancellation during startup and before any process is spawned',async()=>{
 const relay=child(),stop=new AbortController(),start=vi.fn();const pending=superviseDockerService({startRelay:()=>relay,startHeadless:start,signal:stop.signal});
 stop.abort();expect(await pending).toBe(0);expect(start).not.toHaveBeenCalled();expect(relay.stop).toHaveBeenCalledOnce();
 expect(await superviseDockerService({startRelay:start,startHeadless:start,signal:stop.signal})).toBe(0);expect(start).not.toHaveBeenCalled();
});
it('preserves standalone headless mode and failure status',async()=>{
 const headless=child();headless.exit.resolve(2);
 expect(await superviseDockerService({startHeadless:()=>headless,signal:new AbortController().signal})).toBe(2);
});
it('stops both peers on shutdown, and bounds an unresponsive peer for container teardown',async()=>{
 const relay=child(),headless=child(),stop=new AbortController(),start=vi.fn(()=>headless);relay.readyGate.resolve();
 relay.stop.mockImplementation(()=>{});
 const pending=superviseDockerService({startRelay:()=>relay,startHeadless:start,signal:stop.signal,shutdownMs:20});
 await vi.waitFor(()=>expect(start).toHaveBeenCalledOnce());stop.abort();expect(await pending).toBe(1);
 expect(headless.stop).toHaveBeenCalledOnce();expect(relay.stop).toHaveBeenCalledOnce();
});
it('cleans up the relay if spawning headless throws',async()=>{
 const relay=child();relay.readyGate.resolve();
 expect(await superviseDockerService({startRelay:()=>relay,startHeadless:()=>{throw new Error('private detail');},signal:new AbortController().signal})).toBe(1);
 expect(relay.stop).toHaveBeenCalledOnce();
});
it('does not accept a relay without a readiness contract',async()=>{
 const relay=child(),start=vi.fn();
 expect(await superviseDockerService({startRelay:()=>({...relay,ready:undefined}) as ManagedService,startHeadless:start,signal:new AbortController().signal})).toBe(1);
 expect(start).not.toHaveBeenCalled();expect(relay.stop).toHaveBeenCalledOnce();
});
const env={OMB_OPENCODEX_RELAY_ENABLED:'1',OMB_OPENCODEX_RELAY_UID:'501',OMB_OPENCODEX_RELAY_GID:'501',
 OMB_OPENCODEX_RELAY_PORT:'18100',OMB_OPENCODEX_RELAY_SOCKET:'/run/omb-channel/model.sock'};
it('keeps relay opt-in, requires a separate nonroot identity and strips inherited environment',()=>{
 expect(relayLaunchConfiguration({})).toBeUndefined();
 const result=relayLaunchConfiguration({...env,API_KEY:'never-copy',NODE_OPTIONS:'never-copy',HOME:'/private'})!;
 expect(result.args).toEqual(['--reuid=501','--regid=501','--clear-groups','--inh-caps=-all','--ambient-caps=-all','--no-new-privs']);
 expect(result.environment).toEqual({PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',NODE_ENV:'production'});
 expect(result.channelArgs).toEqual(['--mode','relay','--port','18100','--socket','/run/omb-channel/model.sock','--probe-upstream','1','--parent-stdin','1']);
});
it.each([{OMB_OPENCODEX_RELAY_ENABLED:'yes'},{OMB_OPENCODEX_RELAY_UID:'0'},{OMB_OPENCODEX_RELAY_UID:'10001'},
 {OMB_OPENCODEX_RELAY_GID:'0'},{OMB_OPENCODEX_RELAY_GID:'10001'},{OMB_OPENCODEX_RELAY_PORT:'0'},
 {OMB_OPENCODEX_RELAY_PORT:'65536'},{OMB_OPENCODEX_RELAY_SOCKET:'/run/../sock'},
 {OMB_PROVIDER_UID:'501'},{OMB_PROVIDER_GID:'501'}])('rejects unsafe relay configuration %j',change=>{
 expect(()=>relayLaunchConfiguration({...env,...change})).toThrow('docker_relay_configuration_invalid');
});
