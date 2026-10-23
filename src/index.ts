import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createMcpPaidHandler } from "mcpay/handler";
import { z } from "zod";
import { config } from "./config.js";
import { registerDiscoveryRoutes } from "./discovery.js";
import { landingHtml, devHtml } from "./landing.js";
import { verifyOutcome } from "./tools/verification.js";
import { getServiceQuality } from "./tools/quality.js";
import { reportOutcome } from "./tools/reporting.js";
import { createSettleFirstPaidTools, type SettleFirstConfig, type X402Settlement } from "./lib/x402-settle-first.js";

// ── Shared tool callback helpers ─────────────────────────────

function toolResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function toolError(err: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true as const,
  };
}

/** The wallet whose payment settled for this call; quality scores count each wallet once. */
function payingWallet(extra: unknown): string | null {
  const payer = (extra as { x402Settlement?: X402Settlement } | undefined)?.x402Settlement?.payer;
  return typeof payer === "string" && payer.length > 0 ? payer : null;
}

const NO_PAYER = "The payment settled without naming the paying wallet, so the report cannot be attributed";

// ── Free tool data ───────────────────────────────────────────

function listTools() {
  return {
    server: "harvey-verify",
    version: "1.0.0",
    payment: { network: config.payment.network, currency: config.payment.currency, method: "x402" },
    tools: [
      { name: "list_tools", description: "List all tools with pricing", price: "FREE" },
      { name: "health", description: "Server status and payment config", price: "FREE" },
      { name: "verify_outcome", description: "LLM-as-judge verification of service outcomes", price: "$0.01" },
      { name: "get_service_quality", description: "Aggregated quality scores for a service", price: "$0.005" },
      { name: "report_outcome", description: "Simple pass/fail outcome report", price: "$0.002" },
    ],
  };
}

function health() {
  return {
    status: "ok",
    server: "harvey-verify",
    version: "1.0.0",
    uptime: Math.floor(process.uptime()),
    payment: {
      network: config.payment.network,
      currency: config.payment.currency,
      wallet: config.payment.wallet,
      facilitator: config.payment.facilitator,
      method: "x402",
    },
    capabilities: ["outcome-verification", "quality-scores", "outcome-reporting"],
  };
}

// ── Tool registration ────────────────────────────────────────
// Server typed as `any` because mcpay bundles its own @modelcontextprotocol/sdk
// version, making its McpServer type incompatible at compile time.

/* eslint-disable @typescript-eslint/no-explicit-any */

function registerFreeTools(server: any): void {
  server.tool(
    "list_tools",
    "List all available Harvey Verify tools with pricing and input requirements. Use this for discovery.",
    {},
    async () => toolResult(listTools())
  );

  server.tool(
    "health",
    "Check Harvey Verify server status, uptime, and payment network configuration.",
    {},
    async () => toolResult(health())
  );
}

// ── x402 Paid Handler ────────────────────────────────────────

const x402Config: SettleFirstConfig = {
  facilitator: {
    url: config.payment.facilitator as `${string}://${string}`,
  },
  recipient: {
    svm: {
      address: config.payment.wallet,
      isTestnet: false,
    },
  },
};

// Paid tools take the payment (claim once, verify, settle) before they run.
// mcpay's own paidTool runs the tool first and settles after, which gives
// unsettled payments the tool for free. See src/lib/x402-settle-first.ts.
const settleFirst = createSettleFirstPaidTools(x402Config);

