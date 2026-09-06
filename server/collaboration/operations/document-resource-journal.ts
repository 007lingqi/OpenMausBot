import { DatabaseSync } from "node:sqlite";

export interface DocumentResourceRecord {
  container_name: string;
  image: string;
  docker_context: string;
  source_hash: string;
  container_id: string | null;
  cleanup_acknowledged: number;
  created_at: number;
}

/** Ownership evidence only. An unresolved entry is not permission to delete a container. */
export class DocumentResourceJournal {
  private readonly databaseFile: string;
  private readonly dockerContext: string;
  constructor(databaseFile: string, dockerContext: string) {
    if (!dockerContext.trim()) throw new Error("attachment_document_context_required");
    this.databaseFile = databaseFile;
    this.dockerContext = dockerContext;
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
    this.use(db => db.prepare("INSERT INTO collaboration_document_resources(container_name,image,docker_context,source_hash,created_at) VALUES(?,?,?,?,?)")
      .run(name, image, this.dockerContext, sourceHash, Date.now()));
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
}
