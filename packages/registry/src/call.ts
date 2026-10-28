import { z } from "zod";
import { AbsolutePath, type CapabilityInterface, type FieldType, type ScalarFieldType } from "../../contracts/src/index.js";

/**
 * The runtime schema for the arguments of one call to a capability, derived
 * from its interface (spec §2.1). Every field is required and unknown fields
 * are refused (DECISIONS.md D-016). A string can hold no NUL character,
 * because an argv element ends at NUL: such a value could not arrive intact (§2.4).
 */

export type CallScalar = string | number | boolean;
export type CallValue = CallScalar | readonly CallScalar[] | Readonly<Record<string, CallScalar>>;
export type CapabilityCall = Readonly<Record<string, CallValue>>;

const Text = z.string().refine((text) => !text.includes("\0"), "must not contain NUL; an argv element cannot carry it intact");

function scalarSchema(type: ScalarFieldType): z.ZodType<CallScalar> {
  switch (type.kind) {
    case "string":
      return Text;
    case "path":
      return AbsolutePath;
    case "integer":
      return z.int();
    case "number":
      return z.number().finite();
    case "boolean":
      return z.boolean();
    case "enum":
      return z.string().refine((value) => type.values.includes(value), `must be one of the enum values: ${type.values.join(", ")}`);
  }
}

function fieldSchema(type: FieldType): z.ZodType<CallValue> {
  switch (type.kind) {
    case "list":
      return z.array(scalarSchema(type.items));
    case "map":
      return z.record(z.string(), scalarSchema(type.values));
    default:
      return scalarSchema(type);
  }
}

export function callSchemaFor(capabilityInterface: CapabilityInterface): z.ZodType<CapabilityCall> {
  const shape: Record<string, z.ZodType<CallValue>> = {};
  for (const [name, field] of Object.entries(capabilityInterface)) shape[name] = fieldSchema(field.type);
  return z.strictObject(shape);
}