const paidHandler = createMcpPaidHandler(
  (server) => {
    registerFreeTools(server);
    const paidTool = settleFirst(server);

    paidTool(
      "verify_outcome",
      "Post-transaction verification using LLM-as-judge. Checks if a service delivered what was promised. Returns completeness score, accuracy score, format compliance, SLA adherence, issues list, and overall pass/fail.",
      "$0.01",
      {
        request_description: z.string().describe("What was requested from the service"),
        response_data: z.string().describe("The actual response/output received from the service"),
        expected_schema: z.string().optional().describe("Expected output format or JSON schema"),
        sla_requirements: z.string().optional().describe("SLA requirements to check against (e.g. 'response under 5s, must include all fields')"),
        service_id: z.string().optional().describe("Service identifier for quality tracking (e.g. 'harvey-tools/scrape_url')"),
      },
      {},
      async ({ request_description, response_data, expected_schema, sla_requirements, service_id }: {
        request_description: string;
        response_data: string;
        expected_schema?: string;
        sla_requirements?: string;
        service_id?: string;
      }, extra: unknown) => {
        const reporter = payingWallet(extra);
        if (!reporter) return toolError(NO_PAYER);
        try {
          return toolResult(await verifyOutcome({ request_description, response_data, expected_schema, sla_requirements, service_id }, reporter));
        } catch (err) {
          return toolError(err);
        }
      }
    );

    paidTool(
      "get_service_quality",
      "Get aggregated quality scores for a service based on past verifications and reports, counting each paying wallet once (its latest). Returns average completeness, accuracy, pass rate, format compliance rate, SLA compliance rate, and quality trend.",
      "$0.005",
      {
        service_id: z.string().describe("Service identifier to query (e.g. 'harvey-tools/scrape_url')"),
      },
      {},
      async ({ service_id }: { service_id: string }) => {
        try {
          return toolResult(await getServiceQuality(service_id));
        } catch (err) {
          return toolError(err);
        }
      }
    );

    paidTool(
      "report_outcome",
      "Record a simple pass/fail outcome report for a service call. No LLM analysis - just logs the result to the quality database. Cheaper alternative to verify_outcome when you only need to record success/failure.",
      "$0.002",
      {
        service_id: z.string().describe("Service identifier (e.g. 'harvey-tools/scrape_url')"),
        was_successful: z.boolean().describe("Whether the service call succeeded"),
        response_time_ms: z.number().optional().describe("Response time in milliseconds"),
        notes: z.string().optional().describe("Optional notes about the outcome"),
      },
      {},
      async ({ service_id, was_successful, response_time_ms, notes }: {
        service_id: string;
        was_successful: boolean;
        response_time_ms?: number;
        notes?: string;
      }, extra: unknown) => {
        const reporter = payingWallet(extra);
        if (!reporter) return toolError(NO_PAYER);
        try {
          return toolResult(await reportOutcome({ service_id, was_successful, response_time_ms, notes }, reporter));
        } catch (err) {
          return toolError(err);
        }
      }
    );
  },
  x402Config,
  {
    serverInfo: { name: "harvey-verify", version: "1.0.0" },
  },
  {
    maxDuration: 300,
    verboseLogs: process.env.NODE_ENV !== "production",
    // No Redis here: without this, an anonymous GET /sse or POST /message
    // throws "redisUrl is required" in an unawaited promise and kills the process.
    disableSse: true,
  }
);

// ── Hono HTTP Server ─────────────────────────────────────────

// A rejected promise inside the MCP transport must not stop the process and every
// in-flight call with it (a paid call cut off after settlement is charged).
process.on("unhandledRejection", (reason) => {
  console.error("[mcp] unhandled rejection, process kept alive:", reason);
});

const app = new Hono();

// Health + pricing endpoints (outside MCP, for monitoring/discovery)
app.get("/health", (c) => c.json(health()));
app.get("/pricing", (c) => c.json(listTools()));

// Agent discovery routes
registerDiscoveryRoutes(app);

// Landing pages for human visitors
app.get("/", (c) => c.html(landingHtml()));
app.get("/dev", (c) => c.html(devHtml()));

// MCP handler - x402 only
// mcp-handler parses POST bodies outside a try, so a malformed body would reject
// unhandled and stop the process. Answer it with a JSON-RPC parse error instead.
app.all("*", async (c) => {
  if (c.req.method === "POST") {
    try {
      JSON.parse(await c.req.raw.clone().text());
    } catch {
      return c.json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }, 400);
    }
  }
  return paidHandler(c.req.raw);
});

// ── Start ────────────────────────────────────────────────────

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`Harvey Verify MCP server running on port ${config.port}`);
  console.log(`  MCP endpoint: http://localhost:${config.port}/`);
  console.log(`  Health: http://localhost:${config.port}/health`);
  console.log(`  Pricing: http://localhost:${config.port}/pricing`);
  console.log(`  Auth: x402 USDC only`);
  console.log(`  Payment wallet: ${config.payment.wallet}`);
  console.log(`  Facilitator: ${config.payment.facilitator}`);
  console.log(`  Network: ${config.payment.network} (${config.payment.currency})`);
});
