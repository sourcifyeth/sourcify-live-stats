import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Broadcaster } from "../../src/broadcaster";
import { createApp } from "../../src/http";
import logger from "../../src/logger";
import { LiveState } from "../../src/state";
import { newMatch } from "../helpers";

interface OpenStream {
  res: http.IncomingMessage;
  /** Resolves when the received text contains `text`. */
  waitFor(text: string): Promise<string>;
  close(): void;
}

function openStream(port: number): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { port, path: "/live/stream", host: "127.0.0.1" },
      (res) => {
        let body = "";
        const waiters: { text: string; done: (b: string) => void }[] = [];
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          for (const w of [...waiters]) {
            if (body.includes(w.text)) {
              waiters.splice(waiters.indexOf(w), 1);
              w.done(body);
            }
          }
        });
        resolve({
          res,
          waitFor: (text) =>
            body.includes(text)
              ? Promise.resolve(body)
              : new Promise((done) => waiters.push({ text, done })),
          close: () => req.destroy(),
        });
      },
    );
    req.on("error", reject);
  });
}

function getJson(
  port: number,
  path: string,
): Promise<[number, Record<string, unknown>]> {
  return new Promise((resolve, reject) => {
    http
      .get({ port, path, host: "127.0.0.1" }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve([res.statusCode ?? 0, JSON.parse(body)]));
      })
      .on("error", reject);
  });
}

async function waitUntil(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(check(), "condition not met in time");
}

describe("HTTP endpoints", () => {
  const state = new LiveState();
  const broadcaster = new Broadcaster(state, logger, {
    tickMs: 20,
    pingMs: 60_000,
  });
  const app = createApp({ state, broadcaster, maxConnections: 2 });
  let server: http.Server;
  let port: number;

  before(async () => {
    broadcaster.start();
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    broadcaster.stop();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it("reports health before any message", async () => {
    const [status, body] = await getJson(port, "/live/health");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.newestId, null);
    assert.equal(body.lastMessageAt, null);
    assert.equal(body.connections, 0);
    assert.equal(typeof body.uptimeSeconds, "number");
  });

  it("streams events with the right headers, and cleans up on close", async () => {
    const stream = await openStream(port);
    assert.equal(stream.res.statusCode, 200);
    assert.equal(stream.res.headers["content-type"], "text/event-stream");
    assert.equal(stream.res.headers["cache-control"], "no-cache, no-transform");
    assert.equal(stream.res.headers["x-accel-buffering"], "no");
    assert.equal(stream.res.headers["access-control-allow-origin"], "*");
    await stream.waitFor("retry: 5000\n\n");

    state.add(newMatch(41, "8453"));
    const body = await stream.waitFor("id: 41\n");
    assert.match(body, /data: \{"total":41,"items":\[\{"matchId":"41"/);

    stream.close();
    await waitUntil(() => broadcaster.connections === 0);
  });

  it("sends the snapshot to a new client when the total is known", async () => {
    const stream = await openStream(port);
    const body = await stream.waitFor("id: 41\n");
    assert.ok(body.startsWith("retry: 5000\n\nid: 41\n"));
    stream.close();
    await waitUntil(() => broadcaster.connections === 0);
  });

  it("answers 503 when MAX_CONNECTIONS is reached", async () => {
    const a = await openStream(port);
    const b = await openStream(port);
    await waitUntil(() => broadcaster.connections === 2);
    const [status] = await getJson(port, "/live/stream");
    assert.equal(status, 503);
    const [, health] = await getJson(port, "/live/health");
    assert.equal(health.connections, 2);
    assert.equal(health.newestId, 41);
    a.close();
    b.close();
    await waitUntil(() => broadcaster.connections === 0);
  });
});
