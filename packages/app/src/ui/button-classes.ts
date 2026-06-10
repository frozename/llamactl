import { cx } from "./classes";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "outline" | "destructive";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: readonly ButtonVariant[] = [
  "primary",
  "secondary",
  "ghost",
  "outline",
  "destructive",
];
const SIZES: readonly ButtonSize[] = ["sm", "md", "lg"];

export function buttonClasses(variant: ButtonVariant, size: ButtonSize): string {
  const v = VARIANTS.includes(variant) ? variant : "primary";
  const s = SIZES.includes(size) ? size : "md";
  return cx("bcn-btn", `bcn-btn--${v}`, `bcn-btn--${s}`);
}
