import {
  ArgumentProvenance,
  type Integrity,
  type PromotionReason,
  argvRoles,
  compareIntegrity,
  parseAtBoundary,
} from "../../contracts/src/index.js";
import { callSchemaFor } from "./call.js";
import { type RegistryEntry, programShape } from "./entry.js";

/**
 * The instruction values of one call, and the floor each must meet
 * (spec §2.1, §2.2, §2.3 rule 2, §2.7 step 3; DECISIONS.md D-036 and D-038).
 *
 * - Every scalar `instruction` field of the interface is one value, with the
 *   capability's `min_argument_integrity` as its floor.
 * - Every argv element promoted under the program's declared surface is one
 *   value of its own, named `argv[<index>]`, with the `operator` floor.
 *
 * Each value is judged alone against its own provenance; no `min()` is taken
 * over the argv list (§2.2 rule 2). Computing each argument's integrity from
 * its provenance class is the enforcement boundary's job (§2.6, Increment 4);
 * the check here takes that integrity as input.
 */

/** The floor a promoted argv element must meet (§2.3 rule 2, D-036). */
export const PROMOTED_ARGV_FLOOR: Integrity = "operator";

export type InstructionValue = {
  /** The argument as `argument_provenance` names it: a field name, or `argv[<index>]` (D-022). */
  readonly argument: string;
  readonly floor: Integrity;
  readonly source:
    | { readonly kind: "instruction_field" }
    | { readonly kind: "promoted_argv"; readonly reason: PromotionReason; readonly at: number | null };
};

/** Lists every instruction value of `call`. The call is parsed against the interface first. */
export function instructionValues(entry: RegistryEntry, call: unknown): InstructionValue[] {
  const { capability } = entry;
  const shape = programShape(entry);
  const parsed = parseAtBoundary(`${capability.id} call`, callSchemaFor(capability.interface), call);
  const values: InstructionValue[] = [];
  for (const [name, field] of Object.entries(capability.interface)) {
    if (field.role === "instruction") {
      values.push({ argument: name, floor: capability.min_argument_integrity, source: { kind: "instruction_field" } });
    }
  }
  // A typed entry (D-134) has no argv, so nothing can be promoted.
  if (shape === null) return values;
  const argvField = shape.argv;
  const program = String(parsed[shape.program]);
  const argv = (parsed[argvField] as readonly unknown[]).map(String);
  const surface = entry.program_surfaces.find((candidate) => candidate.program === program);
  for (const element of argvRoles(program, surface, argv).elements) {
    if (element.role === "instruction") {
      values.push({
        argument: `${argvField}[${String(element.index)}]`,
        floor: PROMOTED_ARGV_FLOOR,
        source: { kind: "promoted_argv", reason: element.reason, at: element.at },
      });
    }
  }
  return values;
}

export type FloorViolation = {
  readonly argument: string;
  readonly floor: Integrity;
  /** `null` when no provenance was recorded for the argument: fails closed. */
  readonly integrity: Integrity | null;
  readonly source: InstructionValue["source"];
};

export type InstructionFloorVerdict =
  | { readonly outcome: "proceed" }
  | { readonly outcome: "park"; readonly reason: "integrity_floor"; readonly violations: readonly FloorViolation[] };

/**
 * §2.7 step 3 over the values `instructionValues` lists: any value below its
 * own floor, or with no recorded provenance, parks the task `integrity_floor`.
 */
export function checkInstructionFloors(entry: RegistryEntry, call: unknown, provenance: unknown): InstructionFloorVerdict {
  const recorded = parseAtBoundary(`${entry.capability.id} argument provenance`, ArgumentProvenance, provenance);
  const integrityOf = new Map(recorded.map((item) => [item.argument, item.integrity]));
  const violations: FloorViolation[] = [];
  for (const value of instructionValues(entry, call)) {
    const integrity = integrityOf.get(value.argument) ?? null;
    if (integrity === null || compareIntegrity(integrity, value.floor) < 0) {
      violations.push({ argument: value.argument, floor: value.floor, integrity, source: value.source });
    }
  }
  return violations.length === 0 ? { outcome: "proceed" } : { outcome: "park", reason: "integrity_floor", violations };
}
