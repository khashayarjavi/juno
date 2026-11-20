import {
  BoundaryError,
  type Capability,
  type DataClass,
  type EntryCost,
  type Grant,
  type Integrity,
  type ProvenanceClass,
  type Sensitivity,
  argvRoles,
  compareIntegrity,
  compareSensitivity,
  isTargetField,
  join,
  minIntegrity,
  parseAtBoundary,
  pathWithin,
} from "../../contracts/src/index.js";
import { type EntryDraft, type JournalWriter, canonicalJson, readPayload, readTrajectory } from "../../journal/src/index.js";
import {
  type CallScalar,
  type CallValue,
  type CapabilityCall,
  type CapabilityRegistry,
  type FloorViolation,
  type InstructionValue,
  type InvocationResult,
  type OutboundInvocation,
  PROMOTED_ARGV_FLOOR,
  type RegistryEntry,
  RegistryError,
  callSchemaFor,
  checkInstructionFloors,
  executeOutbound,
  instructionValues,
  programShape,
} from "../../registry/src/index.js";
import { type ResolutionFailureCode, resolveReference } from "./binding.js";
import type { CanonicalPaths } from "./canonical.js";
import { type DeliveryFailure, deliveryFailures } from "./delivery.js";
import type { GrantRefusal, GrantStore } from "./grants.js";
import { ArgumentSource, ProposalEnvelope, ProposedCall, type TaskContext } from "./proposal.js";
import { type ScopeViolation, scopePaths, scopeViolations } from "./scope.js";

/**
 * The enforcement boundary (spec §2.6–2.7, §3.2; build plan Increment 4;
 * DECISIONS.md D-041 to D-054). It runs in the runner, holds the grants and
 * writes the journal; the model only proposes. For each proposed call:
 *
 *   0. Walk every argument value, in whatever shape it arrives (scalar, list,
 *      map, nested). Shape never outranks provenance: nothing about the
 *      proposal's shape is required until step 3 has judged every value placed
 *      under an instruction field (D-052, D-054).
 *   1. Resolve every `bound` reference against the task's own trajectory and
 *      record a `binding_resolution` entry for each, with the candidate set
 *      when the reference's path matches more than one entry.
 *   2. Compute each argument's provenance class and data class (§2.6).
 *      The candidate grants (those that cover the call) are looked up here.
 *   3. `checkInstructionFloors` (D-038): any instruction value, including an
 *      argv element promoted under §2.3 rule 2, below its floor parks
 *      `integrity_floor`. Then each candidate grant's `min_integrity` raises
 *      every instruction value's floor (never a data field's); when no
 *      candidate's floors are met, the call parks `integrity_floor` too (D-046).
 *      Not overridable (§8.3). Step 3 runs before any rejection but an unknown
 *      capability. Every value under an instruction field is judged at that
 *      field's floor, in any shape and at any depth. A bound value whose
 *      reference does not resolve is judged `untrusted`; a value that states no
 *      provenance has none and fails every floor. With no established program,
 *      or one with no declared surface, every argv element is promoted. An
 *      unresolved or malformed call is rejected only once every instruction
 *      value has passed (D-045, D-048, D-052, D-054).
 *   G. No grant covers the call: park `awaiting_grant`. Decided only after
 *      step 3 passes, so an injected instruction is never presented as a
 *      missing grant (D-045, D-046).
 *   4. A data field or argv operand outside the scope of every remaining
 *      candidate: park `scope_violation` (D-047).
 *   5. Aggregate input sensitivity above `max_input_sensitivity`, or above the
 *      `max_sensitivity` of every remaining candidate: park `sensitivity_ceiling` (D-046).
 *   6. The serving adapter is quarantined, or is observed now not delivering a
 *      data value structurally (and is quarantined for it): park `adapter_quarantined`.
 *
 * Each step keeps the candidates the call meets; the first step that leaves
 * none decides the verdict. A call proceeds only when every check passes. It
 * proceeds under the first remaining candidate, in the order the task lists
 * its grants, is charged to that grant, and the journal names it. Every
 * proposal with a capability id and an object of arguments leaves exactly one `capability_call` entry,
 * carrying the per-argument provenance (D-022) and the verdict. The serving
 * adapter's planned invocation is read exactly once, into a frozen copy; that
 * copy is the one inspected at step 6, journalled, carried in the
 * Authorization, and run by `perform` (D-053).
 */

export const ENFORCEMENT_ACTOR = "juno.enforcement";

/** The park reasons this boundary produces (§6.2), in the order its checks run. */
export const ENFORCEMENT_PARK_REASONS = [
  "integrity_floor",
  "awaiting_grant",
  "scope_violation",
  "sensitivity_ceiling",
  "adapter_quarantined",
] as const;
export type EnforcementParkReason = (typeof ENFORCEMENT_PARK_REASONS)[number];

/**
 * One untrusted value in a target field that §2.2.2's table does not permit (D-135): the call's effect, as judged
 * (`write` outside a reversible workspace is judged `irreversible`), and the value, which the grant does not enumerate.
 */
export type EffectRefusal = {
  readonly argument: string;
  readonly field: string;
  readonly value: CallScalar;
  readonly judged_as: "external" | "irreversible";
  /** For a `write`: why it was judged `irreversible`. */
  readonly not_reversible?: string;
};

/** A candidate grant and the target values whose effect it does not permit. */
export type GrantEffectRefusals = { readonly grant: string; readonly refused: readonly EffectRefusal[] };

/** Why one candidate grant was not usable for the call. */
export type GrantFloorViolations = { readonly grant: string; readonly violations: readonly FloorViolation[] };

