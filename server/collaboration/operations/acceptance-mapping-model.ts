import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { AcceptanceMappingModels } from "../acceptance-mapping.ts";
import { ResponsesNaturalIntakeModel } from "./natural-intake-model.ts";
import { readSecureCredentialFile } from "./credentials.ts";

/** Explicit configuration only. Construction/probe does not load credentials or call either model. */
export function configuredAcceptanceMapping(environment: NodeJS.ProcessEnv, dependencies: {fetch?: typeof globalThis.fetch} = {}): AcceptanceMappingModels | undefined {
  if (environment.OMB_ACCEPTANCE_MAPPING_ENABLED !== "1") return undefined;
  const revision=environment.OMB_ACCEPTANCE_MAPPING_POLICY_REVISION?.trim();
  if (!revision || !/^[A-Za-z0-9._:-]{1,128}$/u.test(revision)) throw new Error("acceptance_mapping_configuration_required");
  const allowInsecureLoopback=environment.OMB_ACCEPTANCE_MAPPING_ALLOW_LOOPBACK_HTTP === "1";
  const settings=["PROPOSER","VERIFIER"].map(role => {
    const prefix=`OMB_ACCEPTANCE_MAPPING_${role}`;
    const model=environment[`${prefix}_MODEL`]?.trim();
    const endpoint=environment[`${prefix}_ENDPOINT`]?.trim();
    const file=environment[`${prefix}_CREDENTIAL_FILE`]?.trim();
    if (!model || !endpoint || !file || !isAbsolute(file)) throw new Error("acceptance_mapping_configuration_required");
    return {model,endpoint,file:resolve(file)};
  });
  const contexts=settings.map(setting => new ResponsesNaturalIntakeModel({model:setting.model,endpoint:setting.endpoint,
    allowInsecureLoopback, fetch:dependencies.fetch, credential:() => {
      const raw=readSecureCredentialFile(setting.file);
      try { return raw.toString("utf8").trim(); } finally { raw.fill(0); }
    } }));
  const policyId=`mapping-v1:${createHash("sha256").update(JSON.stringify({revision,settings,allowInsecureLoopback,protocol:1})).digest("hex")}`;
  return {proposer:contexts[0],verifier:contexts[1],policyId};
}
