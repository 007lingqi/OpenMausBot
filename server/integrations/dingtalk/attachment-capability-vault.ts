import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import type { DingTalkPrivateResourceCapability } from "./types.ts";

const CAPABILITY_REF = /^[a-f0-9]{64}$/u;
const MAGIC = Buffer.from("DTCAPV01", "ascii");
const KDF_INFO = Buffer.from("openmausbot/dingtalk/attachment-capability/v1", "utf8");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES;
const PRIVATE_CAPABILITY_SCHEMA = z.object({
  capabilityRef: z.string(),
  downloadCode: z.string(),
  robotCode: z.string().optional(),
}).strict();

function vaultError(code: string): Error {
  return new Error(code);
}

function secretBytes(secret: string | Uint8Array): Buffer {
  const bytes = Buffer.from(secret);
  if (bytes.length < 32) throw vaultError("dingtalk_attachment_capability_vault_secret_invalid");
  return bytes;
}

function capabilityPath(directory: string, ref: string): string {
  if (!CAPABILITY_REF.test(ref)) throw vaultError("dingtalk_attachment_capability_ref_invalid");
  return join(directory, ref);
}

function privateOpaque(value: string, field: "download_code" | "robot_code", maximum: number): string {
  if (
    value.length === 0 ||
    value.length > maximum ||
    /\s/u.test(value) ||
    [...value].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 0x1f || point === 0x7f;
    })
  ) {
    throw vaultError(`dingtalk_attachment_capability_${field}_invalid`);
  }
  return value;
}

function validateCapability(capability: DingTalkPrivateResourceCapability): DingTalkPrivateResourceCapability {
  capabilityPath(".", capability.capabilityRef);
  const downloadCode = privateOpaque(capability.downloadCode, "download_code", 2_048);
  const robotCode = capability.robotCode === undefined
    ? undefined
    : privateOpaque(capability.robotCode, "robot_code", 256);
  const validated: DingTalkPrivateResourceCapability = {
    capabilityRef: capability.capabilityRef,
    downloadCode,
  };
  if (robotCode) validated.robotCode = robotCode;
  return validated;
}

function sameCapability(
  left: DingTalkPrivateResourceCapability,
  right: DingTalkPrivateResourceCapability,
): boolean {
  return left.capabilityRef === right.capabilityRef &&
    left.downloadCode === right.downloadCode &&
    left.robotCode === right.robotCode;
}

export class DingTalkAttachmentCapabilityVault {
  private readonly directory: string;
  private readonly masterSecret: Buffer;

  constructor(directory: string, secret: string | Uint8Array) {
    this.directory = directory;
    this.masterSecret = secretBytes(secret);
    this.prepareDirectory();
  }

  store(capabilities: readonly DingTalkPrivateResourceCapability[]): void {
    for (const candidate of capabilities) {
      const capability = validateCapability(candidate);
      const path = capabilityPath(this.directory, capability.capabilityRef);
      try {
        const existing = this.read(capability.capabilityRef);
        if (!sameCapability(existing, capability)) {
          throw vaultError("dingtalk_attachment_capability_conflict");
        }
        continue;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "dingtalk_attachment_capability_not_found") throw error;
      }
      this.writeAtomic(path, capability);
    }
  }

  read(ref: string): DingTalkPrivateResourceCapability {
    const path = capabilityPath(this.directory, ref);
    let envelope: Buffer;
    try {
      envelope = readFileSync(path);
    } catch (error) {
      // SAFETY: Node filesystem failures are Error objects with an optional stable errno code.
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === "ENOENT") {
        throw vaultError("dingtalk_attachment_capability_not_found");
      }
      throw vaultError("dingtalk_attachment_capability_read_failed");
    }
    try {
      if (envelope.length <= HEADER_BYTES || !envelope.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw vaultError("dingtalk_attachment_capability_corrupt");
      }
      let offset = MAGIC.length;
      const salt = envelope.subarray(offset, offset += SALT_BYTES);
      const iv = envelope.subarray(offset, offset += IV_BYTES);
      const tag = envelope.subarray(offset, offset += TAG_BYTES);
      const ciphertext = envelope.subarray(offset);
      const key = Buffer.from(hkdfSync("sha256", this.masterSecret, salt, KDF_INFO, 32));
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(ref, "ascii"));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const decoded: unknown = JSON.parse(plaintext.toString("utf8"));
      const parsed = PRIVATE_CAPABILITY_SCHEMA.safeParse(decoded);
      if (!parsed.success) throw vaultError("dingtalk_attachment_capability_corrupt");
      const capability = validateCapability(parsed.data);
      if (capability.capabilityRef !== ref) throw vaultError("dingtalk_attachment_capability_corrupt");
      return capability;
    } catch {
      throw vaultError("dingtalk_attachment_capability_corrupt");
    }
  }

  remove(ref: string): void {
    const path = capabilityPath(this.directory, ref);
    try {
      unlinkSync(path);
    } catch (error) {
      // SAFETY: Node filesystem failures are Error objects with an optional stable errno code.
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== "ENOENT") {
        throw vaultError("dingtalk_attachment_capability_remove_failed");
      }
    }
  }

  private prepareDirectory(): void {
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const stat = lstatSync(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw vaultError("dingtalk_attachment_capability_vault_directory_invalid");
      }
      chmodSync(this.directory, 0o700);
    } catch {
      throw vaultError("dingtalk_attachment_capability_vault_directory_invalid");
    }
  }

  private writeAtomic(path: string, capability: DingTalkPrivateResourceCapability): void {
    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const key = Buffer.from(hkdfSync("sha256", this.masterSecret, salt, KDF_INFO, 32));
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(capability.capabilityRef, "ascii"));
    const plaintext = Buffer.from(JSON.stringify(capability), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope = Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), ciphertext]);
    const temporaryPath = join(this.directory, `.${capability.capabilityRef}.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, envelope);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, path);
    } catch {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // Best-effort cleanup without exposing filesystem details.
        }
      }
      rmSync(temporaryPath, { force: true });
      throw vaultError("dingtalk_attachment_capability_store_failed");
    }
  }
}
