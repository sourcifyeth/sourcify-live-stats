import type { Logger } from "./logger";
import type { LiveState } from "./state";
import type { MatchItem, StreamEvent } from "./types";

/** The part of an HTTP response that the broadcaster needs. */
export interface SseClient {
  write(chunk: string): boolean;
  end(): void;
  readonly writableLength?: number;
}

/** Drop a client if this much data waits in its send buffer (a stuck reader). */
const MAX_BUFFERED_BYTES = 1024 * 1024;

export function formatEvent(total: number, items: MatchItem[]): string {
  const data: StreamEvent = { total, items };
  return `id: ${total}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface BroadcasterOptions {
  tickMs: number;
  pingMs: number;
}

/**
 * Sends events to all connected browsers. On each tick it sends at most one
 * event, so a browser gets at most 1000/tickMs events per second, whatever
 * the rate of new matches.
 */
export class Broadcaster {
  private readonly clients = new Set<SseClient>();
  private tickTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;

  constructor(
    private readonly state: LiveState,
    private readonly logger: Logger,
    private readonly options: BroadcasterOptions,
  ) {}

  get connections(): number {
    return this.clients.size;
  }

  start(): void {
    this.tickTimer = setInterval(() => this.tick(), this.options.tickMs);
    this.pingTimer = setInterval(() => this.ping(), this.options.pingMs);
  }

  /** Stops the timers and ends every open stream. */
  stop(): void {
    clearInterval(this.tickTimer);
    clearInterval(this.pingTimer);
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        // The connection is already gone.
      }
    }
    this.clients.clear();
  }

  /** Adds a client. Returns a function that removes it. */
  addClient(client: SseClient): () => void {
    this.clients.add(client);
    return () => {
      this.clients.delete(client);
    };
  }

  /** Sends the current snapshot (total + recent items) to one new client. */
  sendSnapshot(client: SseClient): void {
    if (this.state.newestId === null) return;
    client.write(formatEvent(this.state.newestId, this.state.recent));
  }

  tick(): void {
    const item = this.state.takeNext();
    if (!item || this.state.newestId === null) return;
    this.sendToAll(formatEvent(this.state.newestId, [item]));
  }

  private ping(): void {
    this.sendToAll(": ping\n\n");
  }

  private sendToAll(chunk: string): void {
    for (const client of this.clients) {
      if ((client.writableLength ?? 0) > MAX_BUFFERED_BYTES) {
        this.logger.warn("Dropped slow SSE client");
        this.clients.delete(client);
        client.end();
        continue;
      }
      try {
        client.write(chunk);
      } catch (error) {
        this.logger.debug("Failed to write to SSE client", { error });
        this.clients.delete(client);
      }
    }
  }
}
