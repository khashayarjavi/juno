import { randomBytes } from "node:crypto";
import { type Capability, type FieldType, type ScalarFieldType, WORK_NAMESPACE } from "../../contracts/src/index.js";
import type { Adapter, OutboundInvocation } from "./adapter.js";
import { type CallScalar, type CallValue, type CapabilityCall, callSchemaFor } from "./call.js";

/**
 * The registration conformance suite (spec §2.4). Each `data` field that can
 * hold text is fed a canary: shell metacharacters, both quote characters and
 * the argv provider's structural delimiters (space, tab, newline) around a
 * unique tag. The suite then inspects the adapter's outbound invocation and
 * requires every canary to be one whole argv element, byte for byte, and no
 * other part of the invocation (the program, or any other element) to
 * contain it. A list arrives as consecutive elements in its own order.
 * Failure blocks registration (DECISIONS.md D-033).
 *
 * Like the spec says, this catches honest mistakes, not an adapter built to
 * evade it: an adapter that passes the canary as a discrete element to a
 * program that parses it again (for example `sh -c 'eval $1'`) passes here.
 */

/** The metacharacters, quotes and delimiters every canary carries after its tag. */
export const CANARY_PAYLOAD = " ;|&$(id)`id`<>*?[]{}!#~'\"\\ \t\n%s${IFS}=,:";

export function canaryValue(tag: string, index: number): string {
  return "juno-canary-" + tag + "-" + String(index) + CANARY_PAYLOAD;
}

export type ConformanceFailure =
  | { readonly kind: "refused_canary"; readonly message: string }
  | { readonly kind: "canary_not_discrete"; readonly field: string; readonly canary: string; readonly occurrences: number }
  | { readonly kind: "canary_in_parsed_string"; readonly field: string; readonly canary: string; readonly where: "program" | number }
  | { readonly kind: "list_not_intact"; readonly field: string };

export type ConformanceResult =
  | { readonly conforming: true; readonly canaries: number; readonly invocation: OutboundInvocation }
  | { readonly conforming: false; readonly failures: readonly ConformanceFailure[] };

type Fed = { readonly field: string; readonly needle: string; readonly value: string };

/** A valid value for a field that cannot carry a canary. */
function neutralScalar(type: ScalarFieldType): CallScalar {
  switch (type.kind) {
    case "string":
      return "juno-conformance";
    case "path":
      return WORK_NAMESPACE;
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    case "enum":
      return type.values[0] ?? "";
  }
}

/** Builds a call with a canary in every text-carrying `data` field, and records what was fed where. */
function canaryCall(capability: Capability, tag: string): { call: CapabilityCall; fed: Fed[]; lists: Map<string, Fed[]> } {
  const fed: Fed[] = [];
  const lists = new Map<string, Fed[]>();
  let next = 0;
  const canaryFor = (field: string, kind: "string" | "path"): string => {
    const value = canaryValue(tag, next);
    const needle = "juno-canary-" + tag + "-" + String(next);
    next += 1;
    const delivered = kind === "path" ? WORK_NAMESPACE + "/" + value : value;
    fed.push({ field, needle, value: delivered });
    return delivered;
  };
  const textual = (type: ScalarFieldType): type is ScalarFieldType & { kind: "string" | "path" } =>
    type.kind === "string" || type.kind === "path";

  const call: Record<string, CallValue> = {};
  for (const [name, field] of Object.entries(capability.interface)) {
    const type: FieldType = field.type;
    if (field.role !== "data") {
      // instruction fields are scalars (§2.2 rule 2) and are not the suite's subject
      call[name] = type.kind === "list" || type.kind === "map" ? [] : neutralScalar(type);
    } else if (type.kind === "list") {
      if (textual(type.items)) {
        const kind = type.items.kind;
        const values = [canaryFor(name, kind), canaryFor(name, kind)];
        lists.set(name, fed.slice(-2));
        call[name] = values;
      } else {
        call[name] = [];
      }
    } else if (type.kind === "map") {
      call[name] = textual(type.values) ? { juno_key: canaryFor(name, type.values.kind) } : {};
    } else {
      call[name] = textual(type) ? canaryFor(name, type.kind) : neutralScalar(type);
    }
  }
  return { call, fed, lists };
}

export function runConformanceSuite(capability: Capability, adapter: Adapter, tag: string = randomBytes(8).toString("hex")): ConformanceResult {
  const { call, fed, lists } = canaryCall(capability, tag);
  const parsed = callSchemaFor(capability.interface).parse(call);

  let invocation: OutboundInvocation;
  try {
    invocation = adapter.plan(parsed);
  } catch (error: unknown) {
    // An adapter that cannot carry a valid data value does not deliver it structurally.
    return { conforming: false, failures: [{ kind: "refused_canary", message: error instanceof Error ? error.message : String(error) }] };
  }

  const failures: ConformanceFailure[] = [];
  for (const { field, needle, value } of fed) {
    if (invocation.file.includes(needle)) {
      failures.push({ kind: "canary_in_parsed_string", field, canary: value, where: "program" });
    }
    let occurrences = 0;
    invocation.args.forEach((element, index) => {
      if (element === value) occurrences += 1;
      else if (element.includes(needle)) failures.push({ kind: "canary_in_parsed_string", field, canary: value, where: index });
    });
    if (occurrences !== 1) failures.push({ kind: "canary_not_discrete", field, canary: value, occurrences });
  }
  for (const [field, items] of lists) {
    const positions = items.map((item) => invocation.args.indexOf(item.value));
    const intact = positions.every((position, index) => position !== -1 && (index === 0 || position === (positions[index - 1] ?? -2) + 1));
    if (!intact) failures.push({ kind: "list_not_intact", field });
  }

  return failures.length === 0 ? { conforming: true, canaries: fed.length, invocation } : { conforming: false, failures };
}
