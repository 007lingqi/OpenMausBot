import { createHash } from "node:crypto";
import { posix } from "node:path";

export function nodeTestAssertionId(file: string, name: string): string {
  if (!file || file.length > 2000 || file.includes("\\") || file.includes("\0") || posix.isAbsolute(file) ||
    posix.normalize(file) !== file || file === ".." || file.startsWith("../") || !name || name.length > 2000) {
    throw new Error("node_test_identity_invalid");
  }
  return `node:${createHash("sha256").update(JSON.stringify({ file, name })).digest("hex")}`;
}

/** Materialized outside the candidate and mounted read-only by the Docker runner. */
export const NODE_TEST_REPORTER_SOURCE = String.raw`
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { relative, isAbsolute, sep } from 'node:path';
export default async function* report(events) {
  const runId = process.env.OMB_ASSERTION_RUN_ID;
  const nonce = process.env.OMB_ASSERTION_NONCE;
  if (!runId || runId.length > 256 || !nonce || nonce.length > 256 || !process.env.OMB_ASSERTION_ROOT) throw new Error('node_test_report_invalid');
  const root = realpathSync(process.env.OMB_ASSERTION_ROOT);
  const assertions = [];
  const seen = new Set();
  let cases = 0;
  for await (const event of events) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const data = event.data;
    if (!data || typeof data.file !== 'string' || typeof data.name !== 'string' || !data.name || data.name.length > 2000) throw new Error('node_test_report_invalid');
    const file = relative(root, realpathSync(data.file)).split(sep).join('/');
    if (!file || file.length > 2000 || isAbsolute(file) || file === '..' || file.startsWith('../') || file.includes('\\')) throw new Error('node_test_report_invalid');
    // Node emits a synthetic file test when a file has no declarations or fails to load.
    const fileWrapper = data.name === data.file || data.name === file;
    if (data.details?.type === 'suite' || fileWrapper) {
      if (event.type === 'test:pass') continue;
    } else { cases++; }
    const id = 'node:' + createHash('sha256').update(JSON.stringify({file, name: data.name})).digest('hex');
    if (seen.has(id) || assertions.length >= 500) throw new Error('node_test_report_invalid');
    seen.add(id);
    assertions.push({id, state: event.type === 'test:fail' ? 'failed' : data.skip || data.todo ? 'skipped' : 'passed'});
  }
  if (!cases) throw new Error('node_test_report_no_cases');
  yield JSON.stringify({version: 1, runId, nonce, assertions});
}
`;

export function validateNodeTestArgv(argv: readonly string[]): void {
  const executable = argv[0]?.split(/[\\/]/u).at(-1);
  if (executable !== "node" && executable !== "node.exe") throw new Error("node_test_reporter_command_invalid");
  if (argv[1] !== "--test" || argv.length < 3 || argv.slice(2).some(file => {
    try { nodeTestAssertionId(file, "validation"); } catch { return true; }
    return file.startsWith("-") || !/\.(?:[cm]?js|ts)$/u.test(file);
  })) throw new Error("node_test_reporter_command_invalid");
}
