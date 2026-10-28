/**
 * The `bound` reference grammar (spec §17 O9, §2.6):
 *
 *   ${<seq>.<path>}
 *
 * `<seq>` is a trajectory sequence number within the same task; `<path>` is a
 * JSONPath-style accessor into that entry's payload. References that are
 * cross-task, ambiguous or unresolvable are rejected. The exact grammar is
 * fixed in DECISIONS.md D-019:
 *
 *   reference  := "${" seq "." path "}"
 *   seq        := "0" | [1-9][0-9]*
 *   path       := step ( "." identifier | bracket )*
 *   step       := identifier | bracket
 *   bracket    := "[" index "]" | "[" json-string "]"
 *   identifier := [A-Za-z_][A-Za-z0-9_]*
 *   index      := "0" | [1-9][0-9]*
 *
 * The whole text must be exactly one reference. Text with anything around a
 * reference is not a reference: splicing a value into surrounding text is
 * templating, and a template the model fills is `synthesized` (§2.6).
 *
 * This module only parses. Resolving a reference against the task's own
 * trajectory is the enforcement boundary's job (§2.7, Increment 4).
 */

export type PathStep = { readonly kind: "key"; readonly key: string } | { readonly kind: "index"; readonly index: number };

export type Reference = {
  readonly seq: number;
  readonly path: readonly [PathStep, ...PathStep[]];
};

/**
 * Why a text is not an acceptable reference:
 * - `cross_task`: it tries to name another task. References carry no task component.
 * - `ambiguous`: it could select more than one value, or be read more than one way.
 * - `unresolvable`: it names no entry or no value (missing sequence number or path, or a number out of range).
 * - `malformed`: anything else outside the grammar, including text around a reference.
 */
export type ReferenceErrorCode = "cross_task" | "ambiguous" | "unresolvable" | "malformed";

export type ReferenceParseResult =
  | { readonly ok: true; readonly reference: Reference }
  | { readonly ok: false; readonly code: ReferenceErrorCode; readonly message: string };

