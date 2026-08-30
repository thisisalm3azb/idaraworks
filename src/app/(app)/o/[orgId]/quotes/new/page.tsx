import { redirect } from "next/navigation";
import { Card, CardHeader } from "@/platform/ui";
import { lockedFeatureGate } from "@/platform/ui/subscription";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { can } from "@/platform/authz";
import { listQuoteFormOptions } from "@/modules/quotes/service";
import { getOpportunity } from "@/modules/crm/service";
import { createCustomerInlineAction } from "../../customers/actions";
import { createQuoteAction } from "../actions";
import { QuoteForm } from "./QuoteForm";

export default async function NewQuotePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ customer?: string; opportunity?: string }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  if (!can(resolved.archetype, "quotes.manage")) redirect(`/o/${orgId}/quotes`);
  // Locked-feature UX (U3): the capability gate renders the honest unlock
  // screen instead of letting the action throw CapabilityRequiredError.
  const locked = await lockedFeatureGate(resolved.ctx, resolved.archetype, orgId, "cap.quoting");
  if (locked) return locked;
  const t = await getT();
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const customerT = term("customer", terms, "singular");
  const opts = await listQuoteFormOptions(resolved.ctx);
  // ?customer= continuity (from the customer detail page): honored ONLY when
  // the id is in the org's own ACTIVE option list — a foreign or archived id
  // silently falls back to no selection (and the service re-validates anyway).
  let defaultCustomerId = opts.customers.some((c) => c.id === sp.customer)
    ? sp.customer
    : undefined;
  // H20: ?opportunity= continuity — honored ONLY when the id resolves to one
  // of the org's own OPEN opportunities (the service re-validates the link
  // inside the create transaction anyway). Its customer wins the preselect.
  let opportunityId: string | undefined;
  if (sp.opportunity && can(resolved.archetype, "opportunities.view")) {
    const opp = await getOpportunity(resolved.ctx, resolved.archetype, sp.opportunity).catch(
      () => null,
    );
    if (opp && opp.status === "open" && !opp.archived) {
      opportunityId = opp.id;
      if (opp.customerId && opts.customers.some((c) => c.id === opp.customerId)) {
        defaultCustomerId = opp.customerId;
      }
    }
  }
  const canCreateCustomer = can(resolved.archetype, "customers.manage");

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <h1 className="text-lg font-semibold text-ink">{t("quotes.new")}</h1>
      <Card>
        <CardHeader title={t("quotes.form.title")} />
        <QuoteForm
          orgId={orgId}
          customers={opts.customers.map((c) => ({ id: c.id, label: c.name }))}
          presets={opts.presets}
          defaultCustomerId={defaultCustomerId}
          opportunityId={opportunityId}
          canCreateCustomer={canCreateCustomer}
          createAction={createCustomerInlineAction.bind(null, orgId)}
          submitAction={createQuoteAction.bind(null, orgId)}
          relationshipLabels={{
            addNew: t("relationship.add_new", { record: customerT }),
            dialogTitle: t("relationship.dialog_title", { record: customerT }),
            dialogDescription: t("relationship.dialog_hint"),
            create: t("common.add"),
            cancel: t("common.cancel"),
            close: t("common.close"),
            created: t("relationship.created_selected"),
            similar: t("relationship.similar_exists"),
            useExisting: t("relationship.use_existing"),
            reference: t("masterdata.error.reference_short"),
            errors: {
              unauthorized: t("masterdata.error.unauthorized"),
              invalid_email: t("masterdata.error.invalid_email"),
              name_required: t("masterdata.error.name_required"),
              invalid_input: t("masterdata.error.invalid_input"),
              duplicate: t("masterdata.error.duplicate"),
              read_only_billing: t("masterdata.error.read_only_billing"),
              not_entitled: t("masterdata.error.not_entitled"),
              server_error: t("masterdata.error.server_error"),
              failed: t("masterdata.error.server_error"),
            },
          }}
          dict={{
            customer: t("quotes.form.customer"),
            customer_placeholder: "—",
            preset: t("quotes.form.preset"),
            description: t("quotes.form.description"),
            qty: t("quotes.form.qty"),
            unit: t("quotes.form.unit"),
            vat: t("quotes.form.vat"),
            unit_price: t("quotes.form.unit_price"),
            terms: t("quotes.form.terms"),
            submit: t("quotes.form.submit"),
            contact_name: t("customers.contact_name"),
            phone: t("common.phone"),
            errors: {
              unauthorized: t("masterdata.error.unauthorized"),
              forbidden: t("masterdata.error.unauthorized"),
              customer_invalid: t("quotes.error.customer_invalid", { customer: customerT }),
              customer_archived: t("quotes.error.customer_archived", { customer: customerT }),
              invalid: t("quotes.error.invalid"),
              failed: t("quotes.error.failed"),
            },
          }}
        />
      </Card>
    </div>
  );
}
