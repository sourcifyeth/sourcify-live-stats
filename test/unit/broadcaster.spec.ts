import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { SseClient } from "../../src/broadcaster";
import { Broadcaster, formatEvent } from "../../src/broadcaster";
import logger from "../../src/logger";
import { LiveState } from "../../src/state";
import { newMatch } from "../helpers";

class FakeClient implements SseClient {
  chunks: string[] = [];
  ended = false;
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(): void {
    this.ended = true;
  }
  get events(): { id: number; data: { total: number; items: unknown[] } }[] {
    return this.chunks
      .filter((c) => c.startsWith("id: "))
      .map((c) => {
        const [idLine, dataLine] = c.split("\n");
        return {
          id: Number(idLine.slice(4)),
          data: JSON.parse(dataLine.slice(6)),
        };
      });
  }
}

describe("formatEvent", () => {
  it("writes an SSE event with the total as id", () => {
    assert.equal(formatEvent(5, []), 'id: 5\ndata: {"total":5,"items":[]}\n\n');
  });
});

describe("Broadcaster", () => {
  let state: LiveState;
  let broadcaster: Broadcaster;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setInterval"] });
    state = new LiveState();
    broadcaster = new Broadcaster(state, logger, {
      tickMs: 500,
      pingMs: 20_000,
    });
    broadcaster.start();
  });

  afterEach(() => {
    broadcaster.stop();
    mock.timers.reset();
  });

  it("sends at most one event per tick during a burst, with the exact total", () => {
    const client = new FakeClient();
    broadcaster.addClient(client);

    // A burst of 133 matches in one second, out of order.
    const ids = Array.from({ length: 133 }, (_, i) => 1000 + i).reverse();
    ids.slice(0, 66).forEach((id) => state.add(newMatch(id)));
    mock.timers.tick(500);
    ids.slice(66).forEach((id) => state.add(newMatch(id)));
    mock.timers.tick(500);

    const events = client.events;
    assert.equal(events.length, 2);
    for (const event of events) assert.equal(event.data.items.length, 1);
    assert.equal(events[1].data.total, 1132);
    assert.equal(events[1].id, 1132);
  });

  it("sends nothing when no new match arrived", () => {
    const client = new FakeClient();
    broadcaster.addClient(client);
    mock.timers.tick(5000);
    assert.equal(client.chunks.length, 0);
  });

  it("sends a ping comment every 20 seconds", () => {
    const client = new FakeClient();
    broadcaster.addClient(client);
    mock.timers.tick(40_000);
    assert.deepEqual(client.chunks, [": ping\n\n", ": ping\n\n"]);
  });

  it("stops sending to a removed client", () => {
    const client = new FakeClient();
    const remove = broadcaster.addClient(client);
    remove();
    state.add(newMatch(1));
    mock.timers.tick(500);
    assert.equal(client.chunks.length, 0);
    assert.equal(broadcaster.connections, 0);
  });

  it("sends a snapshot of the recent items only when the total is known", () => {
    const client = new FakeClient();
    broadcaster.sendSnapshot(client);
    assert.equal(client.chunks.length, 0);

    state.add(newMatch(1, "1"));
    mock.timers.tick(500);
    state.add(newMatch(2, "10"));
    mock.timers.tick(500);
    broadcaster.sendSnapshot(client);
    assert.equal(client.events.length, 1);
    assert.equal(client.events[0].data.total, 2);
    assert.equal(client.events[0].data.items.length, 2);
  });

  it("ends all clients on stop", () => {
    const client = new FakeClient();
    broadcaster.addClient(client);
    broadcaster.stop();
    assert.ok(client.ended);
    assert.equal(broadcaster.connections, 0);
  });
});
