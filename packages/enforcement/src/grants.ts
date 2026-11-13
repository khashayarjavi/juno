import { Grant, instant, parseAtBoundary } from "../../contracts/src/index.js";
import { type TrustAnchor, grantSignatureValid } from "./signature.js";

/**
 * Grant storage and lookup (spec §3.2, build plan Increment 4; DECISIONS.md D-042).
 *
 * A grant covers a call only when all of these hold at the moment of the call:
 * the task lists it, it is stored, its principal is the task's principal, its
 * capability selector names the capability, it has been issued, it has not
 * expired, it has not been revoked, and its invocation cap is not used up.
 * A call with no covering grant parks `awaiting_grant` (§6.2).
 *
 * Coverage is independent of the call's values. A covering grant's
 * `data_class_bounds` are applied by the boundary at §2.7 steps 3 and 5,
 * where a breach parks `integrity_floor` or `sensitivity_ceiling` (D-046).
 */

/** Why one grant the task holds does not cover a call. Checked in this order; the first that applies is reported. */
export const GRANT_REFUSALS = [
  "unknown_grant",
  "revoked",
  "signature_invalid",
  "principal_mismatch",
  "capability_not_selected",
  "not_yet_issued",
  "expired",
  "exhausted",
  /** Issued before the journal's recovery epoch (operator ruling D-206; D-207): refused on this journal for good. */
  "issued_before_recovery",
] as const;
export type GrantRefusalReason = (typeof GRANT_REFUSALS)[number];

export type GrantRefusal = { readonly grant: string; readonly reason: GrantRefusalReason };

export type Coverage = {
  /** The grants that cover the call, in the order the task lists them. */
  readonly covering: readonly Grant[];
  /** Every grant the task lists that does not cover it, and why. */
  readonly refused: readonly GrantRefusal[];
};

export class GrantStoreError extends Error {
  override readonly name = "GrantStoreError";
}

export class GrantStore {
  readonly #grants = new Map<string, Grant>();
  readonly #used = new Map<string, number>();
  readonly #anchor: TrustAnchor;
  /** Grants a recovered torn write exhausted (D-206, D-207): never usable again on this journal, whatever their cap. */
  readonly #exhausted = new Set<string>();
  /** The journal's recovery epoch, in milliseconds (D-206, D-207): a grant issued before it is refused. */
  #recoveryEpoch: number | null = null;

  /** `anchor` is the operator's public key; every grant is checked against it at lookup (§3.2, v0.6 C1). */
  constructor(anchor: TrustAnchor) {
    this.#anchor = anchor;
  }

  /** The operator's public key this store trusts (read-only; the runner uses it to refuse a journal key equal to it). */
  get trustAnchor(): TrustAnchor {
    return this.#anchor;
  }

