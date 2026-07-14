# Template Catalogue

The 8 shipped industry templates (source of truth: `src/platform/config/templates/*`, registered in `index.ts` as `TEMPLATE_CATALOGUE`; catalogue order = chooser display order, Generic Operations last as the fallback).

**Templates configure STRUCTURE ONLY.** An install lays down configuration artifacts — terminology, stages, statuses, categories, reference patterns, role presets, job-type presets, holiday calendar, custom-field definitions — as a sequence of ordinary, undoable config revisions. **No jobs, users, suppliers, customers, transactions, expenses or documents are ever created by an install.** The customer still enters their own org info, users, approval thresholds, projects/jobs, suppliers, customers, inventory items, tax settings and all commercial data themselves.

**Enabled/optional modules are ADVISORY.** They are UI emphasis defaults referencing existing capability keys — they **never grant or imply commercial entitlements** (entitlements resolve exclusively from the plan/add-on/override layer; see `src/platform/entitlements/`).

Every template is composed from the shared blocks in `blocks.ts` (see TEMPLATE_CONFIGURATION_REFERENCE.md) and validated at build time — a broken manifest fails the build, never an install.

Role privileges below use the fixed 7-role spine. In every template: **owner, admin and accounts see costs and prices; foreman, procurement and viewer never see money**. Only the manager's money-visibility varies per template, noted below.

---

## 1. Boatbuilding / Marine — `boatbuilding_marine_v1`

