/**
 * Deterministic checks for verify_outcome. What code can decide, code decides:
 * whether the response is the JSON the caller's schema asks for, how many of
 * its required fields are filled, and whether a measured response time met a
 * stated limit. The AI judge cannot change these results, whatever the judged
 * response says. The judged service writes response_data, so it can address
 * the judge (scan finding F1, 10-22); prompt wording alone cannot stop that.
 *
 * expected_schema can be a JSON Schema (the subset below) or a list of two or
 * more required top-level field names ("name, price, url"). Anything else is
 * prose and is not checked by code. format_compliance is false only for a
 * definite failure, true only when code checked everything the schema says,
 * and null when it could not (unsupported keywords, too much work, prose).
 *
 * The schema is compiled once and every check is counted against a work
 * budget, so a crafted schema and response cannot hold the server.
 */

export type SchemaSpec = { kind: "json-schema"; schema: Record<string, unknown> } | { kind: "fields"; fields: string[] } | { kind: "prose"; reason: string };

export interface OutputCheckInput {
  response_data: string;
  expected_schema?: string;
  observed_response_time_ms?: number;
  sla_max_response_time_ms?: number;
}

export interface OutputChecks {
  /** false: a definite failure; true: everything checked and met; null: not (fully) checkable by code. */
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

const TYPE_NAMES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
/** Keywords that only describe; nothing to check. */
const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "default", "examples", "$comment"]);
/** Single words callers write for a format; never field names. */
const FORMAT_WORDS = new Set(["json", "xml", "html", "markdown", "md", "text", "plain", "csv", "yaml", "yml", "pdf", "string", "number", "object", "array"]);
const MAX_DEPTH = 32;
const MAX_SCHEMA_NODES = 2_000;
const MAX_ISSUES = 20;
const MAX_FIELDS = 100;
/** Value-and-node checks allowed per response; past this, format is "not checked". */
const WORK_BUDGET = 200_000;

interface Compiled {
  types: Set<string> | null;
  enumValues: Set<string> | null;
  required: string[];
  properties: Map<string, Compiled>;
  items: Compiled | null;
  noExtraProperties: boolean;
}

/** Text from the response (key names) made safe to store and show: no control characters or lone surrogates. */
export function safeText(text: string, max = 300): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code < 0x20 && ch !== "\n" && ch !== "\t") || code === 0x7f) continue;
    out += code >= 0xd800 && code <= 0xdfff ? "�" : ch;
    if (out.length >= max) break;
  }
  return out;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPrimitive = (v: unknown): boolean => v === null || ["string", "number", "boolean"].includes(typeof v);

/** True when `value` looks like a JSON Schema we can read: every schema keyword present has the right shape. */
function looksLikeSchema(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  if (!["type", "properties", "required", "items", "enum"].some((k) => Object.hasOwn(value, k))) return false;
  if (Object.hasOwn(value, "type")) {
    const t = value.type;
    const names = Array.isArray(t) ? t : [t];
    if (names.length === 0 || !names.every((n) => typeof n === "string" && TYPE_NAMES.has(n))) return false;
  }
  if (Object.hasOwn(value, "properties") && !isPlainObject(value.properties)) return false;
  if (Object.hasOwn(value, "required") && !(Array.isArray(value.required) && value.required.every((r) => typeof r === "string"))) return false;
  if (Object.hasOwn(value, "items") && !isPlainObject(value.items)) return false;
  if (Object.hasOwn(value, "enum") && !Array.isArray(value.enum)) return false;
  return true;
}

