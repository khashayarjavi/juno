// Local ESLint plugin for JUNO.
//
// `juno/no-shell` is the code-level form of the adapter contract (spec §2.4):
// a value must reach a program as a discrete argv element, never inside a
// string that a shell or other parser will interpret. The rule:
//
//   1. allows only `execFile` to be imported from `child_process`
//      (bans `exec`, `execSync`, `spawn*`, `fork`, `execFileSync`, default and
//      namespace imports, `require`, dynamic `import()`, and re-exports);
//   2. bans a `shell` option set to anything but the literal `false`;
//   3. bans building the program or an argv element of an `execFile` call with
//      a template literal that has substitutions, or with `+` concatenation.
//
// Like the §2.4 conformance suite, this catches honest mistakes, not deliberate
// evasion (for example, reaching `child_process` through `process.binding`).
// That limit is stated here on purpose (§0.5 corollary).

const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const ALLOWED_IMPORTS = new Set(["execFile"]);

/** @param {unknown} node */
function isChildProcessSource(node) {
  return (
    typeof node === "object" &&
    node !== null &&
    /** @type {{ type?: unknown }} */ (node).type === "Literal" &&
    CHILD_PROCESS_MODULES.has(String(/** @type {{ value?: unknown }} */ (node).value))
  );
}

/**
 * True when the expression builds a string from parts at runtime.
 * @param {import("estree").Node | null | undefined} node
 */
function isBuiltString(node) {
  if (!node) return false;
  if (node.type === "TemplateLiteral") return node.expressions.length > 0;
  if (node.type === "BinaryExpression") return node.operator === "+";
  return false;
}

/** @param {import("estree").Node} key */
function propertyName(key) {
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal") return String(key.value);
  return undefined;
}

/** @param {import("estree").Node} value */
function isLiteralFalse(value) {
  return value.type === "Literal" && value.value === false;
}

/** @type {import("eslint").Rule.RuleModule} */
const noShell = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban shell execution and string-built commands; only execFile(program, argv[]) is allowed (spec §2.4).",
    },
    schema: [],
    messages: {
      bannedImport:
        "'{{name}}' from child_process is banned. Use execFile(program, argvArray) only (spec §2.4, CLAUDE.md rule 8).",
      wholeModule:
        "Importing child_process as a whole is banned; import { execFile } by name (spec §2.4).",
      reexport: "Re-exporting from child_process is banned (spec §2.4).",
      shellOption:
        "The 'shell' option must be the literal false. A shell parses its input (spec §2.4).",
      builtCommand:
        "Do not build a command or argv element with a template literal or '+'. Pass each value as its own argv element (spec §2.4).",
    },
  },
  create(context) {
    /** Names bound to execFile or to promisify(execFile) in this file. */
    const launchers = new Set(["execFile"]);

    return {
      ImportDeclaration(node) {
        if (!isChildProcessSource(node.source)) return;
        if (/** @type {{ importKind?: string }} */ (node).importKind === "type") return;
        for (const spec of node.specifiers) {
          if (spec.type !== "ImportSpecifier") {
            context.report({ node: spec, messageId: "wholeModule" });
            continue;
          }
          if (/** @type {{ importKind?: string }} */ (spec).importKind === "type") continue;
          const name = propertyName(spec.imported) ?? "";
          if (ALLOWED_IMPORTS.has(name)) {
            launchers.add(spec.local.name);
          } else {
            context.report({ node: spec, messageId: "bannedImport", data: { name } });
          }
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source && isChildProcessSource(node.source)) {
          context.report({ node, messageId: "reexport" });
        }
      },
      ExportAllDeclaration(node) {
        if (isChildProcessSource(node.source)) context.report({ node, messageId: "reexport" });
      },
      ImportExpression(node) {
        if (isChildProcessSource(node.source)) context.report({ node, messageId: "wholeModule" });
      },
      /** @param {any} node TypeScript `import x = require("child_process")` */
      TSImportEqualsDeclaration(node) {
        const ref = node.moduleReference;
        if (ref && ref.type === "TSExternalModuleReference" && isChildProcessSource(ref.expression)) {
          context.report({ node, messageId: "wholeModule" });
        }
      },
      VariableDeclarator(node) {
        // const run = promisify(execFile)  -> `run` is a launcher too.
        const init = node.init;
        if (
          node.id.type === "Identifier" &&
          init &&
          init.type === "CallExpression" &&
          init.arguments[0] &&
          init.arguments[0].type === "Identifier" &&
          launchers.has(init.arguments[0].name)
        ) {
          launchers.add(node.id.name);
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === "Identifier" &&
          callee.name === "require" &&
          isChildProcessSource(node.arguments[0])
        ) {
          context.report({ node, messageId: "wholeModule" });
          return;
        }
        const calleeName =
          callee.type === "Identifier"
            ? callee.name
            : callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier"
              ? callee.property.name
              : undefined;
        if (calleeName === undefined || !launchers.has(calleeName)) return;

        const [program, argv] = node.arguments;
        if (program && program.type !== "SpreadElement" && isBuiltString(program)) {
          context.report({ node: program, messageId: "builtCommand" });
        }
        if (argv && argv.type === "ArrayExpression") {
          for (const element of argv.elements) {
            if (element && element.type !== "SpreadElement" && isBuiltString(element)) {
              context.report({ node: element, messageId: "builtCommand" });
            }
          }
        }
      },
      Property(node) {
        if (node.computed || propertyName(node.key) !== "shell") return;
        const value = /** @type {import("estree").Node} */ (node.value);
        if (isLiteralFalse(value) || value.type === "ObjectExpression") return;
        context.report({ node, messageId: "shellOption" });
      },
      AssignmentExpression(node) {
        const left = node.left;
        if (
          left.type === "MemberExpression" &&
          !left.computed &&
          left.property.type === "Identifier" &&
          left.property.name === "shell" &&
          !isLiteralFalse(node.right)
        ) {
          context.report({ node, messageId: "shellOption" });
        }
      },
    };
  },
};

/** @type {import("eslint").ESLint.Plugin} */
const plugin = {
  meta: { name: "eslint-plugin-juno" },
  rules: { "no-shell": noShell },
};

export default plugin;
