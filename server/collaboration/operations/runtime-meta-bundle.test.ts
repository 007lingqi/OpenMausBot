import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DingTalkInboundMessage } from "../../integrations/dingtalk/types.ts";
import { startCollaborationService } from "../service.ts";
import { CollaborationHeadlessRuntime, type RuntimeLogEvent } from "./runtime.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "collaboration-runtime-meta-bundle-"));
  scratch.push(directory);
  return directory;
}

function message(sourceEventId: string, text = `处理 ${sourceEventId}`, receivedAt = 1_000): DingTalkInboundMessage {
  return {
    sourceEventId,
    transportMessageId: `transport-${sourceEventId}`,
    conversationId: "meta-bundle-conversation",
    addressedToBot: true,
    text,
    sender: {
      senderCorpId: "corp",
      senderStaffId: "contributor",
      senderId: "contributor-sender",
      displayName: "Contributor",
    },
    receivedAt,
  };
}

function bundleRoot(dataDirectory: string, workItemId: string): string {
  return join(dataDirectory, "collaboration", "meta-bundles", workItemId);
}

function currentRevision(dataDirectory: string, workItemId: string): string {
  return readFileSync(join(bundleRoot(dataDirectory, workItemId), "CURRENT"), "utf8").trim();
}

function expectCompleteCurrentBundle(dataDirectory: string, workItemId: string): string {
  const revision = currentRevision(dataDirectory, workItemId);
  const directory = join(bundleRoot(dataDirectory, workItemId), "bundles", revision);
  expect(readdirSync(directory).sort()).toEqual([
    "DECISIONS.md",
    "PROGRESS.md",
    "SPEC.md",
    "VERIFY.md",
    "manifest.json",
  ]);
  return revision;
}

describe("runtime Meta bundle projection", () => {
  it("projects Work Items already stored in the Ledger during startup", async () => {
    const dataDirectory = temporaryDirectory();
    const setup = startCollaborationService({ dataDirectory });
    const workItemId = setup.ingestDingTalkMessage(message("before-start", "修复启动恢复")).workItemId!;
    setup.close();

    const runtime = new CollaborationHeadlessRuntime({ dataDirectory, platform: "linux" });
    await runtime.start();

    const revision = expectCompleteCurrentBundle(dataDirectory, workItemId);
    expect(readFileSync(join(bundleRoot(dataDirectory, workItemId), "bundles", revision, "SPEC.md"), "utf8"))
      .toContain("修复启动恢复");
    await runtime.stop();
  });

  it("publishes CURRENT and the four Meta documents after a new inbound Work Item", async () => {
    const dataDirectory = temporaryDirectory();
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory, platform: "linux" });
    await runtime.start();

    const outcome = runtime.ingestDingTalkMessage(message("new-work-item", "新增优先级筛选"));

    expect(outcome).toMatchObject({ accepted: true, duplicate: false, association: "created" });
    const revision = expectCompleteCurrentBundle(dataDirectory, outcome.workItemId!);
    const bundleDirectory = join(bundleRoot(dataDirectory, outcome.workItemId!), "bundles", revision);
    expect(readFileSync(join(bundleDirectory, "SPEC.md"), "utf8")).toContain("新增优先级筛选");
    expect(readFileSync(join(bundleDirectory, "PROGRESS.md"), "utf8")).toContain("工作项状态");
    expect(readFileSync(join(bundleDirectory, "DECISIONS.md"), "utf8")).toContain("审计决策");
    expect(readFileSync(join(bundleDirectory, "VERIFY.md"), "utf8")).toContain("验证证据");
    await runtime.stop();
  });

  it("advances to a new immutable revision after an Owner state change", async () => {
    const dataDirectory = temporaryDirectory();
    const setup = startCollaborationService({ dataDirectory });
    setup.bootstrapOwnerLocally({ senderCorpId: "corp", senderStaffId: "owner", now: 100 });
    const workItemId = setup.ingestDingTalkMessage(message("owner-state-setup")).workItemId!;
    setup.close();
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory, platform: "linux" });
    await runtime.start();
    const firstRevision = expectCompleteCurrentBundle(dataDirectory, workItemId);

    const outcome = runtime.performDingTalkOwnerTextCommand({
      transportEventId: "pause-owner-state",
      transportMessageId: "transport-pause-owner-state",
      command: "pause",
      workItemId,
      sender: {
        senderCorpId: "corp",
        senderStaffId: "owner",
        senderId: "owner-sender",
        displayName: "Owner",
      },
      receivedAt: 2_000,
    });

    expect(outcome).toMatchObject({ allowed: true, reason: "owner_action_applied" });
    const secondRevision = expectCompleteCurrentBundle(dataDirectory, workItemId);
    expect(secondRevision).not.toBe(firstRevision);
    expect(existsSync(join(bundleRoot(dataDirectory, workItemId), "bundles", firstRevision))).toBe(true);
    expect(readFileSync(join(bundleRoot(dataDirectory, workItemId), "bundles", secondRevision, "PROGRESS.md"), "utf8"))
      .toContain("paused");
    await runtime.stop();
  });

  it("does not block messages or Ledger state when projection is broken and stops drain retries after three failures", async () => {
    const dataDirectory = temporaryDirectory();
    const events: RuntimeLogEvent[] = [];
    const logger = { write: vi.fn((event: RuntimeLogEvent) => events.push(event)) };
    const runtime = new CollaborationHeadlessRuntime({ dataDirectory, platform: "linux", logger });
    await runtime.start();
    const metaBundles = join(dataDirectory, "collaboration", "meta-bundles");
    writeFileSync(metaBundles, "blocks bundle directory creation");

    const created = runtime.ingestDingTalkMessage(message("projection-broken", "消息仍应成功", 2_000));
    expect(created).toMatchObject({ accepted: true, duplicate: false, association: "created" });
    const workItemId = created.workItemId!;
    const database = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
    expect(database.prepare("SELECT title,version FROM collaboration_work_items WHERE id = ?").get(workItemId)).toEqual({
      title: "消息仍应成功",
      version: 1,
    });
    database.close();

    await runtime.drainOnce();
    await runtime.drainOnce();
    expect(events.filter((event) => event.event === "collaboration.meta_bundle.sync_failed")).toEqual([
      expect.objectContaining({ code: "retry_scheduled", workItemId }),
      expect.objectContaining({ code: "retry_limit_reached", workItemId }),
    ]);

    rmSync(metaBundles, { force: true });
    mkdirSync(metaBundles, { mode: 0o700 });
    await runtime.drainOnce();
    expect(existsSync(bundleRoot(dataDirectory, workItemId))).toBe(false);

    const contribution = runtime.ingestDingTalkMessage(
      message("projection-recovered", `${workItemId} 补充验收说明`, 3_000),
    );
    expect(contribution).toMatchObject({ accepted: true, duplicate: false, association: "associated", workItemId });
    expectCompleteCurrentBundle(dataDirectory, workItemId);
    await runtime.stop();
  });
});