export type ParkDetail =
  | {
      readonly reason: "integrity_floor";
      /** Values below their own floor (the capability's, or `operator` for promoted argv). */
      readonly violations: readonly FloorViolation[];
      /** When every value met its own floor: each candidate grant, with the values below the floor its `min_integrity` raised (D-046). */
      readonly grants: readonly GrantFloorViolations[];
      /**
       * §2.2.2 (v0.6, A1) at step 4: when every value met its floors and the call was in scope, each remaining candidate
       * grant with the untrusted target values its effect does not permit (D-135). Absent when step 3 parked.
       */
      readonly effects?: readonly GrantEffectRefusals[];
    }
  | { readonly reason: "awaiting_grant"; readonly refused: readonly GrantRefusal[] }
  | {
      readonly reason: "scope_violation";
      readonly grants: readonly { readonly grant: string; readonly outside: readonly ScopeViolation[] }[];
      /**
       * §8.2 (v0.6, A2): the out-of-scope arguments whose value is `untrusted` (or has no established integrity, §1.5).
       * For a relative argv operand the call's `cwd` is part of the value, so the lower of the two counts (D-109). When
       * any is listed, the park is not overridden: the remedy is a grant.
       */
      readonly untrusted: readonly string[];
    }
  | {
      readonly reason: "sensitivity_ceiling";
      readonly aggregate: Sensitivity;
      /** The capability's `max_input_sensitivity`. */
      readonly ceiling: Sensitivity;
      /** When the capability's ceiling was met: each remaining candidate grant and its lower `max_sensitivity` (D-046). */
      readonly grants: readonly { readonly grant: string; readonly max_sensitivity: Sensitivity }[];
      /** Mediated modes (§4.3 V6-7, D-150): the park is the read gate's: `aggregate` is what the call reads, `ceiling` the provider's clearance. */
      readonly read_gate?: true;
    }
  | {
      readonly reason: "adapter_quarantined";
      readonly adapter: string;
      readonly observation: string;
      readonly failures: readonly DeliveryFailure[];
      /** The one copy of the invocation the adapter planned, when it planned one now (D-053). */
      readonly invocation: OutboundInvocation | null;
    };

export type UnresolvedArgument = {
  readonly argument: string;
  readonly class: "bound" | "constant";
  readonly code: ResolutionFailureCode | "unknown_slot";
  readonly message: string;
};

/**
 * A proposal that is not a call at all. Nothing runs and the task is not
 * parked: the spec rejects such references (O9) and no operator decision can
 * repair them (D-045).
 */
export type RejectDetail =
  | { readonly reason: "unresolved_argument"; readonly failures: readonly UnresolvedArgument[] }
  | { readonly reason: "unknown_capability" }
  | { readonly reason: "malformed_call"; readonly message: string };

/** Permission to run one inspected invocation once. Only `perform` on the boundary that issued it accepts it. */
export type Authorization = {
  readonly task_id: string;
  readonly call_seq: number;
  readonly capability: string;
  readonly grant: string;
  readonly adapter: string;
  readonly call: CapabilityCall;
  readonly invocation: OutboundInvocation;
  /** The join of every argument's data class; the result's class is computed from it (§2.1 `output_class`). */
  readonly input_class: DataClass;
};

export type Verdict =
  | { readonly outcome: "proceed"; readonly call_seq: number; readonly authorization: Authorization }
  | { readonly outcome: "park"; readonly call_seq: number; readonly detail: ParkDetail }
  | { readonly outcome: "reject"; readonly call_seq: number; readonly detail: RejectDetail };

export class EnforcementError extends Error {
  override readonly name = "EnforcementError";
}

export type EnforcementBoundaryOptions = {
  readonly registry: CapabilityRegistry;
  readonly grants: GrantStore;
  readonly journal: JournalWriter;
  /** The clock grants are judged by. Defaults to the system clock. */
  readonly clock?: () => Date;
};

type Origin =
  | { readonly class: "constant"; readonly slot: string }
  | { readonly class: "bound"; readonly reference: string; readonly bound_to: number; readonly binding_entry: number }
  | { readonly class: "synthesized" };

type ArgumentRecord = {
  readonly argument: string;
  readonly class: ProvenanceClass;
  readonly data_class: DataClass;
  readonly value: CallScalar;
  readonly origin: Origin;
};

const NO_COST: EntryCost = { tokens_in: 0, tokens_out: 0, tokens_cached: 0, currency: 0, duration_ms: 0 };

/**
 * One value in a proposal's arguments, wherever it sits (D-052, D-054). It is
 * named as `argument_provenance` names it: a field, `<field>[<index>]` for a
 * list element (D-022), `<field>["<key>"]` for a map member, and so on down.
 */
type Leaf = {
  readonly argument: string;
  /** The top-level argument key it sits under. */
  readonly field: string;
  /** Its stated provenance; `undefined` when the value states none. */
  readonly source: ArgumentSource | undefined;
  /** The value itself, kept only when it states no provenance. */
  readonly raw: unknown;
};

/** How deep the boundary walks an argument value; anything deeper is one value that states no provenance (D-054). */
export const MAX_ARGUMENT_DEPTH = 16;

/** A plain argument key; any other key is named in quotes and brackets, so it can never collide with a list element's name (D-054). */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Every value in a proposal's arguments, in any shape. An object that is an
 * argument source is one value. Any other list or object is walked into, so a
 * value cannot hide from step 3 by being wrapped. Anything else (a bare
 * scalar, `null`, or a structure deeper than `MAX_ARGUMENT_DEPTH`) is one
 * value that states no provenance (D-052, D-054).
 */
function leavesOf(args: Readonly<Record<string, unknown>>): Leaf[] {
  const leaves: Leaf[] = [];
  const walk = (field: string, argument: string, value: unknown, depth: number): void => {
    const source = ArgumentSource.safeParse(value);
    if (source.success) {
      leaves.push({ argument, field, source: source.data, raw: undefined });
    } else if (typeof value === "object" && value !== null && depth < MAX_ARGUMENT_DEPTH) {
      const children: [string, unknown][] = Array.isArray(value)
        ? value.map((item: unknown, index): [string, unknown] => [`[${String(index)}]`, item])
        : Object.entries(value).map(([key, item]): [string, unknown] => [`[${JSON.stringify(key)}]`, item]);
      for (const [step, item] of children) walk(field, `${argument}${step}`, item, depth + 1);
    } else {
      leaves.push({ argument, field, source: undefined, raw: value });
    }
  };
  for (const [field, value] of Object.entries(args)) walk(field, IDENTIFIER.test(field) ? field : `[${JSON.stringify(field)}]`, value, 0);
  return leaves;
}

/** How a value that states no provenance is described in the record: its shape, never its content. */
function shapeOf(raw: unknown): string {
  if (raw === null) return "null";
  return Array.isArray(raw) ? "list" : typeof raw;
}

