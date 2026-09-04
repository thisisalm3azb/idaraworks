/**
 * H29 — readiness, stated as six independent facts rather than one number
 * (ADR-74).
 *
 * "Technically configured" is something this code can decide. "Legally
 * reviewed" is not: it is true only when a person has recorded a review, and no
 * amount of filled-in configuration can imply it. The distinction is the whole
 * point of the centre, so it is enforced here rather than left to the wording
 * on a screen.
 */
import { sql, withCtx, type Ctx, type TenantTx } from "@/platform/tenancy";
import {
  addressProblems,
  ibanProblems,
  identifierProblems,
  resolvePack,
  type CountryPack,
  type ReadinessState,
} from "@/platform/country";
import { LOCALE_NATIVE_NAME } from "@/platform/i18n/locale";
import type { Locale } from "@/platform/registries";
import { listEstablishmentsIn } from "./establishments";
import type {
  AreaReadiness,
  EstablishmentReadiness,
  EstablishmentRow,
  ReadinessCheck,
} from "./types";

type Facts = {
  establishment: EstablishmentRow;
  pack: CountryPack | null;
  adoptedPackKey: string | null;
  registrations: Map<string, string>;
  privacyCategories: number;
  privacyReviewed: number;
  channels: Array<{ adapterKey: string; environment: string; status: string; stopped: boolean }>;
  reviews: Map<string, string>;
};

const ok = (key: string, labelKey: string): ReadinessCheck => ({ key, labelKey, state: "ok" });
const missing = (key: string, labelKey: string, detailKey?: string): ReadinessCheck => ({
  key,
  labelKey,
  state: "missing",
  ...(detailKey ? { detailKey } : {}),
});

function configurationArea(f: Facts): AreaReadiness {
  const checks: ReadinessCheck[] = [];
  checks.push(
    f.adoptedPackKey
      ? ok("pack", "country.readiness.pack_adopted")
      : missing("pack", "country.readiness.pack_adopted", "country.readiness.pack_missing"),
  );
  checks.push(
    f.establishment.timezone
      ? ok("timezone", "country.readiness.timezone")
      : missing("timezone", "country.readiness.timezone"),
  );
  checks.push(
    f.establishment.workingDays.length > 0
      ? ok("working_days", "country.readiness.working_days")
      : missing("working_days", "country.readiness.working_days"),
  );

  if (f.pack) {
    const addressFilled = Object.values(f.establishment.address).some(
      (v) => (v ?? "").toString().trim().length > 0,
    );
    const problems = addressProblems(f.pack.address, f.establishment.address);
    checks.push(
      !addressFilled
        ? missing("address", "country.readiness.address", "country.readiness.address_missing")
        : problems.length
          ? {
              key: "address",
              labelKey: "country.readiness.address",
              state: "blocked",
              detailKey: "country.readiness.address_invalid",
            }
          : ok("address", "country.readiness.address"),
    );

    for (const required of f.pack.requiredConfiguration) {
      // A required identifier is satisfied by a recorded registration.
      const spec = f.pack.identifiers.find((i) => i.key === required.key);
      if (spec) {
        const value = f.registrations.get(required.key);
        checks.push(
          value && identifierProblems(spec, value).length === 0
            ? ok(`config.${required.key}`, required.labelKey)
            : missing(
                `config.${required.key}`,
                required.labelKey,
                "country.readiness.registration_missing",
              ),
        );
      }
    }
  }
  return { area: "configuration", checks, complete: checks.every((c) => c.state === "ok") };
}

function taxArea(f: Facts): AreaReadiness {
  const checks: ReadinessCheck[] = [];
  if (!f.pack) return { area: "tax", checks, complete: false };
  for (const taxModule of f.pack.tax) {
    checks.push(
      taxModule.engineVersion
        ? ok(`tax.${taxModule.key}.engine`, taxModule.labelKey)
        : {
            key: `tax.${taxModule.key}.engine`,
            labelKey: taxModule.labelKey,
            state: "missing",
            detailKey: "country.readiness.tax_engine_missing",
          },
    );
    for (const item of taxModule.requiresConfiguration)
      checks.push({
        key: `tax.${taxModule.key}.config.${item}`,
        labelKey: "country.readiness.tax_configuration",
        state: "missing",
        // The pack states each item as a MESSAGE KEY, so the line reads in the
        // reader's own language instead of dropping an English rule into a
        // translated sentence.
        detailKey: item,
      });
  }
  return { area: "tax", checks, complete: checks.every((c) => c.state === "ok") };
}

