import { z } from "zod";
import { Count, Currency, DurationMs, Ref } from "./common.js";
import { Integrity, Sensitivity } from "./lattice.js";

/**
 * Task (spec §3.1). Shapes the model leaves as "structured" are fixed in
 * DECISIONS.md D-021.
 *
 * Integrity is not a property of tasks (§1.2). A task carries
 * `sensitivity_floor` only, and that floor is monotonic non-decreasing:
 * every write of it goes through `raiseSensitivityFloor` or
 * `assertSensitivityFloorTransition` in `lattice.ts`.
 */

export const CLOSURE_MODES = ["verified", "attested", "accepted"] as const;
export const ClosureMode = z.enum(CLOSURE_MODES);
export type ClosureMode = z.infer<typeof ClosureMode>;

export const ATTENDANCES = ["gated", "autonomous"] as const;
export const Attendance = z.enum(ATTENDANCES);
export type Attendance = z.infer<typeof Attendance>;

export const CONTEXT_OWNERSHIPS = ["native", "owned"] as const;
export const ContextOwnership = z.enum(CONTEXT_OWNERSHIPS);
export type ContextOwnership = z.infer<typeof ContextOwnership>;

export const STEER_CAPABILITIES = ["full", "checkpoint_only", "none"] as const;
export const SteerCapability = z.enum(STEER_CAPABILITIES);
export type SteerCapability = z.infer<typeof SteerCapability>;

/** The states of the §6 state machine. */
export const TASK_STATES = [
  "draft",
  "admitted",
  "running",
  "parked",
  "complete_unverified",
  "verified",
  "failed",
  "aborted",
  "accepted",
] as const;
export const TaskState = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof TaskState>;

/** A runtime sub-state of `running`, never a park (§3.3). */
export const RUNTIME_SUBSTATES = ["active", "blocked"] as const;
export const RuntimeSubstate = z.enum(RUNTIME_SUBSTATES);
export type RuntimeSubstate = z.infer<typeof RuntimeSubstate>;

/** Permitted providers; posture; `conversation_state` constraint (§3.1, §10.3). */
export const ModelPolicy = z.strictObject({
  permitted_providers: z.array(Ref).min(1),
  posture: z.string().min(1),
  /** `stateless` when the task requires a provider that holds no conversation state (§10.3). */
  conversation_state: z.enum(["stateless", "any"]),
});
export type ModelPolicy = z.infer<typeof ModelPolicy>;

/** All four axes, each required (§3.1, §9). */
export const Budget = z.strictObject({
  tokens: Count,
  currency: Currency,
  wall_clock_ms: DurationMs,
  turns: Count,
});
export type Budget = z.infer<typeof Budget>;

/** A machine-evaluable statement of done (§3.1). Its contents are fixed by admission (Increment 5). */
export const Criterion = z.record(z.string(), z.json());
export type Criterion = z.infer<typeof Criterion>;

const TaskFields = z.strictObject({
  id: Ref,
  /** Explicit even with one user (§3.1). */
  principal: Ref,
  /** Verbatim (§3.1). */
  objective: z.string(),
  criterion: Criterion.nullable(),
  /** Integrity of the criterion's author (§5.2). */
  criterion_integrity: Integrity,
  verification: Ref.nullable(),
  closure_mode: ClosureMode,
  attendance: Attendance,
  strategy: Ref,
  sensitivity_floor: Sensitivity,
  /** Derived at admission (§10.2); `null` only while the task is a draft. */
  context_ownership: ContextOwnership.nullable(),
  model_policy: ModelPolicy,
  budget: Budget,
  /** Absolute lifetime including parked time, in milliseconds (§6.4). */
  ttl: z.int().positive(),
  grants: z.array(Ref),
  parent: Ref.nullable(),
  state: TaskState,
  runtime_substate: RuntimeSubstate.nullable(),
  /** Derived at admission from the provider profile (§7.8); `null` only while the task is a draft. */
  steer_capability: SteerCapability.nullable(),
  /** Admission input. Defaults to `true` when `attendance = gated`, `false` otherwise (§3.1). */
  requires_live_steer: z.boolean().optional(),
  trajectory: Ref,
});

export const Task = TaskFields.superRefine((task, ctx) => {
  if (task.runtime_substate !== null && task.state !== "running") {
    ctx.addIssue({
      code: "custom",
      path: ["runtime_substate"],
      message: "runtime_substate is a sub-state of running and must be null in any other state (spec §3.3)",
    });
  }
  for (const field of ["context_ownership", "steer_capability"] as const) {
    if (task.state === "draft" && task[field] !== null) {
      ctx.addIssue({ code: "custom", path: [field], message: `${field} is derived at admission; a draft has none` });
    }
    if (task.state !== "draft" && task[field] === null) {
      ctx.addIssue({ code: "custom", path: [field], message: `${field} must be derived at admission (spec §3.1)` });
    }
  }
}).transform((task) => ({
  ...task,
  requires_live_steer: task.requires_live_steer ?? task.attendance === "gated",
}));
export type Task = z.output<typeof Task>;
