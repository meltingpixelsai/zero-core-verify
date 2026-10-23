/**
 * Deterministic checks for verify_outcome. What code can decide, code decides:
 * whether the response is the JSON the caller's schema asks for, how many of
 * its required fields are filled, and whether a measured response time met a
 * stated limit. The AI judge cannot change these results, whatever the judged
 * response says. The judged service writes response_data, so it can address
 * the judge (scan finding F1, 10-22); prompt wording alone cannot stop that.
 *
 * expected_schema can be a JSON Schema (the subset below) or a plain list of
 * required top-level field names ("name, price, url"). Anything else is prose
 * and is not checked by code: format is reported as not checked, not guessed.
 */

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
  [keyword: string]: unknown;
}

export type SchemaSpec = { kind: "json-schema"; schema: JsonSchema } | { kind: "fields"; fields: string[] } | { kind: "prose" };

export interface OutputCheckInput {
  response_data: string;
  expected_schema?: string;
  observed_response_time_ms?: number;
  sla_max_response_time_ms?: number;
}

export interface OutputChecks {
  /** null: no machine-checkable schema was given. */
  format_compliance: boolean | null;
  /** 0-100, the share of required fields present and filled; null when no required fields are known. */
  completeness_cap: number | null;
  /** null: no measured time and limit were given. */
  sla_met: boolean | null;
  /** Problems code found (they go into the verification's issues). */
  issues: string[];
  /** What code checked, in words. */
  checked: string[];
  /** What code could not check, in words. */
  not_checked: string[];
}

const SCHEMA_KEYWORDS = ["type", "properties", "required", "items", "enum", "additionalProperties"];
/** Keywords that only describe; nothing to check. */
const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "default", "examples", "$comment"]);
const MAX_DEPTH = 32;
const MAX_ISSUES = 20;
const MAX_ARRAY_ITEMS = 1000;
const MAX_FIELDS = 100;

/** How the caller described the expected output, or null when it gave none. */
export function parseSchemaSpec(expected?: string): SchemaSpec | null {
  const text = (expected ?? "").trim();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((f) => typeof f === "string")) {
      return { kind: "fields", fields: [...new Set(parsed as string[])].slice(0, MAX_FIELDS) };
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && SCHEMA_KEYWORDS.some((k) => k in parsed)) {
      return { kind: "json-schema", schema: parsed as JsonSchema };
    }
    return { kind: "prose" };
  } catch {
    // not JSON: a plain list of field names, or prose
  }
  // Separators are a comma or a line break with spaces or tabs around them; the parts never overlap, so the
  // pattern cannot backtrack.
  if (/^[A-Za-z_][\w.-]*(?:[ \t]*(?:,|\r?\n)[ \t]*[A-Za-z_][\w.-]*)*$/.test(text)) {
    const fields = text.split(/[ \t]*(?:,|\r?\n)[ \t]*/).filter(Boolean);
    return { kind: "fields", fields: [...new Set(fields)].slice(0, MAX_FIELDS) };
  }
  return { kind: "prose" };
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return typeOf(value) === "object";
    default:
      return typeOf(value) === type;
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validate(value: unknown, schema: JsonSchema, where: string, issues: string[], unsupported: Set<string>, depth: number): void {
  if (issues.length >= MAX_ISSUES) return;
  if (depth > MAX_DEPTH) {
    unsupported.add(`schema nested deeper than ${MAX_DEPTH} levels`);
    return;
  }
  for (const keyword of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.includes(keyword) && !ANNOTATIONS.has(keyword)) unsupported.add(keyword);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, String(t)))) {
      issues.push(`${where}: expected ${types.join(" or ")}, got ${typeOf(value)}`);
      return;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => sameJson(e, value))) {
    issues.push(`${where}: not one of the allowed values`);
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      if (obj[name] === undefined) issues.push(`${where}.${name}: missing`);
    }
    const props = schema.properties ?? {};
    for (const [name, sub] of Object.entries(props)) {
      if (obj[name] !== undefined && sub && typeof sub === "object") validate(obj[name], sub, `${where}.${name}`, issues, unsupported, depth + 1);
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(obj)) if (!(name in props)) issues.push(`${where}.${name}: not allowed by the schema`);
    }
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === "object") {
    value.slice(0, MAX_ARRAY_ITEMS).forEach((item, i) => validate(item, schema.items as JsonSchema, `${where}[${i}]`, issues, unsupported, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) unsupported.add(`items after the first ${MAX_ARRAY_ITEMS}`);
  }
}

const filled = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0) && !(typeOf(v) === "object" && Object.keys(v as object).length === 0);

function completeness(value: unknown, required: string[]): { cap: number; filledCount: number } {
  if (typeOf(value) !== "object") return { cap: 0, filledCount: 0 };
  const obj = value as Record<string, unknown>;
  const filledCount = required.filter((name) => filled(obj[name])).length;
  return { cap: Math.round((filledCount / required.length) * 100), filledCount };
}

/** Everything code can decide about a response, before and regardless of the AI judge. */
export function runOutputChecks(input: OutputCheckInput): OutputChecks {
  const out: OutputChecks = { format_compliance: null, completeness_cap: null, sla_met: null, issues: [], checked: [], not_checked: [] };
  const spec = parseSchemaSpec(input.expected_schema);

  if (!spec) {
    out.not_checked.push("format: no expected_schema given");
  } else if (spec.kind === "prose") {
    out.not_checked.push("format: expected_schema is prose, not a JSON Schema or a field list");
  } else {
    let value: unknown;
    let isJson = true;
    try {
      value = JSON.parse(input.response_data);
    } catch {
      isJson = false;
    }
    const required = spec.kind === "fields" ? spec.fields : Array.isArray(spec.schema.required) ? spec.schema.required.filter((r) => typeof r === "string") : [];
    if (!isJson) {
      out.format_compliance = false;
      out.issues.push("response_data is not valid JSON");
      out.checked.push("format: the response is not JSON");
      if (required.length) out.completeness_cap = 0;
    } else {
      const issues: string[] = [];
      const unsupported = new Set<string>();
      if (spec.kind === "json-schema") {
        validate(value, spec.schema, "$", issues, unsupported, 0);
        out.checked.push("format: validated against the JSON Schema");
      } else {
        if (typeOf(value) !== "object") issues.push(`$: expected an object with ${spec.fields.join(", ")}, got ${typeOf(value)}`);
        else for (const name of spec.fields) if ((value as Record<string, unknown>)[name] === undefined) issues.push(`$.${name}: missing`);
        out.checked.push(`format: required fields ${spec.fields.join(", ")}`);
      }
      out.format_compliance = issues.length === 0;
      out.issues.push(...issues);
      if (unsupported.size) out.not_checked.push(`schema keywords not checked by code: ${[...unsupported].sort().join(", ")}`);
      if (required.length) {
        const { cap, filledCount } = completeness(value, required);
        out.completeness_cap = cap;
        out.checked.push(`completeness: ${filledCount} of ${required.length} required fields filled`);
      }
    }
  }

  const observed = input.observed_response_time_ms;
  const limit = input.sla_max_response_time_ms;
  if (typeof observed === "number" && typeof limit === "number") {
    out.sla_met = observed <= limit;
    out.checked.push(`sla: ${observed} ms measured against a ${limit} ms limit`);
    if (!out.sla_met) out.issues.push(`response time ${observed} ms is over the ${limit} ms limit`);
  } else {
    out.not_checked.push("sla: no measured response time and limit given");
  }
  return out;
}