/** The call's argument values, shaped as the proposal shaped them. */
function assemble(sources: ProposedCall["arguments"], values: ReadonlyMap<string, CallScalar>): Record<string, CallValue> {
  const call: Record<string, CallValue> = {};
  for (const [field, value] of Object.entries(sources)) {
    call[field] = Array.isArray(value)
      ? value.map((_source, index) => values.get(`${field}[${String(index)}]`) ?? "")
      : (values.get(field) ?? "");
  }
  return call;
}

/** A frozen copy of an inspected call: each list or map value is copied and frozen too. */
function frozenCall(call: CapabilityCall): CapabilityCall {
  const copy: Record<string, CallValue> = {};
  for (const [field, value] of Object.entries(call)) {
    copy[field] = Array.isArray(value) ? Object.freeze([...(value as readonly CallScalar[])]) : typeof value === "object" ? Object.freeze({ ...value }) : value;
  }
  return Object.freeze(copy);
}

/** The data class of what the model composed in this turn (§2.6 `synthesized`). */
function synthesizedClass({ task, synthesis }: TaskContext): DataClass {
  if (task.context_ownership !== "owned") {
    // Under native context JUNO cannot enumerate the volatile region: untrusted, unconditionally (§2.6).
    return { sensitivity: synthesis.sensitivity, integrity: "untrusted" };
  }
  if (synthesis.volatile_region === undefined) {
    throw new EnforcementError("an owned-context task must supply its volatile region; synthesized integrity is min() over it (spec §2.6)");
  }
  const [first, ...rest] = synthesis.volatile_region;
  return { sensitivity: synthesis.sensitivity, integrity: rest.reduce<Integrity>(minIntegrity, first) };
}

/** An argument as step 3 judges it: its provenance class and the integrity it is held to. */
type Judged = { readonly argument: string; readonly class: ProvenanceClass; readonly integrity: Integrity };

/**
 * D-048: every argument whose integrity is established, in proposal order. A
 * `bound` argument whose reference did not resolve has no established
 * integrity, so it is judged `untrusted` (§1.5 fail-closed). A constant slot
 * never fixed is not judged at all; it is rejected once step 3 has passed. A
 * value that states no provenance is left out too, so step 3 holds it to its
 * floor with no integrity at all, and it fails every floor (D-054).
 */
function judgedArguments(leaves: readonly Leaf[], records: readonly ArgumentRecord[], failures: readonly UnresolvedArgument[]): Judged[] {
  return leaves.flatMap(({ argument }): Judged[] => {
    const record = records.find((candidate) => candidate.argument === argument);
    if (record !== undefined) return [{ argument, class: record.class, integrity: record.data_class.integrity }];
    const failure = failures.find((candidate) => candidate.argument === argument);
    return failure?.class === "bound" ? [{ argument, class: "bound", integrity: "untrusted" }] : [];
  });
}

/**
 * D-048: what an argument that did not resolve stands as while step 3 reads
 * the call, so the rest of the call can still be read: a string reads as an
 * operand, a path as the root, a data enum as its first value. The program
 * field gets a value its enum never holds, so with no program the argv is
 * read against no surface. A stand-in never reaches a later step: once step 3
 * passes, a call with an unresolved argument is rejected.
 */
function standIn(entry: RegistryEntry, argument: string): CallScalar {
  const field = argument.replace(/\[\d+\]$/, "");
  const declared = entry.capability.interface[field]?.type;
  const type = declared?.kind === "list" ? declared.items : declared;
  if (field === entry.program_field || type === undefined || type.kind === "map") return "";
  switch (type.kind) {
    case "path":
      return "/";
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    case "enum":
      return type.values[0] ?? "";
    case "string":
      return "";
  }
}

type StepThree = {
  /** Every instruction value step 3 judged, each with its own floor. */
  readonly values: readonly InstructionValue[];
  /** The values below their own floor. */
  readonly violations: readonly FloorViolation[];
  /** The call parsed against the interface, or why it does not parse. */
  readonly parsed: { readonly ok: true; readonly call: CapabilityCall } | { readonly ok: false; readonly message: string };
};

/** What step 3 reads a proposal from. */
type StepThreeInput = {
  readonly entry: RegistryEntry;
  /** The proposal's arguments as they arrived, in any shape. */
  readonly args: Readonly<Record<string, unknown>>;
  readonly leaves: readonly Leaf[];
  /** The proposal, when it has the `ProposedCall` shape. */
  readonly proposal: ProposedCall | undefined;
  /** Each value as step 3 reads it: resolved, a stand-in (D-048), or a bare scalar as written. */
  readonly valueOf: ReadonlyMap<string, CallScalar>;
  /** The values whose provenance is established: they carry their own value, not a stand-in. */
  readonly established: ReadonlySet<string>;
  readonly judged: readonly Judged[];
  /** Arguments step 3 does not judge: constant slots never fixed (D-048). */
  readonly unjudged: ReadonlySet<string>;
};

/**
 * The program the argv is read against: the program field's one value, when
 * it is a single value whose provenance is established. Otherwise there is no
 * program, so no declared surface (D-048, D-052).
 */
function establishedProgram({ entry, leaves, valueOf, established }: StepThreeInput): string | undefined {
  const values = leaves.filter((leaf) => leaf.field === entry.program_field);
  const [only] = values;
  if (values.length !== 1 || only === undefined || only.argument !== entry.program_field || !established.has(only.argument)) return undefined;
  const value = valueOf.get(only.argument);
  return value === undefined ? undefined : String(value);
}

/**
 * §2.7 step 3 is `checkInstructionFloors` (D-038) whenever the call parses.
 * When it does not, step 3 still judges, before any rejection (D-045, D-048,
 * D-052, D-054):
 *   - every value under an instruction field, in any shape and at any depth,
 *     at that field's floor;
 *   - the argv read against the established program's declared surface. With
 *     no established program, or a program with no declared surface, there is
 *     none, so every element is promoted (D-037). An argv that is not a list of
 *     single values cannot be read at all, so every value in it is promoted.
 * Arguments that are not judged (a constant slot never fixed) are left out.
 */
