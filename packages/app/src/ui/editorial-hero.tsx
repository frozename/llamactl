import * as React from "react";

import { AtmosphericPanel } from "./atmospheric-panel";
import { cx } from "./classes";

export interface EditorialHeroProps {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  /** Secondary emphasis span inside the title (renders in brand). Pass
   *  plain text or a <em> — this component wraps it. */
  titleAccent?: React.ReactNode;
  lede?: React.ReactNode;
  pills?: readonly { label: React.ReactNode; tone?: "default" | "ok" | "info" }[];
  actions?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Hero block with serif display title, atmospheric backdrop, and an
 * optional pill row.
 */
export function EditorialHero({
  eyebrow,
  title,
  titleAccent,
  lede,
  pills,
  actions,
  className,
  style,
}: EditorialHeroProps): React.JSX.Element {
  return (
    <AtmosphericPanel className={cx("bcn-editorial-hero", className)} style={style}>
      {eyebrow && <HeroEyebrow>{eyebrow}</HeroEyebrow>}
      <HeroTitle title={title} accent={titleAccent} />
      {lede && (
        <p
          style={{
            fontSize: 15,
            lineHeight: 1.55,
            color: "var(--color-text-secondary)",
            maxWidth: "62ch",
            margin: "0 0 20px",
            fontWeight: 300,
          }}
        >
          {lede}
        </p>
      )}
      {pills && pills.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: actions ? 24 : 0 }}>
          {pills.map((p, i) => (
            <HeroPill key={i} label={p.label} tone={p.tone} />
          ))}
        </div>
      )}
      {actions && <div>{actions}</div>}
    </AtmosphericPanel>
  );
}

function HeroEyebrow({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        color: "var(--color-text-tertiary)",
        marginBottom: 20,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: "var(--color-brand)",
          boxShadow: "0 0 8px var(--color-brand)",
        }}
      />
      {children}
    </div>
  );
}

function HeroTitle({
  title,
  accent,
}: {
  title: React.ReactNode;
  accent?: React.ReactNode;
}): React.JSX.Element {
  return (
    <h1
      style={{
        fontFamily: "var(--font-display)",
        fontWeight: 300,
        fontSize: "clamp(28px, 3.4vw, 48px)",
        letterSpacing: "-0.025em",
        lineHeight: 1.05,
        margin: "0 0 16px",
        color: "var(--color-text)",
      }}
    >
      {title}
      {accent && (
        <>
          {" "}
          <em
            className="t-brand"
            style={{ color: "var(--color-brand)", fontWeight: 400, fontStyle: "normal" }}
          >
            {accent}
          </em>
        </>
      )}
    </h1>
  );
}

function HeroPill({
  label,
  tone,
}: {
  label: React.ReactNode;
  tone?: "default" | "ok" | "info";
}): React.JSX.Element {
  const dotColor =
    tone === "ok"
      ? "var(--color-ok)"
      : tone === "info"
        ? "var(--color-info)"
        : "var(--color-text-tertiary)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderRadius: "var(--r-pill)",
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border-subtle)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--color-text-secondary)",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: dotColor,
          boxShadow: tone === "default" ? "none" : `0 0 6px ${dotColor}`,
        }}
      />
      {label}
    </span>
  );
}
