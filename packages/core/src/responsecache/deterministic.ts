export function isDeterministic(parsedBody: unknown): boolean {
  if (!parsedBody || typeof parsedBody !== "object") return false;
  const body = parsedBody as { temperature?: unknown; seed?: unknown };
  if (
    typeof body.temperature === "number" &&
    Number.isFinite(body.temperature) &&
    body.temperature === 0
  )
    return true;
  return body.seed !== null && body.seed !== undefined;
}
