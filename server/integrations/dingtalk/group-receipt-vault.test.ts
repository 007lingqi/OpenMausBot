import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync, symlinkSync, unlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DingTalkGroupReceiptVault } from "./group-receipt-vault.ts";
import { FetchDingTalkInteractiveCardSender } from "./interactive-card-sender.ts";

const roots: string[] = [];
const secret = "synthetic-receipt-secret-32-bytes-minimum";
const binding = { idempotencyKey: "outbox-1", robotCode: "app-1", openConversationId: "group-1", payloadHash: "a".repeat(64) };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "group-receipts-")); roots.push(root);
  return { root, vault: new DingTalkGroupReceiptVault(root, secret) };
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("encrypted immutable accepted group receipts", () => {
  it("survives reconstruction without writing query capabilities in plaintext", () => {
    const { root, vault } = fixture();
    expect(vault.read(binding)).toBeNull();
    vault.store(binding, "private-query-key");
    vault.store(binding, "private-query-key");
    expect(new DingTalkGroupReceiptVault(root, secret).read(binding)).toBe("private-query-key");
    const files = readdirSync(root); expect(files).toHaveLength(1);
    const raw = readFileSync(join(root, files[0]));
    expect(statSync(join(root, files[0])).mode & 0o777).toBe(0o600);
    for (const value of ["private-query-key", "app-1", "group-1", "outbox-1", secret]) expect(raw.includes(value)).toBe(false);
  });
  it("rejects symlinked receipt files and directories", () => {
    const { root, vault } = fixture(); vault.store(binding, "original");
    const filename = join(root, readdirSync(root)[0]); const target = join(root, "target");
    copyFileSync(filename, target); unlinkSync(filename); symlinkSync(target, filename);
    expect(() => vault.read(binding)).toThrow("dingtalk_group_receipt_unreadable");
    const link = join(root, "directory-link"); symlinkSync(root, link);
    expect(() => new DingTalkGroupReceiptVault(link, secret)).toThrow("dingtalk_group_receipt_directory_invalid");
  });
  it("does not query or report success if saving an accepted receipt fails", async () => {
    const { root } = fixture(); let queries = 0;
    vi.spyOn(DingTalkGroupReceiptVault.prototype, "store").mockImplementation(() => { throw new Error("private-error-detail"); });
    const sender = new FetchDingTalkInteractiveCardSender({ load: () => ({ clientId: "app-1", clientSecret: secret }) }, async url => {
      if (String(url).endsWith("/accessToken")) return new Response(JSON.stringify({ accessToken: "synthetic-token", expireIn: 7200 }));
      if (String(url).endsWith("/query")) queries++;
      return new Response(JSON.stringify({ processQueryKey: "private-key" }));
    }, Date.now, root);
    const result = await sender.send({ proactiveOpenConversationId: "group-1", idempotencyKey: "outbox-1", payload: { type: "primary_status_card", headline: "已记录", workItemId: "WI-TEST" } });
    expect(result).toMatchObject({ ok: false, deliveryState: "unknown", code: "dingtalk_group_receipt_store_failed" });
    expect(JSON.stringify(result)).not.toContain("private"); expect(queries).toBe(0);
  });
  it("rejects changed destinations, app, payload or replacement receipt", () => {
    const { vault } = fixture(); vault.store(binding, "original");
    for (const change of [{ robotCode: "other" }, { openConversationId: "other" }, { payloadHash: "b".repeat(64) }]) {
      expect(() => vault.read({ ...binding, ...change })).toThrow("dingtalk_group_receipt_conflict");
    }
    expect(() => vault.store(binding, "replacement")).toThrow("dingtalk_group_receipt_conflict");
    expect(vault.read(binding)).toBe("original");
  });
  it("fails closed on wrong key, corrupted data and swapping receipt identities", () => {
    const { root, vault } = fixture(); vault.store(binding, "original");
    expect(() => new DingTalkGroupReceiptVault(root, "different-secret-at-least-32-bytes").read(binding)).toThrow("dingtalk_group_receipt_unreadable");
    const first = readdirSync(root)[0];
    const other = { ...binding, idempotencyKey: "outbox-2" }; vault.store(other, "other");
    const second = readdirSync(root).find(name => name !== first)!;
    copyFileSync(join(root, first), join(root, second));
    expect(() => vault.read(other)).toThrow("dingtalk_group_receipt_unreadable");
    writeFileSync(join(root, first), "bad-envelope");
    expect(() => vault.read(binding)).toThrow("dingtalk_group_receipt_unreadable");
  });
  it("persists before querying and can query the same accepted send after reconstruction", async () => {
    const { root } = fixture(); let sends = 0; let queries = 0; let status = "PROCESSING";
    const input = { proactiveOpenConversationId: "group-1", idempotencyKey: "outbox-1", payload: { type: "primary_status_card", headline: "已记录", workItemId: "WI-TEST" } };
    const fetcher = async (url: string | URL) => {
      if (String(url).endsWith("/accessToken")) return new Response(JSON.stringify({ accessToken: "synthetic-token", expireIn: 7200 }));
      if (String(url).endsWith("/send")) { sends++; return new Response(JSON.stringify({ processQueryKey: "private-key" })); }
      queries++; expect(readdirSync(root)).toHaveLength(1);
      return new Response(JSON.stringify({ sendStatus: status }));
    };
    const build = () => new FetchDingTalkInteractiveCardSender({ load: () => ({ clientId: "app-1", clientSecret: secret }) }, fetcher, Date.now, root);
    expect(await build().queryAccepted(input)).toBeNull(); expect(sends).toBe(0);
    expect(await build().send(input)).toMatchObject({ deliveryState: "unknown" });
    status = "SUCCESS";
    expect(await build().queryAccepted(input)).toMatchObject({ ok: true });
    expect(sends).toBe(1); expect(queries).toBe(2);
    expect(await build().queryAccepted({ ...input, proactiveOpenConversationId: "other" })).toMatchObject({ ok: false, deliveryState: "unknown" });
    expect(sends).toBe(1); expect(queries).toBe(2);
  });
});
