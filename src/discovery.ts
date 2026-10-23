import type { Hono } from "hono";

/** Register all agent discovery routes on the Hono app */
export function registerDiscoveryRoutes(app: Hono): void {
  app.get("/llms.txt", (c) => {
    return c.text(LLMS_TXT, 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    });
  });

  const agentCardHandler = (c: any) =>
    c.json(AGENT_CARD, 200, {
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    });
  app.get("/.well-known/agent-card.json", agentCardHandler);
  app.get("/.well-known/agent.json", agentCardHandler);


  app.get("/.well-known/mcp.json", (c) => {
    return c.json(MCP_CARD, 200, {
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    });
  });

  app.get("/.well-known/mcp/server-card.json", (c) => {
    return c.json(MCP_CARD, 200, {
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    });
  });
}
// ── Static Content ────────────────────────────────────────────

const LLMS_TXT = `# Harvey Verify - Agent Outcome Verification MCP Server

> MCP server for AI agents. Post-transaction verification - check if services delivered what was promised.
> LLM-as-judge scoring with quality database. Pay per call with USDC via x402 micropayments. No account needed.
> Built by MeltingPixels.

## Tools (5 total, 2 free + 3 paid)
- [list_tools](https://verify.rugslayer.com/mcp): List all tools with pricing (FREE)
- [health](https://verify.rugslayer.com/mcp): Server status and payment config (FREE)
- [verify_outcome](https://verify.rugslayer.com/mcp): LLM-as-judge verification of service outcomes ($0.01)
- [get_service_quality](https://verify.rugslayer.com/mcp): Aggregated quality scores for a service, one vote per paying wallet ($0.005)
- [report_outcome](https://verify.rugslayer.com/mcp): Simple pass/fail outcome report ($0.002)

## Connection
- [MCP Endpoint](https://verify.rugslayer.com/mcp): Connect directly via MCP
- [npm](https://www.npmjs.com/package/@meltingpixels/harvey-verify): @meltingpixels/harvey-verify
- [Claude Code](https://verify.rugslayer.com/mcp): claude mcp add harvey-verify --transport http https://verify.rugslayer.com/mcp

## Authentication
- [x402 USDC](https://verify.rugslayer.com/mcp): Pay per call on Solana, no account needed

## Pricing
- verify_outcome: $0.01 USDC per call
- get_service_quality: $0.005 USDC per call
- report_outcome: $0.002 USDC per call
`;

const AGENT_CARD = {
  name: "Harvey Verify",
  description:
    "MCP server for AI agents providing post-transaction outcome verification. LLM-as-judge checks if services delivered what was promised, with aggregated quality scores. Pay per call with USDC via x402.",
  version: "1.0.0",
  supportedInterfaces: [
    {
      url: "https://verify.rugslayer.com/mcp",
      protocolBinding: "HTTP+JSON",
      protocolVersion: "0.3",
    },
  ],
  provider: {
    organization: "MeltingPixels",
    url: "https://rugslayer.com",
  },
  iconUrl: "https://rugslayer.com/icon.svg",
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  securitySchemes: {
    x402: {
      httpSecurityScheme: {
        scheme: "x402",
        bearerFormat: "USDC micropayment on Solana",
      },
    },
  },
  defaultInputModes: ["application/json"],
  defaultOutputModes: ["application/json"],
  skills: [
    {
      id: "outcome-verification",
      name: "Outcome Verification",
      description: "LLM-as-judge verification of service outcomes. Scores completeness, accuracy, format compliance, and SLA adherence.",
      tags: ["verification", "quality", "llm-judge", "outcome"],
      examples: ["Verify this API response matches the request", "Check if the service output is correct"],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "service-quality",
      name: "Service Quality Scores",
      description: "Aggregated quality metrics for any service - pass rate, average scores, trends.",
      tags: ["quality", "reputation", "analytics", "scores"],
      examples: ["What's the quality score for this service?", "Show me the pass rate"],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
    {
      id: "outcome-reporting",
      name: "Outcome Reporting",
      description: "Simple pass/fail outcome reports to build the quality database without LLM analysis.",
      tags: ["reporting", "outcomes", "quality-data"],
      examples: ["Report that this service call succeeded", "Log a failed outcome"],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
    },
  ],
};

const MCP_CARD = {
  mcp_version: "2025-11-25",
  name: "harvey-verify",
  display_name: "Harvey Verify - Agent Outcome Verification",
  description:
    "MCP server for AI agents. Post-transaction verification using LLM-as-judge. Checks if services delivered what was promised, with quality database and service reputation scores. Pay per call with USDC via x402.",
  version: "1.0.0",
  vendor: "MeltingPixels",
  homepage: "https://verify.rugslayer.com",
  endpoints: {
    streamable_http: "https://verify.rugslayer.com/mcp",
  },
  pricing: {
    model: "paid",
    free_tools: ["list_tools", "health"],
    paid_tools: {
      verify_outcome: "$0.01",
      get_service_quality: "$0.005",
      report_outcome: "$0.002",
    },
    payment_methods: ["x402_usdc_solana"],
  },
  rate_limits: {
    x402: "unlimited (pay per call)",
  },
  tools: [
    {
      name: "list_tools",
      description: "List all available tools with pricing and input requirements.",
      price: "FREE",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "health",
      description: "Server status, uptime, and payment network configuration.",
      price: "FREE",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "verify_outcome",
      description: "LLM-as-judge verification of a service outcome. Scores completeness, accuracy, format compliance.",
      price: "$0.01 USDC",
      input_schema: {
        type: "object",
        required: ["request_description", "response_data"],
        properties: {
          request_description: { type: "string", description: "What was requested from the service" },
          response_data: { type: "string", description: "The actual response/output received" },
          expected_schema: { type: "string", description: "Expected output format or schema" },
          sla_requirements: { type: "string", description: "SLA requirements to check against" },
          service_id: { type: "string", description: "Service identifier for quality tracking" },
        },
      },
    },
    {
      name: "get_service_quality",
      description: "Aggregated quality scores for a service counting each paying wallet once (its latest report).",
      price: "$0.005 USDC",
      input_schema: {
        type: "object",
        required: ["service_id"],
        properties: {
          service_id: { type: "string", description: "Service identifier to query" },
        },
      },
    },
    {
      name: "report_outcome",
      description: "Simple pass/fail outcome report without LLM analysis.",
      price: "$0.002 USDC",
      input_schema: {
        type: "object",
        required: ["service_id", "was_successful"],
        properties: {
          service_id: { type: "string", description: "Service identifier" },
          was_successful: { type: "boolean", description: "Whether the service call succeeded" },
          response_time_ms: { type: "number", description: "Response time in milliseconds" },
          notes: { type: "string", description: "Optional notes about the outcome" },
        },
      },
    },
  ],
  install: {
    npm: "npx -y @meltingpixels/harvey-verify",
    claude_code: "claude mcp add harvey-verify --transport http https://verify.rugslayer.com/mcp",
    claude_desktop: {
      command: "npx",
      args: ["-y", "@meltingpixels/harvey-verify"],
      env: {},
    },
  },
  categories: ["verification", "quality-assurance", "agent-infrastructure"],
  tags: ["verification", "outcome", "quality", "llm-judge", "x402", "usdc", "agent-trust"],
};
