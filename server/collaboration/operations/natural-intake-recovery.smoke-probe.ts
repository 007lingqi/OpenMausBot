/** Synthetic messages/model; real Linux processes, SQLite WAL and application service. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { startCollaborationService } from "../service.ts";
import { policy, validProposal } from "../planner.test-fixtures.ts";
import { readLatestWorkItemSnapshot } from "../snapshot.ts";
import type { NaturalIntakeRequest } from "../natural-intake.ts";

const count = 15;
function message(index: number) {
  return { sourceEventId: `linux-input-${index}`, transportMessageId: `linux-transport-${index}`, conversationId: "synthetic-group",
    addressedToBot: true, text: `补充验收要求 ${index} 必须保留`, receivedAt: 1000,
    ...(index ? { replyToSourceEventId: "linux-input-0" } : {}),
    sender: { senderCorpId: "synthetic-corp", senderStaffId: `staff-${index % 3}`, senderId: `staff-${index % 3}`, displayName: "合成同事" } };
}
function service(directory: string) {
  return startCollaborationService({ dataDirectory: directory, planning: { policy, planner: { propose: validProposal },
    defaultDefinition: { repository: policy.allowedRepositories[0], acceptanceConditions: [] },
    naturalIntake: { async interpret(request: NaturalIntakeRequest) {
      assert.ok(request.history.length <= 12);
      assert.ok(request.history.reduce((n, row) => n + row.text.length, 0) <= 24000);
      return { version: 1, sourceEventId: request.event.sourceEventId, baseRevision: request.snapshot.revision, goal: null,
        acceptance: [{ description: request.event.text, observation: request.event.text, quote: request.event.text }], answers: [], questions: [] };
    } } } });
}
const [phase, directory] = process.argv.slice(2);
if (phase === "produce") {
  const active = service(directory);
  for (let i = 0; i < count; i++) active.ingestDingTalkMessage(message(i));
  await active.processNaturalIntake();
  // Leave every SQLite connection open; the parent will SIGKILL this process after durable acknowledgement.
  process.send?.("durable");
  setInterval(() => {}, 1000);
} else if (phase === "recover") {
  const active = service(directory);
  const db = new DatabaseSync(join(directory, "collaboration", "collaboration.sqlite"));
  try {
    assert.deepEqual(db.prepare("SELECT status,count(*) n FROM collaboration_natural_intake_jobs GROUP BY status ORDER BY status").all().map(row => ({ ...row })),
      [{ status: "applied", n: 1 }, { status: "pending", n: count - 1 }]);
    const before = db.prepare("SELECT count(*) n FROM collaboration_external_events").get();
    assert.equal(active.ingestDingTalkMessage(message(0)).duplicate, true);
    assert.deepEqual(db.prepare("SELECT count(*) n FROM collaboration_external_events").get(), before);
    for (let i = 1; i < count; i++) await active.processNaturalIntake();
    assert.deepEqual(db.prepare("SELECT status,count(*) n FROM collaboration_natural_intake_jobs GROUP BY status").all().map(row => ({ ...row })), [{ status: "applied", n: count }]);
    const work = db.prepare("SELECT id FROM collaboration_work_items").all() as Array<{ id: string }>;
    assert.equal(work.length, 1);
    const snapshot = readLatestWorkItemSnapshot(db, work[0].id)!;
    assert.deepEqual(snapshot.acceptanceConditions.map(condition => condition.description), Array.from({ length: count }, (_, i) => message(i).text));
    assert.ok(!snapshot.blockingAmbiguities.some(q => ["natural-input-pending", "natural-context-incomplete"].includes(q.id)));
    assert.equal(active.ownerBinding(), null);
  } finally { db.close(); active.close(); }
} else {
  const root = mkdtempSync(join(tmpdir(), "omb-intake-recovery-"));
  const execute = (mode: "produce" | "recover") => new Promise<void>((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), [mode, root], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let durable = false, expired = false, diagnostic = "";
    const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 15000);
    child.on("message", value => { if (mode === "produce" && value === "durable") { durable = true; child.kill("SIGKILL"); } });
    // Bounded diagnostics contain only this probe's self-generated, non-sensitive fixtures.
    child.stderr?.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4000); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (!expired && (mode === "produce" ? durable && signal === "SIGKILL" : code === 0)) resolve();
      else reject(new Error(`natural_intake_smoke_${mode}_failed:${diagnostic}`));
    });
  });
  try {
    await execute("produce"); await execute("recover");
    console.log(JSON.stringify({ evidenceSource: "linux_process_sqlite", interpretation: "controlled", messages: count,
      killedAfterDurableWrite: true, allRecovered: true, replayDeduplicated: true, authorityUnchanged: true }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
