import { PubSub } from "@google-cloud/pubsub";
import type { Message, Subscription } from "@google-cloud/pubsub";
import type { Logger } from "./logger";
import type { NewMatch } from "./types";

export type ParseResult =
  { ok: true; match: NewMatch } | { ok: false; reason: string };

const DIGITS = /^\d+$/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Accepts a positive integer as a number or a string of digits. */
function asIdString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "string" && DIGITS.test(value)) {
    return value;
  }
  return undefined;
}

/**
 * Parses one Pub/Sub message body. The body is a Cloud Logging LogEntry
 * (JSON) that the server wrote after it stored a new match.
 */
export function parseLogEntry(data: Buffer | string): ParseResult {
  let entry: Record<string, unknown> | undefined;
  try {
    entry = asRecord(JSON.parse(data.toString()));
  } catch {
    return { ok: false, reason: "body is not valid JSON" };
  }
  if (!entry) return { ok: false, reason: "body is not a JSON object" };

  const payload = asRecord(entry.jsonPayload);
  if (!payload) return { ok: false, reason: "missing jsonPayload" };

  const matchId = asIdString(payload.matchId);
  if (!matchId) return { ok: false, reason: "missing or invalid matchId" };
  const id = Number(matchId);
  if (!Number.isSafeInteger(id)) {
    return { ok: false, reason: "matchId is too large" };
  }

  const chainId = asIdString(payload.chainId);
  if (!chainId) return { ok: false, reason: "missing or invalid chainId" };

  const address = payload.address;
  if (typeof address !== "string" || address === "") {
    return { ok: false, reason: "missing or invalid address" };
  }

  const match = typeof payload.match === "string" ? payload.match : null;
  const verifiedAt =
    typeof payload.timestamp === "string"
      ? payload.timestamp
      : typeof entry.timestamp === "string"
        ? entry.timestamp
        : null;

  return {
    ok: true,
    match: { id, matchId, chainId, address, match, verifiedAt },
  };
}

export interface SubscriberOptions {
  projectId: string;
  subscription: string;
  logger: Logger;
  onMatch: (match: NewMatch) => void;
  /** Delay before the subscriber re-opens a stream that closed with an error. */
  reopenDelayMs?: number;
}

export interface Subscriber {
  close(): Promise<void>;
}

/** Opens a streaming pull on the subscription and calls `onMatch` per match. */
export function startSubscriber(options: SubscriberOptions): Subscriber {
  const { projectId, logger, onMatch } = options;
  const reopenDelayMs = options.reopenDelayMs ?? 5000;
  const pubsub = new PubSub({ projectId });
  // `subscription()` accepts both the short name and the full resource name.
  const subscription: Subscription = pubsub.subscription(options.subscription, {
    flowControl: { maxMessages: 1000 },
  });
  let closing = false;
  let reopenTimer: NodeJS.Timeout | undefined;

  subscription.on("message", (message: Message) => {
    // Ack at once. A lost message only costs one feed item; the next
    // message corrects the total.
    message.ack();
    const result = parseLogEntry(message.data);
    if (!result.ok) {
      logger.warn("Skipped Pub/Sub message", {
        reason: result.reason,
        messageId: message.id,
      });
      return;
    }
    logger.debug("Received match", {
      matchId: result.match.matchId,
      chainId: result.match.chainId,
    });
    onMatch(result.match);
  });

  subscription.on("error", (error: Error) => {
    logger.error("Pub/Sub subscription error", { error });
    if (closing || reopenTimer) return;
    reopenTimer = setTimeout(() => {
      reopenTimer = undefined;
      if (!closing && !subscription.isOpen) {
        logger.info("Re-opening Pub/Sub subscription");
        subscription.open();
      }
    }, reopenDelayMs);
  });

  logger.info("Listening to Pub/Sub subscription", {
    subscription: subscription.name,
  });

  return {
    async close() {
      closing = true;
      if (reopenTimer) clearTimeout(reopenTimer);
      await subscription.close();
      await pubsub.close();
    },
  };
}
