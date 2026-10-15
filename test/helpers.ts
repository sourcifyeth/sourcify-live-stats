import type { NewMatch } from "../src/types";

export function logEntry(payload: Record<string, unknown>): string {
  return JSON.stringify({
    jsonPayload: {
      message: "Stored to SourcifyDatabase",
      service: "server",
      ...payload,
    },
    resource: {
      type: "cloud_run_revision",
      labels: { service_name: "sourcify-staging-server" },
    },
    timestamp: "2026-10-15T09:57:56.580196Z",
  });
}

export function newMatch(id: number, chainId = "1"): NewMatch {
  return {
    id,
    matchId: String(id),
    chainId,
    address: `0x${id.toString(16).padStart(40, "0")}`,
    match: "exact_match",
    verifiedAt: "2026-10-15T09:57:56.579Z",
    name: "MyToken",
  };
}
