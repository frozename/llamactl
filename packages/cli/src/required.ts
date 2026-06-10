export function required<T>(
  value: T | null | undefined,
  message = "missing required value",
): NonNullable<T> {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}
