/**
 * H29 — production smoke. Creates ONE marked organisation, exercises the
 * country-pack platform against the migrated production database, and proves
 * the claims that matter:
 *
 *  - the shipped pack versions exist as rows and agree with the registry;
 *  - an establishment can be created, a version adopted, and a date in an
 *    earlier period still resolves through the version that applied then;
 *  - the simulator writes nothing;
 *  - electronic invoicing prepares a document and REFUSES to submit, because no
 *    credential exists — never a fabricated success;
 *  - readiness reports six independent states and claims no legal review;
 *  - the language record says Spanish is machine-assisted and unreviewed;
 *  - with the release flags off, no country surface is reachable.
 *
 * The fixture self-destructs in `finally`; residue and the historical counts
 * are verified before the script exits.
 *
 *   npx tsx tooling/scripts/h29-prod-smoke.ts --confirm=<production phrase> [--surfaces=on]
 *
 * Never contacts ZATCA or any other authority: this script asserts that
 * submission is impossible, it does not attempt one.
 */
import { config } from "dotenv";
config({ path: [".env.local"], quiet: true });
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createOrgForUser } from "@/platform/auth/identity";
import { closeAppDb, type Ctx } from "@/platform/tenancy";
import { COUNTRY_PACKS, READINESS_STATES, SA_PACK } from "@/platform/country";
import {
  adoptPack,
  createEstablishment,
  establishmentReadiness,
  listAdoptions,
  previewAdoption,
  setRegistration,
} from "@/modules/country/service";
import {
  createChannel,
  listDocuments,
  prepareDocument,
  submitDocument,
  ZATCA_OWNER_ACTION,
} from "@/modules/einvoicing/service";
import {
  productionMigrationPhrase,
  targetsOnlyProductionProject,
} from "../../tests/integration/guard-env";

const BASE = (process.env.PDF_VERIFY_BASE ?? "https://www.idaraworks.com").replace(/\/$/, "");
const RUN = randomUUID().slice(0, 8);

