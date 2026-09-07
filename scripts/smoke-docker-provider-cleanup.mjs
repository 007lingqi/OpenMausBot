import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {NodeDockerCommandPort} from '../server/collaboration/operations/docker-containment.ts';

const context=process.env.OMB_PROVIDER_CLEANUP_SMOKE_CONTEXT,image=process.env.OMB_PROVIDER_CLEANUP_SMOKE_IMAGE;
if(!context||!/^sha256:[a-f0-9]{64}$/.test(image??''))throw Error('explicit_context_and_fixed_cached_image_required');
const docker=new NodeDockerCommandPort({context}),name='omb-provider-cleanup-'+randomUUID(),root=mkdtempSync(join(tmpdir(),'omb-provider-cleanup-'));
let id;
try{
  const found=await docker.run(['image','inspect','--format','{{.Id}}',image]);assert.equal(found.exitCode,0);assert.equal(found.stdout.toString().trim(),image);
  const bundle=join(root,'probe.mjs');await build({entryPoints:[fileURLToPath(new URL('../server/collaboration/operations/provider-cleanup.smoke-probe.ts',import.meta.url))],outfile:bundle,bundle:true,platform:'node',target:'node24',format:'esm'});
  const created=await docker.run(['create','--name',name,'--label',`com.openmausbot.cleanup-probe=${name}`,'-i','--network','none','--read-only','--user','0:0','--cap-drop','ALL','--cap-add','CHOWN','--cap-add','SETUID','--cap-add','SETGID','--security-opt','no-new-privileges:true','--pids-limit','64','--memory','256m','--memory-swap','256m','--cpus','1','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=64m','--tmpfs','/opt/omb-test-bin:rw,exec,nosuid,nodev,size=1m,mode=0755','--entrypoint','node',image,'--input-type=module']);
  assert.equal(created.exitCode,0);id=created.stdout.toString().trim();assert.match(id,/^[a-f0-9]{64}$/);
  const inspected=await docker.run(['inspect',id]);assert.equal(inspected.exitCode,0);const state=JSON.parse(inspected.stdout.toString())[0];
  assert.equal(state.Image,image);assert.equal(state.Config.User,'0:0');assert.equal(state.HostConfig.Privileged,false);assert.equal(state.HostConfig.NetworkMode,'none');assert.equal(state.HostConfig.ReadonlyRootfs,true);
  assert.deepEqual(state.HostConfig.CapDrop,['ALL']);assert.deepEqual(new Set(state.HostConfig.CapAdd.map(cap=>cap.replace(/^CAP_/,''))),new Set(['CHOWN','SETUID','SETGID']));
  assert.ok(state.HostConfig.SecurityOpt.includes('no-new-privileges:true')||state.HostConfig.SecurityOpt.includes('no-new-privileges'));
  assert.equal(state.Mounts.filter(m=>m.Type!=='tmpfs').length,0);
  assert.ok(state.HostConfig.Tmpfs['/tmp'].split(',').includes('noexec'));
  const result=await docker.run(['start','--attach','--interactive',id],{input:readFileSync(bundle),timeoutMs:20000,maxOutputBytes:8000});
  assert.equal(result.exitCode,0,result.stderr.toString());const evidence=JSON.parse(result.stdout.toString());assert.equal(evidence.privateStateRemoved,true);assert.equal(evidence.outsideSymlinkTargetUnchanged,true);assert.equal(evidence.modelCalls,0);
  console.log(JSON.stringify({...evidence,image,isolationInspected:true}));
}finally{
  const listed=await docker.run(['ps','-aq','--filter',`name=^/${name}$`]);assert.equal(listed.exitCode,0);
  if(listed.stdout.toString().trim()){
    const inspect=await docker.run(['inspect',id??name]);assert.equal(inspect.exitCode,0);const owned=JSON.parse(inspect.stdout.toString())[0];
    assert.equal(owned.Name,'/'+name);assert.equal(owned.Image,image);assert.equal(owned.Config.Labels['com.openmausbot.cleanup-probe'],name);
    const removed=await docker.run(['rm','--force',owned.Id]);assert.equal(removed.exitCode,0);
  }
  const after=await docker.run(['ps','-aq','--filter',`name=^/${name}$`]);assert.equal(after.exitCode,0);assert.equal(after.stdout.toString().trim(),'');
  rmSync(root,{recursive:true,force:true});
}