function stepThree(input: StepThreeInput): StepThree {
  const { entry, proposal, valueOf, judged, unjudged } = input;
  const integrityOf = new Map(judged.map((item) => [item.argument, item.integrity]));
  const considered = (value: InstructionValue | FloorViolation): boolean => !unjudged.has(value.argument);
  if (proposal !== undefined) {
    const call = assemble(proposal.arguments, valueOf);
    try {
      const verdict = checkInstructionFloors(entry, call, judged);
      const parsedCall = callSchemaFor(entry.capability.interface).parse(call);
      return {
        values: instructionValues(entry, parsedCall).filter(considered),
        violations: verdict.outcome === "park" ? verdict.violations.filter(considered) : [],
        parsed: { ok: true, call: parsedCall },
      };
    } catch (error: unknown) {
      if (!(error instanceof BoundaryError)) throw error;
      return { ...judgeUnparsed(input, integrityOf, considered), parsed: { ok: false, message: error.message } };
    }
  }
  return { ...judgeUnparsed(input, integrityOf, considered), parsed: { ok: false, message: "the proposal is not a capability call proposal" } };
}

function judgeUnparsed(
  input: StepThreeInput,
  integrityOf: ReadonlyMap<string, Integrity>,
  considered: (value: InstructionValue | FloorViolation) => boolean,
): Pick<StepThree, "values" | "violations"> {
  const { entry, args, leaves, valueOf } = input;
  const { capability } = entry;
  const values: InstructionValue[] = [];
  for (const [name, field] of Object.entries(capability.interface)) {
    if (field.role !== "instruction") continue;
    for (const leaf of leaves) {
      if (leaf.field === name) values.push({ argument: leaf.argument, floor: capability.min_argument_integrity, source: { kind: "instruction_field" } });
    }
  }
  // A typed entry (D-134) has no argv and no instruction field; nothing is promoted.
  const argvField = programShape(entry)?.argv;
  const argv = argvField === undefined ? [] : leaves.filter((leaf) => leaf.field === argvField);
  const raw = argvField === undefined ? [] : args[argvField];
  const readable = Array.isArray(raw) && argv.length === raw.length && argv.every((leaf, index) => leaf.argument === `${argvField}[${String(index)}]`);
  if (readable) {
    const program = establishedProgram(input);
    const surface = program === undefined ? undefined : entry.program_surfaces.find((candidate) => candidate.program === program);
    const elements = argv.map((leaf) => String(valueOf.get(leaf.argument) ?? ""));
    for (const element of argvRoles(program ?? "", surface, elements).elements) {
      if (element.role === "instruction") {
        values.push({
          argument: `${argvField}[${String(element.index)}]`,
          floor: PROMOTED_ARGV_FLOOR,
          source: { kind: "promoted_argv", reason: element.reason, at: element.at },
        });
      }
    }
  } else {
    for (const leaf of argv) {
      values.push({ argument: leaf.argument, floor: PROMOTED_ARGV_FLOOR, source: { kind: "promoted_argv", reason: "argv_not_a_list", at: null } });
    }
  }
  const judgedValues = values.filter(considered);
  const violations = judgedValues.flatMap((value): FloorViolation[] => {
    const integrity = integrityOf.get(value.argument) ?? null;
    return integrity === null || compareIntegrity(integrity, value.floor) < 0 ? [{ ...value, integrity }] : [];
  });
  return { values: judgedValues, violations };
}

/**
 * §8.2 (A2): the integrity of what put an out-of-scope value where it is (D-109). A value with no established integrity
 * is `untrusted` (§1.5). An argv operand is read against the call's `cwd` (§2.7.1 D4), so a relative one takes the lower
 * of its own integrity and `cwd`'s.
 */
function causingIntegrity(entry: RegistryEntry, call: CapabilityCall, argument: string, integrityOf: ReadonlyMap<string, Integrity>): Integrity {
  const own = integrityOf.get(argument) ?? "untrusted";
  const shape = programShape(entry);
  if (shape === null) return own;
  const prefix = `${shape.argv}[`;
  if (!argument.startsWith(prefix)) return own;
  const element = (call[shape.argv] as readonly unknown[])[Number(argument.slice(prefix.length, -1))];
  if (typeof element === "string" && element.startsWith("/")) return own;
  const cwd = integrityOf.get(shape.cwd) ?? "untrusted";
  return compareIntegrity(cwd, own) < 0 ? cwd : own;
}

/** How §2.2.2's table judges a call's effect: `read` and `external` as declared; a `write` reversible or not (D-135). */
type JudgedEffect =
  | { readonly kind: "read" }
  | { readonly kind: "reversible_write" }
  | { readonly kind: "external" }
  | { readonly kind: "irreversible"; readonly not_reversible?: string };

/**
 * A `write` is reversible only when every target of the call is a path whose canonical form lies inside one of the
 * task's reversible workspaces (§2.2.2: "only if the scope lies in a reversible workspace"; D-135, restrictive): a
 * target that is not a path, or a path with no canonical form, makes it `irreversible`; so does a hard-linked file (D-158),
 * and a path whose canonical form differs from its lexical normalization (D-168).
 */
