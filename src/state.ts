import type { MatchItem, NewMatch } from "./types";

/** How many sent matches the service keeps. A new browser gets all of them. */
export const RECENT_SIZE = 30;
/** takeNext prefers a chain that is not among this many newest sent matches. */
export const CHAIN_VARIETY_SIZE = 5;

function toItem(match: NewMatch): MatchItem {
  return {
    matchId: match.matchId,
    chainId: match.chainId,
    address: match.address,
    match: match.match,
    verifiedAt: match.verifiedAt,
  };
}

/** The in-memory state of the service. Nothing is persisted. */
export class LiveState {
  /** The highest match id seen. Match ids come from a sequence, so this is the total. */
  newestId: number | null = null;
  lastMessageAt: Date | null = null;
  /** Matches received since the last tick, keyed by matchId to drop duplicates. */
  private buffer = new Map<string, NewMatch>();
  /** The last matches sent to browsers, newest first. */
  private recentMatches: NewMatch[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  add(match: NewMatch): void {
    this.lastMessageAt = this.now();
    // Messages from many server instances arrive out of order, so only move up.
    if (this.newestId === null || match.id > this.newestId) {
      this.newestId = match.id;
    }
    if (this.recentMatches.some((m) => m.matchId === match.matchId)) return;
    this.buffer.set(match.matchId, match);
  }

  get pendingCount(): number {
    return this.buffer.size;
  }

  /** The last sent matches, newest first, in browser shape. */
  get recent(): MatchItem[] {
    return this.recentMatches.map(toItem);
  }

  /**
   * Picks at most one match from the buffer to show, records it in `recent`
   * and clears the buffer. It prefers the newest match on a chain that is not
   * among the last CHAIN_VARIETY_SIZE sent items, so one busy chain does not
   * fill the feed.
   */
  takeNext(): MatchItem | null {
    if (this.buffer.size === 0) return null;
    const candidates = [...this.buffer.values()].sort((a, b) => b.id - a.id);
    this.buffer.clear();

    const recentChains = new Set(
      this.recentMatches.slice(0, CHAIN_VARIETY_SIZE).map((m) => m.chainId),
    );
    const picked =
      candidates.find((m) => !recentChains.has(m.chainId)) ?? candidates[0];

    this.recentMatches.unshift(picked);
    this.recentMatches.length = Math.min(
      this.recentMatches.length,
      RECENT_SIZE,
    );
    return toItem(picked);
  }
}
