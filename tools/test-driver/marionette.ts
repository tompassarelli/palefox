// Minimal Marionette TCP client.
//
// Marionette is Firefox's privileged-context remote-control protocol. Wire
// format (from ~/code/firefox/remote/marionette/packets.sys.mjs):
//
//   <utf8-byte-length>:<json-payload>
//
// Where each JSON payload is one of:
//   Command:  [0, msgId, name, params]
//   Response: [1, msgId, error|null, result|null]
//
// Server defaults to TCP port 2828. First packet from server is an info
// banner (`{ applicationType, marionetteProtocol }`) — we read and discard
// it before sending any commands.
//
// We deliberately avoid geckodriver — it adds a wrapper layer for
// WebDriver-protocol consumers but we just need privileged eval.

import { connect, type Socket } from "node:net";

export interface MarionetteOptions {
  host?: string;
  port?: number;
  /** Total time to wait for the Marionette listener to come up after Firefox
   *  spawn. Polls every ~150ms. */
  connectTimeoutMs?: number;
}

export class MarionetteError extends Error {
  constructor(message: string, public readonly remote?: unknown) {
    super(message);
    this.name = "MarionetteError";
  }
}

export interface MarionetteClient {
  /** WebDriver:NewSession — returns the session id. */
  newSession(): Promise<string>;
  /** Marionette:SetContext — "chrome" or "content". Default "content". */
  setContext(context: "chrome" | "content"): Promise<void>;
  /** WebDriver:ExecuteScript — runs `script` in current context, returns
   *  whatever `return` value the script produces (must be JSON-serializable). */
  executeScript<T = unknown>(script: string, args?: readonly unknown[]): Promise<T>;
  /** WebDriver:ExecuteAsyncScript — script gets a callback as its LAST
   *  argument; calling the callback with a value completes the call. Use
   *  this when the script needs to await a Promise. Pattern:
   *    const cb = arguments[arguments.length - 1];
   *    someAsync().then(cb);
   */
  executeAsyncScript<T = unknown>(script: string, args?: readonly unknown[]): Promise<T>;
  /** WebDriver:GetWindowHandle — current chrome window handle (opaque ID). */
  getWindowHandle(): Promise<string>;
  /** WebDriver:GetWindowHandles — all open chrome window handles. */
  getWindowHandles(): Promise<string[]>;
  /** WebDriver:SwitchToWindow — make `handle` the target of executeScript. */
  switchToWindow(handle: string): Promise<void>;
  /** WebDriver:CloseWindow — close current window. Returns remaining handles. */
  closeWindow(): Promise<string[]>;
  /** Marionette:Quit — graceful Firefox shutdown. Used for session-restore
   *  tests that need sessionstore.jsonlz4 to be written. */
  quit(flags?: readonly string[]): Promise<{ cause?: string; in_app?: boolean }>;
  /** WebDriver:PerformActions — execute a WebDriver actions chain (pointer
   *  moves, mouse buttons, key sequences). Useful for headed-mode tests that
   *  need real cursor movement. See https://w3c.github.io/webdriver/#actions. */
  performActions(actions: readonly object[]): Promise<void>;
  /** WebDriver:ReleaseActions — clear all in-flight actions state. */
  releaseActions(): Promise<void>;
  /** WebDriver:DeleteSession — tears down. */
  deleteSession(): Promise<void>;
  /** Close the underlying socket. Call after deleteSession. */
  disconnect(): void;
}

/** Connect to a running Marionette server. Polls until the port accepts a
 *  connection or the timeout elapses. */
export async function connectMarionette(opts: MarionetteOptions = {}): Promise<MarionetteClient> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 2828;
  const deadline = Date.now() + (opts.connectTimeoutMs ?? 30_000);

  let socket: Socket | null = null;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      socket = await openSocket(host, port);
      break;
    } catch (e) {
      lastErr = e;
      await sleep(150);
    }
  }
  if (!socket) {
    throw new MarionetteError(
      `could not connect to Marionette at ${host}:${port} within timeout`,
      lastErr,
    );
  }

  return await initClient(socket);
}

function openSocket(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect({ host, port });
    s.once("connect", () => resolve(s));
    s.once("error", (e) => reject(e));
  });
}