function effectOf(entry: RegistryEntry, call: CapabilityCall, canonical: CanonicalPaths, reversible: readonly string[], unrestorable: Readonly<Record<string, string>> = {}): JudgedEffect {
  const unrestorableOf = (root: string): string | undefined => (Object.hasOwn(unrestorable, root) ? unrestorable[root] : undefined);
  const { side_effect: effect } = entry.capability;
  if (effect === "read") return { kind: "read" };
  if (effect === "external") return { kind: "external" };
  if (effect === "irreversible") return { kind: "irreversible" };
  const paths = new Map(scopePaths(entry, call).map((path) => [path.argument, path.raw]));
  for (const { argument } of targetValues(entry, call)) {
    const raw = paths.get(argument);
    if (raw === undefined) return { kind: "irreversible", not_reversible: `${argument} is not a path` };
    const answer = canonical.get(raw);
    if (answer === undefined || !answer.ok) return { kind: "irreversible", not_reversible: `${argument} has no canonical path` };
    // D-158: a hard-linked file is the same file under a name the checkpoint may not hold, and a restore replaces the
    // workspace's name only, so a write through it is not undone by the restore: never reversible.
    if (answer.hardLinked === true) return { kind: "irreversible", not_reversible: `${answer.canonical} is a file with more than one link` };
    // D-168 (operator ruling 2 of 2026-11-08): a target the kernel resolves elsewhere than its text says (a symlink in any
    // component, `..` after one) is judged at the safe default: a write through it is never reversible.
    if (answer.redirected === true) return { kind: "irreversible", not_reversible: `${raw} resolves to ${answer.canonical}, not where its text says` };
    const workspace = reversible.find((root) => pathWithin(answer.canonical, root));
    if (workspace === undefined) {
      return { kind: "irreversible", not_reversible: `${answer.canonical} lies in no reversible workspace of the task` };
    }
    // Operator ruling 1 of D-234: reversibility is judged at every write, not at admission alone. The undo moves the
    // workspace aside whole, with one rename in the folder that holds it, and makes it again from the checkpoint, so it
    // needs every folder on the way to the workspace to be one the restoring user (the user that resolved the path) can
    // read, change and enter, on one file system. A write below a folder inside the workspace that the user could not
    // change stays irreversible too (D-221, kept: restrictive).
    const blocked = answer.unwritable?.find((folder) => pathWithin(folder, workspace) || pathWithin(workspace, folder));
    if (blocked !== undefined) return { kind: "irreversible", not_reversible: pathWithin(blocked, workspace) && blocked !== workspace ? `the restore could not change ${blocked}, so a write there could not be undone (D-221)` : `the restore could not move ${workspace} aside: it could not change ${blocked}, so a write there could not be undone (D-234)` };
    const mounted = answer.mounts?.find((folder) => pathWithin(folder, workspace) || pathWithin(workspace, folder));
    if (mounted !== undefined) return { kind: "irreversible", not_reversible: `${mounted} is on another file system (a mount), so the restore could not show it can undo a write there (D-234)` };
    const unrestorable = unrestorableOf(workspace);
    if (unrestorable !== undefined) return { kind: "irreversible", not_reversible: `${workspace} can no longer be undone: ${unrestorable} (D-234)` };
  }
  return { kind: "reversible_write" };
}

/** Every value of a target field (§2.2.2), named as `argument_provenance` names it (D-022). */
function targetValues(entry: RegistryEntry, call: CapabilityCall): { readonly argument: string; readonly field: string; readonly value: CallScalar }[] {
  const values: { argument: string; field: string; value: CallScalar }[] = [];
  for (const [name, field] of Object.entries(entry.capability.interface)) {
    if (!isTargetField(field)) continue;
    const value = call[name];
    if (Array.isArray(value)) value.forEach((item: CallScalar, index) => values.push({ argument: `${name}[${String(index)}]`, field: name, value: item }));
    else if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value as Readonly<Record<string, CallScalar>>)) values.push({ argument: `${name}[${JSON.stringify(key)}]`, field: name, value: item });
    } else if (value !== undefined) values.push({ argument: name, field: name, value });
  }
  return values;
}

/**
 * §2.2.2's table for one candidate grant (D-135): under a `read` or a reversible `write`, nothing; under `external` or
 * `irreversible` (a `write` outside a reversible workspace included), every untrusted target value (or one with no
 * established integrity, §1.5; for a relative argv operand, the lower of it and `cwd`) the grant does not enumerate for
 * that field. `constant` values and `bound` values whose entry is not `untrusted` proceed.
 */
function effectRefusals(
  entry: RegistryEntry,
  call: CapabilityCall,
  grant: Grant,
  integrityOf: ReadonlyMap<string, Integrity>,
  effect: JudgedEffect,
  canonical: CanonicalPaths,
): EffectRefusal[] {
  if (effect.kind === "read" || effect.kind === "reversible_write") return [];
  const enumerated = grant.enumerated_targets ?? [];
  const paths = new Map(scopePaths(entry, call).map((path) => [path.argument, path.raw]));
  const refusals: EffectRefusal[] = [];
  for (const { argument, field, value } of targetValues(entry, call)) {
    if (causingIntegrity(entry, call, argument, integrityOf) !== "untrusted") continue;
    if (enumerated.some((target) => target.field === field && enumeratedMatches(target.value, value, paths.get(argument), canonical))) continue;
    refusals.push({
      argument,
      field,
      value,
      judged_as: effect.kind,
      ...(effect.kind === "irreversible" && effect.not_reversible !== undefined ? { not_reversible: effect.not_reversible } : {}),
    });
  }
  return refusals;
}

/** An email address as D-154 compares it: one `@`, a local part with no space, and an ASCII host name. */
const EMAIL = /^([^@\s]+)@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)$/;

/**
 * Whether an enumerated value admits a target value (operator ruling D-154; D-184). A path target matches only on its
 * canonical (resolved) path, never as typed: it must have resolved, must not be a hard-linked file (its path does not
 * name it alone, D-157), and its canonical form must equal the enumerated value exactly. Any other value matches only
 * an exactly equal value, except that the domain of an email address is compared case-insensitively (ASCII only); the
 * local part stays exact. No prefix, wildcard or subdomain ever matches.
 */
function enumeratedMatches(enumerated: CallScalar, value: CallScalar, raw: string | undefined, canonical: CanonicalPaths): boolean {
  if (raw !== undefined) {
    const answer = canonical.get(raw);
    return answer !== undefined && answer.ok && answer.hardLinked !== true && answer.canonical === enumerated;
  }
  if (enumerated === value) return true;
  if (typeof enumerated !== "string" || typeof value !== "string") return false;
  const [, enumLocal, enumDomain] = EMAIL.exec(enumerated) ?? [];
  const [, local, domain] = EMAIL.exec(value) ?? [];
  if (enumLocal === undefined || enumDomain === undefined || local === undefined || domain === undefined) return false;
  const lower = (text: string): string => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return local === enumLocal && lower(domain) === lower(enumDomain);
}

/** §2.3.1 rule 6 (A5): the first undeclared flag of a parsed call whose program's surface is code-free everywhere, or `null`. */
function undeclaredFlagOf(entry: RegistryEntry, call: CapabilityCall): number | null {
  const shape = programShape(entry);
  if (shape === null) return null;
  const program = String(call[shape.program]);
  const argv = (call[shape.argv] as readonly unknown[]).map(String);
  const surface = entry.program_surfaces.find((candidate) => candidate.program === program);
  return argvRoles(program, surface, argv).undeclaredFlag;
}

/**
 * D-053: reads an adapter's planned invocation exactly once (`file` once,
 * `args` once, each element once) into a frozen copy of plain strings. An
 * adapter that returns anything else has not planned an invocation; the
 * caller treats the throw as an adapter refusing a valid call.
 */
