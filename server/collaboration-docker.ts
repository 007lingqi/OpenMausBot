import {spawn,type ChildProcess} from 'node:child_process';
import {existsSync,realpathSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {documentRelayLaunchConfiguration,relayLaunchConfiguration,superviseDockerService,type ManagedService} from './collaboration/operations/docker-service-supervisor.ts';

function managed(child:ChildProcess,relayUrl?:string,event='model_channel_ready'):ManagedService {
  const exited=new Promise<number>(resolve=>{
    child.once('error',()=>resolve(1));child.once('exit',code=>resolve(code??1));
  });
  child.stdin?.on('error',()=>{});
  let ready:Promise<void>|undefined;
  if(relayUrl){
    ready=new Promise<void>((resolve,reject)=>{
      let output='',done=false;
      const fail=()=>{if(!done){done=true;reject(new Error('docker_relay_start_failed'));}};
      child.once('error',fail);child.once('exit',fail);
      child.stdout!.once('error',fail);
      child.stdout!.on('data',(chunk:Buffer)=>{
        if(done)return;
        if(Buffer.byteLength(output)+chunk.length>4096){fail();return;}
        output+=chunk.toString('utf8');if(!output.includes('\n'))return;
        try{
          const report=JSON.parse(output.trim());
          if(report.event!==event||report.mode!=='relay'||report.url!==relayUrl){fail();return;}
          done=true;resolve();
        }catch{fail();}
      });
    });
  }
  return {ready,exited,stop(){
    if(child.exitCode!==null||child.signalCode!==null)return;
    // The relay has a different UID and no tool dispatcher/child processes.
    // Closing its private lifetime pipe works without adding CAP_KILL. If it
    // cannot cooperate, the bounded main-process exit tears down the container.
    if(relayUrl)child.stdin?.end();else child.kill('SIGTERM');
  }};
}

export async function runDockerEntrypoint(args=process.argv.slice(2),environment:NodeJS.ProcessEnv=process.env):Promise<number>{
  const config=relayLaunchConfiguration(environment);
  const documents=documentRelayLaunchConfiguration(environment);
  if((config||documents)&&(process.platform!=='linux'||process.getuid?.()!==0||!existsSync('/.dockerenv')))
    throw new Error('docker_relay_container_required');
  const suffix=import.meta.url.endsWith('.ts')?'.ts':'.js';
  const headless=fileURLToPath(new URL(`./collaboration-headless${suffix}`,import.meta.url));
  const channel=fileURLToPath(new URL(`./collaboration/operations/opencodex-model-channel${suffix}`,import.meta.url));
  const documentChannel=fileURLToPath(new URL(`./collaboration/operations/online-document-relay${suffix}`,import.meta.url));
  const stop=new AbortController(),terminate=()=>stop.abort();
  process.once('SIGTERM',terminate);process.once('SIGINT',terminate);
  try{
    return await superviseDockerService({signal:stop.signal,
      ...(config?{startRelay:()=>managed(spawn('/usr/bin/setpriv',[...config.args,process.execPath,channel,...config.channelArgs],
        {env:config.environment,stdio:['pipe','pipe','ignore']}),config.url)}:{}),
      ...(documents?{startDocumentRelay:()=>managed(spawn('/usr/bin/setpriv',[...documents.args,process.execPath,documentChannel,...documents.channelArgs],
        {env:documents.environment,stdio:['pipe','pipe','ignore']}),documents.url,'online_document_channel_ready')}:{}),
      startHeadless:()=>managed(spawn(process.execPath,[headless,...args],{env:environment,stdio:['ignore','inherit','inherit']})),
    });
  }finally{process.off('SIGTERM',terminate);process.off('SIGINT',terminate);}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){
  // Deliberate hard boundary: Docker/tini exits its PID namespace even if a
  // peer ignored cooperative shutdown. Never use the relay mode on a host.
  runDockerEntrypoint().then(code=>process.exit(code),()=>{
    process.stderr.write('docker_service_failed\n');process.exit(1);
  });
}
