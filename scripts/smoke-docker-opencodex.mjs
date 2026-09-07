import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {cpSync,mkdtempSync,writeFileSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startLocalOpenCodexBridge} from '../server/collaboration/operations/opencodex-local-bridge.ts';
// Explicit non-production fault-injection probe; never runs as part of ordinary startup.
if(process.env.OMB_DOCKER_MODEL_SMOKE!=='1')throw new Error('docker_model_smoke_opt_in_required');
const image=process.env.OMB_DOCKER_MODEL_SMOKE_IMAGE;
if(!/^sha256:[a-f0-9]{64}$/.test(image??''))throw new Error('docker_model_smoke_cached_image_required');
const project=fileURLToPath(new URL('../',import.meta.url));
const context='colima-openmausbot-pilot',host='lima-colima-openmausbot-pilot';
const sshConfig=join(homedir(),'.colima','_lima','colima-openmausbot-pilot','ssh.config');
const run=(file,args,timeout=20000)=>new Promise((resolve,reject)=>execFile(file,args,{timeout,maxBuffer:1024*1024},(error,stdout)=>
 error?reject(new Error(`probe_command_failed:${file}:${error.code}`)):resolve(stdout.trim())));
const docker=(args,timeout)=>run('docker',['--context',context,...args],timeout);
const remote=command=>run('/usr/bin/ssh',['-F',sshConfig,'-T','-o','ControlMaster=no','-o','ProxyCommand=false','-o','ClearAllForwardings=yes',host,command]);
const root=mkdtempSync(join(realpathSync('/tmp'),'omb-wrapper-build-')),tag=`omb-wrapper-probe:${randomUUID()}`,base=`omb-wrapper-base:${randomUUID()}`;
const names=[];let bridge,directory,directoryWasAbsent=false,bridgeStarted=false,tagged=false,built=false;
const until=async predicate=>{const end=Date.now()+20000;while(!await predicate()){
 if(Date.now()>end)throw new Error('wrapper_probe_timeout');await new Promise(r=>setTimeout(r,100));}};
