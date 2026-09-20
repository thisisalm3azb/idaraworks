"use client";

import { useId, useState } from "react";
import Link from "next/link";
import {
  INDUSTRIES,
  STEPS,
  SWATCHES,
  MAX_NAME_LENGTH,
  displayName,
  initialsFor,
  isLastStep,
  nextStep,
  stepView,
  type DemoCopy,
  type Industry,
  type SwatchKey,
} from "./demoRules";

/**
 * The interactive demonstration: a visitor names a company, picks a colour and
 * an industry, then follows one sample piece of work from quote to recorded
 * payment. Everything is React state in this component; nothing is sent
 * anywhere, and the typed name is rendered as text, never as markup.
 *
 * Keyboard: the industry and colour choices are toggle buttons in labelled
 * groups; the journey steps are buttons in an ordered list with the current
 * one marked; the sample document and phone announce changes politely.
 */

export type TryItLabels = {
  nameLabel: string;
  namePlaceholder: string;
  colourLabel: string;
  colours: Record<SwatchKey, string>;
  industryLabel: string;
  industries: Record<Industry, string>;
  status: string;
  workspace: string;
  steps: Record<(typeof STEPS)[number], string>;
  stepAria: string; // "View sample step {n}: {name}" with {n} and {name} literal tokens
  sideEyebrow: string;
  sideEvent: string;
  sideCaption: string;
  powered: string;
  footerNote: string;
  reset: string;
  cta: string;
  ctaNote: string;
  ctaLocal: string;
  ctaHref: string;
};

