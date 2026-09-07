import {execFile} from 'node:child_process';
import {lstatSync} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute,normalize} from 'node:path';
import type {PrivateSshOperations} from './opencodex-ssh-channel.ts';

export interface SshCommandResult {code:number;stdout:string;stderr:string}
type Run=(args:readonly string[])=>Promise<SshCommandResult>;
const HOST='lima-colima-openmausbot-pilot';
const defaultRun:Run=args=>new Promise(resolve=>{
  execFile('/usr/bin/ssh',[...args],{timeout:5000,killSignal:'SIGKILL',maxBuffer:4096,
    env:{PATH:'/usr/bin:/bin',HOME:homedir(),LC_ALL:'C'}},(error,stdout,stderr)=>{
    // A killed/timed-out/overflowed client is not a completed SSH exit 255,
    // even if it happened to print a normally benign diagnostic beforehand.
    resolve({code:error?(typeof error.code==='number'?error.code:-1):0,stdout,stderr});
  });
});

export function createPilotSshOperations(options:{sshConfig:string;port:number;run?:Run}):PrivateSshOperations {
  const validate=()=>{
    try{
      const info=lstatSync(options.sshConfig);
      if(!process.getuid||!isAbsolute(options.sshConfig)||normalize(options.sshConfig)!==options.sshConfig||
        !options.sshConfig.endsWith('/colima-openmausbot-pilot/ssh.config')||!info.isFile()||
        info.uid!==process.getuid()||(info.mode&0o022)!==0||!Number.isSafeInteger(options.port)||options.port<1||options.port>65535)throw new Error();
    }catch{throw new Error('ssh_channel_configuration_invalid');}
  };
  validate();
  const run=options.run??defaultRun;
  const directory=`/tmp/omb-model-channel-${options.port}`,socket=`${directory}/model.sock`;
  const forward=`${socket}:127.0.0.1:${options.port}`;
  const base=['-F',options.sshConfig,'-T','-o','BatchMode=yes','-o','ControlMaster=no','-o','ProxyCommand=false'];
  const command=async(args:readonly string[])=>{validate();return run([...base,...args]);};
  const control=(operation:string)=>command(['-O',operation,...(operation==='check'?[]:['-R',forward]),HOST]);
  const remote=(script:string)=>command(['-o','ClearAllForwardings=yes',HOST,script]);
  // All remote paths are derived solely from the validated numeric port, never
  // from message text or arbitrary shell fragments. Parent remains persistent
  // through process restarts so an existing bind mount sees a recreated socket.
  const prefix=`set -eu; d='${directory}'; s='${socket}'; u="$(id -u)"; `;
  // set -e does not stop on an early failure in an && list. Explicit guards
  // are required before any unlink; an unsafe earlier test must not fall
  // through merely because the last test in the list was never executed.
  const privateDirectory='if ! { test -d "$d" && test ! -L "$d" && test "$(stat -c %u:%a "$d")" = "$u:700" && test "$(readlink -f "$d")" = "$d"; }; then exit 1; fi; ';
  const privateSocket='if ! { test -S "$s" && test ! -L "$s" && test "$(stat -c %u:%a "$s")" = "$u:600"; }; then exit 1; fi; ';
  const success=async(promise:Promise<SshCommandResult>,code:string)=>{if((await promise).code!==0)throw new Error(code);};
  return {
    async master(){
      try{
        const check=await control('check'),pid=/^Master running \(pid=(\d+)\)\s*$/.exec(check.stderr)?.[1];
        if(check.code!==0||!pid)return null;
        const boot=await remote('cat /proc/sys/kernel/random/boot_id');
        const id=boot.stdout.trim();
        if(boot.code!==0||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))return null;
        return `${pid}:${id}`;
      }catch{return null;}
    },
    prepare:()=>success(remote(prefix+'if test -e "$d" || test -L "$d"; then :; else (umask 077; mkdir "$d"); fi; '+
      privateDirectory+'if test -e "$s" || test -L "$s"; then '+privateSocket+'fi'),'ssh_channel_private_path_invalid'),
    connect:()=>success(control('forward'),'ssh_channel_forward_failed'),
    async disconnect(){
      const result=await control('cancel');
      if(result.code!==0&&!(result.code===255&&result.stderr.trim()==='mux_client_forward: forwarding request failed: port not forwarded'))
        throw new Error('ssh_channel_cancel_failed');
    },
    // A canceled SSH forward can leave its filesystem socket behind. Require
    // the kernel's live stream-listener entry, not just a stale inode.
    inspect:async()=> (await remote(prefix+privateDirectory+privateSocket+
      'awk -v path="$s" \'$4=="00010000" && $5=="0001" && $8==path {found=1} END {exit !found}\' /proc/net/unix')).code===0,
    cleanup:()=>success(remote(prefix+privateDirectory+'if test -e "$s" || test -L "$s"; then '+privateSocket+'rm -f "$s"; fi'),
      'ssh_channel_socket_cleanup_failed'),
  };
}
