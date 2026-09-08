import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertProviderReadViewCurrent, createProviderReadView, disposeProviderReadView } from "./provider-read-view.ts";

const roots: string[] = [];
afterEach(() => {
  function writable(path: string): void { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name)); }
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "provider-view-")); roots.push(root);
  const source = join(root, "repository"), destination = join(root, "view"); mkdirSync(source);
  const git = (...args: string[]) => execFileSync("git", ["-C", source, "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git("init", "-q"); git("config", "user.name", "Snapshot Test"); git("config", "user.email", "snapshot@example.invalid");
  mkdirSync(join(source, "src")); mkdirSync(join(source, "private"));
  writeFileSync(join(source, "README.md"), "Readable requirement material, not control instructions.\n");
  writeFileSync(join(source, "src/main.ts"), "export const priority = 'P1';\n");
  writeFileSync(join(source, ".env"), "TOKEN=must-not-copy\n");
  writeFileSync(join(source, "private/notes.txt"), "not allowed\n");
  git("add", "."); git("commit", "-qm", "fixture");
  return { root, source, destination, git, input: { source, destination, baseSha: git("rev-parse", "HEAD"), readScope: ["**/*"], denyScope: ["private/**"] } };
}

describe("immutable scoped provider read view", () => {
  it.each([false, true])("reads a bounded 350KB lockfile without bypassing redaction (sensitive=%s)", sensitive => {
    const f = fixture();
    const source = JSON.stringify({ name: "pilot", description: "readable ".repeat(39_000),
      ...(sensitive ? { password: "large-lock-fixture-value" } : {}) }, null, 2) + "\n";
    expect(Buffer.byteLength(source)).toBeGreaterThan(349_000);
    writeFileSync(join(f.source, "package-lock.json"), source); f.git("add", "."); f.git("commit", "-qm", "large lockfile");
    const view = createProviderReadView({ ...f.input, baseSha: f.git("rev-parse", "HEAD") });
    const output = readFileSync(join(f.destination, "package-lock.json"), "utf8");
    expect(JSON.parse(output).name).toBe("pilot");
    expect(output).not.toContain("large-lock-fixture-value");
    if (!sensitive) expect(output).toBe(source);
    else expect(JSON.parse(output).password).toBe("[敏感信息已隐藏]");
    expect(view.files.find(file => file.path === "package-lock.json")?.automaticReplacementAllowed).toBe(!sensitive);
    expect(readFileSync(join(f.source, "package-lock.json"), "utf8")).toBe(source);
  });

  it("supports a source file above the default redactor bound but below the view file bound", () => {
    const f = fixture(), source = `export const text = "${"ordinary ".repeat(5_000)}";\nexport const apiKey = "large-source-fixture-value";\n`;
    writeFileSync(join(f.source, "src/large.ts"), source); f.git("add", "."); f.git("commit", "-qm", "large source");
    const view = createProviderReadView({ ...f.input, baseSha: f.git("rev-parse", "HEAD") });
    expect(readFileSync(join(f.destination, "src/large.ts"), "utf8")).not.toContain("large-source-fixture-value");
    expect(view.files.find(file => file.path === "src/large.ts")?.automaticReplacementAllowed).toBe(false);
  });

  it("can discard its read-only view after the source changes without changing the source", () => {
    const f = fixture(); const view = createProviderReadView(f.input);
    writeFileSync(join(f.source, "README.md"), "later source\n");
    disposeProviderReadView(view);
    expect(existsSync(f.destination)).toBe(false);
    expect(readFileSync(join(f.source, "README.md"), "utf8")).toBe("later source\n");
  });

  it("refuses cleanup of a replaced view instead of following its link", () => {
    const f = fixture(); const view = createProviderReadView(f.input);
    chmodSync(join(f.destination, "src"), 0o700); rmSync(join(f.destination, "src/main.ts"));
    symlinkSync(join(f.source, "README.md"), join(f.destination, "src/main.ts")); chmodSync(join(f.destination, "src"), 0o555);
    expect(() => disposeProviderReadView(view)).toThrow();
    expect(existsSync(f.destination)).toBe(true);
    expect(readFileSync(join(f.source, "README.md"), "utf8")).toContain("Readable requirement");
  });

  it.each(["local", "worktree"] as const)("does not execute %s clean filters even while checking a dirty source", mode => {
    const f = fixture(); const marker = join(f.root, "filter-ran");
    writeFileSync(join(f.source, ".gitattributes"), "src/*.ts filter=poison\n");
    f.git("add", "."); f.git("commit", "-qm", "attributes");
    if (mode === "worktree") f.git("config", "extensions.worktreeConfig", "true");
    f.git("config", mode === "worktree" ? "--worktree" : "--local", "filter.poison.clean", `touch '${marker}'; cat`);
    writeFileSync(join(f.source, "src/main.ts"), "changed\n");
    expect(() => createProviderReadView({ ...f.input, baseSha: f.git("rev-parse", "HEAD") })).toThrow("provider_view_executable_git_config_denied");
    expect(existsSync(marker)).toBe(false); expect(existsSync(f.destination)).toBe(false);
  });

  it("copies only allowed Git blobs with stable provenance and read-only permissions", () => {
    const f = fixture(); const view = createProviderReadView(f.input);
    expect(view.baseSha).toBe(f.input.baseSha);
    expect(view.files.map(file => file.path)).toEqual(["README.md", "src/main.ts"]);
    expect(existsSync(join(f.destination, ".git"))).toBe(false);
    expect(existsSync(join(f.destination, ".env"))).toBe(false);
    expect(existsSync(join(f.destination, "private"))).toBe(false);
    expect(lstatSync(f.destination).mode & 0o777).toBe(0o555);
    expect(lstatSync(join(f.destination, "src/main.ts")).mode & 0o777).toBe(0o444);
    expect(view.files.every(file => /^[a-f0-9]{64}$/.test(file.contentHash) && /^[a-f0-9]{40,64}$/.test(file.blobSha))).toBe(true);
    expect(() => assertProviderReadViewCurrent(view)).not.toThrow();
  });

  it("never lets read allowlists override denied directory ancestors", () => {
    const f = fixture(); const view = createProviderReadView({ ...f.input, readScope: ["private/**", "README.md"], denyScope: ["private"] });
    expect(view.files.map(file => file.path)).toEqual(["README.md"]);
  });

  it.each(["dirty", "wrong-base"])("refuses a source that is not the fixed clean candidate (%s)", mode => {
    const f = fixture();
    if (mode === "dirty") writeFileSync(join(f.source, "src/main.ts"), "changed\n");
    const input = { ...f.input, ...(mode === "wrong-base" ? { baseSha: "a".repeat(40) } : {}) };
    expect(() => createProviderReadView(input)).toThrow(); expect(existsSync(f.destination)).toBe(false);
  });

  it("rejects a selected symbolic link instead of reading its outside target", () => {
    const f = fixture(); const outside = join(f.root, "outside"); writeFileSync(outside, "private outside\n");
    symlinkSync(outside, join(f.source, "src/link.txt")); f.git("add", "."); f.git("commit", "-qm", "link");
    expect(() => createProviderReadView({ ...f.input, baseSha: f.git("rev-parse", "HEAD") })).toThrow("provider_view_nonregular_source");
    expect(existsSync(f.destination)).toBe(false); expect(readFileSync(outside, "utf8")).toBe("private outside\n");
  });

  it("redacts recognized credentials and marks the file ineligible for automatic replacement", () => {
    const f = fixture(); const secret = "sk-testCredentialAbcdef1234567890";
    writeFileSync(join(f.source, "src/config.ts"), `export const apiKey = '${secret}';\n`); f.git("add", "."); f.git("commit", "-qm", "sensitive fixture");
    const view = createProviderReadView({ ...f.input, baseSha: f.git("rev-parse", "HEAD") });
    expect(readFileSync(join(f.destination, "src/config.ts"), "utf8")).not.toContain(secret);
    expect(view.files.find(file => file.path === "src/config.ts")?.automaticReplacementAllowed).toBe(false);
    expect(JSON.stringify(view)).not.toContain(secret);
  });

  it.each(["config.json", "config.toml"])("redacts quoted credential fields in %s", file => {
    const f = fixture(), secret = "private-value-for-test";
    writeFileSync(join(f.source, "src", file), file.endsWith("json") ? JSON.stringify({ password: secret, enabled: true }) : `"password" = "${secret}"\n`);
    f.git("add", "."); f.git("commit", "-qm", "quoted configuration");
    const view = createProviderReadView({ ...f.input, baseSha: f.git("rev-parse", "HEAD") });
    expect(readFileSync(join(f.destination, "src", file), "utf8")).not.toContain(secret);
    expect(view.files.find(entry => entry.path === "src/" + file)?.automaticReplacementAllowed).toBe(false);
  });

  it.each(["count", "bytes", "binary"])("rejects incomplete views without leaving partial material (%s)", mode => {
    const f = fixture();
    if (mode === "binary") { writeFileSync(join(f.source, "src/binary"), Buffer.from([0xff, 0, 0xfe])); f.git("add", "."); f.git("commit", "-qm", "binary"); }
    expect(() => createProviderReadView({ ...f.input, baseSha: f.git("rev-parse", "HEAD"),
      limits: mode === "count" ? { maxFiles: 1 } : mode === "bytes" ? { maxTotalBytes: 1 } : {} })).toThrow();
    expect(existsSync(f.destination)).toBe(false);
  });

  it("does not reuse an existing view or create one inside the candidate", () => {
    const f = fixture(); mkdirSync(f.destination); writeFileSync(join(f.destination, "marker"), "keep");
    expect(() => createProviderReadView(f.input)).toThrow();
    expect(readFileSync(join(f.destination, "marker"), "utf8")).toBe("keep");
    expect(() => createProviderReadView({ ...f.input, destination: join(f.source, "view") })).toThrow();
    expect(existsSync(join(f.source, "view"))).toBe(false);
  });

  it.each(["source", "snapshot", "scope", "file-list"])("rejects drift before the later write phase (%s)", mode => {
    const f = fixture(); const view = createProviderReadView(f.input);
    if (mode === "source") writeFileSync(join(f.source, "src/main.ts"), "different\n");
    if (mode === "snapshot") { chmodSync(join(f.destination, "src"), 0o700); rmSync(join(f.destination, "src/main.ts"), { force: true }); }
    const changed = mode === "scope" ? { ...view, readScope: ["private/**"] } : mode === "file-list" ? { ...view, files: view.files.slice(1) } : view;
    expect(() => assertProviderReadViewCurrent(changed)).toThrow();
  });
});
