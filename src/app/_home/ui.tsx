import Link from "next/link";
import type { ReactNode } from "react";

/** The translator shape every homepage section takes (resolved on the server). */
export type HomeT = (key: string, vars?: Record<string, string | number>) => string;

/** Small uppercase label above a heading, in the muted green. */
export function Eyebrow({
  children,
  tone = "green",
}: {
  children: ReactNode;
  tone?: "green" | "lime";
}) {
  return (
    <p
      className={`text-[0.65rem] font-semibold uppercase tracking-[0.15em] ${
        tone === "lime" ? "text-mk-lime" : "text-brand"
      }`}
    >
      {children}
    </p>
  );
}

/** A section opener: eyebrow, a large medium-weight heading, and an aside. */
export function SectionHead({
  eyebrow,
  title,
  body,
  id,
}: {
  eyebrow: string;
  title: ReactNode;
  body: string;
  id?: string;
}) {
  return (
    <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between md:gap-9">
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2
          id={id}
          className="mk-tight mt-3 text-balance text-[2rem] font-medium leading-[1.14] tracking-[-0.04em] text-ink sm:text-[2.4rem] lg:text-[2.7rem]"
        >
          {title}
        </h2>
      </div>
      <p className="max-w-xs text-pretty text-sm leading-[1.85] text-ink-secondary">{body}</p>
    </div>
  );
}

/** The page's buttons: dark (primary), lime (the highlighted trial action), outline. */
export function Btn({
  href,
  children,
  tone = "dark",
  size = "md",
  className = "",
}: {
  href: string;
  children: ReactNode;
  tone?: "dark" | "lime" | "outline";
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const tones = {
    dark: "bg-ink text-ink-inverse hover:bg-mk-forest-raised",
    lime: "bg-mk-lime text-mk-forest hover:bg-mk-lime-strong",
    outline: "border border-line-strong bg-transparent text-ink hover:bg-brand-soft",
  } as const;
  const sizes = {
    sm: "min-h-10 px-3.5 text-xs",
    md: "min-h-11 px-5 text-[0.8rem]",
    lg: "min-h-12 px-5 text-sm",
  } as const;
  const cls = `mk-lift inline-flex items-center justify-center gap-4 rounded-sm font-semibold ${tones[tone]} ${sizes[size]} ${className}`;
  return href.startsWith("#") ? (
    <a href={href} className={cls}>
      {children}
    </a>
  ) : (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}

/** A "↗" style glyph, hidden from assistive technology. */
export function Glyph({ children }: { children: ReactNode }) {
  return <span aria-hidden>{children}</span>;
}

/** Splits "Run the business.|Not after it." into a heading with a coloured second line. */
export function TwoLine({ text, emClass = "text-mk-green" }: { text: string; emClass?: string }) {
  const [a, b] = text.split("|");
  return (
    <>
      {a}
      {b ? (
        <>
          <br />
          <em className={`not-italic ${emClass}`}>{b}</em>
        </>
      ) : null}
    </>
  );
}
