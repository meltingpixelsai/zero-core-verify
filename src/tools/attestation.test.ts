import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceQuality } from "./quality.js";
import { reportOutcome } from "./reporting.js";

/** A query-builder stand-in that returns preset rows and records inserts. */
function fakeSupabase(rows: Record<string, unknown>[] = []) {
  const inserted: Record<string, unknown>[] = [];
  const builder = {
    select: () => builder,
    eq: () => builder,
    not: () => builder,
    order: () => builder,
    limit: () => builder,
    insert: (row: Record<string, unknown>) => {
      inserted.push(row);
      return Promise.resolve({ error: null });
    },
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(resolve, reject),
  };
  return { sb: { from: () => builder } as unknown as SupabaseClient, inserted };
}

const row = (wallet: string, format: boolean | null, sla: boolean | null) => ({
  reporter_wallet: wallet,
  completeness_score: 90,
  accuracy_score: 90,
  format_compliance: format,
  sla_met: sla,
  overall_pass: true,
  created_at: "2026-10-23T10:00:00Z",
});

test("every quality result says the scores are self-reported and unattested", async () => {
  const empty = await getServiceQuality("svc", fakeSupabase([]).sb);
  assert.equal(empty.attestation, "unattested");
  assert.match(empty.note, /not attested/);
  const some = await getServiceQuality("svc", fakeSupabase([row("A", true, null)]).sb);
  assert.equal(some.attestation, "unattested");
  assert.match(some.note, /nothing proves a reporter used the service/);
});

test("the format and SLA rates count only rows where code checked them", async () => {
  const q = await getServiceQuality("svc", fakeSupabase([row("A", true, null), row("B", false, null), row("C", null, true)]).sb);
  assert.equal(q.format_compliance_rate, 50);
  assert.equal(q.sla_compliance_rate, 100);
  const none = await getServiceQuality("svc", fakeSupabase([row("A", null, null)]).sb);
  assert.equal(none.format_compliance_rate, null);
  assert.equal(none.sla_compliance_rate, null);
});

test("averages skip rows without a score, so a code-failed or inconclusive row does not count as zero", async () => {
  const unscored = { ...row("B", false, null), completeness_score: null, accuracy_score: null, overall_pass: false };
  const q = await getServiceQuality("svc", fakeSupabase([row("A", true, null), unscored]).sb);
  assert.equal(q.avg_accuracy, 90);
  assert.equal(q.avg_completeness, 90);
  assert.equal(q.pass_rate, 50, "but it still counts as not passed");
  const none = await getServiceQuality("svc", fakeSupabase([unscored]).sb);
  assert.equal(none.avg_accuracy, null);
});

test("a report claims nothing about format or response time", async () => {
  const { sb, inserted } = fakeSupabase();
  await reportOutcome({ service_id: "svc", was_successful: true }, "WalletA", sb);
  assert.equal(inserted[0].format_compliance, null);
  assert.equal(inserted[0].sla_met, null);
  assert.equal(inserted[0].overall_pass, true);
});
