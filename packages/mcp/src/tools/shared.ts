import { z } from "zod";

export const SERVER_SLUG = "llamactl";

export const PROFILE_ENUM = z.enum(["mac-mini-16g", "balanced", "macbook-pro-48g"]);
export const PRESET_ENUM = z.enum(["best", "vision", "balanced", "fast"]);

export type WorkloadDeleteDryRunResult = {
  dryRun: true;
  found: boolean;
  kind: "ModelRun" | "ModelHost" | null;
  node: string | null;
  rel: string | null;
  message: string;
};