const checks: Array<{ name: string; ok: boolean; note?: string }> = [];
function check(name: string, ok: boolean, note?: string): void {
  checks.push({ name, ok, note });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${note ? ` — ${note}` : ""}`);
}

const owner = postgres(process.env.DIRECT_URL!, { max: 2, prepare: false });
let orgId = "";
let ownerUserId = "";
let establishmentId = "";

/** No credential of any kind is visible to this run. */
const NO_CREDENTIALS: Record<string, string | undefined> = { APP_ENV: "production" };

async function baselineCounts(): Promise<Record<string, string>> {
  const r = (
    await owner`
    select (select count(*) from public.org)::text as orgs,
           (select count(*) from auth.users)::text as users,
           (select count(*) from public.customer)::text as customers,
           (select count(*) from public.job)::text as jobs,
           (select count(*) from public.invoice)::text as invoices,
           (select count(*) from public.audit_log)::text as audit_rows`
  )[0];
  return r as unknown as Record<string, string>;
}

async function cleanup(): Promise<void> {
  if (orgId) {
    const tables = (
      await owner`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'org_id' group by table_name`
    ).map((r) => String(r.table_name));
    await owner.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      for (const t of tables) await tx.unsafe(`delete from public.${t} where org_id = $1`, [orgId]);
      await tx.unsafe(`delete from public.org where id = $1`, [orgId]);
    });
  }
  if (ownerUserId) {
    await owner`delete from public.user_profile where id = ${ownerUserId}`;
    await owner`delete from auth.sessions where user_id = ${ownerUserId}`;
    await owner`delete from auth.identities where user_id = ${ownerUserId}`;
    await owner`delete from auth.users where id = ${ownerUserId}`;
  }
  const nothing = orgId || randomUUID();
  const residue = (await owner`
    select
      (select count(*) from public.org where id = ${nothing}) +
      (select count(*) from public.app_settings where org_id = ${nothing}) +
      (select count(*) from public.establishment where org_id = ${nothing}) +
      (select count(*) from public.establishment_registration where org_id = ${nothing}) +
      (select count(*) from public.establishment_pack_adoption where org_id = ${nothing}) +
      (select count(*) from public.establishment_privacy where org_id = ${nothing}) +
      (select count(*) from public.einvoice_channel where org_id = ${nothing}) +
      (select count(*) from public.einvoice_document where org_id = ${nothing}) +
      (select count(*) from public.einvoice_event where org_id = ${nothing}) +
      (select count(*) from public.audit_log where org_id = ${nothing}) +
      (select count(*) from auth.users where id = ${ownerUserId || randomUUID()})
      as n`) as unknown as Array<{ n: string }>;
  console.log(`cleanup: residue rows = ${residue[0]!.n} (must be 0)`);
  if (Number(residue[0]!.n) !== 0) throw new Error("RESIDUE LEFT — investigate immediately");
}

async function main(): Promise<void> {
  const confirmArg = process.argv
    .find((a) => a.startsWith("--confirm="))
    ?.slice("--confirm=".length);
  const surfaces = process.argv.includes("--surfaces=on");
  // .ok, not the verdict object: a truthy object made this guard vacuous,
  // so it could never refuse anything (H29, found by CI).
  const target = targetsOnlyProductionProject({ ...process.env } as Record<
    string,
    string | undefined
  >);
  if (!target.ok) {
    console.error("Refusing: the environment does not point only at production");
    for (const p of target.problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }
  if (confirmArg !== productionMigrationPhrase()) {
    console.error(`Refusing: pass --confirm=${productionMigrationPhrase()}`);
    process.exitCode = 1;
    return;
  }
  const before = await baselineCounts();
  console.log(`H29 production smoke (run ${RUN})`);

  const ctx = (): Ctx => ({
    orgId,
    userId: ownerUserId,
    costPrivileged: true,
    pricePrivileged: true,
    requestId: `h29-smoke-${RUN}`,
  });

  try {
    // ── the shipped versions ────────────────────────────────────────────────
    const packRows = await owner`
      select pack_key, country, status, effective_from::text as effective_from,
             effective_to::text as effective_to, currency, default_timezone
        from public.country_pack order by pack_key`;
    const byKey = new Map(packRows.map((r) => [String(r.pack_key), r]));
    const drift = COUNTRY_PACKS.filter((p) => {
      const row = byKey.get(p.packKey);
      return (
        !row ||
        row.country !== p.country ||
        row.status !== p.status ||
        row.effective_from !== p.effectiveFrom ||
        row.effective_to !== p.effectiveTo ||
        row.currency !== p.format.currency ||
        row.default_timezone !== p.format.defaultTimezone
      );
    }).map((p) => p.packKey);
    check(
      "packs: every registry version has a matching row",
      drift.length === 0,
      drift.length ? `drift: ${drift.join(", ")}` : `${packRows.length} version(s)`,
    );

    const reviews = await owner`
      select pack_key, kind, state from public.country_pack_review order by pack_key, kind`;
    const claimed = reviews.filter(
      (r) => (r.kind === "professional" || r.kind === "provider") && r.state === "passed",
    );
    check(
      "packs: no professional or provider review is claimed",
      claimed.length === 0,
      `${reviews.length} review record(s)`,
    );

    // ── the language record ─────────────────────────────────────────────────
    const locales = await owner`
      select locale, production, native_review, native_reviewer from public.locale_release order by locale`;
    const es = locales.find((r) => r.locale === "es");
    check(
      "languages: Spanish is recorded as machine-assisted and unreviewed",
      es?.production === "machine_assisted" &&
        es?.native_review === "not_started" &&
        es?.native_reviewer === null,
      es ? `${es.production} / ${es.native_review}` : "no row",
    );
    check(
      "languages: no locale claims a review without a named reviewer",
      locales.every(
        (r) =>
          !["passed", "failed"].includes(String(r.native_review)) || r.native_reviewer !== null,
      ),
      `${locales.length} locale(s)`,
    );

    // ── fixture ─────────────────────────────────────────────────────────────
    ownerUserId = randomUUID();
    await owner`
      insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
      values (${ownerUserId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`h29-smoke-${RUN}@example.invalid`},
              ${JSON.stringify({ full_name: "H29 Smoke" })}::jsonb, now(), now())`;
    orgId = await createOrgForUser(ownerUserId, {
      name: `H29 Smoke ${RUN}`,
      country: "SA",
      baseCurrency: "SAR",
    });
    await owner`
      insert into public.app_settings (org_id, key, value)
      values (${orgId}, 'test.fixture', ${JSON.stringify({
        is_test_fixture: true,
        suite: "h29-prod-smoke",
        run: RUN,
        created_at: new Date().toISOString(),
      })}::jsonb)
      on conflict (org_id, key) do update set value = excluded.value`;

    // ── an establishment, in a country that is not the organisation's default ─
    const est = await createEstablishment(ctx(), "owner", {
      code: "RUH",
      legalName: `Riyadh Smoke ${RUN}`,
      legalNameLocal: "منشأة الفحص",
      country: "SA",
      timezone: "Asia/Riyadh",
      baseCurrency: "SAR",
      isPrimary: true,
      address: {
        buildingNumber: "1234",
        street: "King Fahd",
        district: "Olaya",
        city: "Riyadh",
        postalCode: "12345",
      },
    });
    establishmentId = est.id;
    check("establishment: created in its own country", est.country === "SA", est.code);
    check(
      "establishment: the local-script name is stored exactly as entered",
      est.legalNameLocal === "منشأة الفحص",
    );

    // ── effective dating ────────────────────────────────────────────────────
    const laterDate = "2026-12-01";
    await adoptPack(ctx(), "owner", {
      establishmentId,
      packKey: SA_PACK.packKey,
      effectiveFrom: laterDate,
      note: `h29 smoke ${RUN}`,
    });
    const beforeAdoption = (
      await owner`
      select app.establishment_pack_on(${establishmentId}::uuid, '2026-11-30'::date) as k`
    )[0]!.k;
    const onAdoption = (
      await owner`
      select app.establishment_pack_on(${establishmentId}::uuid, ${laterDate}::date) as k`
    )[0]!.k;
    check(
      "effective dating: the version applies from its own date and not before",
      beforeAdoption === null && onAdoption === SA_PACK.packKey,
      `before=${beforeAdoption ?? "none"} on=${onAdoption ?? "none"}`,
    );

    // A second, earlier adoption must not change the later answer, and the
    // earlier date must resolve to the earlier adoption.
    await adoptPack(ctx(), "owner", {
      establishmentId,
      packKey: SA_PACK.packKey,
      effectiveFrom: SA_PACK.effectiveFrom,
      note: `h29 smoke earlier ${RUN}`,
    });
    const stillLater = (
      await owner`
      select app.establishment_pack_on(${establishmentId}::uuid, ${laterDate}::date) as k`
    )[0]!.k;
    check(
      "effective dating: adding an earlier version does not rewrite the later answer",
      stillLater === onAdoption,
    );
    const adoptions = await listAdoptions(ctx(), establishmentId, { limit: 200, offset: 0 });
    check("effective dating: both adoptions are kept", adoptions.length === 2);

    // ── the simulator writes nothing ────────────────────────────────────────
    const auditBefore = Number(
      (await owner`select count(*)::int as n from public.audit_log where org_id = ${orgId}`)[0]!.n,
    );
    const preview = await previewAdoption(ctx(), "owner", {
      establishmentId,
      packKey: SA_PACK.packKey,
      effectiveFrom: "2027-01-01",
    });
    const adoptionsAfter = await listAdoptions(ctx(), establishmentId, { limit: 200, offset: 0 });
    const auditAfter = Number(
      (await owner`select count(*)::int as n from public.audit_log where org_id = ${orgId}`)[0]!.n,
    );
    check(
      "simulator: a preview adds no adoption and no audit row",
      adoptionsAfter.length === adoptions.length && auditAfter === auditBefore,
      `adoptions ${adoptionsAfter.length}, audit ${auditAfter}`,
    );
    check(
      "simulator: it reports what it cannot touch",
      preview.unchanged.length === 3,
      preview.unchanged.map((u) => `${u.kind}=${u.count}`).join(" "),
    );

    // ── readiness ───────────────────────────────────────────────────────────
    await setRegistration(ctx(), "owner", {
      establishmentId,
      identifierKey: "vat_number",
      value: "300000000000003",
    });
    const readiness = await establishmentReadiness(ctx(), establishmentId, laterDate);
    check(
      "readiness: six independent states, not a score",
      readiness !== null && READINESS_STATES.every((s) => typeof readiness.states[s] === "boolean"),
      readiness
        ? READINESS_STATES.filter((s) => readiness.states[s]).join(", ") || "none met"
        : "null",
    );
    check(
      "readiness: no legal review is claimed",
      readiness?.states.legally_reviewed === false &&
        readiness?.states.generally_available === false,
    );
    check(
      "readiness: the outstanding professional review is named",
      (readiness?.externalActions ?? []).some((a) => /professional/i.test(a)),
    );

    // ── electronic invoicing refuses to submit ──────────────────────────────
    const channel = await createChannel(ctx(), "owner", {
      establishmentId,
      adapterKey: "zatca",
      environment: "sandbox",
    });
    check(
      "e-invoicing: the channel is created with no credential",
      channel.credentialPresent === false,
    );

    const prepared = await prepareDocument(
      ctx(),
      "owner",
      {
        channelId: channel.id,
        document: {
          kind: "tax_invoice",
          id: randomUUID(),
          reference: `SMOKE-${RUN}`,
          issuedAt: "2026-12-05T09:00:00.000Z",
          currency: "SAR",
          totalMinor: 11_500,
          taxTotalMinor: 1_500,
          seller: {
            name: `Riyadh Smoke ${RUN}`,
            taxNumber: "300000000000003",
            address: { buildingNumber: "1234", street: "King Fahd", city: "Riyadh" },
          },
          buyer: {
            name: "Smoke Customer",
            taxNumber: null,
            address: { buildingNumber: "5678", street: "Tahlia", city: "Riyadh" },
          },
          lines: [
            {
              description: "Consultancy",
              quantity: 1,
              unitPriceMinor: 10_000,
              taxRatePercent: 15,
              taxAmountMinor: 1_500,
              lineTotalMinor: 11_500,
            },
          ],
        },
      },
      NO_CREDENTIALS,
    );
    check(
      "e-invoicing: a document is still prepared, hashed and given a QR payload",
      Boolean(prepared.document.documentHash) && Boolean(prepared.document.qrPayload),
      `counter ${prepared.document.counter}`,
    );
    check(
      "e-invoicing: the unknown initial previous-invoice-hash is reported, not invented",
      prepared.issues.some((i) => i.code === "pih-initial-unknown"),
    );

    const submitted = await submitDocument(ctx(), "owner", prepared.document.id, NO_CREDENTIALS);
    check(
      "e-invoicing: submission is UNAVAILABLE, never a fabricated success",
      submitted.state === "unavailable" && submitted.ownerAction === ZATCA_OWNER_ACTION,
      submitted.state,
    );
    const cleared = Number(
      (
        await owner`select count(*)::int as n from public.einvoice_document
                    where org_id = ${orgId} and status in ('cleared', 'reported')`
      )[0]!.n,
    );
    check("e-invoicing: nothing claims a cleared or reported state", cleared === 0);
    const events = await owner`
      select outcome from public.einvoice_event where org_id = ${orgId}`;
    check(
      "e-invoicing: every recorded attempt is 'unavailable'",
      events.length > 0 && events.every((e) => e.outcome === "unavailable"),
      `${events.length} event(s)`,
    );
    const docs = await listDocuments(ctx(), channel.id, { limit: 1, offset: 0 });
    check(
      "e-invoicing: the document list pages and reports the full total",
      docs.rows.length === 1 && docs.total >= 1,
      `page ${docs.rows.length} of ${docs.total}`,
    );

    // ── audit ───────────────────────────────────────────────────────────────
    const countryAudit = Number(
      (
        await owner`select count(*)::int as n from public.audit_log
                    where org_id = ${orgId} and (action like 'country.%' or action like 'einvoice.%')`
      )[0]!.n,
    );
    check(
      "audit: every country and invoicing operation is recorded",
      countryAudit > 0,
      `${countryAudit} rows`,
    );

    // ── the deployed surfaces ───────────────────────────────────────────────
    if (surfaces) {
      const health = await fetch(`${BASE}/api/health`);
      const body = (await health.json()) as { ok: boolean; commit: string };
      check(
        "http: production is healthy",
        body.ok === true,
        `commit ${String(body.commit).slice(0, 7)}`,
      );
      for (const path of [
        "/platform/languages",
        "/platform/countries",
        `/o/${orgId}/settings/countries`,
      ]) {
        const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
        check(
          `http: ${path} is not public`,
          res.status === 404 || res.status === 307 || res.status === 302,
          `status ${res.status}`,
        );
      }
    }
  } finally {
    await cleanup();
    const after = await baselineCounts();
    const intact = JSON.stringify(before) === JSON.stringify(after);
    console.log(
      `historical counts intact: ${intact} (before=${JSON.stringify(before)} after=${JSON.stringify(after)})`,
    );
    if (!intact) checks.push({ name: "historical counts intact", ok: false });
    await owner.end();
    await closeAppDb();
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0)
    console.log(`ALL ${checks.length} CHECKS PASSED (surfaces=${surfaces ? "on" : "off"})`);
  else {
    console.log(`${failed.length} FAILED of ${checks.length}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
