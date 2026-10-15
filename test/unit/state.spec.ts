import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LiveState, RECENT_SIZE } from "../../src/state";
import { newMatch } from "../helpers";

describe("LiveState", () => {
  it("starts with an unknown total", () => {
    const state = new LiveState();
    assert.equal(state.newestId, null);
    assert.equal(state.takeNext(), null);
  });

  it("only moves newestId up when messages arrive out of order", () => {
    const state = new LiveState();
    for (const id of [10, 12, 11, 5, 12, 13, 1]) state.add(newMatch(id));
    assert.equal(state.newestId, 13);
  });

  it("sets lastMessageAt", () => {
    const now = new Date("2026-10-15T10:00:00Z");
    const state = new LiveState(() => now);
    state.add(newMatch(1));
    assert.equal(state.lastMessageAt, now);
  });

  it("takes at most one item per call and clears the buffer", () => {
    const state = new LiveState();
    for (let id = 1; id <= 50; id++) state.add(newMatch(id, "8453"));
    const item = state.takeNext();
    assert.equal(item?.matchId, "50");
    assert.equal(state.pendingCount, 0);
    assert.equal(state.takeNext(), null);
    assert.equal(state.newestId, 50);
  });

  it("prefers a chain that is not among the recent items", () => {
    const state = new LiveState();
    state.add(newMatch(1, "8453"));
    assert.equal(state.takeNext()?.chainId, "8453");

    state.add(newMatch(2, "1"));
    state.add(newMatch(3, "8453"));
    state.add(newMatch(4, "8453"));
    const item = state.takeNext();
    assert.equal(item?.matchId, "2");
    assert.equal(item?.chainId, "1");
  });

  it("falls back to the newest item when all chains were shown recently", () => {
    const state = new LiveState();
    state.add(newMatch(1, "8453"));
    state.takeNext();
    state.add(newMatch(2, "8453"));
    state.add(newMatch(3, "8453"));
    assert.equal(state.takeNext()?.matchId, "3");
  });

  it("keeps the last 5 sent items, newest first", () => {
    const state = new LiveState();
    for (let id = 1; id <= 8; id++) {
      state.add(newMatch(id, String(id)));
      state.takeNext();
    }
    assert.deepEqual(
      state.recent.map((m) => m.matchId),
      ["8", "7", "6", "5", "4"],
    );
    assert.equal(state.recent.length, RECENT_SIZE);
    assert.ok(!("id" in state.recent[0]));
  });

  it("ignores a duplicate delivery of a match that was already sent", () => {
    const state = new LiveState();
    state.add(newMatch(7));
    state.takeNext();
    state.add(newMatch(7));
    assert.equal(state.takeNext(), null);
  });
});
