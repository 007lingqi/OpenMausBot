import { DatabaseSync } from "node:sqlite";
import { assertCurrentInstanceLease, type InstanceLease } from "../leases.ts";

export type DocumentResourceOwner = Pick<InstanceLease, "ownerId" | "fence">;

export interface DocumentResourceRecord {
  container_name: string;
  image: string;
  docker_context: string;
  source_hash: string;
  container_id: string | null;
  cleanup_acknowledged: number;
  created_at: number;
  instance_owner: string | null;
  instance_fence: number | null;
  recovery_attempts: number;
  recovery_verified_absent: number;
}

/** Ownership evidence only. An unresolved entry is not permission to delete a container. */
export class DocumentResourceJournal {
  private readonly databaseFile: string;
  private readonly dockerContext: string;
  private readonly instance: DocumentResourceOwner | undefined;
  constructor(databaseFile: string, dockerContext: string, instance?: DocumentResourceOwner) {
    if (!dockerContext.trim()) throw new Error("attachment_document_context_required");
    this.databaseFile = databaseFile;
    this.dockerContext = dockerContext;
    if (instance && (!instance.ownerId.trim() || !Number.isSafeInteger(instance.fence) || instance.fence < 1)) throw new Error("attachment_document_owner_invalid");
    this.instance = instance ? { ...instance } : undefined;
  }
  private use<T>(action: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.databaseFile);
    try {
      db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL");
      return action(db);
    } catch { throw new Error("attachment_document_journal_failed"); }
    finally { db.close(); }
  }
  reserve(name: string, image: string, sourceHash: string): void {
    if (!/^omb-document-[a-f0-9-]{36}$/.test(name) || !/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error("attachment_document_journal_invalid");
    this.use(db => db.prepare("INSERT INTO collaboration_document_resources(container_name,image,docker_context,source_hash,created_at,instance_owner,instance_fence) VALUES(?,?,?,?,?,?,?)")
      .run(name, image, this.dockerContext, sourceHash, Date.now(), this.instance?.ownerId ?? null, this.instance?.fence ?? null));
  }
  created(name: string, id: string): void {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("attachment_document_journal_invalid");
    this.use(db => {
      const result = db.prepare("UPDATE collaboration_document_resources SET container_id=? WHERE container_name=? AND docker_context=? AND container_id IS NULL AND cleanup_acknowledged=0")
        .run(id, name, this.dockerContext);
      if (result.changes !== 1) throw new Error();
    });
  }
  cleanupAcknowledged(name: string): void {
    this.use(db => {
      const result = db.prepare("UPDATE collaboration_document_resources SET cleanup_acknowledged=1 WHERE container_name=? AND docker_context=? AND cleanup_acknowledged=0")
        .run(name, this.dockerContext);
      if (result.changes !== 1) throw new Error();
    });
  }
  readUnresolved(): DocumentResourceRecord[] {
    return this.use(db => db.prepare("SELECT * FROM collaboration_document_resources WHERE docker_context=? AND cleanup_acknowledged=0 ORDER BY created_at,container_name LIMIT 100")
      .all(this.dockerContext) as unknown as DocumentResourceRecord[]);
  }
  recoveryCandidates(owner: DocumentResourceOwner, now: number): DocumentResourceRecord[] {
    return this.use(db => {
      assertCurrentInstanceLease(db, owner, now);
      return db.prepare("SELECT * FROM collaboration_document_resources WHERE docker_context=? AND cleanup_acknowledged=0 AND instance_owner IS NOT NULL AND instance_fence<? AND recovery_attempts<3 ORDER BY created_at,container_name LIMIT 20")
        .all(this.dockerContext, owner.fence) as unknown as DocumentResourceRecord[];
    });
  }
  claimRecovery(name: string, owner: DocumentResourceOwner, now: number): boolean {
    return this.use(db => {
      db.exec("BEGIN IMMEDIATE");
      try {
        assertCurrentInstanceLease(db, owner, now);
        const result = db.prepare("UPDATE collaboration_document_resources SET recovery_attempts=recovery_attempts+1 WHERE container_name=? AND docker_context=? AND cleanup_acknowledged=0 AND instance_owner IS NOT NULL AND instance_fence<? AND recovery_attempts<3")
          .run(name, this.dockerContext, owner.fence);
        db.exec("COMMIT"); return result.changes === 1;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    });
  }
  assertRecovering(owner: DocumentResourceOwner, now: number): void {
    this.use(db => assertCurrentInstanceLease(db, owner, now));
  }
  /** Persist a verified discovery only for the unchanged, latest recovery attempt. */
  bindDiscoveredId(row: DocumentResourceRecord, id: string, owner: DocumentResourceOwner, now: number): boolean {
    if (!/^[a-f0-9]{64}$/.test(id) || row.container_id !== null || row.docker_context !== this.dockerContext) return false;
    return this.use(db => {
      db.exec("BEGIN IMMEDIATE");
      try {
        assertCurrentInstanceLease(db, owner, now);
        const result = db.prepare("UPDATE collaboration_document_resources SET container_id=? WHERE container_name=? AND docker_context=? " +
          "AND image=? AND source_hash=? AND instance_owner=? AND instance_fence=? AND instance_fence<? " +
          "AND container_id IS NULL AND cleanup_acknowledged=0 AND recovery_attempts=? AND recovery_attempts BETWEEN 1 AND 3")
          .run(id, row.container_name, this.dockerContext, row.image, row.source_hash, row.instance_owner, row.instance_fence,
            owner.fence, row.recovery_attempts + 1);
        db.exec("COMMIT"); return result.changes === 1;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    });
  }
  recovered(name: string, owner: DocumentResourceOwner, now: number): void {
    this.use(db => {
      db.exec("BEGIN IMMEDIATE");
      try {
        assertCurrentInstanceLease(db, owner, now);
        db.prepare("UPDATE collaboration_document_resources SET cleanup_acknowledged=1,recovery_verified_absent=1 WHERE container_name=? AND docker_context=? AND instance_fence<? AND recovery_attempts>0")
          .run(name, this.dockerContext, owner.fence);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    });
  }
}
