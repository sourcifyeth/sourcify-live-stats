/** One new match, in the shape that browsers receive. */
export interface MatchItem {
  matchId: string;
  chainId: string;
  address: string;
  match: string | null;
  verifiedAt: string | null;
  /** The contract name, or null when the log line has no name (older server versions). */
  name: string | null;
}

/** A match plus its numeric id, used for ordering. */
export interface NewMatch extends MatchItem {
  id: number;
}

/** The JSON in the `data:` line of each SSE event. */
export interface StreamEvent {
  total: number;
  items: MatchItem[];
}
