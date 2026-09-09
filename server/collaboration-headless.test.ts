import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openCollaborationLedger } from "./collaboration/db.ts";
import { enqueueInboundCard } from "./collaboration/outbox.ts";
import { LocalOwnerRegistry } from "./collaboration/owner.ts";
import {
  parseHeadlessArguments,
  readDingTalkAllowedConversationIds,
  runCollaborationHeadless,
  type HeadlessIo,
} from "./collaboration-headless.ts";
import type { PrivateOwnerAlertSink, SafeOperationalAlert } from "./collaboration/operations/private-alert.ts";
import { CollaborationHeadlessRuntime, type CollaborationHeadlessRuntimeOptions } from "./collaboration/operations/runtime.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "collaboration-headless-"));
  scratch.push(path);
  return path;
}

function io(input = ""): { io: HeadlessIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdin: Readable.from([input]),
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: (value) => stderr.push(value) },
      once() {},
      off() {},
    },
  };
}

function signalIo(): { io: HeadlessIo; signal(name: NodeJS.Signals): void } {
  const listeners = new Map<NodeJS.Signals, () => void>();
  return {
    io: {
      stdin: Readable.from([]),
      stdout: { write() {} },
      stderr: { write() {} },
      once: (signal, listener) => listeners.set(signal, listener),
      off: (signal) => listeners.delete(signal),
    },
    signal: (name) => listeners.get(name)?.(),
  };
}

