import {
  measuredCalibrationStorePath,
  recordMeasuredMemoryCalibration,
} from "@llamactl/fleet-supervisor/measured-memory";
import { z } from "zod";

import { readFileSync } from "../safe-fs.js";

const USAGE = `Usage: llamactl admit calibrate <local-evidence.json>

Record already collected calibration evidence in this node's local store.
Use evidence from this host with an exact artifact, engine build and runtime key.
The report must contain key, samples and options. RSS-only or shared-device-only reports cannot qualify.`;

const ReportSchema = z.strictObject({
  key: z.union([
    z.strictObject({
      artifactRevision: z.string(),
      engine: z.string(),
      engineBuild: z.string(),
      ctx: z.number(),
      kvType: z.string(),
      speculative: z.discriminatedUnion("mode", [
        z.strictObject({ mode: z.literal("none") }),
        z.strictObject({ mode: z.literal("mtp") }),
        z.strictObject({ mode: z.literal("draft"), artifactRevision: z.string() }),
      ]),
      prefillBatch: z.number(),
      concurrency: z.number(),
    }),
    z.strictObject({ managedLaunchDigest: z.string().regex(/^[0-9a-f]{64}$/) }),
  ]),
  samples: z.array(
    z.strictObject({
      status: z.enum(["ok", "unavailable", "denied", "unsupported"]),
      source: z.string(),
      observedAtMs: z.number().nullable(),
      processBytes: z.number().nullable(),
      processDeviceBytes: z.number().nullable(),
      sharedDeviceBytes: z.number().nullable(),
      deviceAccounting: z.enum(["disjoint", "included", "unknown"]).optional(),
    }),
  ),
  options: z.strictObject({ minSamples: z.number(), overheadFraction: z.number() }),
});

export function runAdmitCalibrate(args: string[]): number {
  const [input] = args;
  if (args.length === 1 && (input === "--help" || input === "-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args.length !== 1 || input === undefined) {
    console.error(USAGE);
    return 2;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(input, "utf8")) as unknown;
  } catch (error) {
    console.error(`admit calibrate: unable to read evidence (${String(error)})`);
    return 2;
  }
  const report = ReportSchema.safeParse(raw);
  if (!report.success) {
    console.error(`admit calibrate: invalid evidence (${z.prettifyError(report.error)})`);
    return 2;
  }

  const path = measuredCalibrationStorePath();
  try {
    const result = recordMeasuredMemoryCalibration(report.data, path);
    if (!result.ok) {
      console.error(`admit calibrate: ${result.reason}`);
      return 1;
    }
    if (result.recorded) {
      process.stdout.write(`Recorded ${String(result.envelope.envelopeBytes)} bytes in ${path}\n`);
    } else {
      process.stdout.write(`Kept existing calibration in ${path}\n`);
    }
    return 0;
  } catch (error) {
    console.error(`admit calibrate: unable to record evidence (${String(error)})`);
    return 1;
  }
}
