import { cx } from "./classes";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "outline" | "destructive";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: ReadonlySet<ButtonVariant> = new Set([
  "primary",
  "secondary",
  "ghost",
  "outline",
  "destructive",
]);
const SIZES: ReadonlySet<ButtonSize> = new Set(["sm", "md", "lg"]);

export function buttonClasses(variant: ButtonVariant, size: ButtonSize): string {
  const v = VARIANTS.has(variant) ? variant : "primary";
  const s = SIZES.has(size) ? size : "md";
  return cx("bcn-btn", `bcn-btn--${v}`, `bcn-btn--${s}`);
}