describe("secure collaboration headless CLI", () => {
  it("parses a dedicated local execution recovery request without enabling Owner identity recovery", () => {
    expect(parseHeadlessArguments(["--authorize-execution-recovery", "/tmp/recovery.json"], {}))
      .toMatchObject({ executionRecoveryFile: "/tmp/recovery.json", recoverOwner: false, healthOnly: false });
  });
  it.each([
    ["--authorize-execution-recovery", "relative.json"],
    ["--authorize-execution-recovery", "/tmp/recovery.json", "--health"],
    ["--authorize-execution-recovery", "/tmp/recovery.json", "--recover-owner", "--expected-generation", "1", "--identity-stdin"],
    ["--authorize-execution-recovery", "/tmp/recovery.json", "--authorize-execution-recovery", "/tmp/other.json"],
  ])("rejects ambiguous execution recovery CLI arguments %j", (...args) => {
    expect(() => parseHeadlessArguments(args, {})).toThrow("execution_recovery_arguments_invalid");
  });
  it.each(["invalid-json", "{}", JSON.stringify({ unexpected: "sensitive-fixture-value" })])(
    "rejects invalid execution recovery data without starting the runtime or disclosing the request", async (raw) => {
      const directory = temporaryDirectory(), request = join(directory, "recovery.json"), output = io();
      writeFileSync(request, raw, { mode: 0o600 });
      let created = false;
      await expect(runCollaborationHeadless(["--data-dir", directory, "--authorize-execution-recovery", request], {}, {
        io: output.io, createRuntime() { created = true; throw new Error("unexpected_runtime_creation"); },
      })).rejects.toThrow("execution_recovery_request_invalid");
      expect(created).toBe(false);
      expect(output.stdout.join("") + output.stderr.join("")).not.toContain(raw);
    },
  );
  it("rejects a public execution recovery file before opening a runtime", async () => {
    const directory = temporaryDirectory(), request = join(directory, "recovery.json");
    writeFileSync(request, "{}", { mode: 0o600 }); chmodSync(request, 0o644);
    await expect(runCollaborationHeadless(["--data-dir", directory, "--authorize-execution-recovery", request], {}, {
      io: io().io, createRuntime() { throw new Error("unexpected_runtime_creation"); },
    })).rejects.toThrow("credential_file_permissions_must_be_0600");
  });
  it("wires explicitly authorized online documents without reading them during a health probe", async () => {
    const directory = temporaryDirectory(), config = join(directory, "online.json");
    writeFileSync(config, JSON.stringify({ version: 1, grants: [{ id: "fixture", profile: "corp:user", conversationId: "group",
      node: "fixture-node", product: "doc" }], transport: { kind: "private_socket", socketPath: "/not-mounted/document.sock" } }), { mode: 0o600 });
    let captured: CollaborationHeadlessRuntimeOptions | undefined;
    await runCollaborationHeadless(["--health", "--data-dir", directory], {
      OMB_DINGTALK_ENABLED: "1", OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "group", OMB_ONLINE_DOCUMENTS_CONFIG_FILE: config,
    }, { io: io().io, createRuntime(options) { captured = options; return new CollaborationHeadlessRuntime({ ...options, dingTalk: undefined }); } });
    expect(captured?.onlineDocuments).toBeDefined();
    expect(captured!.onlineDocuments!.authorizationFingerprint({ conversationId: "group", node: "fixture-node", sourceEventId: "event", normalizedHash: "a".repeat(64) }))
      .toMatch(/^[a-f0-9]{64}$/u);
  });
  it("rejects an online document grant outside the Stream whitelist before creating the runtime", async () => {
    const directory = temporaryDirectory(), config = join(directory, "online.json");
    writeFileSync(config, JSON.stringify({ version: 1, grants: [{ id: "fixture", profile: "corp:user", conversationId: "outside",
      node: "fixture-node", product: "doc" }], transport: { kind: "private_socket", socketPath: "/not-mounted/document.sock" } }), { mode: 0o600 });
    let created = false;
    await expect(runCollaborationHeadless(["--health", "--data-dir", directory], {
      OMB_DINGTALK_ENABLED: "1", OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "group", OMB_ONLINE_DOCUMENTS_CONFIG_FILE: config,
    }, { io: io().io, createRuntime(options) { created = true; return new CollaborationHeadlessRuntime({ ...options, dingTalk: undefined }); } }))
      .rejects.toThrow("online_document_configuration_invalid");
    expect(created).toBe(false);
  });
  it("rejects incomplete document parser configuration before creating the runtime", async () => {
    const directory = temporaryDirectory();
    let created = false;
    await expect(runCollaborationHeadless(["--health", "--data-dir", directory], {
      OMB_DINGTALK_ENABLED: "0", OMB_DOCUMENT_EXTRACTOR_ENABLED: "1",
    }, { io: io().io, createRuntime(options) { created = true; return new CollaborationHeadlessRuntime(options); } }))
      .rejects.toThrow("attachment_document_image_required");
    expect(created).toBe(false);
  });
  it("prints a safe delivery-review summary in health-only mode without consuming the queue or acquiring ownership", async () => {
    const directory = temporaryDirectory();
    const ledger = openCollaborationLedger(join(directory, "collaboration"));
    const database = new DatabaseSync(ledger.filePath);
    try {
      const row = enqueueInboundCard(database, { sourceEventId: "private-message", aggregateType: "work_item", aggregateId: "WI-PRIVATE", aggregateVersion: 1,
        card: { type: "primary_status_card", headline: "已接收", acknowledgement: "private-body", workItemId: "WI-PRIVATE", workItemVersion: 1,
          workItemStatus: "collecting", association: "created" }, now: 1000 });
      database.prepare("UPDATE collaboration_outbox SET delivery_state='dead_letter',last_error='private-error' WHERE id=?").run(row.id);
      const before = database.prepare("SELECT * FROM collaboration_outbox").all();
      const output = io();
      await runCollaborationHeadless(["--health", "--data-dir", directory], { OMB_DINGTALK_ENABLED: "0" }, { io: output.io });
      expect(JSON.parse(output.stdout.join(""))).toMatchObject({ ready: true, delivery: {
        status: "needs_attention", counts: { queued: 0, sending: 0, retrying: 0, needsReview: 1 }, summary: expect.stringContaining("1 条回复需要核查"),
      } });
      for (const value of ["private-message", "private-body", "private-error", "WI-PRIVATE", row.id]) expect(output.stdout.join("")).not.toContain(value);
      expect(database.prepare("SELECT * FROM collaboration_outbox").all()).toEqual(before);
      expect(database.prepare("SELECT owner_id FROM collaboration_instance_lease WHERE singleton=1").get()).toBeUndefined();
      expect(database.prepare("SELECT COUNT(*) AS count FROM collaboration_owner_bindings").get()).toEqual({ count: 0 });
    } finally { database.close(); ledger.close(); }
  });
  it.each(["mjs", "tsx", "jsx"])("preserves trusted %s implementation context and rejects unknown reporter modes", async extension => {
    const root = temporaryDirectory();
    const key = join(root, "key");
    const generation = join(root, "generation");
    writeFileSync(key, Buffer.alloc(32, 1), { mode: 0o600 });
    writeFileSync(generation, "fixture-boot-generation");
    const command = { argv: ["node", "--test", "case.test.mjs"], timeoutMs: 1000, maxOutputBytes: 32000,
      acceptanceSourceFiles: [`src/save.${extension}`],
      nodeTestDiscovery: { directories: ["tests"], excludeFiles: ["tests/rendered-html.test.mjs"] },
      assertionReporter: "node-test-v1", assertionContract: { format: "omb-assertions-v1", bindings: [{ conditionHash: "a".repeat(64), assertionIds: ["case"] }] } };
    const evidencePolicy = { version: 1, policyId: "headless-test", specIdentityHash: "e".repeat(64),
      conditions: [{ conditionHash: "a".repeat(64), requirements: [{ type: "assertions" }] }] };
    const environment = { OMB_DINGTALK_ENABLED: "0", OMB_EXECUTION_ENABLED: "1", OMB_EXECUTION_BACKEND: "docker",
      OMB_EXECUTION_REPOSITORY: root, OMB_EXECUTION_WORKTREE_ROOT: join(root, "worktrees"), OMB_EXECUTION_EXCHANGE_ROOT: join(root, "exchange"),
      OMB_EXECUTION_BASE_SHA: "b".repeat(40), OMB_DOCKER_COMMAND_IMAGE: "fixture:local", OMB_CONTAINMENT_VERIFIER_KEY_FILE: key,
      OMB_HOST_GENERATION_FILE: generation, OMB_EXECUTION_TARGET_COMMANDS_JSON: JSON.stringify({ cases: command }),
      OMB_EXECUTION_WRITE_SCOPES_JSON: '["src/**"]', OMB_EXECUTION_ACCEPTANCE_JSON: '[{"description":"保存成功","observation":"显示已保存"}]',
      OMB_ACCEPTANCE_MAPPING_ENABLED: "1", OMB_ACCEPTANCE_MAPPING_POLICY_REVISION:"fixture-v1",
      OMB_ACCEPTANCE_EVIDENCE_POLICIES_JSON: JSON.stringify([evidencePolicy]),
      ...Object.fromEntries(["PROPOSER","VERIFIER"].flatMap(role => [
        [`OMB_ACCEPTANCE_MAPPING_${role}_MODEL`,"fixture-model"], [`OMB_ACCEPTANCE_MAPPING_${role}_ENDPOINT`,"https://model.example.invalid/responses"],
        [`OMB_ACCEPTANCE_MAPPING_${role}_CREDENTIAL_FILE`,"/not-read-during-probe"],
      ])) };
    const seen: CollaborationHeadlessRuntimeOptions[] = [];
    const dependencies = { io: io().io, createRuntime(options: CollaborationHeadlessRuntimeOptions) {
      seen.push(options);
      return new CollaborationHeadlessRuntime({ dataDirectory: root, probeOnly: true });
    } };
    await runCollaborationHeadless(["--health", "--data-dir", root], environment, dependencies);
    expect(seen[0].execution?.repositories[root].targetCommands.cases).toEqual(command);
    expect(seen[0].acceptanceEvidencePolicies).toEqual([evidencePolicy]);
    expect(seen[0].acceptanceMapping?.policyId).toMatch(/^mapping-v1:/);
    expect(seen[0].acceptanceMapping?.proposer).not.toBe(seen[0].acceptanceMapping?.verifier);
    await expect(runCollaborationHeadless(["--health", "--data-dir", root], { ...environment,
      OMB_CODEX_MODEL: "gpt-6-astra", OMB_CODEX_OPENCODEX_ENDPOINT: "http://remote.invalid/v1/responses",
    }, dependencies)).rejects.toThrow("opencodex_patch_configuration_invalid");
    await expect(runCollaborationHeadless(["--health", "--data-dir", root], { ...environment,
      OMB_EXECUTION_TARGET_COMMANDS_JSON: JSON.stringify({ cases: { ...command, assertionReporter: "arbitrary" } }) }, dependencies)).rejects.toThrow("assertion reporter");
    expect(seen).toHaveLength(1);
    for (const raw of ["{}", JSON.stringify([evidencePolicy, evidencePolicy]), JSON.stringify([{ ...evidencePolicy, skip: true }])]) {
      await expect(runCollaborationHeadless(["--health", "--data-dir", root], { ...environment, OMB_ACCEPTANCE_EVIDENCE_POLICIES_JSON: raw }, dependencies))
        .rejects.toThrow("acceptance_evidence_policies_invalid");
    }
    for (const nodeTestDiscovery of [{ directories: ["../tests"] }, { directories: ["tests"], excludeFiles: ["tests/*.mjs"] }]) {
      await expect(runCollaborationHeadless(["--health", "--data-dir", root], { ...environment,
        OMB_EXECUTION_TARGET_COMMANDS_JSON: JSON.stringify({ cases: { ...command, nodeTestDiscovery } }) }, dependencies))
        .rejects.toThrow("node_test_discovery_invalid");
    }
    for (const acceptanceSourceFiles of ["src/save.mjs", ["../outside.mjs"], ["src/*.mjs"], ["src/save.mjs", "src/save.mjs"]]) {
      await expect(runCollaborationHeadless(["--health", "--data-dir", root], { ...environment,
        OMB_EXECUTION_TARGET_COMMANDS_JSON: JSON.stringify({ cases: { ...command, acceptanceSourceFiles } }) }, dependencies))
        .rejects.toThrow();
    }
    expect(seen).toHaveLength(1);
  });
  it("requires and validates an explicit DingTalk conversation allowlist", () => {
    expect(() => readDingTalkAllowedConversationIds({})).toThrow("dingtalk_allowed_conversation_ids_required");
    expect([...readDingTalkAllowedConversationIds({
      DINGTALK_ROBOT_ALLOWED_CONVERSATION_IDS: '["cid-research-1"]',
    })]).toEqual(["cid-research-1"]);
    expect([...readDingTalkAllowedConversationIds({
      OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "cid-research-1,cid-research-2",
    })]).toEqual(["cid-research-1", "cid-research-2"]);
    expect(() => readDingTalkAllowedConversationIds({
      OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: "cid-research-1",
      DINGTALK_ROBOT_ALLOWED_CONVERSATION_IDS: "cid-other",
    })).toThrow("dingtalk_allowed_conversation_ids_conflict");
  });

  it("prints health and cleanly starts/stops with Stream disabled", async () => {
    const output = io();
    const dataDirectory = temporaryDirectory();
    let receivedOptions: CollaborationHeadlessRuntimeOptions | undefined;
    const health = await runCollaborationHeadless(
      ["--health", "--data-dir", dataDirectory],
      { OMB_DINGTALK_ENABLED: "0" },
      {
        io: output.io,
        createRuntime(options) {
          receivedOptions = options;
          return new CollaborationHeadlessRuntime(options);
        },
      },
    );
    expect(health).toMatchObject({ status: "healthy", ready: true, dingtalk: { state: "disabled" } });
    expect(JSON.parse(output.stdout.join(""))).toMatchObject({ status: "healthy", ready: true });
    expect(receivedOptions).toMatchObject({ probeOnly: true });
    expect(receivedOptions?.outboxDelivery).toBeUndefined();
    const database = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
    expect(database.prepare("SELECT owner_id FROM collaboration_instance_lease WHERE singleton = 1").get()).toBeUndefined();
    database.close();
  });

  it("wires the DingTalk card template into a STREAM-enabled runtime", async () => {
    const output = io();
    const dataDirectory = temporaryDirectory();
    const credentials = join(dataDirectory, "dingtalk.json");
    writeFileSync(credentials, JSON.stringify({ clientId: "app-key", clientSecret: "app-secret" }), { mode: 0o600 });
    chmodSync(credentials, 0o600);
    let receivedOptions: CollaborationHeadlessRuntimeOptions | undefined;
    const health = await runCollaborationHeadless(
      ["--health", "--data-dir", dataDirectory],
      {
        OMB_DINGTALK_ENABLED: "1",
        OMB_DINGTALK_CREDENTIAL_FILE: credentials,
        OMB_DINGTALK_ALLOWED_CONVERSATION_IDS: '["cid-group"]',
        OMB_DINGTALK_PROACTIVE_OPEN_CONVERSATION_ID: "cid-group",
        OMB_DINGTALK_CARD_TEMPLATE_ID: "template-1",
      },
      {
        io: output.io,
        createRuntime(options) {
          receivedOptions = options;
          return new CollaborationHeadlessRuntime({
            ...options,
            dingTalk: {
              ...options.dingTalk!,
              createStream: () => ({
                start: async () => "connected",
                stop() {},
                state: () => "connected",
              }),
            },
          });
        },
      },
    );
    expect(health).toMatchObject({ status: "healthy", ready: true, dingtalk: { state: "configured" } });
    expect(receivedOptions?.dingTalk).toMatchObject({ enabled: true, cardTemplateId: "template-1" });
  });

  it("never accepts Owner corp/staff identity as command-line values", () => {
    expect(() => parseHeadlessArguments(["--recover-owner", "--sender-corp-id", "secret"], {})).toThrow(
      "Unknown argument",
    );
  });

  it("rejects enabling natural interpretation without a trusted planning configuration before any model call", async () => {
    const output = io();
    await expect(runCollaborationHeadless(["--health", "--data-dir", temporaryDirectory()], {
      OMB_DINGTALK_ENABLED: "0", OMB_NATURAL_INTAKE_ENABLED: "1",
      OMB_NATURAL_INTAKE_MODEL: "configured-model", OMB_NATURAL_INTAKE_ENDPOINT: "https://model.example.invalid/v1/responses",
      OMB_NATURAL_INTAKE_CREDENTIAL_FILE: "/nonexistent/credential-reference",
    }, { io: output.io })).rejects.toThrow("natural_intake_requires_planning_configuration");
    expect(output.stdout.join("")).not.toContain("credential-reference");
  });

  it("recovers the sole Owner from an absolute secure reference without echoing identity", async () => {
    const dataDirectory = temporaryDirectory();
    const ledger = openCollaborationLedger(join(dataDirectory, "collaboration"));
    const owner = new LocalOwnerRegistry(ledger.filePath);
    owner.bootstrap({ senderCorpId: "old-corp", senderStaffId: "old-staff", now: 1 });
    owner.close();
    ledger.close();

    const identityFile = join(dataDirectory, "owner-recovery.json");
    writeFileSync(identityFile, JSON.stringify({ senderCorpId: "new-corp", senderStaffId: "new-staff" }), { mode: 0o600 });
    chmodSync(identityFile, 0o600);
    const output = io();
    await runCollaborationHeadless(
      [
        "--recover-owner",
        "--expected-generation",
        "1",
        "--identity-file",
        identityFile,
        "--data-dir",
        dataDirectory,
      ],
      {},
      { io: output.io },
    );
    expect(output.stdout.join(""))
      .toBe(`${JSON.stringify({ status: "owner_recovered", generation: 2 })}\n`);
    expect(output.stdout.join("")).not.toContain("new-corp");
    const reopened = openCollaborationLedger(join(dataDirectory, "collaboration"));
    const registry = new LocalOwnerRegistry(reopened.filePath);
    expect(registry.active()).toMatchObject({ senderCorpId: "new-corp", senderStaffId: "new-staff", generation: 2 });
    registry.close();
    reopened.close();
  });

  it("requires exactly one explicit recovery identity source", () => {
    expect(() => parseHeadlessArguments(["--recover-owner", "--expected-generation", "1"], {})).toThrow(
      "owner_recovery_requires_generation_and_identity_source",
    );
    expect(() =>
      parseHeadlessArguments(
        ["--recover-owner", "--expected-generation", "1", "--identity-stdin", "--identity-file", "/tmp/id"],
        {},
      ),
    ).toThrow("owner_identity_source_must_be_unique");
  });

  it("wires low-disk maintenance to the current Owner private channel without group delivery", async () => {
    const dataDirectory = temporaryDirectory();
    const ledger = openCollaborationLedger(join(dataDirectory, "collaboration"));
    const owner = new LocalOwnerRegistry(ledger.filePath);
    owner.bootstrap({ senderCorpId: "corp", senderStaffId: "owner", now: 1 });
    owner.close();
    ledger.close();

    const lifecycle = signalIo();
    const deliveries: Array<{ target: string; alert: Readonly<SafeOperationalAlert> }> = [];
    let delivered: (() => void) | undefined;
    const privateDelivery = new Promise<void>((resolve) => (delivered = resolve));
    const privateSink: PrivateOwnerAlertSink = {
      async sendPrivate(target, alert) {
        deliveries.push({ target, alert });
        delivered?.();
      },
    };
    let runtime: CollaborationHeadlessRuntime | undefined;
    const running = runCollaborationHeadless(
      ["--data-dir", dataDirectory],
      { OMB_DINGTALK_ENABLED: "0" },
      {
        io: lifecycle.io,
        drainIntervalMs: 1,
        diskCapacity: { capacity: () => ({ availableBytes: 1n, totalBytes: 1_000n }) },
        privateOwnerAlertSink: privateSink,
        createRuntime(options) {
          runtime = new CollaborationHeadlessRuntime(options);
          return runtime;
        },
      },
    );
    await privateDelivery;
    expect(runtime?.health()).toMatchObject({ status: "degraded", ready: false, reason: "low_disk" });
    expect(() =>
      runtime?.ingestDingTalkMessage({
        sourceEventId: "blocked-low-disk",
        transportMessageId: "blocked-low-disk-transport",
        conversationId: "conversation",
        addressedToBot: true,
        text: "must not create new work",
        sender: { senderCorpId: "corp", senderStaffId: "member", senderId: "sender", displayName: "Member" },
        receivedAt: 2,
      }),
    ).toThrow("collaboration_runtime_low_disk");
    expect(deliveries).toEqual([
      { target: "corp:owner", alert: expect.objectContaining({ code: "disk_low" }) },
    ]);
    lifecycle.signal("SIGTERM");
    await running;
    const database = new DatabaseSync(join(dataDirectory, "collaboration", "collaboration.sqlite"));
    expect(database.prepare("SELECT low_disk FROM collaboration_runtime_state WHERE singleton = 1").get()).toEqual({
      low_disk: 1,
    });
    expect(database.prepare("SELECT count(*) AS count FROM collaboration_work_items").get()).toEqual({ count: 0 });
    database.close();
  });
});
