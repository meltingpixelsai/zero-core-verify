import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../lib/supabase-client.js";

interface ServiceQuality {
  service_id: string;
  total_verifications: number;
  /** Each paying wallet counts once: its latest report or verification. */
  distinct_reporters: number;
  avg_completeness: number;
  avg_accuracy: number;
  pass_rate: number;
  format_compliance_rate: number;
  sla_compliance_rate: number;
  recent_trend: "improving" | "stable" | "declining" | "insufficient_data";
  last_verified_at: string | null;
}

/**
 * Get aggregated quality scores for a service. Each paying wallet counts once
 * (its latest report or verification, newest 100 wallets), so one payer cannot
 * outvote everyone else by reporting many times. The view
 * verification_latest_by_reporter keeps one row per (service_id,
 * reporter_wallet) in the database (DISTINCT ON), so no number of rows from one
 * wallet can push the others out of the query.
 */
export async function getServiceQuality(serviceId: string, sb: SupabaseClient = getSupabase()): Promise<ServiceQuality> {
  const { data: rows, error } = await sb
    .from("verification_latest_by_reporter")
    .select("completeness_score, accuracy_score, format_compliance, sla_met, overall_pass, created_at, reporter_wallet")
    .eq("service_id", serviceId)
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
      avg_completeness: 0,
      avg_accuracy: 0,
      pass_rate: 0,
      format_compliance_rate: 0,
      sla_compliance_rate: 0,
      recent_trend: "insufficient_data",
      last_verified_at: null,
    };
  }

  const total = data.length;
  const avgCompleteness = Math.round(data.reduce((s, r) => s + (r.completeness_score ?? 0), 0) / total);
  const avgAccuracy = Math.round(data.reduce((s, r) => s + (r.accuracy_score ?? 0), 0) / total);
  const passRate = Math.round((data.filter((r) => r.overall_pass).length / total) * 100);
  const formatRate = Math.round((data.filter((r) => r.format_compliance).length / total) * 100);
  const slaRate = Math.round((data.filter((r) => r.sla_met).length / total) * 100);

  // Calculate trend from recent vs older results
  let trend: "improving" | "stable" | "declining" | "insufficient_data" = "insufficient_data";
  if (total >= 6) {
    const half = Math.floor(total / 2);
    const recent = data.slice(0, half);
    const older = data.slice(half);
    const recentAvg = recent.reduce((s, r) => s + (r.completeness_score ?? 0) + (r.accuracy_score ?? 0), 0) / (recent.length * 2);
    const olderAvg = older.reduce((s, r) => s + (r.completeness_score ?? 0) + (r.accuracy_score ?? 0), 0) / (older.length * 2);
    const diff = recentAvg - olderAvg;
    if (diff > 5) trend = "improving";
    else if (diff < -5) trend = "declining";
    else trend = "stable";
  }

  return {
    service_id: serviceId,
    total_verifications: total,
    distinct_reporters: total,
    avg_completeness: avgCompleteness,
    avg_accuracy: avgAccuracy,
    pass_rate: passRate,
    format_compliance_rate: formatRate,
    sla_compliance_rate: slaRate,
    recent_trend: trend,
    last_verified_at: data[0].created_at,
  };
}
