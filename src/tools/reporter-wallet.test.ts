import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reportOutcome } from "./reporting.js";
import { getServiceQuality } from "./quality.js";

interface Call {
  table: string;
  filters: Array<[string, ...unknown[]]>;
  inserted?: Record<string, unknown>;
}

/** A query-builder stand-in that records filters and inserts and returns preset rows. */
function fakeSupabase(rows: Record<string, unknown>[] = []) {
  const calls: Call[] = [];
  const sb = {
    from(table: string) {
      const call: Call = { table, filters: [] };
      calls.push(call);
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          call.filters.push(["eq", column, value]);
          return builder;
        },
        not: (column: string, op: string, value: unknown) => {
          call.filters.push(["not", column, op, value]);
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        insert: (payload: Record<string, unknown>) => {
          call.inserted = payload;
          return Promise.resolve({ error: null });
        },
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve, reject),
      };
      return builder;
    },
  };
  return { sb: sb as unknown as SupabaseClient, calls };
}

function row(wallet: string, pass: boolean, at: string) {
  return {
    reporter_wallet: wallet,
    completeness_score: pass ? 100 : 0,
    accuracy_score: pass ? 100 : 0,
    format_compliance: pass,
    sla_met: true,
    overall_pass: pass,
    created_at: at,
  };
}

test("report_outcome stores the paying wallet on the row", async () => {
  const { sb, calls } = fakeSupabase();
  await reportOutcome({ service_id: "svc", was_successful: true }, "WalletA", sb);
  assert.equal(calls[0].inserted?.reporter_wallet, "WalletA");
});

test("quality counts each paying wallet once, using its latest row", async () => {
  // Newest first, as the query orders them. WalletA reported 3 times; only its latest (a fail) counts.
  const { sb, calls } = fakeSupabase([
    row("WalletA", false, "2026-10-22T03:00:00Z"),
    row("WalletB", true, "2026-10-22T02:30:00Z"),
    row("WalletA", true, "2026-10-22T02:00:00Z"),
    row("WalletA", true, "2026-10-22T01:00:00Z"),
    row("WalletC", true, "2026-10-22T00:30:00Z"),
  ]);
  const q = await getServiceQuality("svc", sb);
  assert.equal(q.distinct_reporters, 3);
  assert.equal(q.total_verifications, 3);
  assert.equal(q.pass_rate, 67);
  assert.equal(q.last_verified_at, "2026-10-22T03:00:00Z");
  assert.ok(calls[0].filters.some((f) => f[0] === "not" && f[1] === "reporter_wallet"), "unattributed rows excluded");
});

test("one wallet reporting many times cannot outvote the others", async () => {
  const many = Array.from({ length: 50 }, (_, i) => row("Spammer", true, `2026-10-22T01:${String(59 - i).padStart(2, "0")}:00Z`));
  const { sb } = fakeSupabase([row("Honest1", false, "2026-10-22T02:00:00Z"), ...many, row("Honest2", false, "2026-10-22T00:00:00Z")]);
  const q = await getServiceQuality("svc", sb);
  assert.equal(q.distinct_reporters, 3);
  assert.equal(q.pass_rate, 33);
});

test("a service with no attributed reports has no score", async () => {
  const { sb } = fakeSupabase([]);
  const q = await getServiceQuality("svc", sb);
  assert.equal(q.distinct_reporters, 0);
  assert.equal(q.recent_trend, "insufficient_data");
});
