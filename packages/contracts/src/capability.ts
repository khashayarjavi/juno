import { z } from "zod";
import { Currency, DurationMs, Ref } from "./common.js";
import { Integrity, Sensitivity } from "./lattice.js";

/**
 * Capability and its interface (spec §2.1–2.2).
 *
 * Every interface field carries a role. Two schema rules, both fail-closed (§2.2):
 *   1. A field is `instruction` unless explicitly declared `data`.
 *   2. `instruction` fields must be scalars.
 * The field-type language is fixed in DECISIONS.md D-017.
 */

export const FIELD_ROLES = ["instruction", "data"] as const;
export const FieldRole = z.enum(FIELD_ROLES);
export type FieldRole = z.infer<typeof FieldRole>;

const EnumValue = z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/, "must be printable ASCII with no whitespace");

export const ScalarFieldType = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("string") }),
  z.strictObject({ kind: z.literal("path") }),
  z.strictObject({ kind: z.literal("integer") }),
  z.strictObject({ kind: z.literal("number") }),
  z.strictObject({ kind: z.literal("boolean") }),
  z.strictObject({
    kind: z.literal("enum"),
    values: z
      .array(EnumValue)
      .min(1)
      .refine((values) => new Set(values).size === values.length, "enum values must be unique"),
  }),
]);
export type ScalarFieldType = z.infer<typeof ScalarFieldType>;

/** Lists and maps hold scalars only; deeper nesting is not expressible. */
export const ComplexFieldType = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("list"), items: ScalarFieldType }),
  z.strictObject({ kind: z.literal("map"), values: ScalarFieldType }),
]);
export type ComplexFieldType = z.infer<typeof ComplexFieldType>;

export const FieldType = z.union([ScalarFieldType, ComplexFieldType]);
export type FieldType = z.infer<typeof FieldType>;

const COMPLEX_KINDS: ReadonlySet<string> = new Set(["list", "map"]);

export function isComplexFieldType(type: FieldType): type is ComplexFieldType {
  return COMPLEX_KINDS.has(type.kind);
}

/**
 * One interface field. A missing `role` parses as `instruction` (§2.2 rule 1);
 * an `instruction` field of list or map type is rejected (§2.2 rule 2).
 */
export const InterfaceField = z
  .strictObject({
    type: FieldType,
    role: FieldRole.default("instruction"),
  })
  .superRefine((field, ctx) => {
    if (field.role === "instruction" && isComplexFieldType(field.type)) {
      ctx.addIssue({
        code: "custom",
        path: ["role"],
        message: `an instruction field must be a scalar, not a ${field.type.kind} (spec §2.2 rule 2); declare it data or decompose the capability`,
      });
    }
  });
export type InterfaceField = z.infer<typeof InterfaceField>;

const FieldName = z.string().regex(/^[a-z_][a-z0-9_]*$/, "must be a lower-case identifier");

export const CapabilityInterface = z.record(FieldName, InterfaceField);
export type CapabilityInterface = z.infer<typeof CapabilityInterface>;

/** A semantic id such as `fs.file.read` or `shell.run`: two or more dot-separated lower-case segments. */
export const CapabilityId = z
  .string()
  .max(128)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, "must be a dotted semantic id, e.g. fs.file.read");
export type CapabilityId = z.infer<typeof CapabilityId>;

export const SIDE_EFFECTS = ["read", "write", "external", "irreversible"] as const;
export const SideEffect = z.enum(SIDE_EFFECTS);
export type SideEffect = z.infer<typeof SideEffect>;

/** The usual rule is `(input.sensitivity, untrusted)` (§2.1). */
export const OutputClassRule = z.strictObject({
  sensitivity: z.union([z.literal("input"), Sensitivity]),
  integrity: Integrity,
});
export type OutputClassRule = z.infer<typeof OutputClassRule>;

export const CostModel = z.strictObject({
  expected_cost: Currency,
  expected_latency_ms: DurationMs,
  cost_of_failure: Currency,
});
export type CostModel = z.infer<typeof CostModel>;

export const Capability = z.strictObject({
  id: CapabilityId,
  interface: CapabilityInterface,
  /** Adapter bindings; each is subject to the §2.4 conformance suite (Increment 3). */
  providers: z.array(Ref),
  side_effect: SideEffect,
  isolation_tier: z.int().min(1).max(5),
  max_input_sensitivity: Sensitivity,
  /** Applies to `instruction` fields only (§2.1). */
  min_argument_integrity: Integrity,
  output_class: OutputClassRule,
  cost_model: CostModel,
});
export type Capability = z.infer<typeof Capability>;
