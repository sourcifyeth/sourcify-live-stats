import { createLogger, format, transports } from "winston";

// Cloud Logging reads the `severity` field. Map winston levels to it.
const severityMap: Record<string, string> = {
  error: "ERROR",
  warn: "WARNING",
  info: "INFO",
  http: "DEBUG",
  verbose: "DEBUG",
  debug: "DEBUG",
  silly: "DEBUG",
};

const errorFormatter = format((info) => {
  // Error objects have non-enumerable fields and serialize to "{}".
  if (info.error instanceof Error) {
    info.error = {
      name: info.error.name,
      message: info.error.message,
      stack: info.error.stack,
    };
  }
  return info;
});

const severityFormatter = format((info) => {
  info.severity = severityMap[info.level] ?? "DEFAULT";
  return info;
});

const consoleTransport = new transports.Console({
  level: process.env.LOG_LEVEL || "info",
});

const logger = createLogger({
  format: format.combine(
    errorFormatter(),
    severityFormatter(),
    format.timestamp(),
    format.json(),
  ),
  defaultMeta: { service: "live-stats" },
  transports: [consoleTransport],
});

export function setLogLevel(level: string): void {
  if (!(level in severityMap)) {
    throw new Error(
      `Invalid LOG_LEVEL "${level}". Use one of: ${Object.keys(severityMap).join(", ")}`,
    );
  }
  consoleTransport.level = level;
}

export type Logger = typeof logger;
export default logger;
