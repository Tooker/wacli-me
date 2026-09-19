// One long-running `wacli sync` per linked account, supervised.
//
// Without this the history freezes at whatever the linking run fetched, which
// looks like "search is broken" to the person using it. The sync daemon holds
// the store lock and streams new messages in; read commands work alongside it.

import fs from "node:fs";
import { spawn } from "node:child_process";

const RESTART_DELAY_MS = 10_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export class SyncManager {
  constructor({ wacliBin, logDir }) {
    this.wacliBin = wacliBin;
    this.logDir = logDir;
    this.running = new Map(); // store path -> { proc, backoff }
  }

  ensure(store) {
    if (this.running.has(store)) return;
    if (!fs.existsSync(store)) return;
    this.#spawn(store, RESTART_DELAY_MS);
  }

  /** Start a daemon for every store named in the tenant file. */
  ensureAll(tenants) {
    for (const tenant of tenants) this.ensure(tenant.store);
  }

  stop(store) {
    const entry = this.running.get(store);
    if (!entry) return;
    entry.stopping = true;
    clearTimeout(entry.restart);
    entry.proc?.kill();
    this.running.delete(store);
  }

  status() {
    return [...this.running.entries()].map(([store, entry]) => ({
      store,
      pid: entry.proc?.pid ?? null,
      alive: Boolean(entry.proc && entry.proc.exitCode === null),
    }));
  }

  #spawn(store, backoff) {
    const name = store.split("/").pop();
    const log = fs.openSync(`${this.logDir}/sync-${name}.log`, "a");

    const proc = spawn(
      this.wacliBin,
      ["--store", store, "sync", "--follow", "--max-db-size", "2GB"],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          WACLI_DEVICE_LABEL: process.env.WACLI_DEVICE_LABEL || "wacli.me",
          WACLI_DEVICE_PLATFORM: process.env.WACLI_DEVICE_PLATFORM || "DESKTOP",
        },
        stdio: ["ignore", log, log],
      },
    );

    const entry = { proc, backoff, stopping: false };
    this.running.set(store, entry);
    console.log(`[sync] started for ${name} (pid ${proc.pid})`);

    proc.on("exit", (code) => {
      fs.closeSync(log);
      if (entry.stopping) return;
      // A session that was unlinked on the phone exits immediately and forever;
      // backing off keeps that from becoming a spawn loop.
      const next = Math.min(entry.backoff * 2, MAX_BACKOFF_MS);
      console.log(`[sync] ${name} exited (${code}) — retrying in ${entry.backoff / 1000}s`);
      entry.restart = setTimeout(() => {
        this.running.delete(store);
        this.#spawn(store, next);
      }, entry.backoff);
    });
  }
}