function copyInvocation(planned: OutboundInvocation): OutboundInvocation {
  const file: unknown = planned.file;
  const args: unknown = planned.args;
  if (typeof file !== "string" || !Array.isArray(args)) throw new TypeError("the adapter did not plan a program and an argv array");
  const copied: unknown[] = Array.from(args as readonly unknown[]);
  if (!copied.every((element): element is string => typeof element === "string")) throw new TypeError("the adapter planned an argv element that is not a string");
  return Object.freeze({ file, args: Object.freeze(copied) });
}

/**
 * The class of a call's input (§2.1 `output_class`, §2.7 step 5): the join of
 * its argument values' classes. A call with no argument values still carries
 * the proposal the producing turn composed, so its input is the synthesized
 * class, never an input below every ceiling (D-049).
 */
export function callInputClass(argumentClasses: readonly DataClass[], synthesized: DataClass): DataClass {
  const [first, ...rest] = argumentClasses;
  return first === undefined ? synthesized : join([first, ...rest]);
}

/**
 * D-046: a candidate grant's `min_integrity` raises the floor of every
 * instruction value (scalar instruction fields and promoted argv; never a
 * data field) to at least itself. The violations of the raised floors.
 */
function grantFloorViolations(values: readonly InstructionValue[], integrityOf: ReadonlyMap<string, Integrity>, grant: Grant): FloorViolation[] {
  const minimum = grant.data_class_bounds.min_integrity;
  return values.flatMap((value) => {
    const floor = compareIntegrity(minimum, value.floor) > 0 ? minimum : value.floor;
    const integrity = integrityOf.get(value.argument) ?? null;
    return integrity === null || compareIntegrity(integrity, floor) < 0 ? [{ argument: value.argument, floor, integrity, source: value.source }] : [];
  });
}

export class EnforcementBoundary {
  readonly #registry: CapabilityRegistry;
  readonly #grants: GrantStore;
  readonly #journal: JournalWriter;
  readonly #clock: () => Date;
  readonly #issued = new WeakSet<Authorization>();

  constructor(options: EnforcementBoundaryOptions) {
    this.#registry = options.registry;
    this.#grants = options.grants;
    this.#journal = options.journal;
    this.#clock = options.clock ?? (() => new Date());
  }

  /**
   * The raw paths step 4 would judge for this proposal (§2.7.1 C4, D-113), for the caller to resolve where the effect
   * will run before calling `authorize`. It reads exactly as `authorize` does, by the same `scopePaths`, and writes
   * nothing: no entry, no binding record. A proposal that would not reach step 4 names no path.
   */
  pathsToResolve(context: TaskContext, input: unknown): string[] {
    const envelope = ProposalEnvelope.safeParse(input);
    const proposal = ProposedCall.safeParse(input);
    if (!envelope.success || !proposal.success) return [];
    const entry = this.#registry.entry(envelope.data.capability);
    if (entry === undefined) return [];
    const leaves = leavesOf(envelope.data.arguments);
    const { records, failures } = this.#resolve(context, envelope.data.capability, leaves, synthesizedClass(context), false);
    if (failures.length > 0) return [];
    const valueOf = new Map<string, CallScalar>(records.map((item) => [item.argument, item.value]));
    const call = callSchemaFor(entry.capability.interface).safeParse(assemble(proposal.data.arguments, valueOf));
    return call.success ? [...new Set(scopePaths(entry, call.data).map((path) => path.raw))] : [];
  }

