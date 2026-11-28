import { z } from "zod";

export const RESIDENCY_APPLY_PROFILE_TOOL = "llamactl.residency.applyProfile";
export const MANAGED_PROFILE_PROTOCOL_VERSION = 1;

export const profileMutationSchema = z.object({
  node: z.string().min(1),
  to: z.string().min(1),
  from: z.string().min(1).optional(),
  dryRun: z.boolean().default(true),
  confirm: z.boolean().default(false),
});

export const managedProfileMutationSchema = z.strictObject({
  ...profileMutationSchema.shape,
  version: z.literal(MANAGED_PROFILE_PROTOCOL_VERSION),
});

export const residencyApplyProfileToolInput = z.strictObject({
  ...profileMutationSchema.shape,
  managed: z
    .boolean()
    .default(false)
    .describe("Require the named owner's managed profile protocol."),
});
