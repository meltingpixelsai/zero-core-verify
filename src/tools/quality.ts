import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../lib/supabase-client.js";
import { safeText } from "../lib/output-checks.js";

interface ServiceQuality {
  service_id: string;
  total_verifications: number;
  /** Each paying wallet counts once: its latest report or verification. */
  distinct_reporters: number;
  /** Rows that carry scores (the judge's, or a reporter's 100 or 0); the averages cover only these. */
  scored_verifications: number;
  /** null when no row has the score (rows code failed first, or the judge did not score, carry none). */
  avg_completeness: number | null;
  avg_accuracy: number | null;
  pass_rate: number;
  /** Rows where code passed or failed the format (a schema or required fields) or a measured time, and the pass
   * rate over them (null when none). A pass in the other rows rests on the AI judge, or a reporter's word, alone. */
  code_checked_verifications: number;
  code_checked_pass_rate: number | null;
  /** Rows the judge gave no usable answer for. They count as not passed: otherwise a judged service could turn a
   * failure into a gap by confusing the judge. Many of them can also mean the judge was down. */
  inconclusive_verifications: number;
  /** Over the rows where code checked the format; null when none did. */
  format_compliance_rate: number | null;
  /** Over the rows where code checked a measured time; null when none did. */
  sla_compliance_rate: number | null;
  /** The pass rate of the newer half of the rows against the older half. */
  recent_trend: "improving" | "stable" | "declining" | "insufficient_data";
  last_verified_at: string | null;
  /** Nothing proves a reporter used the service: any paying wallet can report. */
  attestation: "unattested";
  note: string;
}

const UNATTESTED_NOTE =
  "Self-reported by paying wallets and not attested: nothing proves a reporter used the service, so treat these scores as unverified.";

type Row = Record<string, unknown>;

/** Rounded mean of a score over the rows that have it; null when none does. */
function averageOf(rows: Row[], field: string): number | null {
  const values = rows.map((r) => r[field]).filter((v): v is number => typeof v === "number");
  return values.length ? Math.round(values.reduce((s, v) => s + v, 0) / values.length) : null;
}

/** Percentage of rows where the field is true, counting only rows that checked it; null when none did. */
function checkedRate(rows: Row[], field: string): number | null {
  const checked = rows.filter((r) => r[field] === true || r[field] === false);
  return checked.length ? Math.round((checked.filter((r) => r[field] === true).length / checked.length) * 100) : null;
}

/** Percentage of rows that passed; 0 for none. */
const passRate = (rows: Row[]): number => (rows.length ? Math.round((rows.filter((r) => r.overall_pass === true).length / rows.length) * 100) : 0);

/**
 * Get aggregated quality scores for a service. Each paying wallet counts once
 * (its latest report or verification, newest 100 wallets), so one payer cannot
 * outvote everyone else by reporting many times. The view
 * verification_latest_by_reporter keeps one row per (service_id,
 * reporter_wallet) in the database (DISTINCT ON), so no number of rows from one
 * wallet can push the others out of the query. The scores stay self-reported:
 * every result says so (attestation "unattested").
 */
export async function getServiceQuality(serviceId: string, sb: SupabaseClient = getSupabase()): Promise<ServiceQuality> {
  const { data: rows, error } = await sb
    .from("verification_latest_by_reporter")
    .select("completeness_score, accuracy_score, format_compliance, sla_met, overall_pass, created_at, reporter_wallet")
    .eq("service_id", safeText(serviceId, 200))
    .not("reporter_wallet", "is", null)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw new Error(`Quality query failed: ${error.message}`);

  const seen = new Set<string>();
  const data = (rows ?? []).filter((row) => {
    if (seen.has(row.reporter_wallet)) return false;
    seen.add(row.reporter_wallet);
    return true;
  }).slice(0, 100);

  if (!data || data.length === 0) {
    return {
      service_id: serviceId,
      total_verifications: 0,
      distinct_reporters: 0,
      scored_verifications: 0,
      avg_completeness: null,
      avg_accuracy: null,
      pass_rate: 0,
      code_checked_verifications: 0,
      code_checked_pass_rate: null,
      inconclusive_verifications: 0,
      format_compliance_rate: null,
      sla_compliance_rate: null,
      recent_trend: "insufficient_data",
      last_verified_at: null,
      attestation: "unattested",
      note: UNATTESTED_NOTE,
    };
  }

  const total = data.length;
  const codeChecked = data.filter((r) => typeof r.format_compliance === "boolean" || typeof r.sla_met === "boolean");

  // Trend: the pass rate of the newer half of the rows (newest first) against the older half. Every row has a
  // pass or a fail, so rows code failed before the judge scored them count too.
  let trend: "improving" | "stable" | "declining" | "insufficient_data" = "insufficient_data";
  if (total >= 6) {
    const half = Math.floor(total / 2);
    const diff = passRate(data.slice(0, half)) - passRate(data.slice(half));
    if (diff > 10) trend = "improving";
    else if (diff < -10) trend = "declining";
    else trend = "stable";
  }

  return {
    service_id: serviceId,
    total_verifications: total,
    distinct_reporters: total,
    scored_verifications: data.filter((r) => typeof r.accuracy_score === "number").length,
    avg_completeness: averageOf(data, "completeness_score"),
    avg_accuracy: averageOf(data, "accuracy_score"),
    pass_rate: passRate(data),
    code_checked_verifications: codeChecked.length,
    code_checked_pass_rate: codeChecked.length ? passRate(codeChecked) : null,
    // No score and no code failure: the judge was asked and gave nothing usable (reports always carry scores).
    inconclusive_verifications: data.filter((r) => r.accuracy_score === null && r.format_compliance !== false && r.sla_met !== false).length,
    format_compliance_rate: checkedRate(data, "format_compliance"),
    sla_compliance_rate: checkedRate(data, "sla_met"),
    recent_trend: trend,
    last_verified_at: data[0].created_at,
    attestation: "unattested",
    note: UNATTESTED_NOTE,
  };
}
