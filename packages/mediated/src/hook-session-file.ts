import { z } from "zod";
import { SessionRequest } from "./session.js";

/** The session file the operator writes (plan Increment 6): the session request and the signed grant files it uses. */
export { HookAdmissionService } from "./hook-admission.js";

export const HookSessionFile = z.strictObject({
  /** Plain-language notes for the operator; ignored. */
  comments: z.array(z.string()).optional(),
  session: SessionRequest,
  grants: z.array(z.string().regex(/^\//)).max(64).default([]),
});