  /** Judges one proposed call by a running task, records it, and returns the verdict. Nothing runs here. */
  authorize(context: TaskContext, input: unknown): Verdict {
    const { task } = context;
    if (task.state !== "running") throw new EnforcementError(`task ${task.id} is ${task.state}; only a running task makes capability calls (spec §6)`);
    // Only a capability id and an object of arguments are required before step 3 (D-052, D-054).
    const envelope = parseAtBoundary("capability call proposal", ProposalEnvelope, input);
    const proposal = ProposedCall.safeParse(input);
    const synthesized = synthesizedClass(context);
    const leaves = leavesOf(envelope.arguments);

    // Step 1 and step 2: resolve and classify every value, in whatever shape it arrived.
    const { records, failures } = this.#resolve(context, envelope.capability, leaves, synthesized);
    const unprovenanced = leaves.filter((leaf) => leaf.source === undefined);
    const judged = judgedArguments(leaves, records, failures);
    const record = (verdict: Readonly<Record<string, unknown>>, grant: string | null): number =>
      this.#recordCall(task.id, envelope.capability, records, judged, failures, unprovenanced, synthesized, verdict, grant);
    const park = (detail: ParkDetail): Verdict => ({ outcome: "park", call_seq: record({ outcome: "park", ...detail }, null), detail });
    const reject = (detail: RejectDetail): Verdict => ({ outcome: "reject", call_seq: record({ outcome: "reject", ...detail }, null), detail });

    const entry = this.#registry.entry(envelope.capability);
    if (entry === undefined) return reject(failures.length > 0 ? { reason: "unresolved_argument", failures } : { reason: "unknown_capability" });
    const { capability } = entry;
    const valueOf = new Map<string, CallScalar>();
    for (const leaf of unprovenanced) {
      if (typeof leaf.raw === "string" || typeof leaf.raw === "boolean" || (typeof leaf.raw === "number" && Number.isFinite(leaf.raw))) valueOf.set(leaf.argument, leaf.raw);
    }
    for (const failure of failures) valueOf.set(failure.argument, standIn(entry, failure.argument));
    for (const item of records) valueOf.set(item.argument, item.value);

    // The candidate grants, looked up before step 3 because their bounds raise its floors (D-046).
    const coverage = this.#grants.coverage(task, capability.id, this.#clock());

    // Step 3: each value against its own floor, then against each candidate's raised floors. It runs before any
    // rejection, so neither a resolution failure nor the proposal's shape can mask an instruction below its floor
    // (D-045, D-048, D-052).
    const floors = stepThree({
      entry,
      args: envelope.arguments,
      leaves,
      proposal: proposal.success ? proposal.data : undefined,
      valueOf,
      established: new Set(records.map((item) => item.argument)),
      judged,
      unjudged: new Set(failures.filter((failure) => failure.class === "constant").map((failure) => failure.argument)),
    });
    if (floors.violations.length > 0) return park({ reason: "integrity_floor", violations: floors.violations, grants: [] });
    const integrityOf = new Map(judged.map((item) => [item.argument, item.integrity]));
    const raised = coverage.covering.map((grant) => ({ grant, violations: grantFloorViolations(floors.values, integrityOf, grant) }));
    const meetFloors = raised.filter((candidate) => candidate.violations.length === 0).map((candidate) => candidate.grant);
    if (raised.length > 0 && meetFloors.length === 0) {
      return park({ reason: "integrity_floor", violations: [], grants: raised.map(({ grant, violations }) => ({ grant: grant.id, violations })) });
    }
    if (failures.length > 0) return reject({ reason: "unresolved_argument", failures });
    if (!proposal.success) return reject({ reason: "malformed_call", message: `not a capability call proposal: ${proposal.error.message}` });
    if (!floors.parsed.ok) return reject({ reason: "malformed_call", message: floors.parsed.message });
    // §2.3.1 rule 6 (v0.6, A5): an undeclared flag on a program whose surface is code-free everywhere, and which is not
    // on the §2.3 list, is a rejection. Step 3 has passed, so no instruction value is below its floor.
    const undeclared = undeclaredFlagOf(entry, floors.parsed.call);
    if (undeclared !== null) {
      return reject({ reason: "malformed_call", message: `${programShape(entry)?.argv ?? "argv"}[${String(undeclared)}] is a flag the program's declared surface does not list (§2.3.1 rule 6)` });
    }
    // One frozen copy of the inspected call: the adapter plans from it, and the Authorization carries it (D-053).
    const parsedCall = frozenCall(floors.parsed.call);

    // The grant check, decided only now that step 3 has passed.
    if (coverage.covering.length === 0) return park({ reason: "awaiting_grant", refused: coverage.refused });

    // Step 4.
    const canonical = context.canonical ?? new Map();
    const scoped = meetFloors.map((grant) => ({ grant, outside: scopeViolations(entry, parsedCall, grant, canonical) }));
    const inScope = scoped.filter((candidate) => candidate.outside.length === 0).map((candidate) => candidate.grant);
    if (inScope.length === 0) {
      const outside = [...new Set(scoped.flatMap((candidate) => candidate.outside.map((violation) => violation.argument)))].sort();
      const untrusted = outside.filter((argument) => causingIntegrity(entry, parsedCall, argument, integrityOf) === "untrusted");
      return park({ reason: "scope_violation", grants: scoped.map(({ grant, outside: values }) => ({ grant: grant.id, outside: values })), untrusted });
    }

    // Step 4, effects (§2.2.2, §2.7.1 "Effects"; D-135): an untrusted target of an effect that cannot be undone must be
    // one the grant enumerates. Not overridable (§8.3): the operator cannot observe where such an effect lands.
    const judgedEffect = effectOf(entry, parsedCall, canonical, context.reversible ?? [], context.unrestorable ?? {});
    const effects = inScope.map((grant) => ({ grant, refused: effectRefusals(entry, parsedCall, grant, integrityOf, judgedEffect, canonical) }));
    const permitted = effects.filter((candidate) => candidate.refused.length === 0).map((candidate) => candidate.grant);
    if (permitted.length === 0) {
      return park({ reason: "integrity_floor", violations: [], grants: [], effects: effects.map(({ grant, refused }) => ({ grant: grant.id, refused })) });
    }

    // Step 5, mediated modes (§4.3 V6-7, D-150): a read above the session provider's clearance parks before it runs. It is
    // judged here, after steps 3 and 4, so an integrity_floor or scope_violation park is never turned into this one.
    const gate = context.readGate;
    if (gate !== undefined && compareSensitivity(gate.reads, gate.clearance) > 0) {
      return park({ reason: "sensitivity_ceiling", aggregate: gate.reads, ceiling: gate.clearance, grants: [], read_gate: true });
    }

    // Step 5: the capability's ceiling, then each remaining candidate's lower ceiling.
    const inputClass = callInputClass(
      records.map((item) => item.data_class),
      synthesized,
    );
    const aggregate = inputClass.sensitivity;
    const ceiling = capability.max_input_sensitivity;
    if (compareSensitivity(aggregate, ceiling) > 0) {
      return park({ reason: "sensitivity_ceiling", aggregate, ceiling, grants: [] });
    }
    const chosen = permitted.find((grant) => compareSensitivity(aggregate, grant.data_class_bounds.max_sensitivity) <= 0);
    if (chosen === undefined) {
      return park({
        reason: "sensitivity_ceiling",
        aggregate,
        ceiling,
        grants: permitted.map((grant) => ({ grant: grant.id, max_sensitivity: grant.data_class_bounds.max_sensitivity })),
      });
    }

    // Step 6.
    const planned = this.#plan(capability, parsedCall);
    if (!planned.ok) return park(planned.detail);
    const { adapter, invocation } = planned;

    this.#grants.charge(chosen.id);
    // The journal records the same copy the Authorization carries and `perform` runs (D-053).
    const callSeq = record({ outcome: "proceed", adapter, invocation }, chosen.id);
    // Frozen, with frozen copies of what was inspected: what `perform` runs cannot be changed after inspection.
    const authorization: Authorization = Object.freeze({
      task_id: task.id,
      call_seq: callSeq,
      capability: capability.id,
      grant: chosen.id,
      adapter,
      call: parsedCall,
      invocation,
      input_class: Object.freeze({ ...inputClass }),
    });
    this.#issued.add(authorization);
    return { outcome: "proceed", call_seq: callSeq, authorization };
  }

  /** Runs an authorized invocation, exactly as inspected, once (§3.2: the task requests an effect, the boundary performs it). */
  perform(authorization: Authorization): Promise<InvocationResult> {
    if (!this.#issued.delete(authorization)) {
      return Promise.reject(new EnforcementError("not an authorization this boundary issued, or one already performed"));
    }
    return executeOutbound(authorization.invocation);
  }