/** How the caller described the expected output, or null when it gave none. */
export function parseSchemaSpec(expected?: string): SchemaSpec | null {
  const text = (expected ?? "").trim();
  if (!text) return null;
  let parsed: unknown;
  let isJson = true;
  try {
    parsed = JSON.parse(text);
  } catch {
    isJson = false;
  }
  if (isJson) {
    if (Array.isArray(parsed) && parsed.length >= 2 && parsed.every((f) => typeof f === "string")) return fieldList(parsed as string[]);
    if (looksLikeSchema(parsed)) return { kind: "json-schema", schema: parsed };
    return { kind: "prose", reason: "expected_schema is JSON but not a JSON Schema this checks (an example?)" };
  }
  // Separators are a comma or a line break with spaces or tabs around them; the parts never overlap, so the
  // pattern cannot backtrack.
  if (/^[A-Za-z_][\w.-]*(?:[ \t]*(?:,|\r?\n)[ \t]*[A-Za-z_][\w.-]*)+$/.test(text)) {
    return fieldList(text.split(/[ \t]*(?:,|\r?\n)[ \t]*/).filter(Boolean));
  }
  return { kind: "prose", reason: "expected_schema is prose, not a JSON Schema or a list of field names" };
}

function fieldList(names: string[]): SchemaSpec {
  const fields = [...new Set(names)];
  if (fields.length < 2) return { kind: "prose", reason: "a single word is read as a format, not a field list" };
  if (fields.length > MAX_FIELDS) return { kind: "prose", reason: `more than ${MAX_FIELDS} field names` };
  if (fields.some((f) => FORMAT_WORDS.has(f.toLowerCase()))) return { kind: "prose", reason: "the list names a format, not fields" };
  return { kind: "fields", fields };
}

/** Compile a schema once; anything code cannot check is recorded in `unsupported`. Returns null past the limits. */
function compile(schema: Record<string, unknown>, depth: number, unsupported: Set<string>, count: { nodes: number }): Compiled | null {
  if (++count.nodes > MAX_SCHEMA_NODES || depth > MAX_DEPTH) return null;
  const node: Compiled = { types: null, enumValues: null, required: [], properties: new Map(), items: null, noExtraProperties: false };
  for (const key of Object.keys(schema)) {
    if (ANNOTATIONS.has(key)) continue;
    const v = schema[key];
    switch (key) {
      case "type": {
        const names = Array.isArray(v) ? v : [v];
        if (names.every((n) => typeof n === "string" && TYPE_NAMES.has(n))) node.types = new Set(names as string[]);
        else unsupported.add("type");
        break;
      }
      case "enum":
        if (Array.isArray(v) && v.every(isPrimitive)) node.enumValues = new Set(v.map((e) => JSON.stringify(e)));
        else unsupported.add("enum with objects or arrays");
        break;
      case "required":
        if (Array.isArray(v) && v.every((r) => typeof r === "string")) node.required = v as string[];
        else unsupported.add("required");
        break;
      case "properties":
        if (!isPlainObject(v)) {
          unsupported.add("properties");
          break;
        }
        for (const [name, sub] of Object.entries(v)) {
          if (!isPlainObject(sub)) {
            unsupported.add("boolean property schemas");
            continue;
          }
          const child = compile(sub, depth + 1, unsupported, count);
          if (!child) return null;
          node.properties.set(name, child);
        }
        break;
      case "items": {
        if (!isPlainObject(v)) {
          unsupported.add("items");
          break;
        }
        const child = compile(v, depth + 1, unsupported, count);
        if (!child) return null;
        node.items = child;
        break;
      }
      case "additionalProperties":
        if (v === false) node.noExtraProperties = true;
        else if (v !== true) unsupported.add("additionalProperties as a schema");
        break;
      default:
        unsupported.add(safeText(key, 40));
    }
  }
  return node;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeOf(value) === type;
}

class Checker {
  issues: string[] = [];
  overflow = 0;
  work = 0;
  exhausted = false;

  issue(text: string): void {
    if (this.issues.length < MAX_ISSUES) this.issues.push(safeText(text));
    else this.overflow++;
  }

  spend(units = 1): boolean {
    this.work += units;
    if (this.work > WORK_BUDGET) this.exhausted = true;
    return !this.exhausted;
  }

