export interface Config {
  port: number;
  /** Short name (`sourcify-staging-live-stats`) or full name (`projects/p/subscriptions/s`). */
  subscription: string;
  projectId: string;
  maxConnections: number;
  logLevel: string;
  /** How often the broadcaster may send one event to every browser. */
  tickMs: number;
  /** How often each SSE connection gets a keep-alive comment. */
  pingMs: number;
}

function intFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const subscription = env.PUBSUB_SUBSCRIPTION;
  if (!subscription) {
    throw new Error("PUBSUB_SUBSCRIPTION is required");
  }
  return {
    port: intFromEnv(env, "PORT", 8080),
    subscription,
    projectId: env.GOOGLE_CLOUD_PROJECT || "sourcify-project",
    maxConnections: intFromEnv(env, "MAX_CONNECTIONS", 1000),
    logLevel: env.LOG_LEVEL || "info",
    tickMs: 500,
    pingMs: 20_000,
  };
}
