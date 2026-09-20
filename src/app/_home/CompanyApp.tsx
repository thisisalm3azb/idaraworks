import { Btn, Eyebrow, Glyph, TwoLine, type HomeT } from "./ui";
import { ANCHORS } from "./nav";

/**
 * Your company app: the branded, installable workspace. The copy says exactly
 * what it is (a web app powered by IdaraWorks), that installation depends on
 * the browser and device, that two companies are two installations sharing
 * the browser's sign-in, and that access follows membership and permissions.
 */
export function CompanyApp({ t }: { t: HomeT }) {
  return (
    <section
      id="company-app"
      className="scroll-mt-20 border-y border-[#dae2d0] bg-mk-tint"
      aria-labelledby="company-app-title"
    >
      <div className="mx-auto grid w-full max-w-[1150px] items-center gap-8 px-5 py-14 sm:px-6 lg:grid-cols-2 lg:gap-14 lg:py-[4.5rem]">
        <div>
          <Eyebrow>{t("home.app.eyebrow")}</Eyebrow>
          <h2
            id="company-app-title"
            className="mk-tight mt-4 text-balance text-[2.1rem] font-medium leading-[1.13] tracking-[-0.04em] text-ink sm:text-[2.6rem]"
          >
            <TwoLine text={t("home.app.title")} />
          </h2>
          <p className="mt-4 max-w-[23rem] text-sm leading-[1.85] text-ink-secondary">
            {t("home.app.body")}
          </p>
          <ul className="mt-5 grid max-w-[24rem] gap-3 text-xs text-brand-strong">
            {(["l1", "l2", "l3"] as const).map((k) => (
              <li key={k} className="flex items-start gap-2.5">
                <span aria-hidden>✓</span>
                {t(`home.app.${k}`)}
              </li>
            ))}
          </ul>
          <Btn href={ANCHORS.demo} tone="outline" className="mt-5">
            {t("home.app.cta")}
            <Glyph>↗</Glyph>
          </Btn>
          <p className="mt-5 max-w-[26rem] text-[0.7rem] leading-[1.7] text-ink-muted">
            {t("home.app.note")}
            <br />
            {t("home.app.note2")}
          </p>
        </div>

        <div
          className="relative mx-auto grid h-[19rem] w-full max-w-[22rem] place-items-center bg-[radial-gradient(ellipse_at_center,#cfddbd,transparent_65%)] lg:max-w-none"
          role="img"
          aria-label={t("home.app.scene_aria")}
        >
          <span className="absolute start-2 top-1 text-[0.55rem] font-medium uppercase tracking-[0.1em] text-brand">
            {t("home.app.scene_label")}
          </span>
          <span
            aria-hidden
            className="absolute start-4 top-12 grid size-[4.2rem] -rotate-12 place-items-center rounded-[18px] bg-[#254c41] text-[1.6rem] font-semibold text-[#e2e9b8] shadow-pop sm:start-6"
          >
            SF
          </span>
          <div className="relative h-[17rem] w-[10rem] rotate-[7deg] rounded-[1.7rem] border-[6px] border-[#243d31] bg-card px-3 pb-3 pt-8 shadow-pop">
            <span
              aria-hidden
              className="absolute start-1/2 top-2 h-2.5 w-11 -translate-x-1/2 rounded-full bg-[#243d31] rtl:translate-x-1/2"
            />
            <small className="text-[0.55rem] uppercase tracking-wider text-ink-muted">
              {t("home.app.workspace")}
            </small>
            <b className="mb-3 mt-1 block text-[0.9rem] font-semibold text-ink">
              {t("home.hero.company")}
            </b>
            <div className="mb-2 rounded-[8px] bg-[#eef3e8] px-2 py-2.5 text-[0.55rem] text-ink">
              {t("home.app.greeting")}
              <strong className="mt-1 block text-base font-medium text-[#537047]">
                {t("home.app.greeting_sub")}
              </strong>
            </div>
            <div className="mb-2 rounded-[8px] bg-[#eef3e8] px-2 py-2.5 text-[0.55rem] text-ink">
              {t("home.app.tasks")}
              <strong className="mt-1 block text-base font-medium text-[#537047]">
                12{" "}
                <span className="text-[0.5rem] font-normal text-ink-secondary">
                  {t("home.app.tasks_note")}
                </span>
              </strong>
            </div>
            <div className="flex justify-between rounded-[8px] bg-[#eef3e8] px-2 py-2.5 text-[0.55rem] text-ink">
              {t("home.app.approvals")}
              <span>3 →</span>
            </div>
          </div>
          <span
            aria-hidden
            className="absolute bottom-12 end-4 grid size-[4.2rem] rotate-12 place-items-center rounded-[18px] bg-[#dcad63] text-[1.6rem] font-semibold text-[#422e23] shadow-pop sm:end-6"
          >
            DR
          </span>
          <span className="absolute bottom-3 start-8 rounded-full bg-card px-3.5 py-2.5 text-[0.65rem] text-ink shadow-pop">
            ✓ {t("home.app.tag")}
          </span>
        </div>
      </div>
    </section>
  );
}
