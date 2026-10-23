import "dotenv/config";
import type { Server } from "node:http";
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
import { MCP_ALLOWED_METHODS, mcpRequestProblem } from "./lib/request-guard.js";
import { installGracefulShutdown } from "./lib/graceful-shutdown.js";

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
      { name: "verify_outcome", description: "Code-checked verification of service outcomes, with an advisory AI judge", price: "$0.01" },
      { name: "get_service_quality", description: "Aggregated quality scores for a service (self-reported, unattested)", price: "$0.005" },
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

// mcp-handler serves all clients through one transport that knows a request
// only by its JSON-RPC id, and every client numbers its requests from the
// start, so two clients' calls with the same id could get each other's answers,
// a paid result included. Each request therefore gets its own handler, with its
// own server and transport; building one registers the tools (milliseconds).
const createPaidHandler = () => createMcpPaidHandler(
  (server) => {
    registerFreeTools(server);
    const paidTool = settleFirst(server);

    paidTool(
      "verify_outcome",
      "Post-transaction verification. Code checks what it can: the response against expected_schema (a JSON Schema or a list of required field names), and a measured response time against a stated limit. An AI judge scores accuracy and completeness as advice; it cannot pass a response that fails code's checks. Returns a verdict (pass, fail or inconclusive), scores, format compliance, SLA result, issues, and what code checked.",
      "$0.01",
      {
        request_description: z.string().max(8_000).describe("What was requested from the service"),
        response_data: z.string().max(100_000).describe("The actual response/output received from the service"),
        expected_schema: z.string().max(20_000).optional().describe("A JSON Schema, or required field names separated by commas (e.g. 'name, price, url'). Prose is passed to the AI judge only."),
        sla_requirements: z.string().max(2_000).optional().describe("SLA wording for the AI judge (e.g. 'must include all fields'). For a time limit code can check, use the two fields below."),
        service_id: z.string().max(200).optional().describe("Service identifier for quality tracking (e.g. 'harvey-tools/scrape_url')"),
        observed_response_time_ms: z.number().int().min(0).max(3_600_000).optional().describe("The response time you measured, in milliseconds"),
        sla_max_response_time_ms: z.number().int().min(0).max(3_600_000).optional().describe("The response time limit, in milliseconds"),
      },
      {},
      async ({ request_description, response_data, expected_schema, sla_requirements, service_id, observed_response_time_ms, sla_max_response_time_ms }: {
        request_description: string;
        response_data: string;
        expected_schema?: string;
        sla_requirements?: string;
        service_id?: string;
        observed_response_time_ms?: number;
        sla_max_response_time_ms?: number;
      }, extra: unknown) => {
        const reporter = payingWallet(extra);
        if (!reporter) return toolError(NO_PAYER);
        try {
          return toolResult(
            await verifyOutcome(
              { request_description, response_data, expected_schema, sla_requirements, service_id, observed_response_time_ms, sla_max_response_time_ms },
              reporter
            )
          );
        } catch (err) {
          return toolError(err);
        }
      }
    );

    paidTool(
      "get_service_quality",
      "Get aggregated quality scores for a service based on past verifications and reports, counting each paying wallet once (its latest). Returns average completeness, accuracy, pass rate, format compliance rate, SLA compliance rate, and quality trend. The scores are self-reported by paying wallets and not attested: nothing proves a reporter used the service.",
      "$0.005",
      {
        service_id: z.string().max(200).describe("Service identifier to query (e.g. 'harvey-tools/scrape_url')"),
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
        service_id: z.string().max(200).describe("Service identifier (e.g. 'harvey-tools/scrape_url')"),
        was_successful: z.boolean().describe("Whether the service call succeeded"),
        response_time_ms: z.number().int().min(0).max(3_600_000).optional().describe("Response time in milliseconds"),
        notes: z.string().max(2_000).optional().describe("Optional notes about the outcome"),
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
// Requests mcp-handler would throw on in a promise nobody awaits (a body that is
// not JSON, or JSON too deep to re-serialize), never answer (PUT, PATCH, HEAD),
// or misroute (one client's cancellation of another client's call) are answered
// here instead. See src/lib/request-guard.ts.
app.all("*", async (c) => {
  let body: string | null = null;
  if (c.req.method === "POST") {
    try {
      body = await c.req.raw.clone().text();
    } catch {
      return c.json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }, 400);
    }
  }
  const problem = mcpRequestProblem(c.req.method, body);
  if (problem?.status === 202) return c.body(null, 202);
  if (problem) {
    if (problem.status === 405) c.header("Allow", MCP_ALLOWED_METHODS);
    return c.json({ jsonrpc: "2.0", error: { code: problem.code, message: problem.message }, id: null }, problem.status);
  }
  return createPaidHandler()(c.req.raw);
});

// ── Start ────────────────────────────────────────────────────

// serve() returns an http.Server here (no createServer option is passed).
const server = serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`Harvey Verify MCP server running on port ${config.port}`);
  console.log(`  MCP endpoint: http://localhost:${config.port}/`);
  console.log(`  Health: http://localhost:${config.port}/health`);
  console.log(`  Pricing: http://localhost:${config.port}/pricing`);
  console.log(`  Auth: x402 USDC only`);
  console.log(`  Payment wallet: ${config.payment.wallet}`);
  console.log(`  Facilitator: ${config.payment.facilitator}`);
  console.log(`  Network: ${config.payment.network} (${config.payment.currency})`);
}) as Server;

// A stop or restart lets paid calls in flight finish. See src/lib/graceful-shutdown.ts.
installGracefulShutdown(server);
