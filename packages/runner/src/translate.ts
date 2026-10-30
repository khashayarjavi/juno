import { MAX_ARGUMENT_DEPTH } from "../../enforcement/src/index.js";

/**
 * Turns a capability call the model proposed into a proposal for the
 * enforcement boundary (spec §2.6; DECISIONS.md D-060). Provenance is stated
 * by the mechanism the model used, never inferred from a value (invariant 7):
 *
 *   - `{"ref": "<reference>"}` is a `bound` argument: the runtime resolves the
 *     `${<seq>.<path>}` reference from the task's own trajectory, so the value
 *     never round-trips through the model.
 *   - `{"slot": "<name>"}` is a `constant` argument: the runtime fills the
 *     slot with the value admission fixed.
 *   - Any other string, number or boolean is `synthesized`: free text the
 *     model composed. A string that looks like a reference is still text.
 *
 * Every other value keeps its shape: lists and objects are walked, so the
 * boundary judges each value inside them under the field it was placed in,
 * and rejects the shape only afterwards (D-052, D-054). A model-composed
 * object never becomes an argument source: every scalar inside it is wrapped
 * as `synthesized`, so `{"class": "constant", ...}` written by the model is
 * a map of synthesized text, not a constant. Anything else (`null`, a
 * non-finite number, nesting past the boundary's depth) is passed as it is,
 * and the boundary treats it as a value that states no provenance.
 */

export type ModelCall = { readonly capability: string; readonly arguments: Readonly<Record<string, unknown>> };

function isWrapper(value: object, key: "ref" | "slot"): value is Record<typeof key, string> {
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === key && typeof (value as Record<string, unknown>)[key] === "string";
}

function translate(value: unknown, depth: number): unknown {
  if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    return { class: "synthesized", value };
  }
  if (typeof value !== "object" || value === null || depth > MAX_ARGUMENT_DEPTH) return value;
  if (Array.isArray(value)) return value.map((element: unknown) => translate(element, depth + 1));
  if (isWrapper(value, "ref")) return { class: "bound", reference: value.ref };
  if (isWrapper(value, "slot")) return { class: "constant", slot: value.slot };
  return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, translate(member, depth + 1)]));
}

export function toProposal(call: ModelCall): { capability: string; arguments: Record<string, unknown> } {
  return {
    capability: call.capability,
    arguments: Object.fromEntries(Object.entries(call.arguments).map(([key, value]) => [key, translate(value, 1)])),
  };
}
