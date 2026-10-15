import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../../src/config";

describe("loadConfig", () => {
  it("requires PUBSUB_SUBSCRIPTION", () => {
    assert.throws(() => loadConfig({}), /PUBSUB_SUBSCRIPTION/);
  });

  it("applies defaults", () => {
    const config = loadConfig({ PUBSUB_SUBSCRIPTION: "s" });
    assert.equal(config.port, 8080);
    assert.equal(config.projectId, "sourcify-project");
    assert.equal(config.maxConnections, 1000);
  });

  it("rejects a bad MAX_CONNECTIONS", () => {
    assert.throws(
      () => loadConfig({ PUBSUB_SUBSCRIPTION: "s", MAX_CONNECTIONS: "x" }),
      /MAX_CONNECTIONS/,
    );
  });
});
