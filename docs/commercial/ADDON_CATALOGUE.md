# Add-on Catalogue — Recommended Launch Catalogue

> **Source of truth:** `src/platform/entitlements/addons.ts` (code-owned; migration 0065 seeds
> `addon_def`/`addon_price` from exactly these keys, integration-tested for DB ⇔ code parity).
> This document is the human-readable mirror.
>
> **Prices:** USD base + AED companion, per month, **tax-exclusive**; **yearly = 10× monthly**
> (two months free). Seeded `is_placeholder = true` — recommended pending owner ratification
> ([OWNER_PRICING_DECISIONS.md](./OWNER_PRICING_DECISIONS.md)). Real payment collection is D1-gated.
>
> **Entitlement math** (`resolve.ts`): plan base → add-ons (features OR-merged; limit deltas ADDED
> × purchased quantity) → org overrides (highest precedence).

## Availability classes (the honesty law — tested)

| Class | Meaning | Purchasable? |
|---|---|---|
| `available` | production-operational today | **Yes** |
| `manual_process` | works via a labelled founder/operator manual step | **Yes** |
| `credential_gated` | needs a provider credential (workers/email/AI/OAuth) | No — visible with honest reason |
| `d1_gated` | needs the real-payment decision D1 | No — visible with honest reason |
| `deferred` | capability does not exist yet | **NEVER** — $0, no price rows, roadmap honesty only |

`isPurchasable()` returns true only for `available` and `manual_process`; the pricing UI and the
service layer both enforce it. A bundle is purchasable only if **every** member is.

## Seats & workspace

| Key | Name (EN / AR) | USD/mo | AED/mo | Enables | Availability | Stackable |
|---|---|---|---|---|---|---|
| `addon.members_10` | Additional 10 members / 10 أعضاء إضافيين | $5 | 19 | `limit.full_users` +10, `limit.viewer_users` +10 | available | **Yes** |
| `addon.extra_org` | Additional organization / منشأة إضافية | $9 | 33 | second isolated workspace | manual_process — provisioned with support during pilot | **Yes** |
| `addon.storage_25gb` | Additional 25 GB storage / سعة تخزين إضافية | $4 | 15 | `limit.storage_gb` +25 | available | **Yes** |

Field/foreman seats are always free and unlimited; packs add office + viewer seats only.

## Money modules

| Key | Name (EN / AR) | USD/mo | AED/mo | Enables | Availability | Stackable |
|---|---|---|---|---|---|---|
| `addon.quotes_invoices` | Quotes & invoices / عروض الأسعار والفواتير | $5 | 19 | `cap.quoting`, `cap.invoicing` — e-invoice submission INCLUDED when D1 opens, never sold separately | available | No |
| `addon.payments_ar` | Customer payments & receivables / دفعات العملاء والذمم المدينة | $5 | 19 | `cap.payments` (manual recording only; online collection stays D1-disabled) | available | No |
| `addon.expenses_cashbook` | Expenses & cashbook / المصروفات ودفتر النقدية | $4 | 15 | `cap.expenses` | available | No |

## Purchasing modules

| Key | Name (EN / AR) | USD/mo | AED/mo | Enables | Availability | Stackable |
|---|---|---|---|---|---|---|
| `addon.purchase_requests` | Purchase requests & approvals / طلبات الشراء والموافقات | $4 | 15 | `cap.material_requests` | available | No |
| `addon.purchase_orders` | Purchase orders (LPOs) / أوامر الشراء | $5 | 19 | `cap.purchase_orders` (auto PDF rendering activates with automation pack) | available | No |
| `addon.goods_receiving` | Goods receiving / استلام البضائع | $3 | 11 | `cap.goods_receipts` | available | No |
| `addon.items_catalogue` | Items & materials catalogue / دليل الأصناف والمواد | $3 | 11 | `cap.items` (category-level tracking — not warehouse stock control) | available | No |
| `addon.approval_workflows` | Advanced approval workflows / مسارات موافقات متقدمة | $4 | 15 | `cap.approvals` | available | No |

## Costing & intelligence

