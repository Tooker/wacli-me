// Retention: the part of the free tier that actually bounds the cost.
//
// A linked account costs money whether or not anyone queries it — the sync
// daemon runs and the history sits on disk. So the free tier is bounded by two
// things the request counter cannot touch: dormant chats are pruned, and an
// account nobody has used in a fortnight is removed entirely.
//
// This is also the Article 5(1)(e) side of the promise. Keeping a stranger's
// complete WhatsApp history forever, for free, is a liability rather than a
// courtesy.

import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;

export class Retention {
  constructor({ wacliBin, tenantsFile, usage, sync, planFor, intervalMs = 6 * 60 * 60 * 1000 }) {
    this.wacliBin = wacliBin;
    this.tenantsFile = tenantsFile;
    this.usage = usage;
    this.sync = sync;
    this.planFor = planFor;
    this.intervalMs = intervalMs;
    this.timer = null;
  }

  start() {
    // Not on boot: a restart during a deploy should not immediately touch
    // anyone's data. Give the server time to settle first.
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => console.error(`[retention] pass failed: ${err.message}`));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  #tenants() {
    const parsed = JSON.parse(fs.readFileSync(this.tenantsFile, "utf8"));
    return { parsed, list: Array.isArray(parsed) ? parsed : parsed.tenants || [] };
  }

  // When did we last hear from this account at all? Falls back to when it was
  // linked, so a brand-new account is never treated as long-dormant.
  #lastSeen(tenant) {
    const seen = this.usage.peek(tenant.id).lastSeenAt;
    const stamp = seen || tenant.createdAt;
    const parsed = stamp ? Date.parse(stamp) : NaN;
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  async runOnce({ dryRun = false } = {}) {
    const { parsed, list } = this.#tenants();
    const actions = [];
    let removedAny = false;

    for (const tenant of [...list]) {
      const plan = this.planFor(tenant);

      // The operator's own accounts, and anything explicitly held, are exempt.
      // Without this the test accounts this service is developed against would
      // quietly delete themselves.
      if (tenant.retentionExempt === true) continue;

      const idleDays = Math.floor((Date.now() - this.#lastSeen(tenant)) / DAY_MS);

      if (plan.idleDays !== null && idleDays >= plan.idleDays) {
        actions.push({ tenant: tenant.id, action: "delete-store", idleDays });
        if (!dryRun) {
          this.sync.stop(tenant.store);
          fs.rmSync(tenant.store, { recursive: true, force: true });
          const at = list.indexOf(tenant);
          if (at >= 0) list.splice(at, 1);
          removedAny = true;
        }
        continue;
      }

      if (plan.historyDays !== null) {
        actions.push({ tenant: tenant.id, action: "prune-dormant-chats", olderThanDays: plan.historyDays });
        if (!dryRun) {
          try {
            await this.#prune(tenant, plan.historyDays);
          } catch (err) {
            console.error(`[retention] prune failed for ${tenant.id}: ${err.message}`);
          }
        }
      }
    }

    if (removedAny && !dryRun) {
      fs.writeFileSync(this.tenantsFile, JSON.stringify(parsed, null, 2), { mode: 0o600 });
    }
    for (const entry of actions) {
      console.log(`[retention] ${dryRun ? "would " : ""}${entry.action} ${entry.tenant} ${JSON.stringify(entry)}`);
    }
    return actions;
  }

  // `wacli store cleanup` needs the store lock, which the sync daemon holds.
  // Stop it, prune, hand it back — and hand it back even when pruning throws,
  // because an account whose sync never restarts silently stops receiving
  // messages, which is far worse than a skipped prune.
  async #prune(tenant, days) {
    this.sync.stop(tenant.store);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await run(this.wacliBin, ["--store", tenant.store, "store", "cleanup", "--days", String(days), "--confirm"], {
        timeout: 5 * 60_000,
      });
    } finally {
      this.sync.ensure(tenant.store);
    }
  }
}