  #resolve(
    context: TaskContext,
    capability: string,
    leaves: readonly Leaf[],
    synthesized: DataClass,
    journal = true,
  ): { records: ArgumentRecord[]; failures: UnresolvedArgument[] } {
    const { task, constants } = context;
    const root = this.#journal.root;
    // The task's own trajectory, and nothing else: a reference cannot reach another task (§2.6).
    const trajectory = readTrajectory(root, task.id);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const payloads = new Map<number, unknown>();
    const payloadOf = (entry: { readonly seq: number; readonly payload_ref: string }): unknown => {
      if (!payloads.has(entry.seq)) {
        const blob = readPayload(root, entry.payload_ref);
        let parsed: unknown;
        try {
          parsed = blob.status === "present" ? JSON.parse(decoder.decode(blob.bytes)) : undefined;
        } catch {
          parsed = undefined;
        }
        payloads.set(entry.seq, parsed);
      }
      return payloads.get(entry.seq);
    };

    const records: ArgumentRecord[] = [];
    const failures: UnresolvedArgument[] = [];
    for (const { argument, source } of leaves) {
      if (source === undefined) {
        // States no provenance: nothing to resolve or classify. Step 3 holds it to its floor with no integrity (D-054).
        continue;
      } else if (source.class === "synthesized") {
        // Invariant 7: no comparison with prior values is made; only the reference mechanism confers `bound`.
        records.push({ argument, class: "synthesized", data_class: synthesized, value: source.value, origin: { class: "synthesized" } });
      } else if (source.class === "constant") {
        const constant = Object.hasOwn(constants, source.slot) ? constants[source.slot] : undefined;
        if (constant === undefined) {
          failures.push({ argument, class: "constant", code: "unknown_slot", message: `no constant slot ${JSON.stringify(source.slot)} was fixed at admission` });
        } else {
          records.push({ argument, class: "constant", data_class: constant.data_class, value: constant.value, origin: { class: "constant", slot: source.slot } });
        }
      } else {
        const resolution = resolveReference(source.reference, trajectory, payloadOf);
        const base = { capability, argument, reference: source.reference };
        if (resolution.ok) {
          const candidates = resolution.candidates.length > 1 ? { binding_candidates: [...resolution.candidates] } : {};
          const bindingEntry = !journal ? -1 : this.#append(
            task.id,
            { ...this.#draft("binding_resolution", join([synthesized, resolution.data_class])), ...candidates },
            { ...base, outcome: "resolved", bound_to: resolution.seq, value: resolution.value, candidates: [...resolution.candidates] },
          );
          records.push({
            argument,
            class: "bound",
            data_class: resolution.data_class,
            value: resolution.value,
            origin: { class: "bound", reference: source.reference, bound_to: resolution.seq, binding_entry: bindingEntry },
          });
        } else {
          if (journal) this.#append(task.id, this.#draft("binding_resolution", synthesized), {
            ...base,
            outcome: "rejected",
            code: resolution.code,
            message: resolution.message,
          });
          failures.push({ argument, class: "bound", code: resolution.code, message: resolution.message });
        }
      }
    }
    return { records, failures };
  }

  /**
   * Step 6: the quarantine check, then the runtime observation of the planned
   * invocation (§2.4, §2.5). The adapter's plan is read exactly once, into a
   * frozen copy; only that copy is inspected and returned (D-053).
   */
  #plan(
    definition: Capability,
    call: CapabilityCall,
  ): { ok: true; adapter: string; invocation: OutboundInvocation } | { ok: false; detail: ParkDetail } {
    const capability = definition.id;
    const adapter = this.#registry.servingAdapter(capability);
    if (adapter === undefined) throw new EnforcementError(`capability ${capability} has no serving adapter`);
    const known = this.#registry.quarantined(capability, adapter);
    if (known !== undefined) return { ok: false, detail: { reason: "adapter_quarantined", adapter, observation: known.observation, failures: [], invocation: null } };

    let invocation: OutboundInvocation;
    try {
      invocation = copyInvocation(this.#registry.plan(capability, call).invocation);
    } catch (error: unknown) {
      if (error instanceof RegistryError || error instanceof BoundaryError) throw error;
      // An adapter that cannot carry a valid data value does not deliver it structurally (D-033, D-044).
      const observation = `the adapter refused a valid call: ${error instanceof Error ? error.message : String(error)}`;
      this.#registry.quarantine({ capability, adapter, observation });
      return { ok: false, detail: { reason: "adapter_quarantined", adapter, observation, failures: [], invocation: null } };
    }
    const failures = deliveryFailures(definition, call, invocation);
    if (failures.length > 0) {
      const observation = `data not delivered as discrete argv elements: ${failures.map((failure) => failure.field).join(", ")}`;
      this.#registry.quarantine({ capability, adapter, observation });
      return { ok: false, detail: { reason: "adapter_quarantined", adapter, observation, failures, invocation } };
    }
    return { ok: true, adapter, invocation };
  }

  #draft(kind: EntryDraft["kind"], dataClass: DataClass): EntryDraft {
    return { kind, actor: ENFORCEMENT_ACTOR, provider: null, data_class: dataClass, cost: NO_COST };
  }

  #append(taskId: string, draft: EntryDraft, payload: unknown): number {
    return this.#journal.append(taskId, draft, new TextEncoder().encode(canonicalJson(payload))).seq;
  }

  #recordCall(
    taskId: string,
    capability: string,
    records: readonly ArgumentRecord[],
    judged: readonly Judged[],
    failures: readonly UnresolvedArgument[],
    unprovenanced: readonly Leaf[],
    synthesized: DataClass,
    verdict: Readonly<Record<string, unknown>>,
    grant: string | null,
  ): number {
    // The provenance step 3 judged: an unresolved bound argument is recorded as the `untrusted` it was held to (D-048).
    const provenance = judged.map(({ argument, class: kind, integrity }) => ({ argument, class: kind, integrity }));
    // The entry holds the proposal itself, which the model composed, and every argument value.
    const dataClass = join([synthesized, ...records.map((item) => item.data_class)]);
    const payload = {
      capability,
      arguments: records.map(({ argument, class: kind, data_class, value, origin }) => ({
        argument,
        class: kind,
        integrity: data_class.integrity,
        sensitivity: data_class.sensitivity,
        value,
        origin: { ...origin },
      })),
      unresolved: failures.map((failure) => ({ ...failure })),
      // Values that stated no provenance: named, with their shape, never their content (D-054).
      unprovenanced: unprovenanced.map(({ argument, raw }) => ({ argument, shape: shapeOf(raw) })),
      grant,
      verdict,
    };
    return this.#append(taskId, { ...this.#draft("capability_call", dataClass), argument_provenance: provenance }, payload);
  }
}