  /** Stores an operator-issued grant. The grant is a boundary input: it is parsed first. */
  add(input: unknown): Grant {
    const grant = parseAtBoundary("grant", Grant, input);
    if (this.#grants.has(grant.id)) throw new GrantStoreError(`grant ${grant.id} is already stored`);
    this.#grants.set(grant.id, grant);
    return grant;
  }

  get(id: string): Grant | undefined {
    return this.#grants.get(id);
  }

  /**
   * A stored grant whose operator signature verifies against the trust anchor, or `undefined`. A grant with a missing
   * or invalid signature does not exist (§3.2 C1), so admission and resume look grants up through this (D-125).
   */
  signed(id: string): Grant | undefined {
    const grant = this.#grants.get(id);
    // D-206: a grant issued before the journal's recovery epoch is refused wherever a signed grant is asked for.
    if (grant !== undefined && this.#recoveryEpoch !== null && instant(grant.issued_at) < this.#recoveryEpoch) return undefined;
    return grant !== undefined && grantSignatureValid(grant, this.#anchor) ? grant : undefined;
  }

  /**
   * What the journal's recovery records decide for grants (operator ruling D-206; D-207), set by the shared session
   * layer from the journal when a service starts, with the use counts:
   *   - `exhausted`: every grant used by a session open when a torn write was recovered. It is treated as used up,
   *     whatever its cap, until the operator signs a new grant (a new id);
   *   - `recoveryEpoch`: the time the operator registered this journal. A grant issued before it is refused.
   * Both only ever tighten: an id once exhausted stays so, and the epoch can be set once.
   */
  restoreRecovery(recovery: { readonly exhausted: Iterable<string>; readonly recoveryEpoch: number | null }): void {
    for (const id of recovery.exhausted) this.#exhausted.add(id);
    if (recovery.recoveryEpoch !== null) {
      if (!Number.isFinite(recovery.recoveryEpoch)) throw new GrantStoreError("the recovery epoch is not a time");
      if (this.#recoveryEpoch !== null && this.#recoveryEpoch !== recovery.recoveryEpoch) throw new GrantStoreError("the grant store already has another recovery epoch");
      this.#recoveryEpoch = recovery.recoveryEpoch;
    }
  }

  /** Whether a recovered torn write exhausted this grant (D-206). */
  exhaustedByRecovery(id: string): boolean {
    return this.#exhausted.has(id);
  }

  /** Whether the grant is stored and was issued before the journal's recovery epoch (D-206). */
  issuedBeforeRecovery(id: string): boolean {
    const grant = this.#grants.get(id);
    return grant !== undefined && this.#recoveryEpoch !== null && instant(grant.issued_at) < this.#recoveryEpoch;
  }

  /** Revokes a grant from `at` on. Revoking twice keeps the first revocation. */
  revoke(id: string, at: Date): Grant {
    const grant = this.#grants.get(id);
    if (grant === undefined) throw new GrantStoreError(`grant ${id} is not stored`);
    if (grant.revoked_at !== null) return grant;
    const revoked = parseAtBoundary("grant", Grant, { ...grant, revoked_at: at.toISOString() });
    this.#grants.set(id, revoked);
    return revoked;
  }

  /** How many calls this grant has authorized. */
  invocations(id: string): number {
    return this.#used.get(id) ?? 0;
  }

  /**
   * Sets every grant's use count from the journal (D-202): the shared session layer calls it once, when a service
   * starts, with the calls the journal shows each grant authorized. A count is kept by grant id, whether or not the
   * grant is stored yet, so a grant added later starts from what it already used. The store must hold no charge yet:
   * the journal is the only count.
   */
  restoreUse(counts: ReadonlyMap<string, number>): void {
    if (this.#used.size > 0) throw new GrantStoreError("the grant store already has charges; every count is rebuilt from the journal when a service starts (D-202)");
    for (const [id, count] of counts) {
      if (!Number.isSafeInteger(count) || count < 0) throw new GrantStoreError(`grant ${id} has no usable count in the journal`);
      if (count > 0) this.#used.set(id, count);
    }
  }

  /** Every grant's use count, by grant id. */
  use(): ReadonlyMap<string, number> {
    return new Map(this.#used);
  }

  /** Charges one authorized call to a grant. */
  charge(id: string): void {
    if (!this.#grants.has(id)) throw new GrantStoreError(`grant ${id} is not stored`);
    this.#used.set(id, this.invocations(id) + 1);
  }

  /** The ids of every stored grant. */
  ids(): readonly string[] {
    return [...this.#grants.keys()];
  }

  /**
   * Why each of the task's grants could not cover any call at `now`, whatever
   * the capability (§6.3 step 1: re-evaluated on resume). A grant absent here
   * is still valid; it may still not select a given capability.
   */
  validity(task: { readonly principal: string; readonly grants: readonly string[] }, now: Date): GrantRefusal[] {
    return task.grants.flatMap((id): GrantRefusal[] => {
      const grant = this.#grants.get(id);
      if (grant === undefined) return [{ grant: id, reason: "unknown_grant" }];
      const reason = this.#refusal(grant, task.principal, grant.capability_selector.capabilities[0] ?? "", now);
      return reason === null ? [] : [{ grant: id, reason }];
    });
  }

  /** Which of the task's grants cover a call to `capability` at `now`. */
  coverage(task: { readonly principal: string; readonly grants: readonly string[] }, capability: string, now: Date): Coverage {
    const covering: Grant[] = [];
    const refused: GrantRefusal[] = [];
    for (const id of task.grants) {
      const grant = this.#grants.get(id);
      const reason = grant === undefined ? "unknown_grant" : this.#refusal(grant, task.principal, capability, now);
      if (reason === null && grant !== undefined) covering.push(grant);
      else if (reason !== null) refused.push({ grant: id, reason });
    }
    return { covering, refused };
  }

  #refusal(grant: Grant, principal: string, capability: string, now: Date): GrantRefusalReason | null {
    const at = now.getTime();
    // A revocation is an act already taken; a recorded revocation time is never waited for. It is read first: the
    // signature covers `revoked_at`, so a grant revoked here no longer verifies, and it is reported as what it is.
    if (grant.revoked_at !== null) return "revoked";
    // §3.2 (C1): a grant whose signature does not verify against the trust anchor does not exist.
    if (!grantSignatureValid(grant, this.#anchor)) return "signature_invalid";
    if (grant.principal !== principal) return "principal_mismatch";
    if (!grant.capability_selector.capabilities.includes(capability)) return "capability_not_selected";
    if (at < instant(grant.issued_at)) return "not_yet_issued";
    if (at >= instant(grant.expires_at)) return "expired";
    if (this.#recoveryEpoch !== null && instant(grant.issued_at) < this.#recoveryEpoch) return "issued_before_recovery";
    if (this.#exhausted.has(grant.id)) return "exhausted";
    if (grant.max_invocations !== null && this.invocations(grant.id) >= grant.max_invocations) return "exhausted";
    return null;
  }
}
