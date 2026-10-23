import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceQuality } from "./quality.js";
import { reportOutcome } from "./reporting.js";

/** A query-builder stand-in that returns preset rows and records inserts. */
function fakeSupabase(rows: Record<string, unknown>[] = []) {
  const inserted: Record<string, unknown>[] = [];
  const eqs: Array<[string, unknown]> = [];
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      eqs.push([column, value]);
      return builder;
    },
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
  return { sb: { from: () => builder } as unknown as SupabaseClient, inserted, eqs };
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

/** A row code failed before the judge scored it. */
const codeFailed = (wallet: string) => ({ ...row(wallet, false, null), completeness_score: null, accuracy_score: null, overall_pass: false });

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

test("averages skip rows without a score and say how many rows they cover", async () => {
  const q = await getServiceQuality("svc", fakeSupabase([row("A", true, null), codeFailed("B")]).sb);
  assert.equal(q.avg_accuracy, 90);
  assert.equal(q.avg_completeness, 90);
  assert.equal(q.scored_verifications, 1);
  assert.equal(q.pass_rate, 50, "the unscored row still counts as not passed");
  // The review's case: five code failures and one judged 90 read as 90 on one scored row, against a 17% pass rate.
  const mostlyFailed = await getServiceQuality("svc", fakeSupabase([row("A", true, null), ...["B", "C", "D", "E", "F"].map(codeFailed)]).sb);
  assert.equal(mostlyFailed.avg_accuracy, 90);
  assert.equal(mostlyFailed.scored_verifications, 1);
  assert.equal(mostlyFailed.pass_rate, 17);
  const none = await getServiceQuality("svc", fakeSupabase([codeFailed("B")]).sb);
  assert.equal(none.avg_accuracy, null);
  assert.equal(none.scored_verifications, 0);
});

test("the code-checked pass rate counts only rows where code checked the format or a measured time", async () => {
  const judgeOnly = { ...row("C", null, null), overall_pass: true };
  const q = await getServiceQuality("svc", fakeSupabase([row("A", true, null), codeFailed("B"), judgeOnly, row("D", null, true)]).sb);
  assert.equal(q.code_checked_verifications, 3);
  assert.equal(q.code_checked_pass_rate, 67);
  assert.equal(q.pass_rate, 75);
  const none = await getServiceQuality("svc", fakeSupabase([judgeOnly]).sb);
  assert.equal(none.code_checked_verifications, 0);
  assert.equal(none.code_checked_pass_rate, null);
});

test("the trend compares pass rates over every row, so failures code caught count", async () => {
  const passes = (prefix: string) => Array.from({ length: 6 }, (_, i) => row(`${prefix}${i}`, true, null));
  const fails = (prefix: string) => Array.from({ length: 6 }, (_, i) => codeFailed(`${prefix}${i}`));
  // Rows come newest first.
  assert.equal((await getServiceQuality("svc", fakeSupabase([...fails("new"), ...passes("old")]).sb)).recent_trend, "declining");
  assert.equal((await getServiceQuality("svc", fakeSupabase([...passes("new"), ...fails("old")]).sb)).recent_trend, "improving");
  assert.equal((await getServiceQuality("svc", fakeSupabase([...passes("new"), ...passes("old")]).sb)).recent_trend, "stable");
  assert.equal((await getServiceQuality("svc", fakeSupabase(passes("only").slice(0, 5)).sb)).recent_trend, "insufficient_data");
});

test("the trend needs more than a 10-point move", async () => {
  // Newest first: 6 of the newer 10 passed, 5 of the older 10.
  const rows = Array.from({ length: 20 }, (_, i) => ({ ...row(`W${i}`, true, null), overall_pass: i < 10 ? i < 6 : i < 15 }));
  assert.equal((await getServiceQuality("svc", fakeSupabase(rows).sb)).recent_trend, "stable");
});

test("inconclusive rows are counted, and still count as not passed", async () => {
  const inconclusive = { ...row("B", true, null), completeness_score: null, accuracy_score: null, overall_pass: false };
  const lateByCode = { ...row("D", null, false), completeness_score: null, accuracy_score: null, overall_pass: false };
  const q = await getServiceQuality("svc", fakeSupabase([row("A", true, null), inconclusive, codeFailed("C"), lateByCode]).sb);
  assert.equal(q.inconclusive_verifications, 1, "rows code failed, on format or on time, are not inconclusive");
  assert.equal(q.pass_rate, 25);
});

test("service ids are stored and looked up without control characters", async () => {
  const { sb, inserted, eqs } = fakeSupabase();
  await reportOutcome({ service_id: "svc\u0000one", was_successful: false, notes: "bad\u0001note" }, "WalletA", sb);
  assert.equal(inserted[0].service_id, "svcone");
  assert.equal(inserted[0].request_description, "badnote");
  await getServiceQuality("svc\u0000one", sb);
  assert.deepEqual(eqs.find(([column]) => column === "service_id"), ["service_id", "svcone"]);
});

test("a report claims nothing about format or response time", async () => {
  const { sb, inserted } = fakeSupabase();
  await reportOutcome({ service_id: "svc", was_successful: true }, "WalletA", sb);
  assert.equal(inserted[0].format_compliance, null);
  assert.equal(inserted[0].sla_met, null);
  assert.equal(inserted[0].overall_pass, true);
});
