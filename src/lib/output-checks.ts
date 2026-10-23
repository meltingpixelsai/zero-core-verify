/**
 * Deterministic checks for verify_outcome. What code can decide, code decides:
 * whether the response is the JSON the caller's schema asks for, whether its
 * required fields are present, and whether a measured response time met a
 * stated limit. The AI judge cannot change these results, whatever the judged
 * response says. The judged service writes response_data, so it can address
 * the judge (scan finding F1, 10-22); prompt wording alone cannot stop that.
 *
 * expected_schema can be a JSON Schema (the subset below) or a list of two or
 * more required top-level field names ("name, price, url"). Anything else is
 * prose and is not checked by code. format_compliance is false only for a
 * definite failure, true only when code checked everything the schema says,
 * and null when it could not (unsupported keywords, too much work, prose).
 * Where a keyword could excuse what a checked keyword refuses (nullable,
 * patternProperties, prefixItems, $ref), code reports no failure it might
 * excuse.
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
  /**
   * 0-100, the share of the required top-level fields present; 100 only when all are. A present but empty value
   * counts: whether it is enough is the judge's call. null when no required fields apply. Below 100 always comes
   * with format_compliance false.
   */
  required_present: number | null;
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
/** Single words callers write for a format. A list of nothing but these names formats, not fields. */
const FORMAT_WORDS = new Set(["json", "xml", "html", "markdown", "md", "text", "plain", "csv", "yaml", "yml", "pdf", "string", "number", "object", "array"]);
/** A field name code checks: letters, digits, _ and -. A dot may mean a nested path, so a list with one is prose. */
const FIELD_NAME = /^[A-Za-z_][\w-]*$/;
/** Draft 7 and older ignore every other keyword beside these, so nothing at such a node can fail definitely. */
const REF_KEYWORDS = ["$ref", "$dynamicRef", "$recursiveRef"];
const MAX_DEPTH = 32;
const MAX_SCHEMA_NODES = 2_000;
const MAX_ISSUES = 20;
const MAX_FIELDS = 100;
/** Value, key and field checks allowed per response; past this, format is "not checked". */
const WORK_BUDGET = 200_000;

interface Compiled {
  /** Accepts anything: a $ref, a `true` schema, or a part of the schema past the size limits. */
  any: boolean;
  types: Set<string> | null;
  enumValues: Set<string> | null;
  /** OpenAPI's nullable: it may allow null beside `type` and `enum`, so a null here is never a definite failure. */
  nullable: boolean;
  required: string[];
  properties: Map<string, Compiled>;
  items: Compiled | null;
  /** items applies from this index on: in 2020-12, prefixItems covers the elements before it. */
  itemsFrom: number;
  noExtraProperties: boolean;
}

interface CompileContext {
  nodes: number;
  /** Part of the schema was past MAX_SCHEMA_NODES or MAX_DEPTH and is not checked. */
  tooBig: boolean;
  unsupported: Set<string>;
}

/** Text made safe to store and show: no control characters (but newline and tab) or lone surrogates; at most `max`. */
export function safeText(text: string, max = 300): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code < 0x20 && ch !== "\n" && ch !== "\t") || code === 0x7f) continue;
    const safe = code >= 0xd800 && code <= 0xdfff ? "�" : ch;
    if (out.length + safe.length > max) break;
    out += safe;
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
  if (/^[A-Za-z_][\w-]*(?:[ \t]*(?:,|\r?\n)[ \t]*[A-Za-z_][\w-]*)+$/.test(text)) {
    return fieldList(text.split(/[ \t]*(?:,|\r?\n)[ \t]*/).filter(Boolean));
  }
  return { kind: "prose", reason: "expected_schema is prose, not a JSON Schema or a list of field names" };
}

function fieldList(names: string[]): SchemaSpec {
  const fields = [...new Set(names)];
  if (fields.length < 2) return { kind: "prose", reason: "a single word is read as a format, not a field list" };
  if (fields.length > MAX_FIELDS) return { kind: "prose", reason: `more than ${MAX_FIELDS} field names` };
  if (fields.every((f) => FORMAT_WORDS.has(f.toLowerCase()))) return { kind: "prose", reason: "the list names formats, not fields" };
  if (!fields.every((f) => FIELD_NAME.test(f))) return { kind: "prose", reason: "a name is not a plain field name (a dot may mean a nested path)" };
  return { kind: "fields", fields };
}

