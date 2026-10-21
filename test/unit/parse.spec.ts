import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLogEntry } from "../../src/pubsub";
import { logEntry } from "../helpers";

const sample = {
  matchId: "56150969",
  address: "0x0d89Cb4f4220B7BECB5A54f9e16De41a615987FC",
  chainId: "8453",
  runtimeMatch: "match",
  creationMatch: null,
  match: "match",
  verifiedAt: "2026-10-15T09:57:56Z",
  name: "MyToken",
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
        verifiedAt: "2026-10-15T09:57:56Z",
        name: "MyToken",
      },
    });
  });

  it("parses a log entry without a name as name null", () => {
    const result = parseLogEntry(logEntry({ ...sample, name: undefined }));
    assert.ok(result.ok);
    assert.equal(result.match.name, null);
  });

  for (const [label, value] of [
    ["an empty string", ""],
    ["a number", 42],
    ["an object", { name: "MyToken" }],
    ["null", null],
  ] as const) {
    it(`ignores a name that is ${label}`, () => {
      const result = parseLogEntry(logEntry({ ...sample, name: value }));
      assert.ok(result.ok);
      assert.equal(result.match.name, null);
    });
  }

  it("accepts a numeric matchId and a numeric chainId", () => {
    const result = parseLogEntry(
      logEntry({ ...sample, matchId: 42, chainId: 1 }),
    );
    assert.ok(result.ok);
    assert.equal(result.match.matchId, "42");
    assert.equal(result.match.id, 42);
    assert.equal(result.match.chainId, "1");
  });

  it("falls back to the log timestamp without verifiedAt", () => {
    const result = parseLogEntry(
      logEntry({ ...sample, verifiedAt: undefined }),
    );
    assert.ok(result.ok);
    assert.equal(result.match.verifiedAt, "2026-10-15T09:57:56.579Z");
  });

  it("falls back to the entry timestamp", () => {
    const result = parseLogEntry(
      logEntry({ ...sample, verifiedAt: undefined, timestamp: undefined }),
    );
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
