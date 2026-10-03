// A supervised sync process either stays connected continuously or is started
// for MCP tool calls and stopped shortly after the last request.

import fs from "node:fs";
import { spawn } from "node:child_process";

const RESTART_DELAY_MS = 10_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const REQUEST_READY_TIMEOUT_MS = 90_000;

export class SyncManager {
  constructor({ wacliBin, logDir, mode = "continuous", idleMs = 5_000 }) {
    this.wacliBin = wacliBin;
    this.logDir = logDir;
    this.mode = mode === "on-request" ? "on-request" : "continuous";
    this.idleMs = Number.isFinite(idleMs) ? Math.max(0, idleMs) : 5_000;
    this.running = new Map(); // store path -> process/session state
  }

  ensure(store) {
    if (this.mode === "on-request" || this.running.has(store)) return;
    if (!fs.existsSync(store)) return;
    this.#spawn(store, RESTART_DELAY_MS);
  }

  /** Start a quiet session for a tool request and return a release callback. */
  async acquireForRequest(store) {
    if (this.mode !== "on-request") return () => {};
    if (!fs.existsSync(store)) throw new Error("WhatsApp account store is missing.");

    let entry = this.running.get(store);
    if (!entry) {
      entry = this.#newRequestEntry();
      this.running.set(store, entry);
      this.#spawn(store, RESTART_DELAY_MS, entry);
    }

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    entry.activeRequests += 1;

    try {
      // Wait until wacli has replayed the offline backlog so this request sees
      // the newest local mirror. The MCP call owns this connection while it
      // waits and while its tool handler is running.
      await entry.ready;
    } catch (err) {
      this.#releaseRequest(store, entry, true);
      throw err;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#releaseRequest(store, entry);
    };
  }

  /** Start a daemon for every store named in the tenant file. */
  ensureAll(tenants) {
    if (this.mode === "on-request") return;
    for (const tenant of tenants) this.ensure(tenant.store);
  }

  stop(store) {
    const entry = this.running.get(store);
    if (!entry) return;
    entry.stopping = true;
    clearTimeout(entry.restart);
    clearTimeout(entry.idleTimer);
    entry.rejectReady?.(new Error("WhatsApp sync was stopped."));
    entry.proc?.kill();
    this.running.delete(store);
  }

  stopAll() {
    for (const store of [...this.running.keys()]) this.stop(store);
  }

  status() {
    return [...this.running.entries()].map(([store, entry]) => ({
      store,
      pid: entry.proc?.pid ?? null,
      alive: Boolean(entry.proc && entry.proc.exitCode === null),
    }));
  }

  #newRequestEntry() {
    let resolve;
    let reject;
    const entry = {
      proc: null,
      backoff: RESTART_DELAY_MS,
      stopping: false,
      activeRequests: 0,
      idleTimer: null,
      readyState: "pending",
      eventBuffers: { stdout: "", stderr: "" },
      ready: new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      }),
    };
    entry.resolveReady = () => {
      if (entry.readyState !== "pending") return;
      entry.readyState = "ready";
      clearTimeout(entry.readyTimer);
      resolve();
    };
    entry.rejectReady = (err) => {
      if (entry.readyState !== "pending") return;
      entry.readyState = "failed";
      clearTimeout(entry.readyTimer);
      reject(err);
    };
    entry.readyTimer = setTimeout(
      () => entry.rejectReady(new Error("Timed out waiting for WhatsApp sync.")),
      REQUEST_READY_TIMEOUT_MS,
    );
    return entry;
  }

  #releaseRequest(store, entry, immediate = false) {
    entry.activeRequests = Math.max(0, entry.activeRequests - 1);
    if (entry.activeRequests !== 0 || this.running.get(store) !== entry) return;

    if (immediate || this.idleMs === 0) {
      this.stop(store);
      return;
    }

    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (entry.activeRequests === 0 && this.running.get(store) === entry) this.stop(store);
    }, this.idleMs);
    entry.idleTimer.unref?.();
  }

  #spawn(store, backoff, requestEntry = null) {
    const requestScoped = this.mode === "on-request";
    const name = store.split("/").pop();
    const log = fs.openSync(`${this.logDir}/sync-${name}.log`, "a");
    const args = ["--store", store];
    if (requestScoped) args.push("--events");
    args.push("sync", "--follow", "--presence-mode", "quiet", "--max-db-size", "2GB");

    const proc = spawn(this.wacliBin, args, {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        WACLI_DEVICE_LABEL: process.env.WACLI_DEVICE_LABEL || "wacli.me",
        WACLI_DEVICE_PLATFORM: process.env.WACLI_DEVICE_PLATFORM || "DESKTOP",
      },
      stdio: requestScoped ? ["ignore", "pipe", "pipe"] : ["ignore", log, log],
    });

    const entry = requestEntry || { proc: null, backoff, stopping: false };
    entry.proc = proc;
    entry.backoff = backoff;
    entry.stopping = false;
    this.running.set(store, entry);
    console.log(`[sync] started for ${name} (pid ${proc.pid}, ${this.mode})`);

    let logClosed = false;
    const closeLog = () => {
      if (logClosed) return;
      logClosed = true;
      fs.closeSync(log);
    };

    if (requestScoped) {
      const capture = (stream, key) => {
        stream.on("data", (chunk) => {
          fs.writeSync(log, chunk);
          let buffered = entry.eventBuffers[key] + chunk.toString("utf8");
          const lines = buffered.split(/\r?\n/);
          entry.eventBuffers[key] = lines.pop() || "";
          for (const line of lines) {
            if (line.includes("offline_sync_completed")) entry.resolveReady();
            if (line.includes("logged_out")) {
              entry.rejectReady(new Error("WhatsApp linked session is no longer authenticated."));
            }
          }
        });
      };
      capture(proc.stdout, "stdout");
      capture(proc.stderr, "stderr");
    }

    proc.on("error", (err) => {
      closeLog();
      entry.rejectReady?.(new Error("Could not start WhatsApp sync."));
      if (this.running.get(store) === entry) this.running.delete(store);
      console.error(`[sync] ${name} failed to start: ${err.message}`);
    });

    proc.on("close", (code) => {
      closeLog();
      if (entry.stopping) return;

      if (requestScoped) {
        entry.rejectReady(new Error("WhatsApp sync exited before it was ready."));
        if (this.running.get(store) === entry) this.running.delete(store);
        console.log(`[sync] ${name} exited (${code}) during request-scoped sync`);
        return;
      }

      // A session that was unlinked on the phone exits immediately and forever;
      // backing off keeps that from becoming a spawn loop.
      const next = Math.min(entry.backoff * 2, MAX_BACKOFF_MS);
      console.log(`[sync] ${name} exited (${code}) — retrying in ${entry.backoff / 1000}s`);
      entry.restart = setTimeout(() => {
        if (this.running.get(store) !== entry) return;
        this.running.delete(store);
        this.#spawn(store, next);
      }, entry.backoff);
    });
  }
}
