import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../lib/supabase-client.js";
import { randomUUID } from "crypto";

interface ReportInput {
  service_id: string;
  was_successful: boolean;
  response_time_ms?: number;
  notes?: string;
}

interface ReportResult {
  report_id: string;
  service_id: string;
  recorded: boolean;
}

/** Simple outcome report - no LLM, just records pass/fail, stamped with the paying wallet */
export async function reportOutcome(
  input: ReportInput,
  reporterWallet: string,
  sb: SupabaseClient = getSupabase()
): Promise<ReportResult> {
  const reportId = `rpt_${randomUUID().slice(0, 12)}`;

  const { error } = await sb.from("verification_results").insert({
    verification_id: reportId,
    service_id: input.service_id,
    request_description: input.notes || "Outcome report",
    completeness_score: input.was_successful ? 100 : 0,
    accuracy_score: input.was_successful ? 100 : 0,
    // A report is the reporter's word only: nothing here checked a format or measured a time against a limit.
    format_compliance: null,
    sla_met: null,
    overall_pass: input.was_successful,
    issues: input.was_successful ? [] : ["Agent reported failure"],
    summary: input.was_successful ? "Agent reported successful outcome" : "Agent reported failed outcome",
    response_time_ms: input.response_time_ms || null,
    verification_type: "report",
    reporter_wallet: reporterWallet,
  });

  if (error) throw new Error(`Failed to record report: ${error.message}`);

  return {
    report_id: reportId,
    service_id: input.service_id,
    recorded: true,
  };
}
