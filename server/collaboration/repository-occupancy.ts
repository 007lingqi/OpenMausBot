import { realpathSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export function canonicalRepository(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

export function hasUnsettledExecution(db: DatabaseSync, repository: string): boolean {
  return !!db.prepare("SELECT 1 FROM collaboration_execution_sessions s LEFT JOIN collaboration_execution_settlements f ON f.session_id=s.id WHERE s.repository_path=? AND f.session_id IS NULL LIMIT 1")
    .get(canonicalRepository(repository));
}

export function hasUnsettledVerification(db: DatabaseSync, repository: string): boolean {
  return !!db.prepare("SELECT 1 FROM collaboration_verification_sessions s LEFT JOIN collaboration_verification_settlements f ON f.session_id=s.id WHERE s.repository_path=? AND f.session_id IS NULL LIMIT 1")
    .get(canonicalRepository(repository));
}

export function hasUnsettledRepositoryActivity(db: DatabaseSync, repository: string): boolean {
  return hasUnsettledExecution(db, repository) || hasUnsettledVerification(db, repository);
}