- **Names:** Boatbuilding / Marine — بناء القوارب والصناعات البحرية
- **Target businesses:** boat builders and boatyards, marine fabrication and composites workshops, boat refit and repair yards, marine outfitting contractors. The marine specialisation of the manufacturing/workshop pattern — same operational spine (stages → daily reports → purchasing → costing → billing) with the production-proven 11 marine stages and 9 boat-model presets.
- **Terminology:** Job = **Boat / قارب**; stage = Production Stage; daily report = Daily Report; purchase order = **LPO** (the house term, carried deliberately); quote = Quotation; employee = Worker; team = Team; material request = Material Request.
- **Roles:** Owner, Admin, **Workshop Manager** (manager — costs OFF, prices OFF), Foreman, Procurement, Accounts (routes Najolatech's back-office "Inventory = accountant" duties), Viewer.

| Stage | Weight | Phase semantic |
|---|---|---|
| Mould Prep | 5 | preparation |
| Lamination | 16 | production |
| Below Deck Rigging | 10 | production |
| 3-part Assembly | 12 | production |
| Over Deck Assembly | 12 | production |
| Hardware Rigging | 10 | production |
| Electrical Rigging | 10 | production |
| Upholstery | 7 | production |
| Finishing & Polishing | 10 | finishing |
| Sea Trial | 4 | verification |
| Delivery | 4 | handover |

- **Job statuses:** Draft → In Production → (On Hold) → Sea Trial → Delivered → Closed / Cancelled (a custom set, not the shared spine).
- **Presets (9 boat models):** 13ft Skiff (13S), 18ft Skiff (18S), 21ft Panga GW (21P), 24ft Catamaran (24C), 27ft Panga GW (27P), 34ft Catamaran (34C), 35ft EQM (35E), 46ft Dustour (D46), 20m Catamaran (20M). Small skiffs (13S/18S) skip Upholstery by default. **Billing:** 60% on acceptance, 40% at Delivery (the real contract terms, audit F-1) on every model.
- **Reference pattern:** `{preset_code}-{seq:3}` → hull numbers like `24C-001`.
- **Approval structure:** approvals module enabled by default; thresholds are entered by the org (F-28 caps apply to onboarding proposals — see AI_TEMPLATE_SELECTION_RULES.md).
- **Categories:** 17 item categories (fiberglass, resin, chemicals, core, vacuum consumables, sanding, polishing, hardware, assembly rubber, piping/fitting, fuel, upholstery, lights, electrical, navionics, stereo, motors), 13 expense categories with the F-2 costing mappings, 9 quote sections (boat package, engine package, electronics, upholstery, fishing accessories, safety equipment, trailer/transport, custom options, other).
- **Custom fields on job:** engine_package (text), colour_scheme (text).
- **Enabled modules (advisory):** cap.jobs, cap.daily_reports, cap.people, cap.issues, cap.approvals, cap.procurement, cap.expenses_costing, cap.quoting, cap.invoicing, cap.customers. **Optional:** cap.customer_updates.
- **Dashboard defaults:** jobs_active, reports_today, approvals_pending, exceptions.
- **Example classification phrases:** "we build fiberglass boats to order", "boatyard building skiffs and catamarans", "marine fabrication workshop", "hull lamination and assembly yard", "مصنع قوارب في الإمارات", "حوض بناء قوارب صيد".
- **Known limitations (verbatim):**
  - No naval-architecture/CAD or engineering design tools
  - No marina, berth or charter management
  - Stock is category-level operational tracking, not serial/lot traceability

---

## 2. Manufacturing & Workshop — `manufacturing_workshop_v1`

- **Names:** Manufacturing & Workshop — التصنيع والورش الصناعية
- **Target businesses:** metal fabrication and welding workshops, joinery/carpentry, aluminium and glass fabricators, equipment and machinery manufacturers, composites/GRP workshops, project-based factories. The general workshop pattern that the more specialised production templates are refinements of.
- **Terminology:** Job = **Work Order / أمر تشغيل**; stage = Production Stage; daily report = Production Report.
- **Roles:** standard spine with **Production Manager** (costs OFF, prices OFF) and Foreman / مشرف الورشة.

| Stage | Weight | Phase semantic |
|---|---|---|
| Design & Prep | 8 | preparation |
| Material Preparation | 10 | preparation |
| Fabrication | 30 | production |
| Assembly | 22 | production |
| Surface Finishing | 14 | finishing |
| Quality Inspection | 8 | verification |
| Delivery | 8 | handover |

- **Job statuses:** shared spine with active renamed **In Production / قيد الإنتاج** (Draft → In Production → On Hold → Completed → Closed / Cancelled).
- **Presets:** FAB Custom Fabrication (50/50 acceptance/delivery), BATCH Batch Production (skips design_prep; 100% on acceptance), REP Repair & Rework (skips design_prep; 100% on acceptance), ASSY Assembly Order (skips fabrication; 40/60 acceptance/delivery).
- **Reference pattern:** `WO-{year}-{seq:4}` → `WO-2026-0001`.
- **Categories:** 14 item categories (sheet metal, structural steel, aluminium, fasteners, welding consumables, coatings & paint, timber & boards, composites & resins, machine parts, abrasives, gases, electrical components, packaging, other); expense = shared spine + consumables (job_materials), surface treatment (job_other), machine maintenance (overhead); 7 quote sections.
- **Custom fields on job:** drawing_reference (text), material_grade (text).
- **Enabled modules:** cap.jobs, cap.daily_reports, cap.people, cap.issues, cap.approvals, cap.procurement, cap.expenses_costing, cap.customers. **Optional:** cap.quoting, cap.invoicing, cap.customer_updates.
- **Dashboard defaults:** jobs_active, reports_today, approvals_pending, exceptions.
- **Example classification phrases:** "we run a steel fabrication workshop in dammam", "custom metalwork and welding shop in sharjah", "joinery workshop making custom doors and furniture", "ورشة تصنيع معادن ولحام في جدة", "مصنع أبواب وشبابيك ألمنيوم".
- **Known limitations (verbatim):**
  - No MRP or BOM explosion — materials are requested and costed per work order
  - No capacity or machine-load planning
  - No machine or CNC integration — does not connect to shop-floor equipment
  - No serial or lot traceability on stock items
  - Quality checks are stage sign-offs, not statistical process control

---

## 3. Service Business — `service_business_v1`

- **Names:** Service Business — شركات الخدمات
- **Target businesses:** maintenance & AC companies, repair workshops, cleaning & facility services, electrical & plumbing contractors, technical & field-service teams, consultancies & professional services.
- **Terminology:** Job = **Service Job / أمر خدمة**; stage = Service Stage; daily report = **Field Report / تقرير ميداني**; employee = **Technician / فني**; team = **Crew / طاقم**.
- **Roles:** **Service Manager** (manager — **costs ON**, prices OFF; the service manager owns job profitability, prices stay owner/accounts) and Crew Lead (foreman).

| Stage | Weight | Phase semantic |
|---|---|---|
| Request Logged | 5 | preparation |
| Scheduled | 10 | preparation |
| On Site / In Service | 45 | production |
| Wrap-up & Site Cleanup | 15 | finishing |
| Quality Check | 10 | verification |
| Handover & Close | 15 | handover |

- **Job statuses:** spine with active = **In Service**, done = **Work Complete**, plus an extra active status **Awaiting Parts / بانتظار قطع الغيار** (jobs stall on parts).
- **Presets:** SVC Service Call (skips wrap_up; 100% on acceptance), MNT Maintenance Contract Visit (skips wrap_up; 100% on acceptance), INST Installation Project (50/50 acceptance/handover), OVHL Deep Clean / Major Overhaul (50/50 acceptance/handover).
- **Reference pattern:** `{preset_code}-{year}-{seq:3}` → `SVC-2026-001`.
- **Categories:** 9 item categories (spare parts, consumables, cleaning supplies, tools & accessories, safety equipment, electrical parts, plumbing parts, filters & fluids, other); expense = spine + spare parts, consumables (job_materials), equipment rental, permits & fees (job_other); 5 quote sections (labour & call-out, parts & materials, equipment, transport, other).
- **Custom fields on job:** service_location (text), priority (select: low/normal/urgent), asset_details (text).
- **Enabled modules:** cap.jobs, cap.daily_reports, cap.people, cap.issues, cap.customers, cap.quoting, cap.invoicing, cap.expenses_costing. **Optional:** cap.approvals, cap.procurement, cap.customer_updates.
- **Dashboard defaults:** jobs_active, week_plan, reports_today, ar_outstanding.
- **Example classification phrases:** "we run an ac maintenance company in dubai", "small plumbing and electrical services team", "equipment repair workshop with field technicians", "شركة صيانة تكييف في الرياض", "فريق صيانة كهرباء وسباكة".
- **Known limitations (verbatim):**
  - No GPS tracking or route optimisation
  - No customer self-service booking portal
  - No IoT or asset condition monitoring
  - Scheduling is a week view, not a live dispatch board

---

## 4. Construction & Contracting — `construction_v1`

- **Names:** Construction & Contracting — المقاولات والإنشاءات
- **Target businesses:** fit-out and interior contracting companies, small civil works and building contractors, MEP contractors and subcontractors, renovation and refurbishment companies, specialist subcontractors under main contractors.
- **Terminology:** Job = **Project / مشروع**; stage = **Phase / مرحلة**; daily report = **Site Report / تقرير موقع**; purchase order = **LPO** (the GCC contracting house term); supplier = **Supplier/Subcontractor**; employee = Worker; quote = Quotation.
- **Roles:** **Project Manager** (manager — **costs ON**, prices OFF; the PM tracks budget) and Site Supervisor (foreman).

| Phase | Weight | Phase semantic |
|---|---|---|
| Mobilisation | 5 | preparation |
| Civil & Structural Works | 35 | production |
| MEP First Fix | 20 | production |
| Finishes | 28 | finishing |
| Snagging | 7 | verification |
| Handover | 5 | handover |

- **Job statuses:** spine with active = **On Site / قيد التنفيذ بالموقع**, done = **Handed Over / تم التسليم**.
- **Presets (milestone billing, each Σ=100):** FIT Fit-out (skips civil_structural; 30/40/30 acceptance/finishes/handover), CVL Civil Works (skips mep_first_fix; 20/50/30 acceptance/civil/handover), MEP MEP Package (skips civil_structural + finishes; 30/40/30 acceptance/MEP/handover), REN Renovation (full sequence; 40/30/30 acceptance/finishes/handover).
- **Reference pattern:** `{preset_code}-{year}-{seq:3}` → `FIT-2026-001`.
- **Categories:** 14 item categories (cement & aggregates, steel & rebar, blockwork, timber & joinery, electrical materials, plumbing & drainage, HVAC, paint & finishes, tiles & flooring, gypsum & partitions, waterproofing, scaffolding & access, safety equipment, other); expense = spine + variations, equipment & plant rental, permits & government fees, site facilities & temporary works (all job_other); 6 quote sections (preliminaries, civil & structural, MEP, finishes, variations, other).
- **Custom fields on job:** site_location (text), contract_reference (text).
- **Enabled modules:** cap.jobs, cap.daily_reports, cap.people, cap.issues, cap.approvals, cap.procurement, cap.expenses_costing, cap.customers. **Optional:** cap.quoting, cap.invoicing, cap.customer_updates.
- **Dashboard defaults:** jobs_active, reports_today, approvals_pending, exceptions.
- **Example classification phrases:** "we are a fit-out contractor in dubai", "mep subcontractor for commercial buildings", "civil works contractor doing site packages", "شركة مقاولات صغيرة في جدة", "مقاول تشطيبات وديكور داخلي".
- **Known limitations (verbatim):**
  - No BIM or CAD tools — drawings and models live outside the platform
  - No payroll — labour cost is captured through site reports and expenses only
  - No quantity surveying or BOQ engine
  - No tender or bid management
  - Progress is stage-weight based, not earned-value

---

## 5. Food & Beverage — `food_beverage_v1`

- **Names:** Food & Beverage — الأغذية والمشروبات
- **Target businesses:** restaurants & cafés, bakeries & sweet shops, catering companies, central & cloud kitchens, small food production workshops. The core JOB is an operational order/run: a catering order, an internal production batch, or a full event service.
- **Terminology:** Job = **Order / طلبية**; stage = Order Stage; daily report = **Daily Ops Report**; material request = **Kitchen Requisition / طلب مستلزمات المطبخ**; employee = Staff Member.
- **Roles:** **Operations Manager** (manager — **costs ON**, prices OFF; sees food cost, not customer pricing) and Shift Supervisor (foreman).

| Stage | Weight | Phase semantic |
|---|---|---|
| Order Confirmed & Prep Plan | 10 | preparation |
| Ingredient Prep | 15 | preparation |
| Cooking & Production | 35 | production |
| Packing & Plating | 15 | finishing |
| Quality Check | 10 | verification |
| Delivery & Service | 15 | handover |

- **Job statuses:** spine with active = **In Preparation**, done = **Fulfilled**, extra active **Out for Delivery / قيد التوصيل**.
- **Presets:** CAT Catering Order (50/50 acceptance/delivery_service), PROD Production Batch (internal — skips delivery_service; 100% on acceptance), EVNT Event Service (40/60 acceptance/delivery_service).
- **Reference pattern:** `{preset_code}-{year}-{seq:3}` → `CAT-2026-001`.
- **Categories:** 11 item categories (produce, dry goods, dairy, meat & poultry, seafood, beverages, bakery supplies, packaging, cleaning supplies, kitchen equipment, other); expense = spine + wastage & spoilage (job_other), packaging & disposables (job_materials), equipment rental (job_other), licences & municipality fees (overhead); 6 quote sections (menu & catering package, beverages & desserts, staffing & service, equipment rental, delivery & setup, other).
- **Custom fields on job:** branch_location (text), guest_count (number).
- **Enabled modules:** cap.jobs, cap.daily_reports, cap.people, cap.issues, cap.procurement, cap.expenses_costing, cap.customers. **Optional:** cap.approvals, cap.quoting, cap.invoicing, cap.customer_updates.
- **Dashboard defaults:** jobs_active, reports_today, exceptions, week_plan.
- **Example classification phrases:** "we run a catering company in dubai", "cloud kitchen taking catering orders", "small bakery in sharjah making cakes and pastries", "شركة تموين حفلات وأعراس", "مطبخ مركزي يجهز وجبات للشركات".
- **Known limitations (verbatim):**
  - Not a POS or till system — in-store sales are not processed here
  - No online-ordering or delivery-app integrations
  - No recipe or nutrition engineering
  - Stock is tracked at category level, without batch or expiry traceability

---

## 6. Online Store & E-commerce — `online_store_v1`

- **Names:** Online Store & E-commerce — المتجر الإلكتروني والتجارة الإلكترونية
- **Target businesses:** electronics & gadget stores, mobile phone & accessories shops, online sellers taking Instagram/WhatsApp orders, home electronics retailers, computer & IT equipment sellers, small wholesale & distribution.
- **Terminology:** Job = **Order / طلب**; stage = **Fulfilment Stage**; material request = **Stock Request**; quote = Quotation.
- **Roles:** **Store Manager** (manager — **costs ON, prices ON**; runs pricing and margins day to day — the only template where the manager sees prices) and Fulfilment Supervisor (foreman).

| Stage | Weight | Phase semantic |
|---|---|---|
| Order Confirmed | 10 | preparation |
| Sourcing & Allocation | 25 | production |
| Picking & Packing | 30 | production |
| Dispatch | 15 | finishing |
| Delivered | 10 | verification |
| Order Closed | 10 | handover |

- **Job statuses:** spine with active = **Processing / قيد التجهيز**, done = **Fulfilled / تم التسليم**.
- **Presets (paid up-front is the norm — 100% on acceptance):** ORD Standard Order, BULK Bulk/Wholesale Order, RMA Return/Exchange (skips sourcing_allocation, picking_packing, dispatch by default; money moves via credit paths — the billing point only satisfies the operational contract).
- **Reference pattern:** `{preset_code}-{year}-{seq:4}` → `ORD-2026-0001`.
- **Categories:** 9 item categories (mobile phones, tablets & computers, accessories, audio, wearables, home electronics, spare parts, packaging, other); expense = spine + packaging supplies (job_materials), shipping & delivery (job_other), marketing & advertising, bank & card fees (overhead); 5 quote sections (products, delivery, installation & setup, extended warranty, other).
- **Custom fields on order:** sales_channel (select: website/whatsapp/instagram/phone/walk_in), delivery_address (text), tracking_number (text — manual entry, no courier integration).
- **Enabled modules:** cap.jobs, cap.daily_reports, cap.people, cap.customers, cap.procurement, cap.expenses_costing, cap.invoicing, cap.customer_updates. **Optional:** cap.quoting, cap.approvals, cap.issues.
- **Dashboard defaults:** jobs_active, reports_today, ar_outstanding, exceptions.
- **Example classification phrases:** "we sell mobile phones and accessories online", "we take orders on instagram and deliver in dubai", "small e-commerce business selling gadgets", "متجر إلكتروني لبيع الجوالات والإكسسوارات", "محل هواتف يستقبل طلبات عبر واتساب".
- **Known limitations (verbatim):**
  - Not a storefront or website builder — it manages orders behind the scenes
  - No Shopify or marketplace integration — orders are entered in the app
  - No courier or last-mile integration — dispatch and tracking are recorded manually
  - No online payment gateway — payments are recorded manually
  - Stock is tracked by operational categories, not barcode or variant-level warehouse management

---

## 7. Farms & Agriculture — `agriculture_v1`

- **Names:** Farms & Agriculture — المزارع والزراعة
- **Target businesses:** crop farms (vegetables, fodder, dates), livestock farms (sheep, goats, camels, poultry), mixed farms, greenhouse and nursery operations, dairy and poultry production units. The JOB is a **Season Program**: stages are generic seasonal activities covering both cropping and livestock cycles; presets specialise via skipped stages.
- **Terminology:** Job = **Season Program / برنامج موسمي**; stage = **Season Activity**; daily report = **Field Log / سجل ميداني**; material request = **Input Request**; issue = **Incident / حادثة**; employee = **Farm Worker**.
- **Roles:** **Farm Owner** (owner label override), **Farm Manager** (manager — **costs ON**, prices OFF) and Field Supervisor (foreman).

| Stage | Weight | Phase semantic |
|---|---|---|
| Land & Housing Prep | 12 | preparation |
| Planting / Stocking | 18 | production |
| Growing & Care | 34 | production |
| Harvest / Collection | 20 | production |
| Post-Harvest & Storage | 10 | finishing |
| Season Close | 6 | handover |

- **Job statuses:** spine with active = **In Season**, done = **Season Complete**.
- **Presets (billing 100% on acceptance — seasons are internal programs, a selling price is optional):** CROP Crop Season (full arc), LVSK Livestock Cycle (skips post_harvest_storage), FMNT Field Maintenance (skips planting_stocking, harvest_collection, post_harvest_storage — a maintenance job outside the planting→harvest arc).
- **Reference pattern:** `{preset_code}-{year}-{seq:3}` → `CROP-2026-001`.
- **Categories:** 10 item categories (seeds & seedlings, fertilisers, pesticides & sprays, animal feed, veterinary supplies, fuel & lubricants, irrigation parts, tools & spares, packaging & crates, other); expense = spine + seeds & fertiliser, animal feed, veterinary supplies (job_materials), irrigation & water, equipment hire (job_other); 5 quote sections (produce, livestock, services, delivery, other).
- **Custom fields on job:** location_plot (text), area_or_headcount (number).
- **Enabled modules:** cap.jobs, cap.daily_reports, cap.people, cap.issues, cap.approvals, cap.procurement, cap.expenses_costing. **Optional:** cap.quoting, cap.invoicing, cap.customers, cap.customer_updates.
- **Dashboard defaults:** jobs_active, reports_today, approvals_pending, exceptions.
- **Example classification phrases:** "we run a vegetable farm in al ain", "livestock farm with sheep and goats in riyadh", "poultry farm producing eggs", "مزرعة نخيل وتمور في الأحساء", "بيوت محمية لإنتاج الخضار".
- **Known limitations (verbatim):**
  - No veterinary or animal health-management records — veterinary items are tracked as supplies only
  - No regulatory or traceability compliance (GlobalG.A.P., organic certification)
  - No scientific agronomy: soil analysis, weather data or yield analytics
  - No weighbridge, sensor or farm-equipment integrations

---

## 8. Generic Operations — `generic_operations_v1` (the fallback)

- **Names:** Generic Operations — العمليات العامة
- **Target businesses:** general trading and services companies, project-based teams without a specialised template, maintenance and facilities providers, consultancies, small operations and back-office teams. Installed when no industry template matches the founder's description (see AI_TEMPLATE_SELECTION_RULES.md).
- **Terminology:** intentionally plain — only the core object changes: Job = **Project / مشروع**. Everything else keeps platform defaults.
- **Roles:** the standard 7-role spine with neutral labels as shipped (manager — costs OFF, prices OFF).

| Stage | Weight | Phase semantic |
|---|---|---|
| Planning | 15 | preparation |
| Execution | 45 | production |
| Finalization | 15 | finishing |
| Review | 15 | verification |
| Handover | 10 | handover |

- **Job statuses:** the standard spine, no renames (Draft → In Progress → On Hold → Completed → Closed / Cancelled).
- **Presets:** PRJ Standard Project (50/50 acceptance/handover), JOB Small Job (100% on acceptance), INT Internal Work (100% on acceptance, typically no selling price).
- **Reference pattern:** `{preset_code}-{year}-{seq:3}` → `PRJ-2026-001`.
- **Categories:** 8 neutral item categories; expense = the shared spine only (no domain extras); 5 quote sections (services, materials, equipment, delivery, other).
- **Custom fields on job:** reference_code (text).
- **Enabled modules:** cap.jobs, cap.daily_reports, cap.people, cap.issues, cap.approvals, cap.expenses_costing, cap.customers. **Optional:** cap.procurement, cap.quoting, cap.invoicing, cap.customer_updates.
- **Dashboard defaults:** jobs_active, reports_today, approvals_pending, exceptions.
- **Example classification phrases:** "we run a general services company in dubai", "nothing here matches our business exactly", "ننفذ مشاريع متنوعة لعملائنا", "نحتاج نظاماً بسيطاً لمتابعة المشاريع والمصروفات".
- **Known limitations (verbatim):**
  - Generic structure — no industry-specific workflows or stage names
  - Pick a specialised template instead when one fits your industry
  - Terminology is intentionally plain: projects, stages, tasks
  - Not a point-of-sale, payroll or full accounting system
