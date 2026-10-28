import type { Capability } from "../../contracts/src/index.js";
import type { CapabilityCall, OutboundInvocation } from "../../registry/src/index.js";

/**
 * Runtime observation of the §2.4 structural channel (spec §2.5: "where
 * detection is possible it is applied"; DECISIONS.md D-044).
 *
 * Before a call runs, the boundary inspects the one invocation the serving
 * adapter planned for it. Every text-carrying `data` value must arrive as one
 * whole argv element, byte for byte, and a list as consecutive elements in
 * its own order. A value that is missing as a whole element was transformed
 * on the way: the adapter built a string from it. That forfeits the adapter's
 * registration and quarantines its capability.
 *
 * Accepted residual (§0.5 corollary): real values are not unique the way the
 * registration canary is, so this cannot tell whether a value *also* appears
 * inside a longer element (`-n` is a substring of `--no-deps`). An adapter
 * that delivers a value discretely and interpolates it as well passes here;
 * the registration suite's canary is what catches that.
 */

export type DeliveryFailure = {
  readonly field: string;
  readonly kind: "not_discrete" | "list_not_intact";
};

function containsRun(args: readonly string[], run: readonly string[]): boolean {
  if (run.length === 0) return true;
  for (let start = 0; start + run.length <= args.length; start += 1) {
    if (run.every((item, offset) => args[start + offset] === item)) return true;
  }
  return false;
}

export function deliveryFailures(capability: Capability, call: CapabilityCall, invocation: OutboundInvocation): DeliveryFailure[] {
  const failures: DeliveryFailure[] = [];
  for (const [name, field] of Object.entries(capability.interface)) {
    if (field.role !== "data") continue;
    const value = call[name];
    if (typeof value === "string") {
      if (!invocation.args.includes(value)) failures.push({ field: name, kind: "not_discrete" });
    } else if (Array.isArray(value)) {
      const texts = value.filter((item): item is string => typeof item === "string");
      if (texts.length === value.length && !containsRun(invocation.args, texts)) failures.push({ field: name, kind: "list_not_intact" });
    }
  }
  return failures;
}
