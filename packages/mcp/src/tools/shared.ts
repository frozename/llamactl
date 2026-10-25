import { MACHINE_PROFILES } from "@llamactl/core";
import { z } from "zod";

export const SERVER_SLUG = "llamactl";

export const PROFILE_ENUM = z.enum(MACHINE_PROFILES);
export const PRESET_ENUM = z.enum(["best", "vision", "balanced", "fast"]);

export type WorkloadDeleteDryRunResult = {
  dryRun: true;
  found: boolean;
  kind: "ModelRun" | "ModelHost" | null;
  node: string | null;
  rel: string | null;
  message: string;
};