export const MAX_REFERENCE_LENGTH = 1024;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
/** Characters that qualify a sequence number with a task, e.g. `task:12`, `12@task`, `task/12`, `task#12`. */
const TASK_QUALIFIER = /[:@/#]/;

class ReferenceSyntaxError extends Error {
  readonly code: ReferenceErrorCode;

  constructor(code: ReferenceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function fail(code: ReferenceErrorCode, message: string): never {
  throw new ReferenceSyntaxError(code, message);
}

/** Parses a non-negative decimal integer with no leading zeros and no larger than Number.MAX_SAFE_INTEGER. */
function parseNatural(digits: string, what: string): number {
  if (digits.length > 1 && digits.startsWith("0")) {
    fail("ambiguous", `${what} "${digits}" has a leading zero`);
  }
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) {
    fail("unresolvable", `${what} "${digits}" is out of range`);
  }
  return value;
}

class Cursor {
  private index = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  get atEnd(): boolean {
    return this.index >= this.text.length;
  }

  peek(offset = 0): string {
    return this.text.charAt(this.index + offset);
  }

  next(): string {
    const char = this.text.charAt(this.index);
    this.index += 1;
    return char;
  }

  takeWhile(pattern: RegExp): string {
    const start = this.index;
    while (!this.atEnd && pattern.test(this.peek())) {
      this.index += 1;
    }
    return this.text.slice(start, this.index);
  }

  /** Reads a JSON string literal starting at the opening quote. */
  takeJsonString(): string {
    const start = this.index;
    this.index += 1;
    while (!this.atEnd) {
      const char = this.next();
      if (char === "\\") {
        this.index += 1;
      } else if (char === '"') {
        const literal = this.text.slice(start, this.index);
        try {
          const parsed: unknown = JSON.parse(literal);
          if (typeof parsed === "string") {
            return parsed;
          }
        } catch {
          // fall through to the failure below
        }
        fail("malformed", `key ${literal} is not a valid JSON string`);
      }
    }
    fail("malformed", "unterminated quoted key");
  }
}

function unexpected(char: string, where: string): never {
  if (char === "*" || char === "?") {
    fail("ambiguous", `"${char}" ${where} can select more than one value`);
  }
  fail("malformed", `unexpected "${char}" ${where}`);
}

function parseIdentifier(cursor: Cursor): PathStep {
  const char = cursor.peek();
  if (cursor.atEnd) {
    fail("unresolvable", "empty path segment");
  }
  if (char === ".") {
    fail("ambiguous", "recursive descent (..) can select more than one value");
  }
  if (!IDENTIFIER_START.test(char)) {
    unexpected(char, "at the start of a path segment");
  }
  return { kind: "key", key: cursor.takeWhile(IDENTIFIER_PART) };
}

function parseBracket(cursor: Cursor): PathStep {
  cursor.next(); // "["
  const char = cursor.peek();
  let step: PathStep;
  if (cursor.atEnd) {
    fail("malformed", "unterminated bracket");
  } else if (char === "]") {
    fail("unresolvable", "empty brackets name no value");
  } else if (char === "-") {
    fail("ambiguous", "a negative index is relative to the end of the list");
  } else if (char === ":") {
    fail("ambiguous", "a slice can select more than one value");
  } else if (DIGIT.test(char)) {
    step = { kind: "index", index: parseNatural(cursor.takeWhile(DIGIT), "index") };
  } else if (char === '"') {
    step = { kind: "key", key: cursor.takeJsonString() };
  } else {
    unexpected(char, "inside brackets");
  }
  const close = cursor.peek();
  if (close === "," || close === ":") {
    fail("ambiguous", close === "," ? "a union can select more than one value" : "a slice can select more than one value");
  }
  if (close !== "]") {
    if (cursor.atEnd) {
      fail("malformed", "unterminated bracket");
    }
    unexpected(close, "inside brackets");
  }
  cursor.next(); // "]"
  return step;
}

function parseSeq(cursor: Cursor): number {
  const head = cursor.takeWhile(/[^.[]/);
  if (head === "") {
    fail("unresolvable", "missing sequence number");
  }
  if (/^[0-9]+$/.test(head)) {
    return parseNatural(head, "sequence number");
  }
  const qualifiesTask = TASK_QUALIFIER.test(head) || (cursor.peek() === "." && DIGIT.test(cursor.peek(1)));
  if (qualifiesTask) {
    fail("cross_task", `"${head}" names a task; a reference resolves only within its own task's trajectory (spec §2.6)`);
  }
  fail("malformed", `sequence number "${head}" is not a non-negative integer`);
}

function parseBody(body: string): Reference {
  const cursor = new Cursor(body);
  const seq = parseSeq(cursor);
  if (cursor.atEnd) {
    fail("unresolvable", "missing path into the entry's payload");
  }
  if (cursor.peek() !== ".") {
    unexpected(cursor.peek(), "after the sequence number");
  }
  cursor.next(); // "."
  if (cursor.atEnd) {
    fail("unresolvable", "missing path into the entry's payload");
  }
  const first = cursor.peek() === "[" ? parseBracket(cursor) : parseIdentifier(cursor);
  const path: [PathStep, ...PathStep[]] = [first];
  while (!cursor.atEnd) {
    const char = cursor.peek();
    if (char === ".") {
      cursor.next();
      path.push(parseIdentifier(cursor));
    } else if (char === "[") {
      path.push(parseBracket(cursor));
    } else {
      unexpected(char, "in the path");
    }
  }
  return { seq, path };
}

export function parseReference(text: string): ReferenceParseResult {
  if (text.length > MAX_REFERENCE_LENGTH) {
    return { ok: false, code: "malformed", message: `longer than ${String(MAX_REFERENCE_LENGTH)} characters` };
  }
  if (!text.startsWith("${") || !text.endsWith("}")) {
    return { ok: false, code: "malformed", message: "a reference is exactly one ${<seq>.<path>} with nothing around it" };
  }
  try {
    return { ok: true, reference: parseBody(text.slice(2, -1)) };
  } catch (error: unknown) {
    if (error instanceof ReferenceSyntaxError) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}

/** The canonical text of a reference. `parseReference(formatReference(r))` returns `r`. */
export function formatReference(reference: Reference): string {
  const steps = reference.path.map((step, position) => {
    if (step.kind === "index") {
      return `[${String(step.index)}]`;
    }
    if (IDENTIFIER.test(step.key)) {
      return position === 0 ? step.key : `.${step.key}`;
    }
    return `[${JSON.stringify(step.key)}]`;
  });
  return `\${${String(reference.seq)}.${steps.join("")}}`;
}
