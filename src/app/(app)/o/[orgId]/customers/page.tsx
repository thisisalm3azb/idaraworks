import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, Button, Card, CardHeader, EmptyState, Field } from "@/platform/ui";
import { getT, getServerLocale } from "@/platform/i18n/server";
import { resolveCtx } from "@/platform/auth/resolve";
import { loadOrgTerminology, term } from "@/platform/terminology";
import { can } from "@/platform/authz";
import { cn } from "@/lib/cn";
import { listCustomers } from "@/modules/masters/service";
import { isMasterDataErrorCode } from "@/platform/http/actionError";
import { createCustomerAction } from "./actions";

/**
 * Customers workspace (003C): searchable, filterable, rows navigate to the
 * detail page, archived records stay discoverable behind an explicit filter.
 * Search and filtering are SERVER-side (bounded query, never browser
 * filtering of an unbounded table).
 */
export default async function CustomersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{
    q?: string;
    status?: string;
    error?: string;
    ref?: string;
    field?: string;
    name?: string;
    country?: string;
    contact_name?: string;
    notes?: string;
  }>;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const resolved = await resolveCtx(orgId);
  if (typeof resolved === "string") redirect("/");
  const t = await getT();
  const locale = await getServerLocale();
  const terms = await loadOrgTerminology(resolved.ctx, locale);
  const customerT = term("customer", terms, "singular");
  const customersT = term("customer", terms, "plural");

  const q = (sp.q ?? "").trim();
  const status = sp.status === "archived" ? "archived" : sp.status === "all" ? "all" : "active";
  const customers = await listCustomers(resolved.ctx, resolved.archetype, { q, status });
  // Distinguish "no customers at all" from "only archived remain" for the
  // active view's empty state (one bounded probe, only when needed).
  const archivedOnly =
    customers.length === 0 && status === "active" && q === ""
      ? (await listCustomers(resolved.ctx, resolved.archetype, { status: "archived", limit: 1 }))
          .length > 0
      : false;

  const canManage = can(resolved.archetype, "customers.manage");
  const addWithOrg = createCustomerAction.bind(null, orgId);

  const errorCode = isMasterDataErrorCode(sp.error) ? sp.error : undefined;
  const errorMsg = errorCode ? t(`masterdata.error.${errorCode}`) : null;
  const invalid = errorCode ? sp.field : undefined;

  const filterHref = (s: string) =>
    `/o/${orgId}/customers?status=${s}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
  const FILTERS = [
    { key: "active", label: t("customers.filter.active") },
    { key: "archived", label: t("customers.filter.archived") },
    { key: "all", label: t("customers.filter.all") },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={t("customers.title", { customers: customersT })} />
        <form method="get" className="flex flex-wrap items-end gap-2" role="search">
          <input type="hidden" name="status" value={status} />
          <div className="min-w-0 flex-1">
            <Field
              label={t("customers.search")}
              name="q"
              defaultValue={q}
              placeholder={t("customers.search_hint")}
            />
          </div>
          <Button type="submit" variant="secondary">
            {t("common.search")}
          </Button>
        </form>
        <div
          className="mt-3 flex flex-wrap gap-2"
          role="group"
          aria-label={t("customers.filter.label")}
        >
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={filterHref(f.key)}
              aria-current={status === f.key ? "true" : undefined}
              className={cn(
                "inline-flex min-h-9 items-center rounded-full border px-3 text-xs font-medium",
                status === f.key
                  ? "border-ink bg-ink text-card"
                  : "border-line bg-card text-ink-secondary",
              )}
            >
              {f.label}
            </Link>
          ))}
        </div>

        {customers.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              title={
                q !== ""
                  ? t("customers.none_matching")
                  : archivedOnly
                    ? t("customers.only_archived", { customers: customersT })
                    : status === "archived"
                      ? t("customers.none_archived")
                      : t("customers.none", { customers: customersT })
              }
            />
            {archivedOnly ? (
              <p className="mt-2 text-center text-sm">
                <Link href={filterHref("archived")} className="text-accent hover:underline">
                  {t("customers.filter.archived")} →
                </Link>
              </p>
            ) : null}
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {customers.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/o/${orgId}/customers/${c.id}`}
                  className={cn(
                    "flex min-h-14 items-center justify-between gap-3 py-2 hover:bg-sunken",
                    !c.active && "opacity-70",
                  )}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{c.name}</p>
                    <p className="truncate text-xs text-ink-muted">
                      {[c.contactName, c.phone, c.country].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <Badge tone={c.active ? "success" : "neutral"}>
                    {c.active ? t("common.active") : t("customers.archived")}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canManage ? (
        <Card>
          <CardHeader title={t("customers.add", { customer: customerT })} />
          {errorMsg ? (
            <div className="mb-3 rounded-md bg-danger-soft p-3 text-sm text-danger" role="alert">
              <p>{errorMsg}</p>
              {sp.ref ? (
                <p className="mt-1 text-xs text-danger/80">
                  {t("masterdata.error.reference", { id: sp.ref })}
                </p>
              ) : null}
            </div>
          ) : null}
          <form action={addWithOrg} className="flex flex-col gap-4">
            <Field
              label={t("common.name")}
              name="name"
              required
              defaultValue={sp.name ?? ""}
              error={invalid === "name" ? (errorMsg ?? undefined) : undefined}
              autoFocus={invalid === "name" || undefined}
            />
            <Field
              label={t("customers.contact_name")}
              name="contact_name"
              defaultValue={sp.contact_name ?? ""}
            />
            <Field
              label={t("customers.country")}
              name="country"
              maxLength={2}
              placeholder="AE"
              defaultValue={sp.country ?? ""}
              error={invalid === "country" ? (errorMsg ?? undefined) : undefined}
              autoFocus={invalid === "country" || undefined}
            />
            <Field label={t("common.phone")} name="phone" defaultValue="" />
            <Field
              label={t("common.email")}
              name="email"
              type="email"
              defaultValue=""
              error={invalid === "email" ? (errorMsg ?? undefined) : undefined}
              autoFocus={invalid === "email" || undefined}
            />
            <Field label={t("customers.tax_no")} name="tax_reg_no" defaultValue="" />
            <Field label={t("common.notes")} name="notes" defaultValue={sp.notes ?? ""} />
            <Button type="submit">{t("common.add")}</Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
