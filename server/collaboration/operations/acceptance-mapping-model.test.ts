import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configuredAcceptanceMapping } from "./acceptance-mapping-model.ts";
const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach(path => rmSync(path, {recursive:true,force:true})));
function environment(file = "/not-read-at-startup") {
  return { OMB_ACCEPTANCE_MAPPING_ENABLED: "1", OMB_ACCEPTANCE_MAPPING_POLICY_REVISION: "policy-1",
    ...Object.fromEntries(["PROPOSER", "VERIFIER"].flatMap(role => [
      [`OMB_ACCEPTANCE_MAPPING_${role}_MODEL`, "explicit-model"],
      [`OMB_ACCEPTANCE_MAPPING_${role}_ENDPOINT`, "https://model.example.invalid/v1/responses"],
      [`OMB_ACCEPTANCE_MAPPING_${role}_CREDENTIAL_FILE`, file],
    ])) };
}
const input = { system: "核对验收条件", user: "不可信业务材料", responseSchema: {type:"object",properties:{},additionalProperties:false}, signal:new AbortController().signal };
it("stays disabled by default and never borrows another feature's credentials", () => {
  expect(configuredAcceptanceMapping({OPENAI_API_KEY:"unrelated",OMB_NATURAL_INTAKE_CREDENTIAL_FILE:"/other"})).toBeUndefined();
  expect(() => configuredAcceptanceMapping({OMB_ACCEPTANCE_MAPPING_ENABLED:"1",OMB_NATURAL_INTAKE_MODEL:"other"})).toThrow("acceptance_mapping_configuration_required");
});
it("constructs independent stateless contexts without reading credentials", () => {
  const config = configuredAcceptanceMapping(environment())!;
  expect(config.proposer).not.toBe(config.verifier);
  expect(config.policyId).toMatch(/^mapping-v1:[a-f0-9]{64}$/);
});
it("invalidates policy identity when either model endpoint, name, credential reference or revision changes", () => {
  const env = environment(); const base = configuredAcceptanceMapping(env)!.policyId;
  for (const change of [{OMB_ACCEPTANCE_MAPPING_PROPOSER_MODEL:"changed"}, {OMB_ACCEPTANCE_MAPPING_VERIFIER_ENDPOINT:"https://other.example.invalid/responses"},
    {OMB_ACCEPTANCE_MAPPING_VERIFIER_CREDENTIAL_FILE:"/new-reference"}, {OMB_ACCEPTANCE_MAPPING_POLICY_REVISION:"policy-2"}]) {
    expect(configuredAcceptanceMapping({...env,...change})!.policyId).not.toBe(base);
  }
});
it("rejects incomplete configuration, unsafe endpoints and relative credential paths", () => {
  for (const change of [{OMB_ACCEPTANCE_MAPPING_VERIFIER_MODEL:""}, {OMB_ACCEPTANCE_MAPPING_PROPOSER_ENDPOINT:"http://remote.invalid/responses"},
    {OMB_ACCEPTANCE_MAPPING_VERIFIER_ENDPOINT:"https://host.invalid/?token=private"}, {OMB_ACCEPTANCE_MAPPING_VERIFIER_CREDENTIAL_FILE:"relative"}]) {
    expect(() => configuredAcceptanceMapping({...environment(),...change})).toThrow();
  }
});
it("uses only each explicit credential and never enables tools or conversation reuse", async () => {
  const root=mkdtempSync(join(tmpdir(),"omb-mapping-model-")); scratch.push(root);
  const file=join(root,"credential"); writeFileSync(file,"fixture-key",{mode:0o600});
  const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({status:"completed",output:[{type:"message",content:[{type:"output_text",text:"{}"}]}]})));
  const config=configuredAcceptanceMapping(environment(file),{fetch:fetcher})!;
  await config.proposer.complete(input); await config.verifier.complete(input);
  expect(fetcher).toHaveBeenCalledTimes(2);
  for(const [,init] of fetcher.mock.calls) {
    expect(init).toMatchObject({redirect:"error",headers:{Authorization:"Bearer fixture-key"}});
    const body=JSON.parse(String(init?.body));
    expect(body).toMatchObject({store:false,tools:[],tool_choice:"none"});
    expect(body).not.toHaveProperty("previous_response_id");
    expect(JSON.stringify(body)).not.toContain("fixture-key");
  }
  chmodSync(file,0o644);
  await expect(config.proposer.complete(input)).rejects.toThrow("credentials_unavailable");
  expect(fetcher).toHaveBeenCalledTimes(2);
});
