import {afterEach,expect,it,vi} from 'vitest';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPilotSshOperations, type SshCommandResult} from './opencodex-pilot-ssh.ts';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'omb-ssh-test-'));roots.push(root);const directory=join(root,'colima-openmausbot-pilot');mkdirSync(directory);
 const sshConfig=join(directory,'ssh.config');writeFileSync(sshConfig,'# synthetic configuration\n',{mode:0o600});
 const run=vi.fn(async(_args:readonly string[]):Promise<SshCommandResult>=>({code:0,stdout:'',stderr:''}));
 return {sshConfig,run,operations:createPilotSshOperations({sshConfig,port:12345,run})};
}
it('uses only the named existing pilot master and disables fallback connections',async()=>{
 const {run,operations}=fixture();run.mockResolvedValueOnce({code:0,stdout:'',stderr:'Master running (pid=42)\n'})
  .mockResolvedValueOnce({code:0,stdout:'00000000-0000-4000-8000-000000000001\n',stderr:''});
 expect(await operations.master()).toBe('42:00000000-0000-4000-8000-000000000001');
 for(const [args] of run.mock.calls){expect(args).toContain('ProxyCommand=false');expect(args).toContain('ControlMaster=no');expect(args).toContain('lima-colima-openmausbot-pilot');}
 expect(run.mock.calls[0][0]).toContain('check');expect(run.mock.calls[1][0]).toContain('ClearAllForwardings=yes');
});
it('does not run remote commands when the existing master is absent',async()=>{
 const {run,operations}=fixture();run.mockResolvedValue({code:255,stdout:'',stderr:'unavailable'});
 expect(await operations.master()).toBeNull();expect(run).toHaveBeenCalledTimes(1);
});
it('fixes both ends of the forward and bounds remote cleanup to the private socket',async()=>{
 const {run,operations}=fixture();await operations.prepare();await operations.connect();await operations.cleanup();
 expect(run.mock.calls[1][0]).toContain('/tmp/omb-model-channel-12345/model.sock:127.0.0.1:12345');
 const prepare=run.mock.calls[0][0].at(-1)!;expect(prepare).toContain('id -u');expect(prepare).toContain('700');
 const cleanup=run.mock.calls[2][0].at(-1)!;expect(cleanup).toContain('test -S');expect(cleanup).toContain('rm -f');expect(cleanup).not.toContain('rm -rf');
});
it('does not treat arbitrary cancel errors as successful cleanup',async()=>{
 const {run,operations}=fixture();run.mockResolvedValue({code:255,stdout:'',stderr:'private diagnostics'});
 await expect(operations.disconnect()).rejects.toThrow('ssh_channel_cancel_failed');
});
it('requires a live Unix listening socket, not just a leftover filesystem entry',async()=>{
 const {run,operations}=fixture();await operations.inspect();const script=run.mock.calls[0][0].at(-1)!;
 expect(script).toContain('/proc/net/unix');expect(script).toContain('$4=="00010000"');expect(script).toContain('$8==path');
});
it('allows only the exact benign no-existing-forward cancellation result',async()=>{
 const {run,operations}=fixture();run.mockResolvedValue({code:255,stdout:'',stderr:'mux_client_forward: forwarding request failed: port not forwarded\n'});
 await expect(operations.disconnect()).resolves.toBeUndefined();
});
it.each([-1,1])('does not mistake transport/timeout exit %s for a benign cancellation',async code=>{
 const {run,operations}=fixture();run.mockResolvedValue({code,stdout:'',stderr:'mux_client_forward: forwarding request failed: port not forwarded\n'});
 await expect(operations.disconnect()).rejects.toThrow('ssh_channel_cancel_failed');
});
it('rejects invalid ports and writable SSH configuration',()=>{
 const {sshConfig}=fixture();expect(()=>createPilotSshOperations({sshConfig,port:0})).toThrow('ssh_channel_configuration_invalid');
 chmodSync(sshConfig,0o666);expect(()=>createPilotSshOperations({sshConfig,port:12345})).toThrow('ssh_channel_configuration_invalid');
});
it.skipIf(process.platform==='win32')('never removes a regular file in place of a socket',async()=>{
 const {sshConfig,run}=fixture(),root=join(sshConfig,'..','scratch');mkdirSync(root,{mode:0o700});
 const file=join(root,'model.sock');writeFileSync(file,'synthetic',{mode:0o600});
 run.mockImplementation(async args=>{
  const script=args.at(-1)!.replaceAll('/tmp/omb-model-channel-12345',root);
  // Portable metadata fixtures: actual shell test -S and control flow still
  // execute. No SSH connection, real user directory or secret is involved.
  const shim='stat(){ case "$*" in *model.sock*) echo "$(id -u):600";; *) echo "$(id -u):700";; esac; }; readlink(){ echo "$2"; }; ';
  const result=spawnSync('/bin/sh',['-c',shim+script],{encoding:'utf8'});
  return {code:result.status??255,stdout:result.stdout,stderr:result.stderr};
 });
 const operations=createPilotSshOperations({sshConfig,port:12345,run});
 await expect(operations.cleanup()).rejects.toThrow('ssh_channel_socket_cleanup_failed');expect(existsSync(file)).toBe(true);
});
it.skipIf(process.platform==='win32')('rejects a symlink parent before claiming ownership',async()=>{
 const {sshConfig,run}=fixture(),root=join(sshConfig,'..','scratch'),target=join(sshConfig,'..','target');mkdirSync(target);symlinkSync(target,root);
 run.mockImplementation(async args=>{
  const script=args.at(-1)!.replaceAll('/tmp/omb-model-channel-12345',root);
  const result=spawnSync('/bin/sh',['-c','stat(){ echo "$(id -u):700"; }; readlink(){ echo "$2"; }; '+script],{encoding:'utf8'});
  return {code:result.status??255,stdout:result.stdout,stderr:result.stderr};
 });
 await expect(createPilotSshOperations({sshConfig,port:12345,run}).prepare()).rejects.toThrow('ssh_channel_private_path_invalid');
});
