import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { containmentBindingHash, runtimeIdentityFingerprint, type ContainmentBinding } from "./containment.ts";
import { buildSupplementalSelfCheck, readSupplementalSelfCheck } from "./supplemental-self-check.ts";
import type { TestEvidence } from "./quality-gate.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach(database => database.close()));
// oxlint-disable-next-line anti-slop/no-object-parameters -- Test-only checksum helper accepts the fixture's typed command object.
const hash = (value: object) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function fixture() {
  const database = new DatabaseSync(":memory:"); databases.push(database);
  database.exec(`
    CREATE TABLE collaboration_verification_sessions(id TEXT,candidate_run_id TEXT,candidate_sha TEXT,instance_owner TEXT,instance_fence INTEGER);
    CREATE TABLE collaboration_verification_commands(session_id TEXT,ordinal INTEGER,binding_json TEXT);
    CREATE TABLE collaboration_verification_proofs(session_id TEXT,ordinal INTEGER,proof_json TEXT);
    CREATE TABLE collaboration_verification_settlements(session_id TEXT,evidence_json TEXT);
    CREATE TABLE collaboration_test_evidence(run_id TEXT,command_id TEXT,state TEXT,argv_json TEXT,stdout TEXT,containment_binding_json TEXT);
    CREATE TABLE collaboration_candidate_recheck_attempts(session_id TEXT,candidate_run_id TEXT,candidate_sha TEXT,contract_hash TEXT,verifier_attempt INTEGER,instance_owner TEXT,instance_fence INTEGER);
  `);
  const runId = "fixed-candidate-run", candidateSha = "c".repeat(40), contractHash = "d".repeat(64);
  database.prepare("INSERT INTO collaboration_verification_sessions VALUES(?,?,?,?,?)").run("session",runId,candidateSha,"instance",3);
  database.prepare("INSERT INTO collaboration_candidate_recheck_attempts VALUES(?,?,?,?,?,?,?)").run("session",runId,candidateSha,contractHash,1,"instance",3);
  database.prepare("INSERT INTO collaboration_test_evidence VALUES(?,?,?,?,?,?)").run(runId,"target","target_passed",
    JSON.stringify(["node","--test","tests/old.test.mjs"]),JSON.stringify({version:1,runId,nonce:"o".repeat(32),assertions:[{id:"old",state:"passed"}]}),
    JSON.stringify({runId,commandId:"target",nonce:"o".repeat(32)}));
  const evidence = (role: string, ordinal: number): TestEvidence => {
    const binding: ContainmentBinding = {runId:`${runId}:verifier:1${role === "self" ? ":self-recheck" : ""}`,commandId:"target",canonicalWorktreePath:`/candidate/${role}`,instanceOwner:"instance",instanceFence:3,nonce:role.repeat(32)};
    const proof = {identity:{backend:"test_runtime",opaqueId:`separate-runtime-${role}`,hostGeneration:"host",verifierVersion:"v1"},receipt:containmentBindingHash(binding)};
    database.prepare("INSERT INTO collaboration_verification_commands VALUES(?,?,?)").run("session",ordinal,JSON.stringify(binding));
    database.prepare("INSERT INTO collaboration_verification_proofs VALUES(?,?,?)").run("session",ordinal,JSON.stringify(proof));
    return {commandId:"target",argv:["node","--test","tests/old.test.mjs","tests/new.test.mjs"],cwd:binding.canonicalWorktreePath,exitCode:0,durationMs:4,
      stdout:JSON.stringify({version:1,runId:binding.runId,nonce:binding.nonce,assertions:[{id:"old",state:"passed"},{id:"new",state:"passed"}]}),stderr:"",state:"target_passed",
      containmentBinding:binding,containmentFingerprint:runtimeIdentityFingerprint(proof.identity)};
  };
  const self = evidence("self",1), verifier = evidence("verifier",2);
  const expected = {candidateRunId:runId,candidateSha,contractHash,verifierAttempt:1,
    definitions:{target:hash({argv:self.argv})},commands:{target:{argv:["node","--test","tests/old.test.mjs","tests/new.test.mjs"] as const,timeoutMs:1000,maxOutputBytes:32000,assertionReporter:"node-test-v1" as const}}};
  const build = () => buildSupplementalSelfCheck(database,{...expected,sessionId:"session",selfEvidence:[self],verifierEvidence:[verifier]});
  const settle = () => database.prepare("INSERT INTO collaboration_verification_settlements VALUES(?,?)").run("session",JSON.stringify([
    {ordinal:1,fingerprint:self.containmentFingerprint,state:"empty"},{ordinal:2,fingerprint:verifier.containmentFingerprint,state:"empty"}]));
  return {database,expected,self,verifier,build,settle};
}

