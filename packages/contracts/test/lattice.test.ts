import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type DataClass,
  INTEGRITY_LEVELS,
  type NonEmpty,
  SENSITIVITY_LEVELS,
  SensitivityFloorDecreaseError,
  assertSensitivityFloorTransition,
  compareIntegrity,
  compareSensitivity,
  join,
  raiseSensitivityFloor,
} from "../src/index.js";

const sensitivity = fc.constantFrom(...SENSITIVITY_LEVELS);
const integrity = fc.constantFrom(...INTEGRITY_LEVELS);
const dataClass: fc.Arbitrary<DataClass> = fc.record({ sensitivity, integrity });
const inputs: fc.Arbitrary<NonEmpty<DataClass>> = fc
  .array(dataClass, { minLength: 1, maxLength: 12 })
  .map((list) => list as unknown as NonEmpty<DataClass>);

const join2 = (a: DataClass, b: DataClass): DataClass => join([a, b]);
const sameClass = (a: DataClass, b: DataClass): boolean => a.sensitivity === b.sensitivity && a.integrity === b.integrity;

describe("the lattice orders (§1.1)", () => {
  // proves §1.1: public < internal < confidential < secret
  it("orders sensitivity public < internal < confidential < secret", () => {
    expect(compareSensitivity("public", "internal")).toBeLessThan(0);
    expect(compareSensitivity("internal", "confidential")).toBeLessThan(0);
    expect(compareSensitivity("confidential", "secret")).toBeLessThan(0);
  });

  // proves §1.1: operator is the most trusted level and untrusted the least
  it("orders integrity untrusted < derived < attested < operator", () => {
    expect(compareIntegrity("untrusted", "derived")).toBeLessThan(0);
    expect(compareIntegrity("derived", "attested")).toBeLessThan(0);
    expect(compareIntegrity("attested", "operator")).toBeLessThan(0);
  });
});

describe("join (§1.2): sensitivity = max(inputs), integrity = min(inputs)", () => {
  // proves §1.2: the join takes the most sensitive input and the least trusted input
  it("returns the highest input sensitivity and the lowest input integrity", () => {
    fc.assert(
      fc.property(inputs, (list) => {
        const result = join(list);
        expect(list.some((input) => input.sensitivity === result.sensitivity)).toBe(true);
        expect(list.some((input) => input.integrity === result.integrity)).toBe(true);
        for (const input of list) {
          expect(compareSensitivity(result.sensitivity, input.sensitivity)).toBeGreaterThanOrEqual(0);
          expect(compareIntegrity(result.integrity, input.integrity)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });

  // proves §1.2: join is commutative — the order two inputs arrive in does not matter
  it("is commutative", () => {
    fc.assert(fc.property(dataClass, dataClass, (a, b) => sameClass(join2(a, b), join2(b, a))));
  });

  // proves §1.2: join is associative — how inputs are grouped does not matter
  it("is associative", () => {
    fc.assert(
      fc.property(dataClass, dataClass, dataClass, (a, b, c) =>
        sameClass(join2(join2(a, b), c), join2(a, join2(b, c))),
      ),
    );
  });

  // proves §1.2: commutativity and associativity checked on every one of the 16^3 triples, not a sample
  it("is commutative and associative on the whole lattice, exhaustively", () => {
    const all: DataClass[] = SENSITIVITY_LEVELS.flatMap((s) => INTEGRITY_LEVELS.map((i) => ({ sensitivity: s, integrity: i })));
    for (const a of all) {
      for (const b of all) {
        expect(sameClass(join2(a, b), join2(b, a))).toBe(true);
        for (const c of all) {
          expect(sameClass(join2(join2(a, b), c), join2(a, join2(b, c)))).toBe(true);
        }
      }
    }
  });

  // proves §1.2: joining material with itself changes nothing
  it("is idempotent", () => {
    fc.assert(fc.property(dataClass, (a) => sameClass(join2(a, a), a)));
  });

  // proves §1.2: a list of inputs joins to the same class in any order
  it("does not depend on the order of a list of inputs", () => {
    fc.assert(
      fc.property(inputs, fc.infiniteStream(fc.nat()), (list, randomness) => {
        const shuffled = [...list].map((input) => ({ input, key: randomness.next().value as number }));
        shuffled.sort((x, y) => x.key - y.key);
        const permuted = shuffled.map((entry) => entry.input) as unknown as NonEmpty<DataClass>;
        return sameClass(join(list), join(permuted));
      }),
    );
  });

  // proves §1.2: joining two lists equals joining the joins of each list
  it("composes over concatenation", () => {
    fc.assert(fc.property(inputs, inputs, (xs, ys) => sameClass(join([...xs, ...ys]), join2(join(xs), join(ys)))));
  });

  // proves §1.2 monotonicity: adding an input never lowers sensitivity and never raises integrity
  it("is monotonic in the right direction on both axes", () => {
    fc.assert(
      fc.property(inputs, dataClass, (list, extra) => {
        const before = join(list);
        const after = join([...list, extra]);
        expect(compareSensitivity(after.sensitivity, before.sensitivity)).toBeGreaterThanOrEqual(0);
        expect(compareIntegrity(after.integrity, before.integrity)).toBeLessThanOrEqual(0);
      }),
    );
  });

  // proves §1.2 contamination: one untrusted input makes the whole result untrusted, one secret input makes it secret
  it("is contaminated by any single untrusted or secret input", () => {
    fc.assert(
      fc.property(inputs, (list) => {
        expect(join([...list, { sensitivity: "public", integrity: "untrusted" }]).integrity).toBe("untrusted");
        expect(join([...list, { sensitivity: "secret", integrity: "operator" }]).sensitivity).toBe("secret");
      }),
    );
  });

  // proves §1.2 / D-015: join is defined over inputs, so it cannot be called with none
  it("refuses an empty input list", () => {
    // @ts-expect-error the type requires at least one input
    expect(() => join([])).toThrow(RangeError);
  });
});

describe("task sensitivity_floor (§1.2, §3.1): monotonic non-decreasing", () => {
  // proves §3.1: exposure to any material never lowers the floor
  it("never decreases when the task is exposed to more material", () => {
    fc.assert(
      fc.property(sensitivity, fc.array(sensitivity), (start, exposures) => {
        let floor = start;
        for (const exposure of exposures) {
          const next = raiseSensitivityFloor(floor, exposure);
          expect(compareSensitivity(next, floor)).toBeGreaterThanOrEqual(0);
          expect(compareSensitivity(next, exposure)).toBeGreaterThanOrEqual(0);
          floor = next;
        }
      }),
    );
  });

  // proves §3.1: a write that would lower the floor is refused, on every pair of levels
  it("rejects every transition that would lower the floor and accepts every other", () => {
    for (const from of SENSITIVITY_LEVELS) {
      for (const to of SENSITIVITY_LEVELS) {
        if (compareSensitivity(to, from) < 0) {
          expect(() => assertSensitivityFloorTransition(from, to)).toThrow(SensitivityFloorDecreaseError);
        } else {
          expect(assertSensitivityFloorTransition(from, to)).toBe(to);
        }
      }
    }
  });
});