  validate(value: unknown, node: Compiled, where: string): void {
    if (!this.spend()) return;
    if (node.types && ![...node.types].some((t) => matchesType(value, t))) {
      this.issue(`${where}: expected ${[...node.types].join(" or ")}, got ${typeOf(value)}`);
      return;
    }
    if (node.enumValues && !(isPrimitive(value) && node.enumValues.has(JSON.stringify(value)))) {
      this.issue(`${where}: not one of the allowed values`);
    }
    if (isPlainObject(value)) {
      for (const name of node.required) {
        if (!this.spend()) return;
        if (!Object.hasOwn(value, name)) this.issue(`${where}.${name}: missing`);
      }
      for (const [name, child] of node.properties) {
        if (Object.hasOwn(value, name)) this.validate(value[name], child, `${where}.${name}`);
        if (this.exhausted) return;
      }
      if (node.noExtraProperties) {
        for (const name of Object.keys(value)) {
          if (!this.spend()) return;
          if (!node.properties.has(name)) this.issue(`${where}.${name}: not allowed by the schema`);
        }
      }
    }
    if (Array.isArray(value) && node.items) {
      for (let i = 0; i < value.length; i++) {
        this.validate(value[i], node.items, `${where}[${i}]`);
        if (this.exhausted) return;
      }
    }
  }
}

const filled = (v: unknown): boolean => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0) && !(isPlainObject(v) && Object.keys(v).length === 0);

/** Everything code can decide about a response, before and regardless of the AI judge. */
export function runOutputChecks(input: OutputCheckInput): OutputChecks {
  const out: OutputChecks = { format_compliance: null, completeness_cap: null, sla_met: null, issues: [], checked: [], not_checked: [] };
  const spec = parseSchemaSpec(input.expected_schema);

  if (!spec) {
    out.not_checked.push("format: no expected_schema given");
  } else if (spec.kind === "prose") {
    out.not_checked.push(`format: ${spec.reason}`);
  } else {
    let value: unknown;
    let isJson = true;
    try {
      value = JSON.parse(input.response_data);
    } catch {
      isJson = false;
    }
    const required = spec.kind === "fields" ? spec.fields : Array.isArray(spec.schema.required) ? (spec.schema.required as unknown[]).filter((r): r is string => typeof r === "string") : [];
    if (!isJson) {
      out.format_compliance = false;
      out.issues.push("response_data is not valid JSON");
      out.checked.push("format: the response is not JSON");
      if (required.length) out.completeness_cap = 0;
    } else {
      const checker = new Checker();
      const unsupported = new Set<string>();
      if (spec.kind === "json-schema") {
        const compiled = compile(spec.schema, 0, unsupported, { nodes: 0 });
        if (!compiled) {
          out.not_checked.push(`format: the schema is larger or deeper than code checks (${MAX_SCHEMA_NODES} nodes, ${MAX_DEPTH} levels)`);
        } else {
          checker.validate(value, compiled, "$");
          out.checked.push("format: validated against the JSON Schema");
        }
      } else if (!isPlainObject(value)) {
        checker.issue(`$: expected an object with ${spec.fields.join(", ")}, got ${typeOf(value)}`);
        out.checked.push(`format: required fields ${spec.fields.join(", ")}`);
      } else {
        for (const name of spec.fields) if (!Object.hasOwn(value, name)) checker.issue(`$.${name}: missing`);
        out.checked.push(`format: required fields ${spec.fields.join(", ")}`);
      }
      if (checker.exhausted) {
        out.not_checked.push("format: the check stopped at its work limit");
      }
      if (unsupported.size) {
        out.not_checked.push(`schema keywords not checked by code: ${[...unsupported].sort().join(", ")}`);
      }
      const failed = checker.issues.length > 0;
      const complete = !checker.exhausted && unsupported.size === 0 && (spec.kind === "fields" || out.checked.length > 0);
      out.format_compliance = failed ? false : complete ? true : null;
      out.issues.push(...checker.issues);
      if (checker.overflow) out.issues.push(`and ${checker.overflow} more problems`);
      if (required.length && isPlainObject(value)) {
        const filledCount = required.filter((name) => Object.hasOwn(value as object, name) && filled((value as Record<string, unknown>)[name])).length;
        out.completeness_cap = Math.round((filledCount / required.length) * 100);
        out.checked.push(`completeness: ${filledCount} of ${required.length} required fields filled`);
      } else if (required.length) {
        out.completeness_cap = 0;
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
