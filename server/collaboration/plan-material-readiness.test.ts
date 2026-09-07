import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCollaborationService } from "./service.ts";
import { policy, validProposal } from "./planner.test-fixtures.ts";
import { readLatestWorkItemSnapshot } from "./snapshot.ts";
import { enqueueInboundCard } from "./outbox.ts";
import { OutboxDispatcher } from "./outbox-dispatcher.ts";
import { InstanceLeaseCoordinator } from "./leases.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "plan-materials-")); roots.push(root);
  const service = startCollaborationService({ dataDirectory: root, planning: { policy, planner: { propose: () => validProposal() } } });
  const id = service.ingestDingTalkMessage({ sourceEventId: "legacy", transportMessageId: "legacy", conversationId: "group", addressedToBot: true,
    text: "修复登录提示", sender: { senderId: "user", senderCorpId: "corp", senderStaffId: "user", displayName: "测试" }, receivedAt: 1000 }).workItemId!;
  service.reviseWorkItemDefinition(id, { goal: "修复登录提示", goalConfirmed: true, repository: policy.allowedRepositories[0],
    acceptanceConditions: [{ description: "显示失败原因", observation: "可看到原因" }], blockingAmbiguities: [] }, 2000);
  const db = new DatabaseSync(join(root, "collaboration", "collaboration.sqlite"));
  const unread = () => db.prepare("UPDATE collaboration_external_events SET normalized_json=? WHERE work_item_id=?")
    .run(JSON.stringify({ text: "按 https://alidocs.dingtalk.com/i/nodes/legacy 修复" }), id);
  return { service, db, id, unread };
}
describe("current plan material readiness", () => {
  it("reprojects a legacy ready plan to one understandable clarification, with no repeat side effects", () => {
    const h = fixture();
    try { h.unread();
      expect(h.service.recheckPlanMaterials(h.id, 3000)).toBe(false);
      const snapshot = readLatestWorkItemSnapshot(h.db, h.id)!;
      expect(snapshot.blockingAmbiguities.map(q => q.id)).toContain("online-document-content-unavailable");
      expect(h.db.prepare("SELECT definition_status FROM collaboration_work_items WHERE id=?").get(h.id)).toEqual({ definition_status: "waiting_clarification" });
      const notices = h.db.prepare("SELECT * FROM collaboration_outbox").all();
      expect(JSON.stringify(notices)).toContain("还没有读取正文");
      expect(h.service.recheckPlanMaterials(h.id, 3001)).toBe(false);
      expect(readLatestWorkItemSnapshot(h.db, h.id)!.revision).toBe(snapshot.revision);
      expect(h.db.prepare("SELECT * FROM collaboration_outbox").all()).toEqual(notices);
    } finally { h.service.close(); h.db.close(); }
  });
  it.each(["completed", "candidate_ready"] as const)("does not send a legacy %s notice when its source is unread", async status => {
    const h = fixture();
    try { h.unread(); h.db.exec("UPDATE collaboration_outbox SET delivery_state='sent',sent_at=2001");
      const id = enqueueInboundCard(h.db, { sourceEventId: "old-result", aggregateType: "work_item", aggregateId: h.id, aggregateVersion: 1,
        card: { type: "plan_status_card", headline: "修改已完成", workItemId: h.id, status }, now: 3000 }).id;
      const lease = new InstanceLeaseCoordinator(h.db, "delivery").acquire(3000, 60000)!;
      const deliver = vi.fn(async () => ({ outcome: "sent" as const }));
      const dispatcher = new OutboxDispatcher(h.db, { deliver }, { maxAttempts: 3, claimTtlMs: 1000, baseBackoffMs: 100, maxBackoffMs: 1000 });
      expect(await dispatcher.dispatchOne(lease, 3001)).toMatchObject({ id, state: "superseded" });
      expect(deliver).not.toHaveBeenCalled();
    } finally { h.service.close(); h.db.close(); }
  });
  it("does not apply an uncertain completion receipt after materials lose completeness", async () => {
    const h = fixture();
    try { h.db.exec("UPDATE collaboration_outbox SET delivery_state='sent',sent_at=2001");
      const id = enqueueInboundCard(h.db, { sourceEventId: "uncertain-result", aggregateType: "work_item", aggregateId: h.id, aggregateVersion: 1,
        card: { type: "plan_status_card", headline: "修改已完成", workItemId: h.id, status: "completed" }, now: 3000 }).id;
      h.db.prepare("UPDATE collaboration_outbox SET delivery_state='dead_letter',attempt=1 WHERE id=?").run(id);
      const lease = new InstanceLeaseCoordinator(h.db, "delivery").acquire(3000, 60000)!;
      let finish!: (value: { outcome: "sent" }) => void;
      const dispatcher = new OutboxDispatcher(h.db, { deliver: vi.fn(), reconcile: () => new Promise(resolve => { finish = resolve; }) },
        { maxAttempts: 3, claimTtlMs: 1000, baseBackoffMs: 100, maxBackoffMs: 1000 });
      const pending = dispatcher.dispatchOne(lease, 3001); h.unread(); finish({ outcome: "sent" });
      expect(await pending).toMatchObject({ state: "superseded" });
      expect(h.db.prepare("SELECT sent_at FROM collaboration_outbox WHERE id=?").get(id)).toEqual({ sent_at: null });
    } finally { h.service.close(); h.db.close(); }
  });
});
