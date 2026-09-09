import { expect, it } from "vitest";
import { validateTargetCommandSpec, type TargetCommandSpec } from "./quality-gate.ts";

const command: TargetCommandSpec = { argv: ["node", "--test", "tests/base.test.mjs"], timeoutMs: 1000,
  maxOutputBytes: 32000, assertionReporter: "node-test-v1" };
it("accepts bounded trusted discovery roots with exact exclusions", () => {
  expect(() => validateTargetCommandSpec("cases", { ...command,
    nodeTestDiscovery: { directories: ["tests"], excludeFiles: ["tests/rendered-html.test.mjs"] } })).not.toThrow();
});
it.each([
  { directories: [] }, { directories: ["tests", "tests"] }, { directories: ["."] },
  { directories: ["../tests"] }, { directories: ["/tests"] }, { directories: ["tests/**"] },
  { directories: ["tests\\nested"] }, { directories: ["tests/.ssh"] }, { directories: [".git"] },
  { directories: ["tests"], excludeFiles: ["tests/base.test.mjs"] },
  { directories: ["tests"], excludeFiles: ["outside/case.test.mjs"] },
  { directories: ["tests"], excludeFiles: ["tests/*.test.mjs"] },
  { directories: ["tests"], excludeFiles: ["tests/a.test.mjs", "tests/a.test.mjs"] },
  { directories: ["tests"], extra: true },
])("rejects unsafe, unbounded or base-removing discovery policies: %j", nodeTestDiscovery => {
  expect(() => validateTargetCommandSpec("cases", { ...command, nodeTestDiscovery })).toThrow("node_test_discovery_invalid");
});
it("requires the protected node:test reporter for discovery", () => {
  expect(() => validateTargetCommandSpec("cases", { ...command, assertionReporter: undefined,
    nodeTestDiscovery: { directories: ["tests"] } })).toThrow("node_test_discovery_invalid");
});
