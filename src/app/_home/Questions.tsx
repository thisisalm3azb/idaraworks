import { Icon, type IconName } from "@/platform/ui";
import { Eyebrow, SectionHead, TwoLine, type HomeT } from "./ui";
import { ANCHORS } from "./nav";

/** The industries the sample journeys are written for, under the hero. */
export function IndustryStrip({ t }: { t: HomeT }) {
  const items: Array<{ k: string; icon: IconName }> = [
    { k: "construction", icon: "building" },
    { k: "trading", icon: "cart" },
    { k: "services", icon: "briefcase" },
    { k: "manufacturing", icon: "wrench" },
  ];
  return (
    <div className="border-y border-line bg-mk-strip">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col items-center gap-4 px-5 py-6 sm:flex-row sm:justify-between sm:gap-8 sm:px-8">
        <p className="max-w-[12rem] text-center text-xs leading-relaxed text-ink-secondary sm:text-start">
          {t("home.strip.lead")}
        </p>
        <ul className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs font-semibold text-brand-strong sm:gap-x-8">
          {items.map(({ k, icon }) => (
            <li key={k} className="flex items-center gap-2">
              <Icon name={icon} size={16} aria-hidden className="text-ink-muted" />
              {t(`home.strip.${k}`)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** The three owner questions, each tied to the workflow that answers it. */
export function OwnerQuestions({ t, job }: { t: HomeT; job: string }) {
  const cards = [
    { n: 1, icon: "clipboard" as IconName },
    { n: 2, icon: "receipt" as IconName },
    { n: 3, icon: "users" as IconName },
  ];
  return (
    <section className="mx-auto w-full max-w-[1200px] px-5 py-14 sm:px-6 lg:py-20">
      <SectionHead
        eyebrow={t("home.q.eyebrow")}
        title={<TwoLine text={t("home.q.title")} emClass="text-ink" />}
        body={t("home.q.body")}
      />
      <div className="mt-8 grid gap-6 md:grid-cols-3 md:gap-5">
        {cards.map(({ n, icon }) => (
          <article key={n} className="border-t border-line-strong pt-5">
            <Eyebrow>{t(`home.q.${n}_no`)}</Eyebrow>
            <h3 className="mk-tight mt-3 max-w-[18rem] text-[1.35rem] font-medium leading-tight tracking-[-0.03em] text-ink">
              {t(`home.q.${n}_title`, { job })}
            </h3>
            <p className="mt-3 max-w-[19rem] text-sm leading-[1.8] text-ink-secondary">
              {t(`home.q.${n}_text`, { job })}
            </p>
            <a
              href={ANCHORS.demo}
              className="mt-4 inline-flex min-h-9 items-center gap-2 text-xs font-medium text-brand-strong hover:underline"
            >
              <Icon name={icon} size={14} aria-hidden />
              {t(`home.q.${n}_link`)}
            </a>
          </article>
        ))}
      </div>
    </section>
  );
}