function payrollArea(f: Facts): AreaReadiness {
  const checks: ReadinessCheck[] = [];
  if (!f.pack?.payroll) return { area: "payroll", checks, complete: false };
  checks.push(
    f.pack.payroll.engineVersion
      ? ok("payroll.engine", "country.readiness.payroll_engine")
      : {
          key: "payroll.engine",
          labelKey: "country.readiness.payroll_engine",
          state: "missing",
          detailKey: "country.readiness.payroll_engine_missing",
        },
  );
  for (const item of f.pack.payroll.requiresConfiguration)
    checks.push({
      key: `payroll.config.${item}`,
      labelKey: "country.readiness.payroll_configuration",
      state: "missing",
      detailKey: item,
    });
  return { area: "payroll", checks, complete: checks.every((c) => c.state === "ok") };
}

function documentsArea(f: Facts): AreaReadiness {
  const checks: ReadinessCheck[] = [];
  if (!f.pack) return { area: "documents", checks, complete: false };
  const required = f.pack.format.requiredDocumentLanguages.value;
  checks.push(
    required.length === 0
      ? {
          key: "documents.language",
          labelKey: "country.readiness.document_language",
          state: "not_applicable",
        }
      : {
          key: "documents.language",
          labelKey: "country.readiness.document_language",
          state: "missing",
          detailKey: "country.readiness.document_language_required",
          // Named, not coded: "ar" on a screen means nothing to the person
          // reading it, and the name is the same in every interface language.
          detail: {
            languages: required
              .map((code) => LOCALE_NATIVE_NAME[code as Locale] ?? code)
              .join(", "),
          },
        },
  );
  const identity = f.establishment.invoiceIdentity;
  checks.push(
    Object.keys(identity).length > 0
      ? ok("documents.identity", "country.readiness.invoice_identity")
      : missing("documents.identity", "country.readiness.invoice_identity"),
  );
  return {
    area: "documents",
    checks,
    complete: checks.every((c) => c.state !== "missing" && c.state !== "blocked"),
  };
}

function bankingArea(f: Facts): AreaReadiness {
  const checks: ReadinessCheck[] = [];
  const iban = (f.establishment.banking as { iban?: string }).iban ?? "";
  if (!f.pack || iban.length === 0) {
    checks.push(missing("banking.iban", "country.readiness.iban"));
  } else {
    const problems = ibanProblems(iban, f.pack);
    checks.push(
      problems.length === 0
        ? ok("banking.iban", "country.readiness.iban")
        : {
            key: "banking.iban",
            labelKey: "country.readiness.iban",
            state: "blocked",
            detailKey: problems[0]!.messageKey,
          },
    );
  }
  return { area: "banking", checks, complete: checks.every((c) => c.state === "ok") };
}

function privacyArea(f: Facts): AreaReadiness {
  const checks: ReadinessCheck[] = [];
  checks.push(
    f.privacyCategories > 0
      ? ok("privacy.register", "country.readiness.privacy_register")
      : missing(
          "privacy.register",
          "country.readiness.privacy_register",
          "country.readiness.privacy_missing",
        ),
  );
  checks.push(
    f.privacyCategories > 0 && f.privacyReviewed === f.privacyCategories
      ? ok("privacy.reviewed", "country.readiness.privacy_reviewed")
      : missing(
          "privacy.reviewed",
          "country.readiness.privacy_reviewed",
          "country.readiness.privacy_unreviewed",
        ),
  );
  return { area: "privacy", checks, complete: checks.every((c) => c.state === "ok") };
}

function einvoicingArea(f: Facts): AreaReadiness {
  const checks: ReadinessCheck[] = [];
  const spec = f.pack?.einvoicing;
  if (!spec || spec.model === "none" || !spec.adapterKey)
    return {
      area: "einvoicing",
      checks: [
        { key: "einvoice.none", labelKey: "country.readiness.einvoice", state: "not_applicable" },
      ],
      complete: true,
    };

  const production = f.channels.find(
    (c) => c.adapterKey === spec.adapterKey && c.environment === "production",
  );
  checks.push(
    production && production.status === "ready" && !production.stopped
      ? ok("einvoice.channel", "country.readiness.einvoice_channel")
      : {
          key: "einvoice.channel",
          labelKey: "country.readiness.einvoice_channel",
          state: "missing",
          detailKey: "country.readiness.einvoice_not_configured",
        },
  );
  for (const credential of spec.requiredCredentials)
    checks.push({
      key: `einvoice.credential.${credential.slice(0, 32)}`,
      labelKey: "country.readiness.einvoice_credential",
      state: "missing",
      detailKey: credential,
    });
  for (const provider of spec.requiredProviders)
    checks.push({
      key: `einvoice.provider.${provider.slice(0, 32)}`,
      labelKey: "country.readiness.einvoice_provider",
      state: "missing",
      detailKey: provider,
    });
  return { area: "einvoicing", checks, complete: checks.every((c) => c.state === "ok") };
}

