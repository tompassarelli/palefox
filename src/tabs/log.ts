// Debug logging — writes a timestamped event log to <profile>/palefox-debug.log
// when the pfx.debug pref is true. Lines also go to console.log.
//
// The log file accumulates across the session; delete it to start fresh.
// Read it from the profile directory (~/.mozilla/firefox/*.default*/).
//
// Designed so each module can create its own tagged logger:
//
//   import { createLogger } from "./log.ts";
//   const log = createLogger("tabs");
//   log("event-name", { foo: 1 });


/**
 * Tagged log function. Returns a no-op when pfx.debug is false (cheap to call).
 * @param event Short event name; first column in the log line.
 * @param data  Arbitrary object; serialized as JSON onto the same line.
 */
export type Logger = (event: string, data?: Record<string, unknown>) => void;

const LOG_FILENAME = "palefox-debug.log";
// Truncate the log at startup if it exceeds this size. Prevents the file
// from growing unbounded across sessions (which made every append slower
// when we were doing read-then-write, and still wastes disk now).
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

let _logPath: string | null = null;
let _rotateChecked = false;
function logPath(): string {
  if (_logPath) return _logPath;
  _logPath = PathUtils.join(
    Services.dirsvc.get("ProfD", Ci.nsIFile).path,
    LOG_FILENAME,
  );
  return _logPath!;
}
function maybeRotate(): void {
  if (_rotateChecked) return;
  _rotateChecked = true;
  IOUtils.stat(logPath())
    .then((info: { size: number }) => {
      if (info.size > LOG_MAX_BYTES) {
        return IOUtils.write(logPath(), new Uint8Array(0), { mode: "overwrite" });
      }
    })
    .catch(() => {});
}

const _lines: string[] = [];
let _flushPending = false;

function flush(): void {
  const batch = _lines.splice(0);
  if (!batch.length) {
    _flushPending = false;
    return;
  }
  const blob = new TextEncoder().encode(batch.join("\n") + "\n");
  const path = logPath();
  // Append-only write: O(blob) instead of O(file). The previous
  // read-then-write pattern was O(n²) over the session and pegged CPU
  // once the log file grew past a few MB.
  IOUtils.write(path, blob, { mode: "appendOrCreate" })
    .then(() => {
      if (_lines.length) flush();
      else _flushPending = false;
    })
    .catch((e: unknown) => {
      console.error("[PFX:log] write failed", e);
      _flushPending = false;
    });
}

export function createLogger(tag: string): Logger {
  const consolePrefix = `[PFX:${tag}]`;
  return (event, data = {}) => {
    if (!Services.prefs.getBoolPref("pfx.debug", false)) return;
    maybeRotate();
    console.log(consolePrefix, event, data);
    _lines.push(`${Date.now()} [${tag}] ${event} ${JSON.stringify(data)}`);
    if (!_flushPending) {
      _flushPending = true;
      Promise.resolve().then(flush);
    }
  };
}