export function TryIt({ copy, labels }: { copy: DemoCopy; labels: TryItLabels }) {
  const [rawName, setRawName] = useState("");
  const [swatch, setSwatch] = useState<SwatchKey>("forest");
  const [industry, setIndustry] = useState<Industry>("trading");
  const [step, setStep] = useState(0);
  const nameId = useId();

  const name = displayName(rawName, labels.namePlaceholder);
  const initials = initialsFor(name);
  const colour = SWATCHES.find((s) => s.key === swatch)?.hex ?? SWATCHES[0].hex;
  const view = stepView(copy, industry, step);
  const scenario = copy.scenarios[industry];

  const tile = (size: string) => (
    <span
      aria-hidden
      data-initials
      className={`grid shrink-0 place-items-center rounded-[0.6em] font-semibold text-white ${size}`}
      style={{ background: colour }}
    >
      {initials}
    </span>
  );

  return (
    <div className="mt-8 flex flex-col gap-5" data-try-it>
      {/* Controls */}
      <div className="grid gap-4 md:grid-cols-[1fr_1.1fr] md:items-center">
        <div className="flex flex-wrap items-center gap-5 rounded-md border border-line bg-card px-4 py-3">
          <div className="min-w-0 flex-1 basis-40">
            <label
              htmlFor={nameId}
              className="mb-1 block text-[0.65rem] font-semibold uppercase tracking-[0.1em] text-brand"
            >
              {labels.nameLabel}
            </label>
            <input
              id={nameId}
              type="text"
              value={rawName}
              maxLength={MAX_NAME_LENGTH}
              autoComplete="off"
              spellCheck={false}
              placeholder={labels.namePlaceholder}
              onChange={(e) => setRawName(e.target.value)}
              className="w-full min-w-0 border-0 border-b border-line-strong bg-transparent pb-1.5 pt-1 text-lg text-ink outline-offset-4 placeholder:text-ink-muted focus:border-brand"
            />
          </div>
          <div>
            <p
              id={`${nameId}-colour`}
              className="mb-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.1em] text-brand"
            >
              {labels.colourLabel}
            </p>
            <div
              role="group"
              aria-labelledby={`${nameId}-colour`}
              className="flex items-center gap-2"
            >
              {SWATCHES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  aria-label={labels.colours[s.key]}
                  aria-pressed={swatch === s.key}
                  onClick={() => setSwatch(s.key)}
                  className="grid size-11 place-items-center rounded-full"
                >
                  <span
                    aria-hidden
                    className={`block size-6 rounded-full border-[3px] border-card ${
                      swatch === s.key ? "ring-1 ring-ink-muted" : ""
                    }`}
                    style={{ background: s.hex }}
                  />
                </button>
              ))}
            </div>
          </div>
        </div>

        <div
          role="group"
          aria-label={labels.industryLabel}
          className="flex flex-wrap items-center gap-2 md:justify-end"
        >
          <span className="w-full text-xs text-ink-muted md:w-auto md:text-end">
            {labels.industryLabel}
          </span>
          {INDUSTRIES.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={industry === key}
              onClick={() => {
                setIndustry(key);
                setStep(0);
              }}
              className={`min-h-10 rounded-full border px-3.5 text-xs font-medium transition-colors ${
                industry === key
                  ? "border-mk-forest bg-mk-forest text-mk-forest-ink"
                  : "border-line text-ink-secondary hover:border-line-strong hover:text-ink"
              }`}
            >
              {labels.industries[key]}
            </button>
          ))}
        </div>
      </div>

      {/* The experience */}
      <section
        aria-label={labels.status}
        className="overflow-hidden rounded-lg bg-mk-forest text-mk-forest-ink shadow-pop"
      >
        <div className="flex items-center justify-between gap-4 border-b border-mk-forest-line bg-mk-forest-raised px-4 py-3 text-xs text-mk-forest-dim sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5 font-semibold text-white">
            {tile("size-7 text-[0.7rem]")}
            <span className="truncate" data-company>
              {name}
            </span>
            <span className="hidden font-normal text-mk-forest-dim sm:inline">
              {labels.workspace}
            </span>
          </div>
          <span className="flex shrink-0 items-center gap-2 text-[0.65rem] font-semibold uppercase tracking-[0.12em]">
            <span aria-hidden className="size-1.5 rounded-full bg-mk-lime" />
            {labels.status}
          </span>
        </div>

        <div className="grid md:grid-cols-[1fr_15rem]">
          <div className="min-w-0 p-5 sm:p-7">
            <ol className="mb-6 flex list-none gap-0 p-0" aria-label={labels.status}>
              {STEPS.map((key, i) => {
                const done = i < step;
                const current = i === step;
                return (
                  <li key={key} className="relative flex-1">
                    {i < STEPS.length - 1 ? (
                      <span
                        aria-hidden
                        className="absolute top-3.5 h-px bg-mk-forest-line"
                        style={{ insetInlineStart: "2rem", insetInlineEnd: "0.6rem" }}
                      />
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setStep(i)}
                      aria-current={current ? "step" : undefined}
                      className={`relative z-10 flex min-h-11 min-w-11 flex-col items-start gap-1.5 bg-transparent p-0 text-start text-[0.7rem] ${
                        current ? "text-mk-lime" : "text-mk-forest-dim"
                      }`}
                    >
                      {/* Accessible name: "View sample step 2 Work"; the circle itself is decorative. */}
                      <span className="sr-only">
                        {labels.stepAria.split("{n}")[0]}
                        {i + 1}{" "}
                      </span>
                      <span
                        aria-hidden
                        className={`grid size-7 place-items-center rounded-full border text-[0.65rem] ${
                          current || done
                            ? "border-mk-lime bg-mk-lime text-mk-forest"
                            : "border-mk-forest-line bg-mk-forest"
                        }`}
                      >
                        {done ? "✓" : i + 1}
                      </span>
                      <span className="sr-only sm:not-sr-only">{labels.steps[key]}</span>
                    </button>
                  </li>
                );
              })}
            </ol>

            <div className="grid items-center gap-6 sm:grid-cols-2">
              <div aria-live="polite">
                <p className="text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-mk-lime">
                  {view.label}
                </p>
                <h3 className="mk-tight mt-3 text-2xl font-medium leading-tight tracking-[-0.02em] text-white sm:text-[1.9rem]">
                  {view.heading}
                </h3>
                <p className="mt-3 max-w-xs text-sm leading-relaxed text-mk-forest-dim">
                  {view.text}
                </p>
                <button
                  type="button"
                  onClick={() => setStep(isLastStep(step) ? 0 : nextStep(step))}
                  className="mk-lift mt-4 inline-flex min-h-11 items-center gap-3 rounded-sm bg-mk-lime px-4 text-xs font-semibold text-mk-forest hover:bg-mk-lime-strong"
                >
                  {view.button}
                  <span aria-hidden>{isLastStep(step) ? "↺" : "→"}</span>
                </button>
              </div>

              <div
                key={`${industry}-${step}`}
                className="mk-pop mk-doc-tilt min-h-48 rounded-md bg-[#fafbf7] p-4 text-ink shadow-pop sm:p-5"
                aria-live="polite"
              >
                <div className="flex items-start justify-between gap-3 border-b border-line pb-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    {tile("size-6 text-[0.6rem]")}
                    <div className="min-w-0">
                      <b className="block truncate text-xs font-semibold" data-company>
                        {name}
                      </b>
                      <small className="mt-0.5 block text-[0.65rem] text-ink-muted">
                        {view.reference}
                      </small>
                    </div>
                  </div>
                  <span className="shrink-0 whitespace-nowrap rounded-sm bg-brand-soft px-2 py-1 text-[0.6rem] font-medium text-brand-strong">
                    {view.state}
                  </span>
                </div>
                <div className="my-3.5 flex justify-between gap-3 text-xs text-ink-secondary">
                  <span className="min-w-0 truncate">{scenario.item}</span>
                  <strong className="shrink-0 font-medium text-ink">{scenario.qty}</strong>
                </div>
                <div className="my-3.5 flex justify-between gap-3 text-xs text-ink-secondary">
                  <span>{view.detailLabel}</span>
                  <strong className="text-end font-medium text-ink">{view.detailValue}</strong>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-line pt-3 text-[0.7rem] text-ink-secondary">
                  <span>{view.totalLabel}</span>
                  <strong className="text-2xl font-medium tabular-nums text-ink">
                    {view.totalValue}
                  </strong>
                </div>
                <p className="mt-2.5 text-[0.65rem] text-ink-muted">{view.trace}</p>
              </div>
            </div>
          </div>

          <aside className="hidden flex-col items-center justify-center border-s border-mk-forest-line bg-white/[0.02] px-5 py-6 md:flex">
            <p className="mb-4 text-[0.6rem] font-semibold uppercase tracking-[0.16em] text-mk-forest-dim">
              {labels.sideEyebrow}
            </p>
            <div className="relative w-[9rem] min-w-0 rounded-[1.4rem] border-4 border-[#526573] bg-[#f3f6ee] px-3 pb-3 pt-6 text-ink shadow-pop">
              <span
                aria-hidden
                className="absolute start-1/2 top-1.5 h-1.5 w-9 -translate-x-1/2 rounded-full bg-[#1f303b] rtl:translate-x-1/2"
              />
              {tile("size-9 text-[0.8rem]")}
              <b className="mt-2 block truncate text-[0.7rem] font-semibold" data-company>
                {name}
              </b>
              <small className="block text-[0.55rem] text-ink-muted">{labels.powered}</small>
              <div className="mt-3 rounded-sm border border-line bg-white p-2" aria-live="polite">
                <span className="text-[0.55rem] font-semibold uppercase tracking-wider text-brand">
                  {labels.sideEvent}
                </span>
                <b className="mt-1 block text-[0.65rem] font-semibold">{view.phoneTitle}</b>
                <span className="mt-1 block text-[0.6rem] leading-snug text-ink-secondary">
                  {view.phoneCopy}
                </span>
              </div>
            </div>
            <p className="mt-4 text-center text-[0.65rem] leading-relaxed text-mk-forest-dim">
              {labels.sideCaption}
            </p>
          </aside>
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-mk-forest-line px-4 py-3 text-[0.65rem] text-mk-forest-dim sm:px-6">
          <span>{labels.footerNote}</span>
          <button
            type="button"
            onClick={() => setStep(0)}
            className="min-h-11 shrink-0 bg-transparent px-2 text-xs text-mk-lime hover:underline"
          >
            <span aria-hidden>↺ </span>
            {labels.reset}
          </button>
        </div>
      </section>

      <div className="flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-5">
        <Link
          href={labels.ctaHref}
          className="mk-lift inline-flex min-h-12 items-center gap-4 rounded-sm bg-ink px-5 text-sm font-semibold text-ink-inverse hover:bg-mk-forest-raised"
        >
          {labels.cta}
          <span aria-hidden>↗</span>
        </Link>
        <p className="text-center text-xs text-ink-secondary sm:text-start">
          {labels.ctaNote}
          <span className="block text-[0.65rem] text-ink-muted">{labels.ctaLocal}</span>
        </p>
      </div>
    </div>
  );
}
