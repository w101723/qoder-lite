/** Prefix service log events with ISO 8601 UTC timestamps. */
export function createTimestampLogger(sink = console, now = () => new Date()) {
  const logger = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    logger[level] = (...args) => {
      const write = typeof sink[level] === "function" ? sink[level] : sink.log;
      if (typeof write !== "function") return;
      const at = now();
      const iso = (at instanceof Date ? at : new Date(at)).toISOString();
      write.call(sink, `[${iso}]`, ...args);
    };
  }
  return logger;
}