async function initClient(socket: Socket): Promise<MarionetteClient> {
  let nextId = 1;
  const inflight = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }>();

  // Incoming buffer — accumulates until we have a complete <length>:<json>.
  let buf: Buffer = Buffer.alloc(0);
  let initialBannerSeen = false;
  const bannerSeen = createDeferred<void>();

  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const colonIdx = buf.indexOf(0x3a /* ':' */);
      if (colonIdx < 0) return; // need more data for header
      const lenStr = buf.subarray(0, colonIdx).toString("utf8");
      const len = Number.parseInt(lenStr, 10);
      if (!Number.isFinite(len) || len < 0) {
        socket.destroy(new MarionetteError(`invalid framing header: ${JSON.stringify(lenStr)}`));
        return;
      }
      const totalNeeded = colonIdx + 1 + len;
      if (buf.length < totalNeeded) return; // need more bytes for body
      const payload = buf.subarray(colonIdx + 1, totalNeeded).toString("utf8");
      buf = buf.subarray(totalNeeded);

      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch (e) {
        socket.destroy(new MarionetteError(`malformed JSON from server: ${payload}`, e));
        return;
      }

      if (!initialBannerSeen) {
        // Banner — discard. Shape: { applicationType, marionetteProtocol }
        initialBannerSeen = true;
        bannerSeen.resolve();
        continue;
      }

      // Response: [1, msgId, error|null, result|null]
      if (Array.isArray(parsed) && parsed.length === 4 && parsed[0] === 1) {
        const [, msgId, err, result] = parsed as [number, number, unknown, unknown];
        const w = inflight.get(msgId);
        if (!w) continue; // late or unknown
        inflight.delete(msgId);
        if (err) w.reject(new MarionetteError(formatRemoteError(err), err));
        else w.resolve(result);
      }
    }
  });

  socket.on("error", (e) => {
    for (const [id, w] of inflight) {
      w.reject(new MarionetteError("socket error", e));
      inflight.delete(id);
    }
  });
  socket.on("close", () => {
    for (const [id, w] of inflight) {
      w.reject(new MarionetteError("socket closed before response"));
      inflight.delete(id);
    }
  });

  // Wait for the banner before allowing commands. (Marionette won't process
  // commands sent before its session-init handshake.)
  await bannerSeen.promise;

  function send<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = nextId++;
    const cmd = JSON.stringify([0, id, name, params]);
    const framed = `${Buffer.byteLength(cmd, "utf8")}:${cmd}`;
    return new Promise<T>((resolve, reject) => {
      inflight.set(id, { resolve: resolve as (v: unknown) => void, reject });
      socket.write(framed, "utf8", (err) => {
        if (err) {
          inflight.delete(id);
          reject(new MarionetteError("write failed", err));
        }
      });
    });
  }

  return {
    async newSession() {
      const r = await send<{ sessionId: string }>("WebDriver:NewSession", {
        capabilities: { alwaysMatch: {}, firstMatch: [{}] },
      });
      return r.sessionId;
    },
    async setContext(context) {
      await send<unknown>("Marionette:SetContext", { value: context });
    },
    async executeScript<T = unknown>(script: string, args: readonly unknown[] = []): Promise<T> {
      const r = await send<{ value: T }>("WebDriver:ExecuteScript", {
        script,
        args,
        // Some Firefox versions require these to be present.
        scriptTimeout: 30_000,
        newSandbox: false,
      });
      return r.value;
    },
    async executeAsyncScript<T = unknown>(script: string, args: readonly unknown[] = []): Promise<T> {
      const r = await send<{ value: T }>("WebDriver:ExecuteAsyncScript", {
        script,
        args,
        scriptTimeout: 30_000,
        newSandbox: false,
      });
      return r.value;
    },
    async getWindowHandle() {
      // Marionette wraps single-value returns in { value: ... } here, just
      // like ExecuteScript. Unwrap.
      const r = await send<string | { value: string }>("WebDriver:GetWindowHandle", {});
      return typeof r === "string" ? r : r.value;
    },
    async getWindowHandles() {
      const r = await send<string[] | { value: string[] }>("WebDriver:GetWindowHandles", {});
      return Array.isArray(r) ? r : r.value;
    },
    async switchToWindow(handle: string) {
      await send<unknown>("WebDriver:SwitchToWindow", { handle });
    },
    async closeWindow() {
      // WebDriver:CloseWindow closes the active *tab*, not the chrome window.
      // For our case (palefox is a chrome-window-level extension) we want
      // to close the entire window, hence Marionette:CloseChromeWindow.
      const r = await send<string[] | { value: string[] }>("WebDriver:CloseChromeWindow", {});
      return Array.isArray(r) ? r : r.value;
    },
    async performActions(actions: readonly object[]) {
      await send<unknown>("WebDriver:PerformActions", { actions });
    },
    async releaseActions() {
      await send<unknown>("WebDriver:ReleaseActions", {});
    },
    async quit(flags?: readonly string[]) {
      // Marionette:Quit gracefully shuts Firefox down and writes
      // sessionstore.jsonlz4. Returns { cause, in_app }.
      try {
        return await send<{ cause?: string; in_app?: boolean }>("Marionette:Quit", {
          flags: flags ?? ["eAttemptQuit"],
        });
      } catch (e) {
        // Connection may close mid-shutdown; treat that as success.
        return {};
      }
    },
    async deleteSession() {
      try {
        await send<unknown>("WebDriver:DeleteSession", {});
      } catch {
        // Already gone — fine. We're tearing down anyway.
      }
    },
    disconnect() {
      try { socket.end(); } catch {}
      try { socket.destroy(); } catch {}
    },
  };
}

function formatRemoteError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const o = err as Record<string, unknown>;
    return `${o.error ?? "error"}: ${o.message ?? "(no message)"}`;
  }
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