function anyNode(): Compiled {
  return { any: true, types: null, enumValues: null, nullable: false, required: [], properties: new Map(), items: null, itemsFrom: 0, noExtraProperties: false };
}

/**
 * Compile a schema once. What code cannot check goes into ctx.unsupported; a part past the size limits compiles to a
 * node that accepts anything and sets ctx.tooBig, so the checks above it still run.
 */
function compile(schema: Record<string, unknown>, depth: number, ctx: CompileContext): Compiled {
  if (++ctx.nodes > MAX_SCHEMA_NODES || depth > MAX_DEPTH) {
    ctx.tooBig = true;
    return anyNode();
  }
  if (REF_KEYWORDS.some((k) => Object.hasOwn(schema, k))) {
    ctx.unsupported.add("$ref");
    return anyNode();
  }
  const node: Compiled = { any: false, types: null, enumValues: null, nullable: false, required: [], properties: new Map(), items: null, itemsFrom: 0, noExtraProperties: false };
  let patterned = false;
  for (const key of Object.keys(schema)) {
    if (ANNOTATIONS.has(key)) continue;
    const v = schema[key];
    switch (key) {
      case "type": {
        const names = Array.isArray(v) ? v : [v];
        if (names.length > 0 && names.every((n) => typeof n === "string" && TYPE_NAMES.has(n))) node.types = new Set(names as string[]);
        else ctx.unsupported.add("type");
        break;
      }
      case "enum":
        if (Array.isArray(v) && v.every(isPrimitive)) node.enumValues = new Set(v.map((e) => JSON.stringify(e)));
        else ctx.unsupported.add("enum with objects or arrays");
        break;
      case "required":
        if (Array.isArray(v) && v.every((r) => typeof r === "string")) node.required = [...new Set(v as string[])];
        else ctx.unsupported.add("required");
        break;
      case "properties":
        if (!isPlainObject(v)) {
          ctx.unsupported.add("properties");
          break;
        }
        for (const [name, sub] of Object.entries(v)) {
          if (isPlainObject(sub)) {
            node.properties.set(name, compile(sub, depth + 1, ctx));
          } else {
            // `true` accepts anything; `false` (the property is forbidden) is not checked.
            if (sub !== true) ctx.unsupported.add("property schemas that are not objects");
            node.properties.set(name, anyNode());
          }
        }
        break;
      case "items":
        if (isPlainObject(v)) node.items = compile(v, depth + 1, ctx);
        else ctx.unsupported.add("items");
        break;
      case "additionalProperties":
        if (v === false) node.noExtraProperties = true;
        else if (v !== true) ctx.unsupported.add("additionalProperties as a schema");
        break;
      case "nullable":
      case "x-nullable":
        if (v === true) node.nullable = true;
        else if (v !== false) ctx.unsupported.add(key);
        break;
      case "patternProperties":
        // A property matching a pattern is not "additional", and code does not run the caller's patterns.
        patterned = true;
        ctx.unsupported.add("patternProperties");
        break;
      case "prefixItems":
        // In 2020-12 items covers only the elements after prefixItems; older drafts ignore prefixItems.
        node.itemsFrom = Array.isArray(v) ? v.length : Infinity;
        ctx.unsupported.add("prefixItems");
        break;
      default:
        ctx.unsupported.add(safeText(key, 40));
    }
  }
  if (patterned) node.noExtraProperties = false;
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

function typeAllows(node: Compiled, value: unknown): boolean {
  if (!node.types) return true;
  for (const type of node.types) if (matchesType(value, type)) return true;
  return false;
}

const enumAllows = (node: Compiled, value: unknown): boolean => !node.enumValues || (isPrimitive(value) && node.enumValues.has(JSON.stringify(value)));

class Checker {
  issues: string[] = [];
  overflow = 0;
  work = 0;
  exhausted = false;
  /** Why this response cannot be reported true although nothing failed. */
  uncertain = new Set<string>();

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
    if (!this.spend() || node.any) return;
    if (value === null && node.nullable && !(typeAllows(node, null) && enumAllows(node, null))) {
      // OpenAPI allows this null; JSON Schema ignores nullable and refuses it. Neither a pass nor a failure.
      this.uncertain.add("a null that only nullable allows");
      return;
    }
    if (!typeAllows(node, value)) {
      this.issue(`${where}: expected ${[...(node.types ?? [])].join(" or ")}, got ${typeOf(value)}`);
      return;
    }
    if (!enumAllows(node, value)) this.issue(`${where}: not one of the allowed values`);
    if (isPlainObject(value)) {
      for (const name of node.required) {
        if (!this.spend()) return;
        if (!Object.hasOwn(value, name)) this.issue(`${where}.${name}: missing`);
      }
      // One pass over the object's own keys, so the work follows the response, not the schema's property count.
      for (const name of Object.keys(value)) {
        if (!this.spend()) return;
        const child = node.properties.get(name);
        if (child) this.validate(value[name], child, `${where}.${name}`);
        else if (node.noExtraProperties) this.issue(`${where}.${name}: not allowed by the schema`);
        if (this.exhausted) return;
      }
    }
    if (Array.isArray(value) && node.items) {
      for (let i = node.itemsFrom; i < value.length; i++) {
        this.validate(value[i], node.items, `${where}[${i}]`);
        if (this.exhausted) return;
      }
    }
  }
}

