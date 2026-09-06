import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const bindingSchema = z.object({
  idempotencyKey: z.string().min(1).max(8192), robotCode: z.string().min(1).max(512),
  openConversationId: z.string().min(1).max(512), payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type GroupReceiptBinding = z.infer<typeof bindingSchema>;
const envelopeSchema = z.object({ binding: bindingSchema, processQueryKey: z.string().min(1).max(4096) }).strict();
const MAGIC = Buffer.from("DTGRV001");
const INFO = Buffer.from("openmausbot/dingtalk/group-receipt/v1");
const fail = (kind: string): Error => new Error(`dingtalk_group_receipt_${kind}`);
export function hasGroupReceipt(directory: string, idempotencyKey: string): boolean {
  if (!idempotencyKey || idempotencyKey.length > 8192) throw fail("binding_invalid");
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw fail("directory_invalid");
    lstatSync(join(directory, createHash("sha256").update(idempotencyKey).digest("hex")));
    return true;
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw fail("unreadable");
  }
}
export function validGroupQueryKey(key: string): boolean {
  return !!key && key.length <= 4096 && key.trim() === key && !/[\u0000-\u001f\u007f]/u.test(key);
}

/** Private immutable query capabilities, never business Ledger data or reply aliases. */
export class DingTalkGroupReceiptVault {
  private readonly secret: Buffer;
  private readonly directory: string;
  constructor(directory: string, secret: string | Uint8Array) {
    this.secret = Buffer.from(secret); this.directory = directory;
    if (this.secret.length < 32) throw fail("secret_invalid");
    this.prepare();
  }
  private prepare(): void {
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const stat = lstatSync(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw fail("directory_invalid");
    } catch { throw fail("directory_invalid"); }
  }
  private identity(binding: GroupReceiptBinding): string {
    if (!bindingSchema.safeParse(binding).success) throw fail("binding_invalid");
    return createHash("sha256").update(binding.idempotencyKey).digest("hex");
  }
  read(binding: GroupReceiptBinding): string | null {
    this.prepare();
    const ref = this.identity(binding);
    let fd: number;
    try { fd = openSync(join(this.directory, ref), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw fail("unreadable");
    }
    let bytes: Buffer;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size <= 52 || stat.size > 32768 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw fail("unreadable");
      bytes = readFileSync(fd);
    } catch { throw fail("unreadable"); } finally { closeSync(fd); }
    let decoded: z.infer<typeof envelopeSchema>;
    try {
      if (!bytes.subarray(0, 8).equals(MAGIC)) throw fail("unreadable");
      const key = Buffer.from(hkdfSync("sha256", this.secret, bytes.subarray(8, 24), INFO, 32));
      const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(24, 36));
      cipher.setAAD(Buffer.from(ref)); cipher.setAuthTag(bytes.subarray(36, 52));
      decoded = envelopeSchema.parse(JSON.parse(Buffer.concat([cipher.update(bytes.subarray(52)), cipher.final()]).toString("utf8")));
      if (!validGroupQueryKey(decoded.processQueryKey)) throw fail("unreadable");
    } catch { throw fail("unreadable"); }
    if (Object.keys(binding).some(key => binding[key as keyof GroupReceiptBinding] !== decoded.binding[key as keyof GroupReceiptBinding])) throw fail("conflict");
    return decoded.processQueryKey;
  }
  store(binding: GroupReceiptBinding, processQueryKey: string): void {
    if (!validGroupQueryKey(processQueryKey)) throw fail("invalid");
    const ref = this.identity(binding);
    const previous = this.read(binding);
    if (previous !== null) { if (previous !== processQueryKey) throw fail("conflict"); return; }
    const salt = randomBytes(16); const iv = randomBytes(12);
    const key = Buffer.from(hkdfSync("sha256", this.secret, salt, INFO, 32));
    const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(Buffer.from(ref));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ binding, processQueryKey })), cipher.final()]);
    const temp = join(this.directory, `.${ref}.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), ciphertext])); fsyncSync(fd);
      closeSync(fd); fd = undefined;
      // Publish a complete envelope without replacing an existing receipt, even across processes.
      try { linkSync(temp, join(this.directory, ref)); }
      catch (error) {
        if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (this.read(binding) !== processQueryKey) throw fail("conflict");
      }
      const directoryFd = openSync(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } catch (error) {
      if (error instanceof Error && error.message === "dingtalk_group_receipt_conflict") throw error;
      throw fail("store_failed");
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch { /* Unpublished encrypted remnants are not receipts. */ }
    }
  }
}
