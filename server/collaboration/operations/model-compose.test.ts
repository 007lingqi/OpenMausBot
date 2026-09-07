import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { expect, it } from "vitest";
const root=new URL("../../../packaging/collaboration/docker/",import.meta.url);
it("keeps model use opt-in and mounts only explicit existing credential files read-only",()=>{
  const base=parse(readFileSync(new URL("compose.yaml",root),"utf8"));
  expect(base.services.collaboration.environment.OMB_ACCEPTANCE_MAPPING_ENABLED).toBeUndefined();
  expect(base.services.collaboration.environment.OMB_NATURAL_INTAKE_ENABLED).toBeUndefined();
  const source=readFileSync(new URL("compose.models.yaml",root),"utf8");
  const service=parse(source).services.collaboration;
  expect(service.environment.OMB_ACCEPTANCE_MAPPING_ENABLED).toBe("1");
  expect(service.environment.OMB_NATURAL_INTAKE_ENABLED).toBe("1");
  expect(service.volumes).toHaveLength(3);
  for(const mount of service.volumes) expect(mount).toMatchObject({type:"bind",read_only:true,bind:{create_host_path:false}});
  for(const role of ["PROPOSER","VERIFIER"]) {
    expect(service.environment[`OMB_ACCEPTANCE_MAPPING_${role}_MODEL`]).toContain(":?required}");
    expect(service.environment[`OMB_ACCEPTANCE_MAPPING_${role}_ENDPOINT`]).toContain(":?required}");
    const target=service.environment[`OMB_ACCEPTANCE_MAPPING_${role}_CREDENTIAL_FILE`];
    expect(service.volumes.some((mount:{target:string})=>mount.target===target)).toBe(true);
  }
  expect(source).not.toContain("OPENAI_API_KEY");
  expect(source).not.toContain("codex-auth");
  expect(source).not.toContain("privileged");
});
it('provides a separate no-key OpenCodex overlay with exact private socket and model routing',()=>{
 const source=readFileSync(new URL('compose.opencodex.yaml',root),'utf8');
 const service=parse(source,{customTags:[{tag:'!override',collection:'seq',resolve:(value:unknown)=>value}]}).services.collaboration;
 expect(source).toContain('volumes: !override');
 expect(service.environment.OMB_OPENCODEX_RELAY_ENABLED).toBe('1');
 expect(service.environment.OMB_CODEX_MODEL).toBe('gpt-6-astra');
 expect(service.environment.OMB_CODEX_REASONING_EFFORT).toBe('medium');
 expect(service.environment.OMB_CODEX_OPENCODEX_ENDPOINT).toBe('http://127.0.0.1:18100/v1/responses');
 for(const prefix of ['OMB_NATURAL_INTAKE','OMB_ACCEPTANCE_MAPPING_PROPOSER','OMB_ACCEPTANCE_MAPPING_VERIFIER']){
  expect(service.environment[`${prefix}_TRANSPORT`]).toBe('opencodex_local');
  expect(service.environment[`${prefix}_MODEL`]).toBe('gpt-6-astra');
  expect(service.environment[`${prefix}_REASONING_EFFORT`]).toBe('medium');
  expect(service.environment[`${prefix}_ENDPOINT`]).toBe(service.environment.OMB_CODEX_OPENCODEX_ENDPOINT);
  expect(service.environment[`${prefix}_CREDENTIAL_FILE`]).toBeUndefined();
 }
 expect(service.volumes).toHaveLength(6);
 expect(service.volumes.map((mount:{target:string})=>mount.target)).toEqual([
  '/var/run/docker.sock','/var/lib/openmausbot-collaboration-pilot','${OMB_EXECUTION_REPOSITORY:?required}',
  '/run/openmausbot-secrets/dingtalk.json','/run/openmausbot-secrets/containment-verifier.key','/run/omb-channel']);
 expect(service.volumes.at(-1)).toMatchObject({type:'bind',read_only:true,bind:{create_host_path:false}});
 expect(source).not.toContain('codex-auth');expect(source).not.toContain('cap_add');expect(source).not.toContain('privileged');
 expect(service.stop_grace_period).toBe('20s');
});
