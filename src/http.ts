import express from "express";
import type { Express } from "express";
import type { Broadcaster } from "./broadcaster";
import type { LiveState } from "./state";

export interface AppOptions {
  state: LiveState;
  broadcaster: Broadcaster;
  maxConnections: number;
  startedAt?: Date;
}

export function createApp(options: AppOptions): Express {
  const { state, broadcaster, maxConnections } = options;
  const startedAt = options.startedAt ?? new Date();
  const app = express();
  app.disable("x-powered-by");

  app.get("/live/stream", (req, res) => {
    if (broadcaster.connections >= maxConnections) {
      res.status(503).set("Retry-After", "30").json({
        error: "Too many connections",
      });
      return;
    }

    // res.setHeader (not res.set) so Express does not add "; charset=utf-8".
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    // Public read-only data. This also lets local UI dev use staging.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.flushHeaders();
    res.write("retry: 5000\n\n");
    broadcaster.sendSnapshot(res);

    const remove = broadcaster.addClient(res);
    req.on("close", remove);
  });

  app.get("/live/health", (_req, res) => {
    res.status(200).json({
      ok: true,
      newestId: state.newestId,
      lastMessageAt: state.lastMessageAt?.toISOString() ?? null,
      connections: broadcaster.connections,
      uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
    });
  });

  return app;
}
