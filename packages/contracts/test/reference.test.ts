import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type PathStep, type Reference, formatReference, parseReference } from "../src/index.js";

function parsed(text: string): Reference {
  const result = parseReference(text);
  if (!result.ok) {
    throw new Error(`expected ${text} to parse, got ${result.code}: ${result.message}`);
  }
  return result.reference;
}

function rejection(text: string): string {
  const result = parseReference(text);
  return result.ok ? "accepted" : result.code;
}

describe("the ${<seq>.<path>} reference grammar (§17 O9, §2.6)", () => {
  // proves O9: a reference names one trajectory entry by seq and one value inside its payload by path
  it.each<[string, Reference]>([
    ["${12.path}", { seq: 12, path: [{ kind: "key", key: "path" }] }],
    ["${0.files[0]}", { seq: 0, path: [{ kind: "key", key: "files" }, { kind: "index", index: 0 }] }],
    [
      "${7.result.matches[3].name}",
      {
        seq: 7,
        path: [
          { kind: "key", key: "result" },
          { kind: "key", key: "matches" },
          { kind: "index", index: 3 },
          { kind: "key", key: "name" },
        ],
      },
    ],
    ['${4.["file-name"]}', { seq: 4, path: [{ kind: "key", key: "file-name" }] }],
    ['${4.["a.b"]}', { seq: 4, path: [{ kind: "key", key: "a.b" }] }],
    ["${4.[2]}", { seq: 4, path: [{ kind: "index", index: 2 }] }],
  ])("parses %s", (text, expected) => {
    expect(parsed(text)).toEqual(expected);
  });

  // proves §2.6: cross-task references are prohibited; the grammar has no way to name another task
  it.each(["${task-b:12.path}", "${12@task-b.path}", "${task-b/12.path}", "${task#12.path}", "${taskb.12.path}", "${other_task.3.files[0]}"])(
    "rejects the cross-task form %s",
    (text) => {
      expect(rejection(text)).toBe("cross_task");
    },
  );

  // proves O9: references that could select more than one value, or be read more than one way, are rejected
  it.each([
    "${12.*}",
    "${12.files[*]}",
    "${12..name}",
    "${12.result..name}",
    "${12.files[0:2]}",
    "${12.files[:2]}",
    "${12.files[0,1]}",
    '${12.["a","b"]}',
    "${12.files[?(@.size>1)]}",
    "${12.files[-1]}",
    "${012.path}",
    "${12.files[01]}",
    "${12.file*}",
  ])("rejects the ambiguous form %s", (text) => {
    expect(rejection(text)).toBe("ambiguous");
  });

  // proves O9: references that name no entry or no value are rejected
  it.each(["${}", "${.path}", "${12}", "${12.}", "${12.files.}", "${12.files[]}", "${99999999999999999999.path}", "${1.files[99999999999999999999]}"])(
    "rejects the unresolvable form %s",
    (text) => {
      expect(rejection(text)).toBe("unresolvable");
    },
  );

  // proves §2.6: a reference is the whole argument; splicing one into text is templating, which is synthesized
  it.each(["prefix ${12.path}", "${12.path} suffix", "${1.a}${2.b}", "{12.path}", "$12.path", "12.path", ""])(
    "does not accept %j as a reference",
    (text) => {
      expect(rejection(text)).toBe("malformed");
    },
  );

  // proves O9 auditability: no whitespace, comments or alternative quoting are tolerated
  it.each(["${ 12.path}", "${12.path }", "${12. path}", "${12.['path']}", "${12[0]}", '${12.["unterminated]}'])(
    "rejects the malformed form %s",
    (text) => {
      expect(parseReference(text).ok).toBe(false);
    },
  );

  // proves O9 auditability: a reference renders as readable text and parses back to the same reference
  it("round-trips every reference through its canonical text", () => {
    const step: fc.Arbitrary<PathStep> = fc.oneof(
      fc.record({ kind: fc.constant("key" as const), key: fc.string({ maxLength: 12 }) }),
      fc.record({ kind: fc.constant("key" as const), key: fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,8}$/) }),
      fc.record({ kind: fc.constant("index" as const), index: fc.nat() }),
    );
    const reference: fc.Arbitrary<Reference> = fc.record({
      seq: fc.nat(),
      path: fc.array(step, { minLength: 1, maxLength: 6 }).map((steps) => steps as unknown as Reference["path"]),
    });
    fc.assert(
      fc.property(reference, (ref) => {
        expect(parsed(formatReference(ref))).toEqual(ref);
      }),
    );
  });

  // proves O9: arbitrary text never crashes the parser; it either parses or is rejected with a reason
  it("returns a verdict for any text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (text) => {
        const result = parseReference(`\${${text}}`);
        if (!result.ok) {
          expect(["cross_task", "ambiguous", "unresolvable", "malformed"]).toContain(result.code);
        }
      }),
    );
  });
});
