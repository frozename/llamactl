export type ServerStartOutcome = "started" | "failed" | "pending";

/**
 * Classify one serverStart subscription event. A start the node refuses
 * (e.g. a non-loopback --host without allowExternalBind) arrives as a
 * `done` event with `ok: false` rather than as a subscription error, so it
 * must release the picker the same way an error does.
 */
export function serverStartOutcome(evt: unknown): ServerStartOutcome {
  const e = evt as { type?: string; result?: { ok?: boolean } } | null;
  if (e?.type !== "done") return "pending";
  return e.result?.ok === true ? "started" : "failed";
}
