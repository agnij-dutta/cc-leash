// Append-only JSONL ledger, safe for concurrent Claude Code sessions.
//
// Writes: each event is ONE appendFileSync of one line, opened with O_APPEND,
// so concurrent writers never interleave bytes inside a line on a local fs.
// Reads: no lock. A half-written trailing line fails JSON.parse and is skipped.
//
// Race-free cap checks without locks: a PreToolUse first APPENDS a "reserve"
// line, then reads the file and sums only the entries that come BEFORE its
// own line. File position is a total order every session agrees on, so two
// parallel $60 payments against a $100 cap cannot both pass: whichever
// reserve landed second sees the first and denies itself (and appends a
// "release" for its hold). Under contention this can over-deny (a racer's
// reserve is counted until its release lands) but it never over-allows.
//
// Event types: "reserve" (hold an amount), "settle" (the call ran), "release"
// (denied or failed, drop the hold), "decision" (audit row for allow / ask /
// deny / dry-run). One hold id per tool call: the tool_use_id.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { claudeHome } from "./policy.mjs";

/** Directory for leash data (LEASH_HOME, else ~/.claude/leash). */
export function leashHome() {
  return process.env.LEASH_HOME || path.join(claudeHome(), "leash");
}

/** The ledger file (LEASH_LEDGER, else <leashHome>/ledger.jsonl). */
export function ledgerPath() {
  return process.env.LEASH_LEDGER || path.join(leashHome(), "ledger.jsonl");
}

/** Random 16-hex-char id for holds and reserve nonces. */
export function newId() {
  return crypto.randomBytes(8).toString("hex");
}

/** Append one event as one line (one write). Throws if the ledger can't be written. */
export function append(entry) {
  const file = ledgerPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify({ v: 1, ts: new Date().toISOString(), ...entry }) + "\n";
  fs.appendFileSync(file, line, { encoding: "utf8", flag: "a" });
  return entry;
}

/** Every parseable event in file order. A missing ledger is empty; other read errors throw. */
export function readAll() {
  let txt;
  try {
    txt = fs.readFileSync(ledgerPath(), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const out = [];
  for (const line of txt.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === "object") out.push(e);
    } catch {
      // partial line from a concurrent writer, or garbage: skip
    }
  }
  return out;
}

// Sums are done in integer micro-units so 0.1 + 0.2 never lands a hair over a cap.
const MICRO = 1e6;
export const toMicro = (n) => Math.round(Number(n) * MICRO);
export const fromMicro = (m) => m / MICRO;

/** "YYYY-MM-DD" in the machine's local time zone; daily caps reset at local midnight. */
export function localDay(d = new Date()) {
  const x = new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const day = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Fold events into one state per hold (tool call): reserved, settled,
 * released or expired. A reserve older than `ttlMs` that never settled is
 * expired and no longer counts.
 * @param {object[]} entries ledger events
 * @param {{now?: number, ttlMs?: number}} [opts]
 * @returns {Map<string, any>}
 */
export function fold(entries, { now = Date.now(), ttlMs = 15 * 60_000 } = {}) {
  const holds = new Map();
  for (const e of entries) {
    const key = e.hold;
    if (!key) continue;
    if (e.event === "reserve") {
      if (!holds.has(key)) holds.set(key, { ...e, status: "reserved" });
    } else if (e.event === "settle") {
      const prev = holds.get(key) || {};
      holds.set(key, { ...prev, ...e, status: "settled" });
    } else if (e.event === "release") {
      const prev = holds.get(key);
      if (prev && prev.status === "reserved") holds.set(key, { ...prev, status: "released", releaseReason: e.reason });
    }
  }
  for (const h of holds.values()) {
    if (h.status === "reserved" && now - Date.parse(h.ts) > ttlMs) h.status = "expired";
  }
  return holds;
}

/**
 * Spend (settled + live holds) in one currency, today and for one session.
 * @param {object[]} entries ledger events
 * @param {{session?: string|null, currency?: string|null, now?: number, ttlMs?: number}} [opts]
 */
export function totals(entries, { session, currency, now = Date.now(), ttlMs } = {}) {
  const holds = fold(entries, { now, ttlMs });
  const today = localDay(new Date(now));
  const out = { day: 0, session: 0, pending: 0, unpriced: 0 };
  for (const h of holds.values()) {
    if (h.status !== "settled" && h.status !== "reserved") continue;
    if (h.amount === null || h.amount === undefined) {
      if (h.status === "settled") out.unpriced++;
      continue;
    }
    if (currency && h.currency !== currency) continue;
    const m = toMicro(h.amount);
    if (localDay(new Date(h.ts)) === today) out.day += m;
    if (session && h.session === session) out.session += m;
    if (h.status === "reserved") out.pending += m;
  }
  return { day: fromMicro(out.day), session: fromMicro(out.session), pending: fromMicro(out.pending), unpriced: out.unpriced };
}

/**
 * Per-currency totals for today, for `leash status`.
 * @param {object[]} entries ledger events
 * @param {{now?: number, ttlMs?: number}} [opts]
 */
export function rollup(entries, { now = Date.now(), ttlMs } = {}) {
  const holds = fold(entries, { now, ttlMs });
  const today = localDay(new Date(now));
  const byCur = {};
  let unpriced = 0;
  for (const h of holds.values()) {
    if (h.status !== "settled" && h.status !== "reserved") continue;
    if (h.amount === null || h.amount === undefined) {
      if (h.status === "settled" && localDay(new Date(h.ts)) === today) unpriced++;
      continue;
    }
    if (localDay(new Date(h.ts)) !== today) continue;
    const c = (byCur[h.currency || "?"] ||= { day: 0, pending: 0, calls: 0, sessions: {} });
    c.day += toMicro(h.amount);
    c.calls++;
    if (h.status === "reserved") c.pending += toMicro(h.amount);
    if (h.session) c.sessions[h.session] = (c.sessions[h.session] || 0) + toMicro(h.amount);
  }
  for (const c of Object.values(byCur)) {
    c.day = fromMicro(c.day);
    c.pending = fromMicro(c.pending);
    for (const s of Object.keys(c.sessions)) c.sessions[s] = fromMicro(c.sessions[s]);
  }
  return { byCur, unpriced };
}