describe("append-only supplemental self-check provenance", () => {
  it("keeps the original self-test untouched and requires both isolated phases to settle", () => {
    const f=fixture(); const original=f.database.prepare("SELECT * FROM collaboration_test_evidence").all(); const receipt=f.build();
    expect(readSupplementalSelfCheck(f.database,receipt,f.expected)).toBeNull();
    f.settle(); expect(readSupplementalSelfCheck(f.database,receipt,f.expected)?.[0].assertions).toHaveLength(2);
    expect(f.database.prepare("SELECT * FROM collaboration_test_evidence").all()).toEqual(original);
  });
  it.each(["candidateSha","contractHash","candidateRunId"] as const)("rejects stale %s", key => {
    const f=fixture(), receipt=f.build(); f.settle();
    expect(readSupplementalSelfCheck(f.database,receipt,{...f.expected,[key]:"changed"})).toBeNull();
  });
  it("rejects a different command definition or resolved argument set", () => {
    const f=fixture(),receipt=f.build();f.settle();
    expect(readSupplementalSelfCheck(f.database,receipt,{...f.expected,definitions:{target:"e".repeat(64)}})).toBeNull();
    expect(readSupplementalSelfCheck(f.database,receipt,{...f.expected,commands:{target:{...f.expected.commands.target,argv:["node","wrong"]}}})).toBeNull();
  });
  it.each(["proof","binding","settlement","original","reservation"])("does not trust a receipt with changed %s", what => {
    const f=fixture(),receipt=f.build();f.settle();
    if(what==="proof") f.database.exec("UPDATE collaboration_verification_proofs SET proof_json='{}' WHERE ordinal=1");
    if(what==="binding") f.database.exec("UPDATE collaboration_verification_commands SET binding_json='{}' WHERE ordinal=1");
    if(what==="settlement") f.database.prepare("UPDATE collaboration_verification_settlements SET evidence_json=?").run(JSON.stringify([{ordinal:2,fingerprint:f.verifier.containmentFingerprint,state:"empty"}]));
    if(what==="original") f.database.exec("UPDATE collaboration_test_evidence SET state='failed'");
    if(what==="reservation") f.database.exec("DELETE FROM collaboration_candidate_recheck_attempts");
    expect(readSupplementalSelfCheck(f.database,receipt,f.expected)).toBeNull();
  });
  it("rejects reusing the same container as both self-check and independent verification", () => {
    const f=fixture(); const proof=z.object({proof_json:z.string()}).parse(f.database.prepare("SELECT proof_json FROM collaboration_verification_proofs WHERE ordinal=1").get());
    f.database.prepare("UPDATE collaboration_verification_proofs SET proof_json=? WHERE ordinal=2").run(proof.proof_json);
    f.verifier.containmentFingerprint=f.self.containmentFingerprint;
    expect(f.build).toThrow("supplemental_self_check_invalid");
  });
  it("rejects a report copied between stages, skipped new tests, or a failed self-check", () => {
    const f=fixture();f.self.stdout=f.verifier.stdout;expect(f.build).toThrow("supplemental_self_check_invalid");
    const g=fixture();g.self.state="failed";expect(g.build).toThrow("supplemental_self_check_invalid");
    const h=fixture();h.self.stdout=h.self.stdout.replace('"new","state":"passed"','"new","state":"skipped"');expect(h.build).toThrow("supplemental_self_check_invalid");
  });
  it("requires the original self-test to have a bound successful report", () => {
    const f=fixture();f.database.exec("UPDATE collaboration_test_evidence SET stdout='unbound success'");
    expect(f.build).toThrow("supplemental_self_check_invalid");
  });
  it("accepts recovered settlement arrays but not missing individual command evidence", () => {
    const f=fixture(),receipt=f.build();f.settle();
    const row=z.object({evidence_json:z.string()}).parse(f.database.prepare("SELECT evidence_json FROM collaboration_verification_settlements").get());
    f.database.prepare("UPDATE collaboration_verification_settlements SET evidence_json=?").run(JSON.stringify({version:1,recoveredBy:{ownerId:"new",fence:4},evidence:JSON.parse(row.evidence_json)}));
    expect(readSupplementalSelfCheck(f.database,receipt,f.expected)).not.toBeNull();
  });
});
