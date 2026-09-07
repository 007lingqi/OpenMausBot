import {execFile} from 'node:child_process';
import {isAbsolute,normalize} from 'node:path';

// Runs without supervisor privileges. Never follow links, chmod files, or remove
// the root entry: its parent belongs to the supervisor, not the provider.
const CLEAR_HOME = `
import {lstatSync,chmodSync,readdirSync,unlinkSync,rmdirSync} from 'node:fs';
import {join} from 'node:path';
const [home,uid,gid]=process.argv.slice(1);
if(process.getuid()!==Number(uid)||process.getgid()!==Number(gid))process.exit(1);
const root=lstatSync(home);
if(!root.isDirectory()||root.isSymbolicLink()||root.uid!==Number(uid))process.exit(1);
function clear(path,keep=false){
  const stat=lstatSync(path);
  if(stat.isSymbolicLink()||!stat.isDirectory()){unlinkSync(path);return;}
  if(stat.uid!==Number(uid))throw Error('unexpected_owner');
  chmodSync(path,0o700);
  for(const name of readdirSync(path))clear(join(path,name));
  if(!keep)rmdirSync(path);
}
clear(home,true);
`;

/** Clear only this run's private CLI state as its owner. No model calls/retries. */
export async function clearProviderOwnedHome(input:{home:string;uid:number;gid:number;launcher?:{executable:string;args:readonly string[]}}):Promise<void>{
  if(!isAbsolute(input.home)||normalize(input.home)!==input.home||input.home==='/'||input.home.includes('\0')||
    ![input.uid,input.gid].every(n=>Number.isSafeInteger(n)&&n>=0))throw Error('provider_home_cleanup_failed');
  const args=['--input-type=module','--eval',CLEAR_HOME,input.home,String(input.uid),String(input.gid)];
  const executable=input.launcher?.executable??process.execPath;
  const commandArgs=input.launcher?[...input.launcher.args,process.execPath,...args]:args;
  await new Promise<void>((resolve,reject)=>{
    execFile(executable,commandArgs,{cwd:'/',env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'},timeout:5000,killSignal:'SIGKILL',maxBuffer:4096},
      error=>error?reject(Error('provider_home_cleanup_failed')):resolve());
  });
}
