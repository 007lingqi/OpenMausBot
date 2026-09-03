import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DingTalkAttachmentCapabilityVault } from "./attachment-capability-vault.ts";

const REF_A = "a".repeat(64);
const REF_B = "b".repeat(64);
const VAULT_SECRET = "vault-test-secret-with-at-least-thirty-two-bytes";

describe("DingTalk attachment capability vault", () => {
  const scratchDirectories: string[] = [];

  function scratch(): string {
    const directory = mkdtempSync(join(tmpdir(), "omb-dingtalk-capability-vault-"));
    scratchDirectories.push(directory);
    return join(directory, "vault");
  }

  afterEach(() => {
    for (const directory of scratchDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stores only authenticated ciphertext and can recover it after restart", () => {
    const directory = scratch();
    const capability = {
      capabilityRef: REF_A,
      downloadCode: "private-download-authority-value",
      robotCode: "private-robot-authority-value",
    };

    new DingTalkAttachmentCapabilityVault(directory, VAULT_SECRET).store([capability]);

    expect(readdirSync(directory)).toEqual([REF_A]);
    if (process.platform !== "win32") {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(join(directory, REF_A)).mode & 0o777).toBe(0o600);
    }
    const disk = readFileSync(join(directory, REF_A));
    expect(disk.includes(Buffer.from(capability.downloadCode))).toBe(false);
    expect(disk.includes(Buffer.from(capability.robotCode))).toBe(false);
    expect(disk.includes(Buffer.from(VAULT_SECRET))).toBe(false);

    const restarted = new DingTalkAttachmentCapabilityVault(directory, VAULT_SECRET);
    expect(restarted.read(REF_A)).toEqual(capability);
  });

  it("is idempotent for the same value and rejects conflicting authority", () => {
    const directory = scratch();
    const vault = new DingTalkAttachmentCapabilityVault(directory, VAULT_SECRET);
    const capability = { capabilityRef: REF_A, downloadCode: "original-private-authority" };
    vault.store([capability]);
    const firstEnvelope = readFileSync(join(directory, REF_A));

    vault.store([capability]);
    expect(readFileSync(join(directory, REF_A))).toEqual(firstEnvelope);

    const conflicting = { capabilityRef: REF_A, downloadCode: "conflicting-private-authority" };
    let conflict: unknown;
    try {
      vault.store([conflicting]);
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toEqual(new Error("dingtalk_attachment_capability_conflict"));
    expect(String(conflict)).not.toContain(conflicting.downloadCode);
    expect(vault.read(REF_A)).toEqual(capability);
  });

  it("fails closed when ciphertext is tampered with or the secret is wrong", () => {
    const directory = scratch();
    const vault = new DingTalkAttachmentCapabilityVault(directory, VAULT_SECRET);
    vault.store([{ capabilityRef: REF_A, downloadCode: "tamper-resistant-private-authority" }]);

    expect(() => new DingTalkAttachmentCapabilityVault(
      directory,
      "different-high-entropy-vault-secret-over-thirty-two-bytes",
    ).read(REF_A)).toThrowError("dingtalk_attachment_capability_corrupt");

    const envelope = readFileSync(join(directory, REF_A));
    envelope[envelope.length - 1] ^= 1;
    writeFileSync(join(directory, REF_A), envelope, { mode: 0o600 });
    expect(() => vault.read(REF_A)).toThrowError("dingtalk_attachment_capability_corrupt");
  });

  it("rejects unsafe refs and opaque values without exposing them in errors", () => {
    const directory = scratch();
    const vault = new DingTalkAttachmentCapabilityVault(directory, VAULT_SECRET);
    const unsafeValues = [
      { capabilityRef: "../".padEnd(64, "a"), downloadCode: "private-one" },
      { capabilityRef: `a${"b".repeat(62)}\n`, downloadCode: "private-two" },
      { capabilityRef: REF_A, downloadCode: "private value with whitespace" },
      { capabilityRef: REF_A, downloadCode: "private\u0000control" },
      { capabilityRef: REF_A, downloadCode: "private-three", robotCode: "robot\nprivate" },
    ];

    for (const unsafe of unsafeValues) {
      let failure: unknown;
      try {
        vault.store([unsafe]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain(unsafe.downloadCode);
      if (unsafe.robotCode) expect(String(failure)).not.toContain(unsafe.robotCode);
    }
    expect(readdirSync(directory)).toEqual([]);

    const shortSecret = "secret-too-short";
    let secretFailure: unknown;
    try {
      new DingTalkAttachmentCapabilityVault(directory, shortSecret);
    } catch (error) {
      secretFailure = error;
    }
    expect(secretFailure).toEqual(new Error("dingtalk_attachment_capability_vault_secret_invalid"));
    expect(String(secretFailure)).not.toContain(shortSecret);
  });

  it("removes capabilities idempotently without affecting other refs", () => {
    const directory = scratch();
    const vault = new DingTalkAttachmentCapabilityVault(directory, VAULT_SECRET);
    vault.store([
      { capabilityRef: REF_A, downloadCode: "private-a" },
      { capabilityRef: REF_B, downloadCode: "private-b" },
    ]);

    vault.remove(REF_A);
    vault.remove(REF_A);

    expect(existsSync(join(directory, REF_A))).toBe(false);
    expect(vault.read(REF_B)).toEqual({ capabilityRef: REF_B, downloadCode: "private-b" });
    expect(() => vault.read(REF_A)).toThrowError("dingtalk_attachment_capability_not_found");
  });
});
