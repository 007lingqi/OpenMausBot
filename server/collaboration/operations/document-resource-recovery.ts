import type { DockerCommandPort } from "./docker-containment.ts";
import type { DocumentResourceJournal, DocumentResourceOwner, DocumentResourceRecord } from "./document-resource-journal.ts";

function matchedId(value: unknown, row: DocumentResourceRecord): string | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const container = value[0];
  return typeof container?.Id === "string" && /^[a-f0-9]{64}$/.test(container.Id) &&
    (row.container_id === null || container.Id === row.container_id) && container?.Name === `/${row.container_name}` &&
    container?.Config?.Labels?.["com.openmausbot.document.resource"] === row.container_name &&
    (row.image.startsWith("sha256:") ? container?.Image === row.image : container?.Config?.Image === row.image && /^sha256:[a-f0-9]{64}$/.test(container?.Image ?? ""))
    ? container.Id : null;
}

/** Discover by exact reserved name if needed; reclaim only verified, persisted IDs of old instances. */
export class DocumentResourceRecovery {
  private readonly journal: DocumentResourceJournal;
  private readonly docker: DockerCommandPort;
  constructor(journal: DocumentResourceJournal, docker: DockerCommandPort) { this.journal = journal; this.docker = docker; }
  // assertActive must check the runtime's current clock, not the batch timestamp.
  async run(owner: DocumentResourceOwner, now: number, assertActive: () => void, signal?: AbortSignal): Promise<void> {
    const guard = () => { if (signal?.aborted) throw new Error("attachment_document_inactive"); assertActive(); this.journal.assertRecovering(owner, now); };
    guard();
    for (const row of this.journal.recoveryCandidates(owner, now)) {
      guard();
      if ((row.container_id !== null && !/^[a-f0-9]{64}$/.test(row.container_id)) ||
        !/^omb-document-[a-f0-9-]{36}$/.test(row.container_name) || !this.journal.claimRecovery(row.container_name, owner, now)) continue;
      try {
        const options = { timeoutMs: 10_000, maxOutputBytes: 64 * 1024, signal };
        let id = row.container_id;
        const inspected = await this.docker.run(["inspect", "--type", "container", id ?? row.container_name], options);
        guard();
        if (inspected.exitCode === 0) {
          const discovered = matchedId(JSON.parse(inspected.stdout.toString("utf8")), row);
          if (!discovered) continue;
          if (id === null) {
            if (!this.journal.bindDiscoveredId(row, discovered, owner, now)) continue;
            id = discovered;
          }
          guard();
          const removed = await this.docker.run(["rm", "--force", id], options);
          guard();
          if (removed.exitCode !== 0) continue;
        }
        // A missing name is not proof that a delayed create cannot still appear.
        if (id === null) continue;
        const absent = await this.docker.run(["container", "ls", "--all", "--no-trunc", "--filter", `id=${id}`, "--format", "{{.ID}}"], options);
        guard();
        if (absent.exitCode === 0 && absent.stdout.toString("utf8").trim() === "") this.journal.recovered(row.container_name, owner, now);
      } catch {
        // Docker failures consume the persisted attempt, but losing authority must
        // propagate to the caller even for the last resource in the batch.
        guard();
      }
    }
    guard();
  }
}
