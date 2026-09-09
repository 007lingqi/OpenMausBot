// Keep this regression in the repository's discovered scripts/**/*.test.mjs suite.
import { describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseImageContract, pinReleaseImageContract } from "./release-image-contract.ts";

const controller = `sha256:${"6".repeat(64)}`;
const currentProvider = `sha256:${"9".repeat(64)}`;
const oldProvider = `sha256:${"a".repeat(64)}`;
const commandImage = `sha256:${"b".repeat(64)}`;
const expected = { serviceImage: controller, coordinatorImage: controller, providerImage: currentProvider };
function service() {
  return { image: controller, command: ["node", "headless.js"], restart: "unless-stopped",
    environment: { OMB_DOCKER_COORDINATOR_IMAGE: controller, OMB_DOCKER_PROVIDER_IMAGE: currentProvider,
      OMB_DOCKER_COMMAND_IMAGE: commandImage, OMB_EXECUTION_MAX_ATTEMPTS: "3", SECRET: "private-test-sentinel" },
    volumes: ["/private/source:/private/target:ro"], healthcheck: { test: ["CMD", "node", "--version"] } };
}

describe("explicit release image role contract", () => {
  it("rejects the incident's drifted provider even when service and coordinator match", () => {
    const stale = service(); stale.environment.OMB_DOCKER_PROVIDER_IMAGE = oldProvider;
    expect(() => assertReleaseImageContract(stale, expected)).toThrow("release_image_provider_mismatch");
  });

  it("pins exactly the three roles in a deep clone while preserving command images and all other configuration", () => {
    const source = service(); source.environment.OMB_DOCKER_PROVIDER_IMAGE = oldProvider;
    const before = structuredClone(source);
    Object.freeze(source.environment); Object.freeze(source);
    const wanted = { serviceImage: `sha256:${"e".repeat(64)}`, coordinatorImage: `sha256:${"e".repeat(64)}`, providerImage: `sha256:${"f".repeat(64)}` };
    const pinned = pinReleaseImageContract(source, wanted);
    expect(pinned).not.toBe(source);
    expect(pinned).toEqual({ ...before, image: wanted.serviceImage,
      environment: { ...before.environment, OMB_DOCKER_COORDINATOR_IMAGE: wanted.coordinatorImage, OMB_DOCKER_PROVIDER_IMAGE: wanted.providerImage } });
    expect(source).toEqual(before);
    expect(pinned.environment.OMB_DOCKER_COMMAND_IMAGE).toBe(commandImage);
    expect(pinned.command).not.toBe(source.command);
    expect(pinned.healthcheck).not.toBe(source.healthcheck);
    expect(() => assertReleaseImageContract(pinned, wanted)).not.toThrow();
  });

  it("allows an explicitly independent fixed provider image instead of requiring every execution image to match", () => {
    const current = service();
    expect(current.image).not.toBe(current.environment.OMB_DOCKER_PROVIDER_IMAGE);
    expect(current.image).not.toBe(current.environment.OMB_DOCKER_COMMAND_IMAGE);
    expect(() => assertReleaseImageContract(current, expected)).not.toThrow();
  });

  it.each(["service", "coordinator", "provider"])("rejects a missing %s role in assertions and pinning", role => {
    const current = service();
    if (role === "service") delete current.image;
    else delete current.environment[role === "coordinator" ? "OMB_DOCKER_COORDINATOR_IMAGE" : "OMB_DOCKER_PROVIDER_IMAGE"];
    for (const operation of [assertReleaseImageContract, pinReleaseImageContract]) {
      expect(() => operation(current, expected)).toThrow(/^release_image_(service|roles)_invalid$/u);
    }
  });

  it.each(["image:latest", "${OMB_DOCKER_PROVIDER_IMAGE:?required}", "sha256:abc", `sha256:${"F".repeat(64)}`, ` sha256:${"a".repeat(64)}`, null])("rejects non-fixed or malformed provider value %s", value => {
    const current = service(); current.environment.OMB_DOCKER_PROVIDER_IMAGE = value;
    expect(() => assertReleaseImageContract(current, expected)).toThrow("release_image_roles_invalid");
    expect(() => pinReleaseImageContract(current, expected)).toThrow("release_image_roles_invalid");
  });

  it.each(["serviceImage", "coordinatorImage", "providerImage"])("requires an explicit fixed expected %s", role => {
    const missing = { ...expected }; delete missing[role];
    const invalid = { ...expected, [role]: "private-secret=image:latest" };
    for (const wanted of [missing, invalid]) for (const operation of [assertReleaseImageContract, pinReleaseImageContract]) {
      expect(() => operation(service(), wanted)).toThrow("release_image_expected_invalid");
    }
  });

  it("rejects extra or missing expected-role input without accepting implicit provider defaults", () => {
    for (const wanted of [null, {}, { ...expected, commandImage }]) {
      expect(() => assertReleaseImageContract(service(), wanted)).toThrow("release_image_expected_invalid");
    }
  });

  it("requires both expected and actual coordinators to match their service image", () => {
    const wrongExpected = { ...expected, coordinatorImage: oldProvider };
    const wrongActual = service(); wrongActual.environment.OMB_DOCKER_COORDINATOR_IMAGE = oldProvider;
    for (const operation of [assertReleaseImageContract, pinReleaseImageContract]) {
      expect(() => operation(service(), wrongExpected)).toThrow("release_image_coordinator_mismatch");
      expect(() => operation(wrongActual, expected)).toThrow("release_image_coordinator_mismatch");
    }
  });

  it("rejects a coherent but unexpected controller without confusing it with provider drift", () => {
    const wanted = { ...expected, serviceImage: oldProvider, coordinatorImage: oldProvider };
    expect(() => assertReleaseImageContract(service(), wanted)).toThrow("release_image_service_mismatch");
  });

  it.each([null, [], {}, { image: controller }, { image: controller, environment: ["SECRET=private-test-sentinel"] }])("fails closed for malformed service configuration without leaking any configuration", value => {
    for (const operation of [assertReleaseImageContract, pinReleaseImageContract]) {
      let message;
      try { operation(value, expected); } catch (error) { message = error.message; }
      expect(message).toBe("release_image_service_invalid");
      expect(message).not.toMatch(/SECRET|private|sha256|OMB_|environment/u);
    }
  });

  it("bundles as CommonJS and verifies the same role contract outside the repository", () => {
    const directory = mkdtempSync(join(tmpdir(), "release-image-contract-")), bundled = join(directory, "contract.cjs");
    try {
      buildSync({ entryPoints: [fileURLToPath(new URL("./release-image-contract.ts", import.meta.url))], outfile: bundled,
        bundle: true, platform: "node", format: "cjs", target: "node24", logLevel: "silent" });
      const original = service(); original.environment.OMB_DOCKER_PROVIDER_IMAGE = oldProvider;
      const script = `const assert=require('node:assert/strict');const helper=require(process.argv[1]);
        const service=${JSON.stringify(original)},expected=${JSON.stringify(expected)};
        assert.throws(()=>helper.assertReleaseImageContract(service,expected),/release_image_provider_mismatch/);
        const fixed=helper.pinReleaseImageContract(service,expected);helper.assertReleaseImageContract(fixed,expected);
        assert.equal(service.environment.OMB_DOCKER_PROVIDER_IMAGE,${JSON.stringify(oldProvider)});
        assert.equal(fixed.environment.OMB_DOCKER_COMMAND_IMAGE,${JSON.stringify(commandImage)});
        process.stdout.write('release-image-contract-ok');`;
      const result = spawnSync(process.execPath, ["--eval", script, bundled], { cwd: directory, encoding: "utf8", timeout: 5000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("release-image-contract-ok");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
