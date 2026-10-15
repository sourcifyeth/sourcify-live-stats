import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHAIN_VARIETY_SIZE, LiveState, RECENT_SIZE } from "../../src/state";
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

  it("keeps the last RECENT_SIZE sent items, newest first", () => {
    const state = new LiveState();
    for (let id = 1; id <= RECENT_SIZE + 3; id++) {
      state.add(newMatch(id, String(id)));
      state.takeNext();
    }
    assert.equal(state.recent.length, RECENT_SIZE);
    assert.equal(state.recent[0].matchId, String(RECENT_SIZE + 3));
    assert.equal(state.recent[RECENT_SIZE - 1].matchId, "4");
    assert.ok(!("id" in state.recent[0]));
  });

  it("ignores a duplicate delivery of a match that was already sent", () => {
    const state = new LiveState();
    state.add(newMatch(7));
    state.takeNext();
    state.add(newMatch(7));
    assert.equal(state.takeNext(), null);
  });

  it("prefers a chain again once it left the last CHAIN_VARIETY_SIZE items", () => {
    const state = new LiveState();
    // Chain "1" is sent first, then CHAIN_VARIETY_SIZE items on other chains.
    state.add(newMatch(1, "1"));
    state.takeNext();
    for (let i = 0; i < CHAIN_VARIETY_SIZE; i++) {
      state.add(newMatch(2 + i, String(100 + i)));
      state.takeNext();
    }
    // Chain "1" is out of the variety window, chain "100" is in it.
    state.add(newMatch(50, "1"));
    state.add(newMatch(51, "100"));
    assert.equal(state.takeNext()?.matchId, "50");
  });
});
