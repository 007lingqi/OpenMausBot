import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("Docker collaboration deployment", () => {
  it("ships the document relay at the path used by the Docker entrypoint", () => {
    const dockerfile = readFileSync(resolve("packaging/collaboration/docker/Dockerfile"), "utf8");
    const runtimeStage = dockerfile.split("AS runtime")[1];
    expect(runtimeStage).toContain(
      "COPY --from=build /src/dist-server/collaboration/operations/online-document-relay.js /opt/openmausbot/collaboration/operations/online-document-relay.js",
    );
  });

  it("pins the nested Docker client API to the daemon compatibility floor", () => {
    const compose = readFileSync(resolve("packaging/collaboration/docker/compose.yaml"), "utf8");
    expect(compose).toContain('DOCKER_API_VERSION: "1.44"');
  });

  it("does not require an interactive card template for Owner decisions", () => {
    const compose = readFileSync(resolve("packaging/collaboration/docker/compose.yaml"), "utf8");
    expect(compose).toContain(
      "OMB_DINGTALK_PROACTIVE_OPEN_CONVERSATION_ID: ${OMB_DINGTALK_PROACTIVE_OPEN_CONVERSATION_ID:-}",
    );
    expect(compose).toContain("OMB_DINGTALK_CARD_TEMPLATE_ID: ${OMB_DINGTALK_CARD_TEMPLATE_ID:-}");
    expect(compose).not.toContain("OMB_DINGTALK_CARD_TEMPLATE_ID:?required");
  });
});
