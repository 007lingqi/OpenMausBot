import {execFile} from 'node:child_process';

// Fixed trusted code; no model-provided source, shell, environment or target.
// This helper has exactly the provider's identity, not extra capabilities.
const SIGNAL_GROUP = `
const [pid,signal,uid,gid]=process.argv.slice(1);
if(process.getuid()!==Number(uid)||process.getgid()!==Number(gid))process.exit(1);
if(!/^[1-9][0-9]*$/.test(pid)||Number(pid)<2||!['SIGTERM','SIGKILL'].includes(signal))process.exit(1);
try{process.kill(-Number(pid),signal);}catch(error){if(error.code!=='ESRCH')process.exit(1);}
`;

/** Only the controller may supply a still-tracked child process group. This is
 * cancellation, not an independently verified cgroup containment receipt. */
export async function signalProviderProcess(input:{pid:number;signal:'SIGTERM'|'SIGKILL';uid?:number;gid?:number;
  launcher?:{executable:string;args:readonly string[]}}):Promise<void>{
  if(!Number.isSafeInteger(input.pid)||input.pid<2)throw Error('provider_stop_signal_failed');
  if(input.launcher&&input.uid!==undefined&&input.gid!==undefined){
    if(![input.uid,input.gid].every(n=>Number.isSafeInteger(n)&&n>=0))throw Error('provider_stop_signal_failed');
    await new Promise<void>((resolve,reject)=>{
      execFile(input.launcher!.executable,[...input.launcher!.args,process.execPath,'--input-type=module','--eval',SIGNAL_GROUP,
        String(input.pid),input.signal,String(input.uid),String(input.gid)],
      {cwd:'/',env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'},timeout:1000,killSignal:'SIGKILL',maxBuffer:1024},
      error=>error?reject(Error('provider_stop_signal_failed')):resolve());
    });
    return;
  }
  try{process.kill(process.platform==='win32'?input.pid:-input.pid,input.signal);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw Error('provider_stop_signal_failed');}
}
