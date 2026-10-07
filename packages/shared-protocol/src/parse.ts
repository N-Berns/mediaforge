import type { z } from "zod";
import {
  type ExtensionToHostMessage,
  ExtensionToHostMessage as ExtensionToHostSchema,
  type HostToExtensionMessage,
  HostToExtensionMessage as HostToExtensionSchema,
} from "./messages.ts";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const parseWith = <T>(schema: z.ZodType<T>, input: unknown): ParseResult<T> => {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  const error = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return { ok: false, error };
};

/** Validate a message received by the desktop host. */
export const parseExtensionMessage = (input: unknown): ParseResult<ExtensionToHostMessage> =>
  parseWith(ExtensionToHostSchema, input);

/** Validate a message received by the extension. */
export const parseHostMessage = (input: unknown): ParseResult<HostToExtensionMessage> =>
  parseWith(HostToExtensionSchema, input);
