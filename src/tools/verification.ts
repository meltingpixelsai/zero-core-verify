import { callGrok } from "../lib/grok-client.js";
import { getSupabase } from "../lib/supabase-client.js";
import { randomUUID } from "crypto";

interface VerificationInput {
  request_description: string;
  response_data: string;
  expected_schema?: string;
  sla_requirements?: string;
  service_id?: string;
}

interface VerificationResult {
  verification_id: string;
  completeness_score: number;
  accuracy_score: number;
  format_compliance: boolean;
  sla_met: boolean;
  overall_pass: boolean;
  issues: string[];
  summary: string;
}

/** Use Grok as LLM-as-judge to verify if a service outcome matches expectations; the stored row names the paying wallet */
export async function verifyOutcome(input: VerificationInput, reporterWallet: string): Promise<VerificationResult> {
  const verificationId = `ver_${randomUUID().slice(0, 12)}`;

  let userPrompt = `Verify this service outcome:

REQUEST DESCRIPTION:
${input.request_description}

RESPONSE DATA:
${input.response_data}`;

  if (input.expected_schema) {
    userPrompt += `\n\nEXPECTED SCHEMA/FORMAT:\n${input.expected_schema}`;
  }
  if (input.sla_requirements) {
    userPrompt += `\n\nSLA REQUIREMENTS:\n${input.sla_requirements}`;
  }

  const response = await callGrok(
    [
      {
        role: "system",
        content: `You are a strict outcome verification judge. Evaluate if a service response properly fulfills the original request. Return ONLY valid JSON with this exact structure (no markdown, no code fences):
{
  "completeness_score": 85,
  "accuracy_score": 90,
  "format_compliance": true,
  "sla_met": true,
  "issues": ["issue 1", "issue 2"],
  "summary": "Brief verification summary"
}

Scoring rules:
- completeness_score (0-100): Does the response contain ALL requested information?
- accuracy_score (0-100): Is the information correct and relevant?
- format_compliance: Does it match the expected schema/format if one was provided?
- sla_met: Did it meet SLA requirements if specified? Default true if no SLA given.
- issues: List specific problems found. Empty array if none.
- summary: One-sentence verification verdict.
- overall_pass = completeness >= 70 AND accuracy >= 70 (you do NOT include this field, we calculate it)`,
      },
      { role: "user", content: userPrompt },
    ],
    { temperature: 0.1, maxTokens: 2048 }
  );

  let parsed: {
    completeness_score: number;
    accuracy_score: number;
    format_compliance: boolean;
    sla_met: boolean;
    issues: string[];
    summary: string;
  };

  try {
    parsed = JSON.parse(response.content);
  } catch {
    parsed = {
      completeness_score: 0,
      accuracy_score: 0,
      format_compliance: false,
      sla_met: false,
      issues: ["Failed to parse verification response"],
      summary: response.content.slice(0, 200),
    };
  }

  const overall_pass = parsed.completeness_score >= 70 && parsed.accuracy_score >= 70;

  const result: VerificationResult = {
    verification_id: verificationId,
    completeness_score: parsed.completeness_score,
    accuracy_score: parsed.accuracy_score,
    format_compliance: parsed.format_compliance,
    sla_met: parsed.sla_met,
    overall_pass,
    issues: parsed.issues || [],
    summary: parsed.summary || "Verification complete",
  };

  // Store in Supabase (fire-and-forget)
  try {
    const sb = getSupabase();
    sb.from("verification_results").insert({
      verification_id: verificationId,
      service_id: input.service_id || null,
      request_description: input.request_description,
      completeness_score: result.completeness_score,
      accuracy_score: result.accuracy_score,
      format_compliance: result.format_compliance,
      sla_met: result.sla_met,
      overall_pass: result.overall_pass,
      issues: result.issues,
      summary: result.summary,
      verification_type: "full",
      reporter_wallet: reporterWallet,
    }).then(({ error }) => {
      if (error) console.error("Failed to store verification:", error.message);
    });
  } catch (err) {
    console.error("Supabase insert error:", err);
  }

  return result;
}