try{
 const uid=Number(await remote('id -u')),gid=Number(await remote('id -g'));
 for(const value of [uid,gid])assert.ok(Number.isSafeInteger(value)&&value>0&&value!==10001,'dedicated relay identity required');
 await docker(['image','tag',image,base]);tagged=true;
 for(const name of ['collaboration-headless.js','collaboration-docker.js'])cpSync(`${project}dist-server/${name}`,`${root}/${name}`);
 cpSync(`${project}dist-server/collaboration/operations/opencodex-model-channel.js`,`${root}/opencodex-model-channel.js`);
 writeFileSync(`${root}/Dockerfile`,`FROM ${base}\nCOPY collaboration-headless.js collaboration-docker.js /opt/openmausbot/\nCOPY opencodex-model-channel.js /opt/openmausbot/collaboration/operations/\nENTRYPOINT ["node","/opt/openmausbot/collaboration-docker.js"]\n`);
 await docker(['build','--pull=false','--network=none','-t',tag,root],60000);built=true;
 const temporary=createServer();temporary.listen(0,'127.0.0.1');await once(temporary,'listening');const port=temporary.address().port;
 await new Promise(r=>temporary.close(r));directory=`/tmp/omb-model-channel-${port}`;
 await remote(`test ! -e ${directory} && test ! -L ${directory}`);
 directoryWasAbsent=true;
 bridge=await startLocalOpenCodexBridge({port,sshConfig,endpoint:'http://127.0.0.1:10100/v1/responses',stateFile:join(root,'bridge-state.json')});
 bridgeStarted=true;
 await until(()=>bridge.snapshot().status==='connected');
 assert.equal(JSON.parse(readFileSync(join(root,'bridge-state.json'),'utf8')).attempts,0);
 async function start(extra=[]){
  const name=`omb-wrapper-probe-${randomUUID()}`;names.push(name);
  await docker(['run','-d','--name',name,'--init','--network','none','--read-only','--cap-drop','ALL','--cap-add','CHOWN','--cap-add','SETUID','--cap-add','SETGID',
   '--security-opt','no-new-privileges:true','--pids-limit','64','--memory','256m','--cpus','1','--tmpfs','/tmp:rw,nosuid,nodev,size=64m',
   '--mount',`type=bind,source=${directory},target=/run/omb-channel,readonly`,
   '-e','OMB_OPENCODEX_RELAY_ENABLED=1','-e',`OMB_OPENCODEX_RELAY_UID=${uid}`,'-e',`OMB_OPENCODEX_RELAY_GID=${gid}`,'-e','OMB_OPENCODEX_RELAY_PORT=18100',
   '-e','OMB_OPENCODEX_RELAY_SOCKET=/run/omb-channel/model.sock','-e','OMB_DINGTALK_ENABLED=0','-e','OMB_EXECUTION_ENABLED=0','-e','OMB_DATA_DIR=/tmp/probe-data',
   ...extra,tag]);return name;
 }
 const logs=name=>docker(['logs',name]);
 const ready=async name=>{try{await until(async()=>{assert.equal(await docker(['inspect','-f','{{.State.Running}}',name]),'true');
   return (await logs(name)).split('\n').some(line=>{try{const value=JSON.parse(line);return value.app==='openmausbot-collaboration'&&typeof value.ready==='boolean'&&typeof value.state==='string'&&value.dingtalk?.enabled===false;}catch{return false;}});
  });}catch(error){console.log('synthetic_container_startup_output',await logs(name));throw error;}};
 const stopped=async(name,code)=>{await until(async()=>await docker(['inspect','-f','{{.State.Running}}',name])==='false');
  assert.equal(await docker(['inspect','-f','{{.State.ExitCode}}',name]),String(code));};
 const normal=await start();await ready(normal);await docker(['kill','--signal','TERM',normal]);await stopped(normal,0);
 console.log('production_wrapper_relay_headless_sigterm_verified');
 const failedRelay=await start();await ready(failedRelay);
 await docker(['exec','--user',`${uid}:${gid}`,failedRelay,'node','--input-type=module','-e',
  `import {readdirSync,readFileSync} from 'node:fs';let found=0;for(const p of readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){try{const args=readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0');if(args[1]==='/opt/openmausbot/collaboration/operations/opencodex-model-channel.js'){process.kill(Number(p),'SIGKILL');found++;}}catch{}}if(found!==1)process.exit(1);`]);
 await stopped(failedRelay,1);console.log('production_wrapper_stops_headless_on_relay_death_verified');
 const failedHeadless=await start(['-e','OMB_EXECUTION_ENABLED=1']);await stopped(failedHeadless,1);
 console.log('production_wrapper_stops_relay_on_headless_failure_verified');
 const frozenRelay=await start();await ready(frozenRelay);
 await docker(['exec','--user',`${uid}:${gid}`,frozenRelay,'node','--input-type=module','-e',
  `import {readdirSync,readFileSync} from 'node:fs';let found=0;for(const p of readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){try{const args=readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0');if(args[1]==='/opt/openmausbot/collaboration/operations/opencodex-model-channel.js'){process.kill(Number(p),'SIGSTOP');found++;}}catch{}}if(found!==1)process.exit(1);`]);
 const stopStart=Date.now();await docker(['kill','--signal','TERM',frozenRelay]);await stopped(frozenRelay,1);
 assert.ok(Date.now()-stopStart>=9000,'frozen relay did not exercise the shutdown deadline');
 assert.equal(await docker(['inspect','-f','{{.State.Pid}}',frozenRelay]),'0');
 console.log('production_wrapper_frozen_relay_timeout_tears_down_container_verified');
 await bridge.close();bridge=undefined;
 const unavailable=await start();await stopped(unavailable,1);
 assert.equal((await logs(unavailable)).trim(),'');
 console.log('production_wrapper_does_not_start_headless_without_channel_verified');
}finally{
 const errors=[];
 for(const name of names)try{await docker(['rm','-f',name]);}catch{errors.push('container');}
 if(bridge)try{await bridge.close();}catch{errors.push('bridge');}
 if(directory&&directoryWasAbsent&&bridgeStarted)try{await remote(`test ! -e ${directory}/model.sock && rmdir ${directory}`);}catch{errors.push('directory');}
 if(built)try{await docker(['image','rm',tag]);}catch{errors.push('image');}
 if(tagged)try{await docker(['image','rm',base]);}catch{errors.push('base_tag');}
 rmSync(root,{recursive:true,force:true});assert.deepEqual(errors,[]);console.log('wrapper_probe_temporary_resources_cleaned');
}
