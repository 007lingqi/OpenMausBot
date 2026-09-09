import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { WorktreeManager } from "./worktree-manager.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(): { root: string; repo: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), "openmausbot-worktree-manager-"));
  scratch.push(root);
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(root, ["init", "-b", "main", repo]);
  writeFileSync(join(repo, ".gitignore"), ".env*\n");
  writeFileSync(join(repo, "src", "value.txt"), "before\n");
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"]);
  return { root, repo, sha: git(repo, ["rev-parse", "HEAD"]) };
}

describe("managed Git worktrees", () => {
  it("pins the exact revision delta and refuses inherited-test edits or mismatched parent/result blobs", async () => {
    const { root, repo, sha } = fixture(), manager = new WorktreeManager(join(root, "managed"));
    const worktree = await manager.prepare({ repository: repo, workItemId: "WI-EXACT-DELTA", nodeId: "modify", attempt: 2, expectedBaseSha: sha, buildParentSha: sha });
    const parentBlobSha = git(repo, ["rev-parse", `${sha}:src/value.txt`]);
    writeFileSync(join(worktree.path, "src/value.txt"), "seam\n");
    writeFileSync(join(worktree.path, "src/added.txt"), "new test\n");
    const resultBlobSha = git(worktree.path, ["hash-object", "src/value.txt"]);
    const changes = [{ path: "src/value.txt", operation: "modify" as const, parentBlobSha, resultBlobSha },
      { path: "src/added.txt", operation: "add" as const, parentBlobSha: null }];
    await manager.assertRevisionDelta(worktree, changes);
    for (const invalid of [changes.slice(0, 1), [{ ...changes[0], parentBlobSha: "0".repeat(40) }, changes[1]],
      [{ ...changes[0], resultBlobSha: "0".repeat(40) }, changes[1]], [{ ...changes[0], operation: "add" as const, parentBlobSha: null }, changes[1]]]) {
      await expect(manager.assertRevisionDelta(worktree, invalid)).rejects.toThrow(/revision/iu);
    }
    const result = await manager.commitCandidate(worktree, { workItemId: "WI-EXACT-DELTA", planRevision: 1, nodeId: "modify", runId: "run-2" });
    await manager.assertRevisionDelta(worktree, changes, result);
    await expect(manager.assertRevisionDelta(worktree, [{ ...changes[0], resultBlobSha: "0".repeat(40) }, changes[1]], result)).rejects.toThrow(/revision/iu);
  });
  it("builds a revision on the fixed parent while preserving the configured base and original dirty state", async () => {
    const { root, repo, sha } = fixture(), parentTree = join(root, "parent");
    git(repo, ["worktree", "add", "-b", "parent-candidate", parentTree, sha]);
    writeFileSync(join(parentTree, "src/value.txt"), "parent\n");
    git(parentTree, ["add", "."]); git(parentTree, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "parent"]);
    const parentSha = git(parentTree, ["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "src/value.txt"), "owner-local-change\n");
    const manager = new WorktreeManager(join(root, "managed"));
    const worktree = await manager.prepare({ repository: repo, workItemId: "WI-REVISION", nodeId: "modify", attempt: 2, expectedBaseSha: sha, buildParentSha: parentSha });
    expect(worktree.baseSha).toBe(sha); expect(worktree.buildParentSha).toBe(parentSha);
    expect(await manager.currentHead(worktree)).toBe(parentSha);
    expect(readFileSync(join(worktree.path, "src/value.txt"), "utf8")).toBe("parent\n");
    writeFileSync(join(worktree.path, "src/new.txt"), "new\n");
    expect(await manager.changedPaths(worktree)).toEqual(["src/new.txt", "src/value.txt"]);
    const result = await manager.commitCandidate(worktree, { workItemId: "WI-REVISION", planRevision: 1, nodeId: "modify", runId: "run-2" });
    expect(git(worktree.path, ["rev-parse", `${result}^`])).toBe(parentSha);
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(sha);
    await manager.assertOriginalUnchanged(worktree);
    expect(readFileSync(join(repo, "src/value.txt"), "utf8")).toBe("owner-local-change\n");
  });

  it("rejects a non-descendant or shortened build parent without replacing the locked repository base", async () => {
    const { root, repo, sha } = fixture(), foreign = fixture();
    writeFileSync(join(foreign.repo, "src/value.txt"), "unrelated\n");
    git(foreign.repo, ["add", "."]); git(foreign.repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "different"]);
    const orphan = git(foreign.repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", "HEAD^{tree}", "-m", "unrelated-root"]);
    git(repo, ["fetch", foreign.repo, orphan]);
    const unrelated = git(repo, ["rev-parse", "FETCH_HEAD"]), manager = new WorktreeManager(join(root, "managed"));
    for (const [attempt, buildParentSha] of [sha.slice(0, 12), unrelated].entries()) {
      await expect(manager.prepare({ repository: repo, workItemId: "WI-BAD-PARENT", nodeId: "modify", attempt, expectedBaseSha: sha, buildParentSha })).rejects.toThrow(/build parent/iu);
    }
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(sha);
  });
  it("locks a full base SHA and parses unusual NUL-delimited paths", async () => {
    const { root, repo, sha } = fixture();
    const manager = new WorktreeManager(join(root, "managed"));
    const worktree = await manager.prepare({
      repository: repo,
      workItemId: "WI-WEIRD-PATHS",
      nodeId: "modify-code",
      attempt: 1,
      expectedBaseSha: sha,
    });
    expect(worktree.commonGitDir).toBe(realpathSync(join(repo, ".git")));
    const unusual = "src/ leading space\tand\nnewline.txt";
    writeFileSync(join(worktree.path, unusual), "content\n");
    expect(await manager.changedPaths(worktree)).toContain(unusual);
    expect(manager.validateDiff(worktree, await manager.changedPaths(worktree), ["src/**"], [".env*"]).violations).toEqual([]);
    await expect(
      manager.prepare({
        repository: repo,
        workItemId: "WI-WRONG-BASE",
        nodeId: "modify-code",
        attempt: 1,
        expectedBaseSha: sha.slice(0, 12),
      }),
    ).rejects.toThrow("locked base SHA");
  });

  it("checks rename endpoints, ignored secrets and symlinks before commit", async () => {
    const { root, repo } = fixture();
    const manager = new WorktreeManager(join(root, "managed"));
    const worktree = await manager.prepare({ repository: repo, workItemId: "WI-BOUNDARY", nodeId: "modify-code", attempt: 1 });
    mkdirSync(join(worktree.path, "docs"));
    renameSync(join(worktree.path, "src", "value.txt"), join(worktree.path, "docs", "renamed.txt"));
    writeFileSync(join(worktree.path, ".env.local"), "secret\n");
    const external = join(root, "external.txt");
    writeFileSync(external, "external\n");
    symlinkSync(external, join(worktree.path, "src", "link.txt"));
    const paths = await manager.changedPaths(worktree);
    expect(paths).toEqual(expect.arrayContaining(["src/value.txt", "docs/renamed.txt", ".env.local", "src/link.txt"]));
    const result = manager.validateDiff(worktree, paths, ["src/**"], [".env*", "**/.env*"]);
    expect(result.violations.join(" ")).toMatch(/outside_claim/u);
    expect(result.violations.join(" ")).toMatch(/denied_path/u);
    expect(result.violations.join(" ")).toMatch(/symlink_change_not_allowed/u);
  });

  it("rejects executable repository Git configuration", async () => {
    const { root, repo } = fixture();
    git(repo, ["config", "core.hooksPath", ".hooks"]);
    const manager = new WorktreeManager(join(root, "managed"));
    await expect(
      manager.prepare({ repository: repo, workItemId: "WI-HOOK", nodeId: "modify-code", attempt: 1 }),
    ).rejects.toThrow("executable Git configuration");
  });
});