| Key | Name (EN / AR) | USD/mo | AED/mo | Enables | Availability | Stackable |
|---|---|---|---|---|---|---|
| `addon.job_costing` | Job costing / تكاليف الأعمال | $7 | 26 | `cap.costing` | available | No |
| `addon.labour_timesheets` | Labour & attendance costing / تكلفة العمالة والحضور | $5 | 19 | `cap.attendance` | available | No |
| `addon.quote_vs_actual` | Quote-versus-actual reporting / تقارير المقارنة بين العرض والفعلي | $3 | 11 | `feat.quote_vs_actual` | available | No |
| `addon.owner_digest` | Owner digest & exception intelligence / ملخص المالك وذكاء الاستثناءات | $5 | 19 | `feat.owner_digest` (on-demand; nightly runs need automation pack) | available | No |
| `addon.customer_updates` | Customer update sharing / مشاركة تحديثات العملاء | $3 | 11 | `cap.customer_updates` | available | No |

## Data & branding

| Key | Name (EN / AR) | USD/mo | AED/mo | Enables | Availability | Stackable |
|---|---|---|---|---|---|---|
| `addon.data_import` | Data import tools / أدوات استيراد البيانات | $3 | 11 | `feat.data_import` | available | No |
| `addon.exports_extended` | Extended data exports / تصدير بيانات موسّع | $3 | 11 | `feat.exports_extended` (core record exports remain free on every plan — never gates your data) | available | No |
| `addon.audit_history` | Audit & compliance history / سجل التدقيق والامتثال | $4 | 15 | `feat.audit_export` | available | No |
| `addon.branding_docs` | Your logo on documents / شعارك على المستندات | $2 | 8 | `feat.branding_docs` | available | No |
| `addon.branding_app` | Full in-app branding / علامتك داخل التطبيق | $1 | 4 | `feat.branding_app` | available | No |
| `addon.priority_support` | Priority support / دعم ذو أولوية | $9 | 33 | priority human support | manual_process — activation confirmed directly | No |

## Credential-gated (visible, NOT purchasable until credentials exist)

| Key | Name (EN / AR) | USD/mo | AED/mo | Enables | Availability note | Stackable |
|---|---|---|---|---|---|---|
| `addon.automation_workers` | Automation & scheduled workers / الأتمتة والمهام المجدولة | $5 | 19 | nightly digests, exception sweeps, PDF rendering, scheduled maintenance | activates once background-worker infra is provisioned | No |
| `addon.email_notifications` | Email notification pack / باقة إشعارات البريد | $3 | 11 | email delivery for invites/approvals/summaries | activates once the email provider is provisioned | No |
| `addon.ai_pack` | AI onboarding & narration pack / باقة الذكاء الاصطناعي | $6 | 22 | `feat.ai_narration`, `feat.ai_drafts`, `limit.ai_credits_month` +200 | activates once an AI provider is wired; the deterministic engine is always included free | No |
| `addon.oauth_login` | OAuth login pack / باقة تسجيل الدخول الموحد | $3 | 11 | Google/Microsoft SSO | activates once OAuth providers are configured | No |

## Deferred — NEVER purchasable

These capabilities **do not exist yet**. They are shown for roadmap honesty only, carry **$0 / no
price rows in 0065**, and can never be purchased: the honesty-law test, `isPurchasable()`, the
pricing UI and the service layer all reject them, and any bundle containing one would be
unpurchasable (`bundleIsPurchasable`). No bundle contains one.

| Key | Name (EN / AR) | Status |
|---|---|---|
| `addon.inventory_stock` | Inventory & stock control / إدارة المخزون | Not built — deferred |
| `addon.multi_location` | Multi-location operations / عمليات متعددة المواقع | Not built — deferred |
| `addon.multi_currency` | Multi-currency documents / مستندات متعددة العملات | Not built — deferred |
| `addon.whatsapp_pack` | WhatsApp / messaging pack / باقة واتساب والمراسلة | Not built — deferred |
| `addon.api_webhooks` | API & webhook access / الوصول البرمجي وWebhooks | Not built — deferred |

## Yearly prices

Every add-on's yearly price = **10× the monthly price in the same currency** (seeded that way in
`addon_price` for both USD and AED) — e.g. `addon.quotes_invoices` $5/mo → $50/yr, AED 19/mo →
AED 190/yr. Deferred add-ons have no price rows at any interval.

Bundles: see [BUNDLE_CATALOGUE.md](./BUNDLE_CATALOGUE.md). Free base: see
[FREE_PLAN_DEFINITION.md](./FREE_PLAN_DEFINITION.md).
