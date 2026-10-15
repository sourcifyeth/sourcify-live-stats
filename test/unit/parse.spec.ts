import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLogEntry } from "../../src/pubsub";
import { logEntry } from "../helpers";

const sample = {
  matchId: "56150969",
  address: "0x0d89Cb4f4220B7BECB5A54f9e16De41a615987FC",
  chainId: 8453,
  runtimeMatch: "partial",
  creationMatch: null,
  match: "match",
  timestamp: "2026-10-15T09:57:56.579Z",
};

describe("parseLogEntry", () => {
  it("parses the server log entry", () => {
    const result = parseLogEntry(Buffer.from(logEntry(sample)));
    assert.deepEqual(result, {
      ok: true,
      match: {
        id: 56150969,
        matchId: "56150969",
        chainId: "8453",
        address: "0x0d89Cb4f4220B7BECB5A54f9e16De41a615987FC",
        match: "match",
        verifiedAt: "2026-10-15T09:57:56.579Z",
      },
    });
  });

  it("accepts a numeric matchId and a string chainId", () => {
    const result = parseLogEntry(
      logEntry({ ...sample, matchId: 42, chainId: "1" }),
    );
    assert.ok(result.ok);
    assert.equal(result.match.matchId, "42");
    assert.equal(result.match.id, 42);
    assert.equal(result.match.chainId, "1");
  });

  it("falls back to the entry timestamp", () => {
    const result = parseLogEntry(logEntry({ ...sample, timestamp: undefined }));
    assert.ok(result.ok);
    assert.equal(result.match.verifiedAt, "2026-10-15T09:57:56.580196Z");
  });

  for (const [name, data] of [
    ["invalid JSON", "{not json"],
    ["a JSON array", "[]"],
    ["no jsonPayload", JSON.stringify({ textPayload: "hi" })],
    ["no matchId", logEntry({ ...sample, matchId: undefined })],
    ["a non-numeric matchId", logEntry({ ...sample, matchId: "abc" })],
    ["a negative matchId", logEntry({ ...sample, matchId: -1 })],
    ["no chainId", logEntry({ ...sample, chainId: undefined })],
    ["no address", logEntry({ ...sample, address: undefined })],
  ] as const) {
    it(`rejects ${name}`, () => {
      const result = parseLogEntry(data);
      assert.equal(result.ok, false);
    });
  }
});