/** Everything code can decide about a response, before and regardless of the AI judge. */
export function runOutputChecks(input: OutputCheckInput): OutputChecks {
  const out: OutputChecks = { format_compliance: null, required_present: null, sla_met: null, issues: [], checked: [], not_checked: [] };
  const spec = parseSchemaSpec(input.expected_schema);

  if (!spec) {
    out.not_checked.push("format: no expected_schema given");
  } else if (spec.kind === "prose") {
    out.not_checked.push(`format: ${spec.reason}`);
  } else {
    const ctx: CompileContext = { nodes: 0, tooBig: false, unsupported: new Set() };
    const root = spec.kind === "json-schema" ? compile(spec.schema, 0, ctx) : null;
    // Deduplicated, so counting them costs at most the schema's size.
    const required = spec.kind === "fields" ? spec.fields : (root?.required ?? []);
    let value: unknown;
    let isJson = true;
    try {
      value = JSON.parse(input.response_data);
    } catch {
      isJson = false;
    }
    if (!isJson) {
      out.format_compliance = false;
      out.issues.push("response_data is not valid JSON");
      out.checked.push("format: the response is not JSON");
      if (required.length) out.required_present = 0;
    } else {
      const checker = new Checker();
      // Required fields apply only to an object: a value that is not one has none present only where an object is a must.
      let mustBeObject = true;
      if (root) {
        checker.validate(value, root, "$");
        out.checked.push("format: validated against the JSON Schema");
        mustBeObject = root.types?.size === 1 && root.types.has("object") && !(value === null && root.nullable);
      } else if (spec.kind === "fields") {
        if (!isPlainObject(value)) checker.issue(`$: expected an object with ${spec.fields.join(", ")}, got ${typeOf(value)}`);
        else for (const name of spec.fields) if (!Object.hasOwn(value, name)) checker.issue(`$.${name}: missing`);
        out.checked.push(`format: required fields ${spec.fields.join(", ")}`);
      }
      if (ctx.tooBig) out.not_checked.push(`format: the schema is larger or deeper than code checks (${MAX_SCHEMA_NODES} nodes, ${MAX_DEPTH} levels); the rest was not checked`);
      if (checker.exhausted) out.not_checked.push("format: the check stopped at its work limit");
      if (ctx.unsupported.size) out.not_checked.push(`schema keywords not checked by code: ${[...ctx.unsupported].sort().join(", ")}`);
      if (checker.uncertain.size) out.not_checked.push(`format: ${[...checker.uncertain].join("; ")}`);
      const complete = !ctx.tooBig && !checker.exhausted && ctx.unsupported.size === 0 && checker.uncertain.size === 0;
      out.format_compliance = checker.issues.length > 0 ? false : complete ? true : null;
      out.issues.push(...checker.issues);
      if (checker.overflow) out.issues.push(`and ${checker.overflow} more problems`);
      if (required.length && isPlainObject(value)) {
        const object = value;
        const present = required.filter((name) => Object.hasOwn(object, name)).length;
        out.required_present = Math.floor((present / required.length) * 100);
        out.checked.push(`required fields: ${present} of ${required.length} present`);
      } else if (required.length && mustBeObject) {
        out.required_present = 0;
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
