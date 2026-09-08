import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { isolatedExecutionEnvironment } from "../execution-limits.ts";
import { redactSensitiveSource } from "../sensitive-source.ts";
import { redactSensitiveText } from "../sensitive-text.ts";
import { matchesPathScope } from "../worktree-manager.ts";

const CAPS = { maxFiles: 512, maxFileBytes: 512 * 1024, maxTotalBytes: 8 * 1024 * 1024 };
type Limits = typeof CAPS;
export interface ProviderReadViewFile {
  path: string;
  blobSha: string;
  contentHash: string;
  bytes: number;
  /** A redacted file must never be blindly replaced with the model's full text. */
  automaticReplacementAllowed: boolean;
}
export interface ProviderReadView {
  version: 1;
  source: string;
  destination: string;
  baseSha: string;
  readScope: string[];
  denyScope: string[];
  limits: Limits;
  files: ProviderReadViewFile[];
  fingerprint: string;
}

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function within(root: string, path: string): boolean {
  const value = relative(root, path);
  return !value || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}
function limits(input: Partial<Limits> = {}): Limits {
  const value = { ...CAPS, ...input };
  if (Object.keys(value).some(key => !(key in CAPS)) || Object.entries(CAPS).some(([key, cap]) => {
    const n = value[key as keyof Limits]; return !Number.isSafeInteger(n) || n < 1 || n > cap;
  })) throw Error("provider_view_limits_invalid");
  return value;
}
function validateScopes(scopes: readonly string[], allowEmpty: boolean): void {
  if (!Array.isArray(scopes) || (!allowEmpty && !scopes.length) || scopes.length > 64 || scopes.some(scope =>
    typeof scope !== "string" || !scope || scope.length > 2000 || /[\x00-\x1f\x7f\\]/u.test(scope) ||
    isAbsolute(scope) || scope.split("/").includes(".."))) throw Error("provider_view_scope_invalid");
}
function git(source: string, args: string[], maxBuffer = 1024 * 1024, input?: Buffer, allowNoMatch = false): Buffer {
  try {
    return execFileSync("git", ["--no-optional-locks", "--literal-pathspecs", "-C", source, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
      env: { ...isolatedExecutionEnvironment(process.env, source), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
      input, maxBuffer, timeout: 10000, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (allowNoMatch && (error as { status?: number }).status === 1) return Buffer.alloc(0);
    throw Error("provider_view_git_unavailable");
  }
}
function assertFixedSource(source: string, baseSha: string): void {
  // status may invoke clean/process filters. Refuse executable repository
  // configuration before touching the worktree/index; never run such filters.
  if (git(source, ["config", "--local", "--includes", "--name-only", "--get-regexp",
    "^(filter\\..*\\.(clean|smudge|process|required)|core\\.(fsmonitor|hooksPath))$"], 64000, undefined, true).length)
    throw Error("provider_view_executable_git_config_denied");
  // Per-worktree configuration is outside --local. Query the effective filter
  // set as well; command-line hooksPath/fsmonitor overrides remain fixed above.
  if (git(source, ["config", "--includes", "--name-only", "--get-regexp",
    "^filter\\..*\\.(clean|smudge|process|required)$"], 64000, undefined, true).length)
    throw Error("provider_view_executable_git_config_denied");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(baseSha) || !lstatSync(source).isDirectory() ||
    realpathSync(git(source, ["rev-parse", "--show-toplevel"]).toString("utf8").trim()) !== source ||
    git(source, ["rev-parse", "--verify", "HEAD^{commit}"]).toString("utf8").trim() !== baseSha ||
    git(source, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).length) throw Error("provider_view_source_not_fixed_clean_candidate");
}

function collect(input: Pick<ProviderReadView, "source" | "baseSha" | "readScope" | "denyScope" | "limits">) {
  validateScopes(input.readScope, false); validateScopes(input.denyScope, true);
  const cap = limits(input.limits);
  assertFixedSource(input.source, input.baseSha);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const tree = decoder.decode(git(input.source, ["ls-tree", "-r", "-z", "--full-tree", input.baseSha]));
  if (!tree.endsWith("\0")) throw Error("provider_view_source_empty_or_incomplete");
  const selected: Array<{ path: string; blobSha: string }> = [];
  for (const row of tree.slice(0, -1).split("\0")) {
    const match = /^([0-9]{6}) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/u.exec(row);
    if (!match) throw Error("provider_view_tree_invalid");
    const path = match[4], segments = path.split("/");
    if (segments.some(part => /^(?:\.git|\.ssh|\.env.*)$/iu.test(part)) ||
      segments.some((_, i) => matchesPathScope(segments.slice(0, i + 1).join("/"), input.denyScope)) ||
      !matchesPathScope(path, input.readScope)) continue;
    if (isAbsolute(path) || /[\x00-\x1f\x7f\\]/u.test(path) || segments.some(part => part === ".." || part === "." || !part) || redactSensitiveText(path) !== path)
      throw Error("provider_view_path_invalid");
    if (!["100644", "100755"].includes(match[1]) || match[2] !== "blob") throw Error("provider_view_nonregular_source");
    selected.push({ path, blobSha: match[3] });
    if (selected.length > cap.maxFiles) throw Error("provider_view_file_limit");
  }
  selected.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!selected.length) throw Error("provider_view_no_allowed_source");
  const raw = git(input.source, ["cat-file", "--batch"], cap.maxTotalBytes + 128 * cap.maxFiles,
    Buffer.from(selected.map(file => file.blobSha).join("\n") + "\n"));
  const files: Array<ProviderReadViewFile & { text: string }> = [];
  let offset = 0, totalSource = 0, totalOutput = 0;
  for (const file of selected) {
    const end = raw.indexOf(10, offset);
    if (end < 0) throw Error("provider_view_blob_incomplete");
    const header = raw.subarray(offset, end).toString("ascii");
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) blob ([0-9]+)$/u.exec(header);
    const size = Number(match?.[2]);
    if (!match || match[1] !== file.blobSha || !Number.isSafeInteger(size) || size < 0 || size > cap.maxFileBytes)
      throw Error("provider_view_blob_invalid_or_large");
    totalSource += size;
    offset = end + 1;
    if (totalSource > cap.maxTotalBytes || offset + size >= raw.length || raw[offset + size] !== 10) throw Error("provider_view_blob_incomplete_or_large");
    const source = decoder.decode(raw.subarray(offset, offset + size)); offset += size + 1;
    if (source.includes("\0")) throw Error("provider_view_binary_source");
    let text: string;
    if (/\.(?:[cm]?[jt]s|[jt]sx)$/iu.test(file.path)) text = source ? redactSensitiveSource(source, file.path, { maxBytes: cap.maxFileBytes }) : source;
    else if (/\.json$/iu.test(file.path)) {
      try {
        JSON.parse(source); // Parse only. No evaluation, imports or object merging.
        const prefix = "const __omb_view_value = (\n", suffix = "\n);";
        text = redactSensitiveSource(prefix + source + suffix, "source.ts", {
          maxBytes: cap.maxFileBytes + Buffer.byteLength(prefix + suffix),
        }).slice(prefix.length, -suffix.length);
        JSON.parse(text);
      } catch { throw Error("provider_view_json_unavailable"); }
    } else {
      // Quoted configuration keys are not caught by plain assignment matching.
      const quoted = source.replace(/(["'])([^"'\r\n]{1,100})\1(\s*[:=]\s*)([^\r\n,;]+)/gu, (match, quote: string, key: string, separator: string) =>
        /(?:password|passwd|secret|credential|token|apikey|密码|密钥|令牌|凭证)/iu.test(key.replace(/[_\s-]/gu, ""))
          ? `${quote}${key}${quote}${separator}"[敏感信息已隐藏]"` : match);
      text = redactSensitiveText(quoted);
    }
    const bytes = Buffer.byteLength(text); totalOutput += bytes;
    if (bytes > cap.maxFileBytes || totalOutput > cap.maxTotalBytes) throw Error("provider_view_output_limit");
    files.push({ ...file, text, bytes, contentHash: hash(text), automaticReplacementAllowed: text === source });
  }
  if (offset !== raw.length) throw Error("provider_view_blob_trailing_data");
  // No mixed candidate if the coordinator/source changed during object reading.
  assertFixedSource(input.source, input.baseSha);
  return files;
}
function fingerprint(view: Omit<ProviderReadView, "fingerprint">): string {
  return hash(JSON.stringify({ version: view.version, source: view.source, destination: view.destination, baseSha: view.baseSha,
    readScope: view.readScope, denyScope: view.denyScope, limits: view.limits, files: view.files }));
}

/** Trusted coordinator only. Raw source stays in Git; only bounded, redacted,
 * scope-filtered text is materialized for a later read-only container mount. */
export function createProviderReadView(input: { source: string; destination: string; baseSha: string;
  readScope: readonly string[]; denyScope: readonly string[]; limits?: Partial<Limits> }): ProviderReadView {
  const source = realpathSync(input.source);
  const destination = join(realpathSync(dirname(resolve(input.destination))), basename(input.destination));
  if (within(source, destination) || within(destination, source)) throw Error("provider_view_destination_overlaps_source");
  const fields = { version: 1 as const, source, destination, baseSha: input.baseSha,
    readScope: [...input.readScope], denyScope: [...input.denyScope], limits: limits(input.limits) };
  const collected = collect(fields); // Validate the complete input before creating a visible view.
  mkdirSync(destination, { mode: 0o700 }); // Exclusive: never replace prior recovery material.
  const directories = new Set<string>([destination]);
  try {
    for (const file of collected) {
      const target = join(destination, file.path);
      let parent = dirname(target);
      while (parent !== destination) { directories.add(parent); parent = dirname(parent); }
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, file.text, { flag: "wx", mode: 0o444 });
      chmodSync(target, 0o444);
    }
    const view = { ...fields, files: collected.map(({ text: _text, ...metadata }) => metadata) };
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) chmodSync(directory, 0o555);
    return { ...view, fingerprint: fingerprint(view) };
  } catch (error) {
    for (const directory of [...directories].sort((a, b) => a.length - b.length)) {
      try { chmodSync(directory, 0o700); } catch { /* Retain any unconfirmed cleanup for the caller. */ }
    }
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

function assertViewMaterial(view: ProviderReadView): void {
  if (view.version !== 1 || fingerprint(view) !== view.fingerprint ||
    realpathSync(view.destination) !== view.destination) throw Error("provider_view_descriptor_changed");
  const expected = new Map(view.files.map(file => [file.path, file]));
  const expectedDirectories = new Set<string>([""]);
  for (const file of view.files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) expectedDirectories.add(parts.slice(0, i).join("/"));
  }
  const seen = new Set<string>();
  function inspect(path: string): void {
    const directory = join(view.destination, path), info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o555 || !expectedDirectories.has(path) ||
      (process.getuid && info.uid !== process.getuid())) throw Error("provider_view_directory_changed");
    for (const name of readdirSync(directory)) {
      const relativePath = path ? `${path}/${name}` : name, target = join(directory, name), stat = lstatSync(target);
      if (stat.isDirectory()) { inspect(relativePath); continue; }
      const file = expected.get(relativePath);
      if (!file || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o444 || stat.size !== file.bytes)
        throw Error("provider_view_file_changed");
      if (hash(readFileSync(target)) !== file.contentHash) throw Error("provider_view_contents_changed");
      seen.add(relativePath);
    }
  }
  inspect("");
  if (seen.size !== expected.size) throw Error("provider_view_incomplete");
}

/** Not authentication: the descriptor belongs to the trusted coordinator and
 * must never be accepted from model output. Revalidate before applying writes. */
export function assertProviderReadViewCurrent(view: ProviderReadView): void {
  assertViewMaterial(view);
  if (realpathSync(view.source) !== view.source) throw Error("provider_view_source_changed");
  const current = collect(view).map(({ text: _text, ...metadata }) => metadata);
  if (JSON.stringify(current) !== JSON.stringify(view.files)) throw Error("provider_view_sources_changed");
}

/** Call only after the owning process/container has been confirmed stopped.
 * A changed candidate does not prevent cleanup, but replaced view material does. */
export function disposeProviderReadView(view: ProviderReadView): void {
  assertViewMaterial(view);
  const directories = new Set<string>([view.destination]);
  for (const file of view.files) {
    let parent = dirname(join(view.destination, file.path));
    while (parent !== view.destination) { directories.add(parent); parent = dirname(parent); }
  }
  for (const directory of [...directories].sort((a, b) => a.length - b.length)) chmodSync(directory, 0o700);
  rmSync(view.destination, { recursive: true });
}
