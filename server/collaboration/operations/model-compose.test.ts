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
