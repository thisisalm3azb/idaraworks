import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Card, CardHeader } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { can } from "@/platform/authz";
import { getCustomer } from "@/modules/masters/service";
import { updateCustomerAction } from "../../actions";
import { CustomerEditForm } from "./CustomerEditForm";

/** Customer edit (003C): pre-populated from the widened read; permission-
 * gated at the page AND in the action/service; `active` is untouched here. */
export default async function CustomerEditPage({
  params,
}: {
  params: Promise<{ orgId: string; customerId: string }>;
}) {
  const { orgId, customerId } = await params;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const detailHref = `/o/${orgId}/customers/${customerId}`;
  if (!can(resolved.archetype, "customers.manage")) redirect(detailHref);
  const t = await getT();
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);

  const c = await getCustomer(resolved.ctx, resolved.archetype, customerId);
  if (!c) notFound();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <Link href={detailHref} className="text-sm text-accent hover:underline">
        ← {c.name}
      </Link>
      <Card>
        <CardHeader
          title={t("customers.edit_title", { customer: term("customer", terms, "singular") })}
        />
        <CustomerEditForm
          initial={{
            name: c.name,
            contactName: c.contactName,
            country: c.country,
            phone: c.phone,
            email: c.email,
            taxRegNo: c.taxRegNo,
            notes: c.notes,
          }}
          cancelHref={detailHref}
          saveAction={updateCustomerAction.bind(null, orgId, customerId, c.active)}
          dict={{
            name: t("common.name"),
            contact_name: t("customers.contact_name"),
            country: t("customers.country"),
            phone: t("common.phone"),
            email: t("common.email"),
            tax_no: t("customers.tax_no"),
            notes: t("common.notes"),
            save: t("common.save"),
            cancel: t("common.cancel"),
            saved: t("common.saved"),
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
            },
          }}
        />
      </Card>
    </div>
  );
}
