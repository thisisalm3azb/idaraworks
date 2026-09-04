/**
 * Bleed-harness seeders for the H29 country-pack and electronic-invoicing
 * org-scoped tables.
 *
 * Same contract as seed-h23..h28 — ONE seeder per org-scoped table via the OWNER
 * connection; each chain builds its own dependencies so every seeder stands
 * alone. The harness then proves, in each organisation's context, that the
 * other's rows are invisible.
 *
 * `country_pack`, `country_pack_review` and `locale_release` are deliberately
 * absent: they are PLATFORM tables describing the product, carry no org_id, and
 * are outside the tenant sweep by construction.
 *
 * Every establishment here is created in a country the registry has a pack for
 * (AE), whatever country the harness gave the organisation. The bleed sweep is
 * about row visibility, not about jurisdiction, and a seeder that had to pick
 * the "right" country per organisation would be testing the wrong thing.
 */
import { randomUUID } from "node:crypto";
import type postgres from "postgres";

type Owner = ReturnType<typeof postgres>;
type Seeder = (owner: Owner, orgId: string, userId: string, recipientId: string) => Promise<void>;

const short = () => randomUUID().slice(0, 8);

/** One establishment, the thing every other H29 tenant row hangs off. */
async function establishmentRow(o: Owner, org: string): Promise<string> {
  const id = randomUUID();
  await o`insert into public.establishment
            (id, org_id, code, legal_name, country, timezone, base_currency, working_days, address)
          values (${id}, ${org}, ${"BLEED" + short().slice(0, 6).toUpperCase()},
                  ${"Bleed establishment " + short()}, 'AE', 'Asia/Dubai', 'AED',
                  '["mon","tue","wed","thu","fri"]'::jsonb,
                  '{"line1":"Bleed","city":"Dubai","emirate":"Dubai"}'::jsonb)`;
  return id;
}

/** A channel, and the establishment it belongs to. */
async function channelRow(
  o: Owner,
  org: string,
): Promise<{ channel: string; establishment: string }> {
  const establishment = await establishmentRow(o, org);
  const channel = randomUUID();
  await o`insert into public.einvoice_channel
            (id, org_id, establishment_id, country, adapter_key, environment)
          values (${channel}, ${org}, ${establishment}, 'AE', 'uae_peppol', 'sandbox')`;
  return { channel, establishment };
}

/** A prepared document with no credential behind it — the shipped state. */
async function documentRow(o: Owner, org: string): Promise<string> {
  const { channel, establishment } = await channelRow(o, org);
  const id = randomUUID();
  await o`insert into public.einvoice_document
            (id, org_id, channel_id, establishment_id, source_kind, source_id,
             counter, document_hash, status, idempotency_key)
          values (${id}, ${org}, ${channel}, ${establishment}, 'invoice', ${randomUUID()},
                  1, ${"bleed-hash-" + short()}, 'prepared', ${"bleed-" + randomUUID()})`;
  return id;
}

export const H29_SEEDERS: Record<string, Seeder> = {
  establishment: async (o, org) => {
    await establishmentRow(o, org);
  },

  establishment_registration: async (o, org) => {
    const establishment = await establishmentRow(o, org);
    await o`insert into public.establishment_registration
              (org_id, establishment_id, identifier_key, kind, authority, value)
            values (${org}, ${establishment}, 'trn', 'tax_registration',
                    'Federal Tax Authority', '100000000000003')`;
  },

  establishment_pack_adoption: async (o, org, u) => {
    const establishment = await establishmentRow(o, org);
    // The pack row must exist; migration 0133 seeds the shipped versions, and
    // the effective date is the version's own so the adoption is never
    // backdated before the version exists.
    const [pack] = (await o`
      select pack_key, effective_from::text as effective_from
        from public.country_pack where country = 'AE' order by effective_from limit 1`) as unknown as Array<{
      pack_key: string;
      effective_from: string;
    }>;
    await o`insert into public.establishment_pack_adoption
              (org_id, establishment_id, pack_key, effective_from, adopted_by, note)
            values (${org}, ${establishment}, ${pack!.pack_key}, ${pack!.effective_from}::date,
                    ${u}, 'bleed')`;
  },

  establishment_privacy: async (o, org) => {
    const establishment = await establishmentRow(o, org);
    await o`insert into public.establishment_privacy
              (org_id, establishment_id, data_category, purpose)
            values (${org}, ${establishment}, ${"bleed " + short()}, 'Bleed purpose')`;
  },

  einvoice_channel: async (o, org) => {
    await channelRow(o, org);
  },

  einvoice_document: async (o, org) => {
    await documentRow(o, org);
  },

  einvoice_event: async (o, org) => {
    const document = await documentRow(o, org);
    await o`insert into public.einvoice_event (org_id, document_id, attempt, outcome, detail)
            values (${org}, ${document}, 1, 'unavailable', '{"state":"unavailable"}'::jsonb)`;
  },
};
