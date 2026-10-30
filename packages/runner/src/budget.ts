import type { Budget } from "../../contracts/src/index.js";

/**
 * Task budgets on all four axes (spec §3.1, §9; DECISIONS.md D-063).
 * Exhausting any axis parks the task `budget_exceeded` (§6.2), each axis on
 * its own.
 *
 * - `turns`: provider calls started.
 * - `tokens`: every token the provider reports, in, out and cached.
 * - `currency`: computed by the runner from those tokens and the provider
 *   profile's prices, never taken from the provider.
 * - `wall_clock_ms`: elapsed running time only; parked time is not counted
 *   (D-025). TTL, which does count parked time, is separate (§6.4).
 */

export const BUDGET_AXES = ["tokens", "currency", "wall_clock_ms", "turns"] as const;
export type BudgetAxis = (typeof BUDGET_AXES)[number];

export type Spend = { tokens: number; currency: number; wall_clock_ms: number; turns: number };

export const NO_SPEND: Readonly<Spend> = Object.freeze({ tokens: 0, currency: 0, wall_clock_ms: 0, turns: 0 });

/** The axes with nothing left: no further turn may start, and no further call may run once wall clock is spent. */
export function exhaustedAxes(spent: Readonly<Spend>, budget: Budget, axes: readonly BudgetAxis[] = BUDGET_AXES): BudgetAxis[] {
  return axes.filter((axis) => spent[axis] >= budget[axis]);
}

/** The axes a finished turn went past. Its proposed calls are then not acted on. */
export function overrunAxes(spent: Readonly<Spend>, budget: Budget): BudgetAxis[] {
  return BUDGET_AXES.filter((axis) => spent[axis] > budget[axis]);
}