async function factsFor(
  tx: TenantTx,
  ctx: Ctx,
  establishment: EstablishmentRow,
  on: string,
): Promise<Facts> {
  const adopted = (await tx.execute(sql`
    select app.establishment_pack_on(${establishment.id}::uuid, ${on}::date) as pack_key`)) as unknown as Array<{
    pack_key: string | null;
  }>;
  const adoptedPackKey = adopted[0]?.pack_key ?? null;
  const pack = adoptedPackKey ? resolvePack(establishment.country, on) : null;

  const registrations = (await tx.execute(sql`
    select identifier_key, value from public.establishment_registration
    where org_id = ${ctx.orgId} and establishment_id = ${establishment.id}`)) as unknown as Array<{
    identifier_key: string;
    value: string;
  }>;

  const privacy = (await tx.execute(sql`
    select count(*)::int as n, count(reviewed_at)::int as reviewed
    from public.establishment_privacy
    where org_id = ${ctx.orgId} and establishment_id = ${establishment.id}`)) as unknown as Array<{
    n: number;
    reviewed: number;
  }>;

  const channels = (await tx.execute(sql`
    select adapter_key, environment, status, stopped from public.einvoice_channel
    where org_id = ${ctx.orgId} and establishment_id = ${establishment.id}`)) as unknown as Array<{
    adapter_key: string;
    environment: string;
    status: string;
    stopped: boolean;
  }>;

  const reviews = adoptedPackKey
    ? ((await tx.execute(sql`
        select kind, state from public.country_pack_review
        where pack_key = ${adoptedPackKey}`)) as unknown as Array<{ kind: string; state: string }>)
    : [];

  return {
    establishment,
    pack: pack && pack.packKey === adoptedPackKey ? pack : null,
    adoptedPackKey,
    registrations: new Map(registrations.map((r) => [r.identifier_key, r.value])),
    privacyCategories: Number(privacy[0]?.n ?? 0),
    privacyReviewed: Number(privacy[0]?.reviewed ?? 0),
    channels: channels.map((c) => ({
      adapterKey: c.adapter_key,
      environment: c.environment,
      status: c.status,
      stopped: Boolean(c.stopped),
    })),
    reviews: new Map(reviews.map((r) => [r.kind, r.state])),
  };
}

function statesFrom(f: Facts, areas: AreaReadiness[]): Record<ReadinessState, boolean> {
  const configuration = areas.find((a) => a.area === "configuration")!;
  const banking = areas.find((a) => a.area === "banking")!;
  const einvoicing = areas.find((a) => a.area === "einvoicing")!;

  // Technically configured: everything this code can decide is decided.
  const technically =
    configuration.complete && banking.complete && f.establishment.status === "active";
  // Reviewed internally, legally reviewed and provider connected are FACTS
  // recorded by people and providers. No amount of configuration implies them.
  const internal = f.reviews.get("internal") === "passed";
  const legal = f.reviews.get("professional") === "passed";
  const provider = einvoicing.complete;

  return {
    technically_configured: technically,
    reviewed_internally: technically && internal,
    provider_connected: provider,
    legally_reviewed: legal,
    // A controlled pilot needs the configuration and an internal review, and is
    // honest about the provider still being absent.
    pilot_ready: technically && internal,
    // General availability needs all of it, including the review only a
    // professional can give.
    generally_available: technically && internal && legal && provider,
  };
}

export async function establishmentReadiness(
  ctx: Ctx,
  establishmentId: string,
  on: string = new Date().toISOString().slice(0, 10),
): Promise<EstablishmentReadiness | null> {
  return withCtx(ctx, async (tx) => {
    const establishment = (await listEstablishmentsIn(tx, ctx)).find(
      (e) => e.id === establishmentId,
    );
    if (!establishment) return null;
    const f = await factsFor(tx, ctx, establishment, on);
    const areas = [
      configurationArea(f),
      taxArea(f),
      payrollArea(f),
      documentsArea(f),
      bankingArea(f),
      privacyArea(f),
      einvoicingArea(f),
    ];
    const blocking = areas.flatMap((a) => a.checks.filter((c) => c.state === "blocked"));
    const externalActions = [
      ...(f.pack?.einvoicing.requiredProviders ?? []),
      ...(f.pack?.privacy.organisationActions ?? []),
      // A message key, like everything else here: an outstanding review is
      // reported in the reader's language, not in the one the pack was written in.
      ...(f.reviews.get("professional") === "passed"
        ? []
        : ["country.external.no_professional_review"]),
    ];
    return {
      establishmentId,
      country: establishment.country,
      packKey: f.adoptedPackKey,
      areas,
      states: statesFrom(f, areas),
      blocking,
      externalActions,
    };
  });
}

export async function organisationReadiness(
  ctx: Ctx,
  on: string = new Date().toISOString().slice(0, 10),
): Promise<EstablishmentReadiness[]> {
  const establishments = await withCtx(ctx, (tx) => listEstablishmentsIn(tx, ctx));
  const out: EstablishmentReadiness[] = [];
  for (const e of establishments) {
    const r = await establishmentReadiness(ctx, e.id, on);
    if (r) out.push(r);
  }
  return out;
}
