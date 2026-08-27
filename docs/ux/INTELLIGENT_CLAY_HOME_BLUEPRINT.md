# Intelligent Clay Home Blueprint

**Micro-step 006A. Research, inspection and design-definition only. No code, dependency, database, migration, commit, push or deploy in this step.**

This document defines the Intelligent Clay product principle, audits the current public homepage against what the product actually does, and specifies an international-first public home and the interaction contract that governs it. It is the single deliverable of this step. Every capability claim here is checked against current code and routes, not documentation.

Baseline: branch `main`, HEAD `d124c85`, clean working tree. Verified surfaces are cited by path (and line where useful). Writing rules for proposed product copy are followed throughout: no em dash character, no marketing filler, short and specific language, no imitation of other products, and no claim the product cannot currently support.

A note on the em dash: this document avoids the em dash character everywhere, not only in the copy sections, so the copy check in Section 6 is trivially safe and the whole file reads consistently.

---

## 1. Executive product definition

IdaraWorks is an **international-first business operating system**. It gives a business one connected place to win work, run it, get paid and understand what happened. It is structured enough to be useful on day one and flexible enough to be shaped around how a specific business actually operates.

The UAE and the GCC are the **initial launch market** and an important source of requirements. They are not the product boundary. English, Arabic and Spanish are the planned first-class product languages. Arabic has complete right-to-left support. English and Spanish are left-to-right. Regional business rules (currency, tax, fiscal period, identifiers, address and phone formats) are configuration, not hard-coded assumptions.

### Intelligent Clay

**Intelligent Clay** is the primary IdaraWorks product principle. It means the product holds a useful shape immediately, and can be reshaped around a business without breaking, surprising the user, or inventing facts. Ten properties define it and govern future product decisions:

1. **Malleable.** Navigation, terminology, views, dashboards, fields, workflows and document presentation can be shaped by the business.
2. **Intelligent.** The product can recommend changes using real, permission-safe operational evidence, never guesses about the business.
3. **Stable.** Nothing moves or changes unexpectedly. Shaping is deliberate, not ambient.
4. **Explainable.** Every recommendation states what it proposes, why, and which data supports it.
5. **Consent-based.** Users preview and approve material configuration changes before they take effect.
6. **Reversible.** Approved changes have history and undo behaviour.
7. **Progressive.** Simple businesses begin with a calm workspace. Complexity appears only when it is needed.
8. **Immediate.** A missing related record can be created inside the current task.
9. **Truthful.** The interface never invents activity, results, goals or business facts.
10. **Governed.** Permissions, entitlements, RLS, auditability and data redaction stay authoritative at all times.

Two of these are constitutional and already enforced in code: **Truthful** (the homepage and dashboards are tested to invent no numbers or claims) and **Governed** (permission checks, pooled `org_id` with RLS, and cost/price redaction are pervasive). The others describe a direction that is **partly operational today** and must be represented honestly. Section 2 draws that line precisely, and Section 9 defines the contract that keeps the malleable and intelligent properties safe as they grow.

**Hard boundary on AI (binding).** AI may, when a provider is configured, help a person configure approved capabilities through validated configuration only. AI never generates or executes application code, SQL, DDL, RLS or migrations. AI never authors configuration on its own: a person previews, edits and approves. Today no AI authors any configuration; the current setup path is deterministic.

---

## 2. Current-state truth audit

Verified against `src/app/_home/HomePage.tsx`, the `home.*` message catalog (`src/platform/i18n/messages/{en,ar}.json`), `src/platform/entitlements/catalogue.ts`, `src/platform/ui/nav/build.ts`, `src/platform/config/*`, `src/modules/onboarding/*`, `src/platform/ai/*`, `src/modules/today/*`, and the route tree under `src/app/(app)/o/[orgId]/`.

### 2a. What the homepage currently claims

The live homepage has eight sections: header, hero, "one connected flow" (six steps), "built around your business" (with an explicit now/planned split), "capabilities by outcome" (four groups), "Made for the GCC" (four cards), pricing (three tiers, no numbers), a final call to action, and a footer. Notable strings:

- Hero: "Run your business like it's built to scale" and "From quote to cash, IdaraWorks brings your work, team and money together in one clear operating system."
- Built section: "You configure your own operation, and IdaraWorks adapts to it" and "**AI can help you configure it faster by turning plain answers into a working setup.**"
- Built guardrail: "AI helps with configuration only. It never writes or changes application code, database structure or security rules."
- Region section eyebrow "**Made for the GCC**" and body "Built to feel native for GCC businesses."
- Meta description: "**Built for GCC small and medium businesses**, in Arabic and English."
- Pricing: "Launch pricing is being finalized," no numeric price.

The page already carries strong honesty scaffolding worth keeping: an "Available now" versus "Planned" split, an "Illustrative" badge on the hero visual, tests that forbid unsupported claims (`tests/unit/home-page.test.ts`), and a footer that links real Terms and Privacy pages backed by honest legal content.

### 2b. What the product currently supports (genuinely operational, route + module + UI)

Every item below has a real route under `src/app/(app)/o/[orgId]/`, a backing module, and working UI.

- **Win and bill:** customers, quotations (with quote to work conversion), invoices, customer payments, accounts-receivable aging.
- **Run the work:** jobs with stages and tasks, daily field reports (work, materials, labour), issues, approvals, week plan.
- **Supply and cost:** material requests, purchase orders, goods receipts, expenses, job costing and quote-versus-actual, attendance.
- **People and identity:** employees, members and invites, org branding and full document identity (legal name, tax registration field, licence, bilingual address, signatory, document language) with a live letterhead preview.
- **Configuration that is real today:** in-app **terminology editing** (rename the business nouns per language, with plural and Arabic gender), **configuration revision history with per-revision undo**, **template install** applied as a sequence of diffable, undoable revisions, and **full subscription and entitlement management** in a governed test mode where selections apply but no money moves.
- **Bilingual and RTL:** every screen renders in English and Arabic with complete right-to-left mirroring, enforced by tests.
- **Governance:** permission checks, pooled `org_id` with RLS, cost and price redaction, and an append-only audit trail.

### 2c. What is partially operational (real logic, missing or narrow UI)

- **Preview-before-apply for configuration.** The pipeline can validate and preview a change (`src/platform/config/pipeline.ts`), but no screen shows a pre-apply diff. Terminology edits apply directly; the diff is only visible afterward in the revision list. The honest present tense is "changes are reversible with history," not "preview then approve."
- **Guided setup proposal.** Onboarding classifies a business from a short description and proposes a starting configuration with alternatives the founder can choose. This is real and useful. It is **deterministic keyword classification**, not AI (`src/modules/onboarding/classify.ts`, `provider.ts` states "No real LLM provider is wired yet").
- **Custom fields.** Field values are captured on records, but there is no in-app editor to define new fields; definitions come from templates.
- **Roles.** The seven role archetypes are fixed. Role labels and money-visibility can be edited by the pipeline, but there is no UI for it, and new roles are rejected. "Permissions that match your trade" overstates this today.
- **Inline creation.** A customer can be created inside the New Quote flow. This is the only inline-create path; there is no general framework yet.
- **AI narration and drafts.** Digest narration and document drafts exist as seams. In production the AI provider is disabled, and drafts are deterministic text built from the record's own facts.

### 2d. What is planned (direction, not shipped)

Movable and resizable dashboard zones; saved and shared filtered views; navigation rename and reorder by the business; a general inline-create framework; a richer setup studio; editable custom fields and roles; and AI-assisted configuration proposals. All of these are consistent with the Intelligent Clay direction, and none may be described as available today.

### 2e. Unsupported or misleading claims to remove or reword

1. **"AI can help you configure it faster by turning plain answers into a working setup" (`home.built.p3`).** The mechanism is deterministic classification, and no LLM is wired. This attributes a shipped capability to AI that AI does not perform. Reword to describe guided setup without claiming AI, and describe AI assistance as planned. This is the most important truthfulness conflict on the page.
2. **"Made for the GCC" region section and "Built for GCC small and medium businesses" meta (`home.gcc.*`, `home.meta.description`).** Correct, but market-limiting. Reframe as international-first with the UAE and GCC as the launch market. This is required by the international-first correction, not a defect.
3. **"the stages, terminology and permissions that match your trade" (`home.built.p1`).** Stages and terminology are configurable; roles are fixed. Soften "permissions" to what is true (roles exist and gate access) or move role customization to planned.
4. **The built-section guardrail** reads as if AI configuration is active. Keep the principle, but phrase it so it does not imply an AI configuration feature ships today.

Everything else on the page (capabilities by outcome, the six-step flow, pricing honesty, the illustrative badge) is truthful and should be retained.

---

## 3. Audience and inclusion model

The home must answer, quickly and without jargon, "is this for a business like mine, and can I trust it." Behaviour is defined for each audience, and the union of these requirements is the design floor.

| Audience | What they need from the home | Design behaviour |
|---|---|---|
| First-time business owner | Plain proof this fits a small operation and will not overwhelm them | Lead with outcomes (win, run, get paid), not a feature wall. One primary action. Calm language. |
| Experienced operator | Fast confirmation of real capabilities and control | A scannable capability section grouped by outcome, with an honest now/planned line. |
| Low-confidence software user | Reassurance, low reading burden, no fear of commitment | Short sentences, concrete nouns, "start free, no charge while you set up," visible undo language. |
| High-confidence power user | Evidence the product can be shaped without breaking | A truthful Intelligent Clay section that shows shaping is deliberate, reversible and governed. |
| Small team | That one person can run it and add others later | Progressive framing: begin small, add people and capability when needed. |
| Growing organization | Headroom without a rebuild | Capability and pricing that scale by outcome, described as tiers of outcomes, not seats alone. |
| English user | Natural English, LTR | Default locale, natural product English. |
| Arabic and RTL user | Natural product Arabic, complete mirroring | Full RTL, Arabic that reads as written for the product, not translated word for word. Numerals stay Latin, matching the product. |
| Spanish user (planned) | Natural product Spanish, LTR | Planned first-class locale. All Spanish copy is draft pending professional native review. |
| Keyboard user | Reach and operate every control without a pointer | Logical focus order, visible focus ring, skip to content, no keyboard traps. |
| Screen-reader user | Meaning without relying on icons or color | Text label beside every icon meaning, one accessible name per visual, decorative graphics hidden from assistive tech, announced landmarks. |
| Larger-text user | No loss of content when text scales | Reflow to 320 CSS px and 200 percent zoom without horizontal scroll or clipping. |
| Reduced-motion user | No vestibular triggers | Every motion gated by `prefers-reduced-motion`, with a legible static state. |
| Low-vision or low-contrast environment | Readable text and controls | Meet contrast minimums for text and for non-text controls. |

Inclusion is not a separate section of the page. It is a property of every section. Three rules apply page-wide: meaning is never carried by icon or color alone, motion is never required to understand a section, and the page reads and operates fully with no client JavaScript beyond the mobile menu.

---

## 4. Public journey architecture

The journey is a sequence of questions. Each public surface exists to answer exactly one, and any surface that answers none is removed.

| Stage | The user's question | Surface | Primary action |
|---|---|---|---|
| First visit | "What is this, and is it for me" | Hero | Get Started |
| Understand | "How would it actually work for my business" | Connected flow (six steps) | See how it works (scroll) |
| See it shaped to me | "Will it fit how I work, or force a template on me" | Intelligent Clay section | Get Started |
| Review capability | "What can it really do today" | Capabilities by outcome, with now and planned | Get Started |
| Regional fit | "Will it work in my language, currency and paperwork" | International and regional section | Get Started |
| Pricing | "What will it cost, and is there risk to trying" | Pricing (outcomes, no charge during setup) | Get Started |
| Trust | "Is my data safe and private" | Trust and privacy strip plus legal links | Read privacy and terms |
| Get Started | "How do I begin" | Signup entry (email or Google) | Create account |
| Verify | "Did my account get created" | Check-inbox and confirm route | Continue |
| Onboarding entry | "Set me up without a long form" | Guided setup entry | Answer a few questions |

Two journey notes from current code. First, email authentication is real and admin-safe, but production email verification depends on owner-side hosted Supabase settings that are not yet applied; the home must not promise instant email delivery beyond what is configured. Second, Google authentication is feature-gated off in production; the home and signup must show it only when it is genuinely available. Both are governed by existing flags and should stay that way.

A trust and privacy surface is added to the journey because current research on software adoption shows trust is a precondition for a first account, and the current home has no dedicated trust answer. It states, in plain language, what is true today: data is isolated per business, access is permission-based, cost and price figures are hidden from roles that should not see them, and configuration changes are logged and reversible. It links to the real Privacy and Terms pages. It makes no certification claim, because none can be substantiated.

---

## 5. Homepage information architecture

Recommended section order, desktop and mobile. Mobile is a single column in the same order; the hero visual moves below the hero copy, connectors in diagrams stack, and the desktop navigation collapses into the existing accessible mobile disclosure. RTL mirrors the whole page from the root `dir` attribute; only inherently directional glyphs (the forward chevron, the flow arrow) are mirrored, and Latin numerals and currency codes stay LTR inside an RTL line.

For each section: the user question, content, primary and secondary action, the product truth it uses, the visual concept, mobile and RTL behaviour, accessibility requirements, and what must never appear.

### Section order

1. Header
2. Hero
3. Connected flow (how it works)
4. Intelligent Clay (shaped to your business)
5. Capabilities by outcome (now and planned)
6. International and regional fit
7. Trust and privacy
8. Pricing
9. Final call to action
10. Footer

### Per-section specification

**1. Header.** Question: "where am I and how do I start or sign in." Content: wordmark, in-page section links, language switch, Log in, Get Started. Primary: Get Started. Secondary: Log in. Truth: an authenticated visitor sees Open workspace instead of Get Started (already implemented). Visual: flat, sticky, one accent square with the grid mark plus the text IdaraWorks. Mobile: accessible disclosure menu (already built). RTL: mirrors; the switch shows the other language's name. Accessibility: single `banner` landmark, `aria-expanded` and `aria-controls` on the menu button, focus returns to the trigger on close. Never: a second competing primary action, or a language switch that reloads and loses scroll position.

**2. Hero.** Question: "what is this and is it for me." Content: eyebrow, one-line promise, one supporting sentence, primary and secondary action, a short reassurance line, and the hero visual. Primary: Get Started. Secondary: See how it works. Truth: the promise is outcome-level, not a feature claim; the visual is badged Illustrative. Visual: the Intelligent Clay hero (Section 8). Mobile: copy first, visual below, visual simplified. RTL: mirrored composition. Accessibility: one `h1`, the visual is a single labelled image with decorative internals hidden, the reassurance line is real text. Never: a fabricated metric, a dashboard screenshot presented as this user's data, or a hero that needs motion to be understood.

**3. Connected flow.** Question: "how would it work for my business." Content: six steps (win, plan, run, control cost, get paid, understand) and one line that the same information carries forward. Primary: Get Started (end of section). Secondary: none. Truth: each step maps to a shipped module. Visual: a numbered, evenly weighted set of steps with an icon and a short line each; a light diagram may show information moving one direction along the steps. Mobile: steps stack; any connector becomes vertical. RTL: order and arrows mirror. Accessibility: an ordered list, numerals decorative and hidden, icons paired with text. Never: more than one connected metaphor competing for attention, or a claim that a step is automated when it is manual.

**4. Intelligent Clay.** Question: "will it fit how I work, or force a template on me." Content: the principle in plain words, three short proofs, and an honest now versus planned split. Primary: Get Started. Secondary: none. Truth: available now is guided setup, terminology you can rename, and changes you can undo. Planned is a richer setup studio and movable dashboards. Visual: a small before and after that shows the same real objects (customer, work, team, approval, document, cash) rearranged into a fuller workspace, with one term renamed. This is the one place the "shaping" idea is shown, and it must show real product concepts, not abstract shapes. Mobile: before and after stack. RTL: mirrored. Accessibility: the before and after is one labelled image with a text caption that states the point; a reduced-motion viewer sees the after state statically. Never: a claim that AI configures the product today, a claim that dashboards are movable today, or a decorative clay blob.

**5. Capabilities by outcome.** Question: "what can it really do today." Content: four outcome groups (win and bill, run the work, supply and cost, see and share), each with three concrete capability chips, plus one honest line separating shipped from planned. Primary: Get Started. Secondary: none. Truth: every chip names a shipped module. Visual: four calm cards, icon plus title plus chips. Mobile: cards stack. RTL: mirrors. Accessibility: each card is a labelled group, chips are text, icons decorative. Never: a capability the product does not ship, a competitor's feature name, or a count of features presented as a benefit.

**6. International and regional fit.** Question: "will it work in my language, currency and paperwork." Content: bilingual and RTL today, Spanish planned, configurable currency and tax, your legal identity on documents, and configurable regional formats. Primary: Get Started. Secondary: none. Truth: English and Arabic ship with full RTL; Spanish is planned; base currency and document identity are configurable today; multi-currency exists at the document level (each quote and invoice carries a currency and rate). Visual: four cards, each naming a concrete regional capability. Mobile: cards stack. RTL: mirrors; this section reads as native, not as translated marketing. Accessibility: as Section 5. Never: "Made for the GCC" as the frame, a claim that any specific tax regime is preconfigured beyond what the product supports, or a fabricated compliance badge.

**7. Trust and privacy.** Question: "is my data safe." Content: per-business isolation, permission-based access, cost and price redaction by role, and logged reversible configuration. Primary: Read privacy. Secondary: Read terms. Truth: all four are enforced in code. Visual: a compact strip, not a section that competes with capabilities. Mobile: stacks. RTL: mirrors. Accessibility: plain text, links are real routes. Never: a certification claim (ISO, SOC 2, GDPR compliant) that cannot be substantiated, or a security theatre graphic.

**8. Pricing.** Question: "what will it cost and is trying risky." Content: three tiers described by outcomes, "start free," "no charge while you set up," and "prices shown at sign-up." Primary: Get Started. Secondary: none. Truth: launch pricing is being finalized; tiers map to real entitlement bundles; no number is shown on the page by design. Visual: three cards, one marked balanced. Mobile: stack. RTL: mirrors. Accessibility: each tier a labelled group; the balanced marker is text, not color alone. Never: a numeric price the product cannot yet honour, a fake discount, or a countdown.

**9. Final call to action.** Question: "I am convinced, how do I begin." Content: one line, one supporting line, one primary and one secondary action. Truth: mirrors the hero promise. Visual: a single calm dark panel using the hero tokens, high contrast. Mobile and RTL: standard. Accessibility: real heading, buttons are links to signup and login. Never: a second unrelated ask, or a form that collects data here.

**10. Footer.** Question: "where is everything else." Content: wordmark, product and pricing anchors, Log in, Terms, Privacy, Get Started, language switch, copyright. Truth: all links are real routes. Visual: quiet. Mobile and RTL: standard. Accessibility: `contentinfo` landmark, labelled navigation. Never: dead links or fabricated social profiles.

---

## 6. Homepage copy system

Proposed English copy, natural product Arabic, and Spanish flagged for professional native review. Arabic is written as product Arabic, not literal translation, and still requires a native review pass before public use because it is customer-facing. Spanish is provided as draft candidates only and must not ship without professional native validation of terminology and natural usage.

The banned marketing words are avoided (no unlock, unleash, revolutionary, seamless, supercharge, effortlessly, game-changing, cutting-edge, one-stop, future of work). No competitor wording is used.

### Navigation

- Product. AR: المنتج. ES draft: Producto.
- How it works. AR: كيف يعمل. ES draft: Cómo funciona.
- Capabilities. AR: القدرات. ES draft: Capacidades.
- Pricing. AR: الأسعار. ES draft: Precios.
- Log in. AR: تسجيل الدخول. ES draft: Iniciar sesión.
- Get Started. AR: ابدأ الآن. ES draft: Empezar.
- Open workspace (authenticated). AR: افتح مساحة العمل. ES draft: Abrir el espacio de trabajo.

### Hero

- Eyebrow, EN: One connected place to run your business.
  AR: مكان واحد مترابط لإدارة عملك.
  ES draft: Un solo lugar conectado para gestionar tu negocio.
- Title, EN: Run your business the way it actually works.
  AR: أدِر عملك بالطريقة التي يعمل بها فعلاً.
  ES draft: Gestiona tu negocio tal como funciona de verdad.
- Subtitle, EN: From the first quote to the last payment, IdaraWorks keeps your work, your team and your money in one place, in Arabic or English.
  AR: من أول عرض سعر إلى آخر دفعة، يجمع IdaraWorks عملك وفريقك وأموالك في مكان واحد، بالعربية أو الإنجليزية.
  ES draft: Desde la primera cotización hasta el último pago, IdaraWorks mantiene tu trabajo, tu equipo y tu dinero en un solo lugar.
- Reassurance, EN: Start free. Set up in minutes. No charge while you set up.
  AR: ابدأ مجاناً. جهّز حسابك في دقائق. لا رسوم أثناء الإعداد.
  ES draft: Empieza gratis. Configúralo en minutos. Sin cargos durante la configuración.

### Calls to action

- Primary, EN: Get Started. AR: ابدأ الآن. ES draft: Empezar.
- Secondary, EN: See how it works. AR: شاهد كيف يعمل. ES draft: Ver cómo funciona.

### Capability explanation

- Section title, EN: Everything the work needs, grouped by outcome.
  AR: كل ما يحتاجه العمل، مرتّب حسب النتيجة.
  ES draft: Todo lo que el trabajo necesita, organizado por resultado.
- Win and bill, EN: Quotes, customers, invoices and payments in one connected place.
  AR: عروض الأسعار والعملاء والفواتير والدفعات في مكان واحد مترابط.
- Run the work, EN: Track delivery day by day, with issues and approvals in the flow.
  AR: تابع التنفيذ يوماً بيوم، مع الملاحظات والاعتمادات ضمن المسار.
- Supply and cost, EN: Materials, purchasing, labour and attendance feeding a real cost picture.
  AR: المواد والمشتريات والعمالة والحضور تغذّي صورة تكلفة حقيقية.
- See and share, EN: Clear reports and branded documents that make the business legible.
  AR: تقارير واضحة ومستندات بهويتك تجعل العمل مفهوماً.
- Honest line, EN: These are working today. Movable dashboards and saved views are on the way.
  AR: هذه متاحة اليوم. لوحات قابلة للترتيب وطرق عرض محفوظة قادمة قريباً.

### Intelligent Clay explanation

- Title, EN: Shaped to how you work, without breaking.
  AR: مُشكّل على طريقة عملك، دون أن ينكسر.
- Body, EN: You set up your own operation, and the words and the workflow follow it across the whole workspace. Changes are yours to make, and yours to undo.
  AR: تُعدّ عمليتك بنفسك، فتتبعها الكلمات وسير العمل في المساحة كلها. التغييرات بيدك، ويمكنك التراجع عنها.
- Proof 1, EN: Rename the words to match your trade, in Arabic and English.
  AR: أعد تسمية الكلمات لتطابق مجالك، بالعربية والإنجليزية.
- Proof 2, EN: Start from a guided setup built from a few plain answers.
  AR: ابدأ من إعداد موجَّه مبني على بضع إجابات بسيطة.
- Proof 3, EN: Every configuration change is logged, and you can undo it.
  AR: كل تغيير في الإعداد مُسجّل، ويمكنك التراجع عنه.
- Now label, EN: Available now. AR: متاح الآن.
- Now body, EN: Guided setup, editable terminology, and reversible configuration with history.
  AR: إعداد موجَّه، ومصطلحات قابلة للتعديل، وإعدادات قابلة للتراجع مع سجل.
- Planned label, EN: Planned. AR: قادم.
- Planned body, EN: A richer setup studio, movable dashboards, and configuration proposals you preview and approve.
  AR: استوديو إعداد أغنى، ولوحات قابلة للترتيب، ومقترحات إعداد تعاينها وتوافق عليها.
- Guardrail, EN: When configuration help is added, it will only propose changes for you to preview and approve. It will never write or change application code, database structure or security rules.
  AR: عند إضافة مساعدة الإعداد، ستقترح تغييرات لتعاينها وتوافق عليها فقط. ولن تكتب أو تغيّر شيفرة التطبيق أو بنية قاعدة البيانات أو قواعد الأمان.

The guardrail is deliberately future-tense, because AI-assisted configuration is planned, not shipped. The word AI is removed from the shipped claim to keep the page truthful.

### Trust section

- Title, EN: Your business, kept separate and safe.
  AR: عملك، محفوظ ومنفصل وآمن.
- Points, EN: Each business is isolated. Access follows permissions. Money figures are hidden from roles that should not see them. Configuration changes are logged and reversible.
  AR: كل عمل معزول عن غيره. الوصول يتبع الصلاحيات. أرقام المال مخفية عن الأدوار التي لا ينبغي أن تراها. تغييرات الإعداد مُسجّلة وقابلة للتراجع.

### Pricing introduction

- Title, EN: Start free, grow when you are ready.
  AR: ابدأ مجاناً، وتوسّع عندما تكون مستعداً.
- Body, EN: Pick the set of outcomes that fits today. You can change tier at any time. Prices are shown at sign-up, and no charge is taken while you set up.
  AR: اختر مجموعة النتائج التي تناسبك اليوم. يمكنك تغيير الباقة في أي وقت. تظهر الأسعار عند التسجيل، ولا تُؤخذ أي رسوم أثناء الإعداد.

### International and regional section

- Title, EN: At home in your language and your market.
  AR: في بيئتك، بلغتك وسوقك.
- Body, EN: English and Arabic today, with complete right-to-left support. Spanish is on the way. Your currency, your tax details and your legal identity are configuration, carried onto the documents you send.
  AR: العربية والإنجليزية اليوم، مع دعم كامل للكتابة من اليمين إلى اليسار. الإسبانية قادمة. عملتك وتفاصيل الضريبة وهويتك القانونية إعدادات، تُحمل إلى المستندات التي ترسلها.

### Final call to action

- Title, EN: Build your business workspace.
  AR: ابنِ مساحة عمل شركتك.
- Body, EN: Set up your operation in minutes and see your work, team and money come together.
  AR: جهّز عمليتك في دقائق وشاهد عملك وفريقك وأموالك تجتمع.

### Footer

- Nav labels reuse the navigation strings above. Rights line, EN: © {year} IdaraWorks. AR: © {year} IdaraWorks.

### Em dash check (required)

Search target: the em dash character across all proposed copy in this section. Result: the proposed English, Arabic and Spanish copy above contains zero em dash characters. Only hyphens, commas, colons and full stops are used. A grep for the em dash over this file is included in the validation step and returns no matches inside the copy.

### Translation status (required flags)

- English: ready for review.
- Arabic: natural product Arabic drafts, still require a native review pass before public use because they are customer-facing.
- Spanish: draft candidates only. Do not ship without professional native validation of terminology and natural usage. Treat every Spanish string above as unverified.

---

## 7. State-of-the-art visual direction

### The visual idea

The recognizable idea is **a workspace that takes shape**. IdaraWorks is shown as real operating objects (customer, quote, work, team, approval, document, cash) arranged as a connected board that can be reshaped from a simple flow into a fuller workspace, without losing orientation. This is the literal meaning of Intelligent Clay expressed through structure and product concepts, not through abstract clay. There are no decorative blobs, gradients for their own sake, robot heads, floating glass cards or meaningless 3D. Depth, motion and 3D are used only where they show structure, change, hierarchy or causality.

### Typography

Keep Geist Sans for text and Geist Mono for reference numbers and codes (already wired). Define a small explicit type scale as tokens so the marketing surfaces stop using arbitrary values: display, h1, h2, h3, body-large, body, small, caption. Line length capped near 66 characters for body text. Arabic uses the same weights; test that Arabic ascenders and diacritics are not clipped by tight line heights.

### Color roles

Reuse the existing semantic tokens. Brand teal is the single brand accent. Surfaces are paper, card and sunken. Text is primary, secondary and muted. Status colors (danger, warning, success, info) each carry a soft tint. The tenant accent token drives indicator bars and soft tints only and never carries text, which keeps any business color WCAG-safe. Do not introduce new raw hex on the marketing pages; extend by token if a new role is genuinely needed.

### Contrast rules

Body and interface text meet WCAG 2.2 contrast minimum, 4.5:1 for normal text and 3:1 for large text. Non-text controls and meaningful graphical boundaries meet 3:1. The dark final-call panel is checked for white text contrast. Add an automated contrast check to the test suite, since none exists today.

### Surface and elevation rules

Two elevation levels only, in one direction (light from above), using the existing elevation tokens. Cards are raised one step; the hero work object may be raised one further step to signal focus. Elevation communicates hierarchy, not decoration.

### Illustration language

Illustration is diagrammatic and product-native. It is built from the same node and connector vocabulary as the product visual: labelled surface cards, dashed connectors, one forward arrow, one status chip. No characters, no mascots, no stock scenes. If a concept cannot be drawn from real product objects, it is written as text instead.

### Product-diagram language

Diagrams show a real mechanism: information entered once moving forward through stages, or a simple flow being reshaped into a workspace. A diagram always has a text caption that states its point, so it is never the only carrier of meaning. Diagrams are inline SVG on tokens.

### Icon rules

Keep the 36-icon inline set (stroke, currentColor, `aria-hidden` by default). An icon never carries meaning alone; it always sits beside a text label. Directional icons mirror under RTL.

### Motion rules

Motion communicates flow, change or attention, never ambience. Keep the existing discipline: every animation is defined only inside the `prefers-reduced-motion: no-preference` block. Durations stay short. One motion per section at most. The homepage flow may show a single travelling pulse along a connector; the shaping diagram may show one reshape transition on scroll into view, once.

### Reduced-motion alternative

Every animated element has a fully legible static state. The travelling pulse becomes a static dot on the connector. The reshape transition shows the after state directly. Nothing essential is conveyed only by motion.

### Photography policy

No photography is recommended for launch. The product is abstract operational software; product-native diagrams communicate it more honestly than stock imagery, and there is no library of real, rights-cleared, representative photos. If photography is added later, it must show real usage in the target markets, be rights-cleared, include people of the region without stereotype, and never be decorative filler.

### Responsive behaviour

Desktop uses the two-column hero and multi-column card grids at the existing `sm`, `md` and `lg` breakpoints inside a `max-w-6xl` container. Tablet collapses multi-column grids to two columns and keeps the hero two-column at `lg`. Mobile is a single column, the hero visual moves below the copy and simplifies, and connectors become vertical. Content reflows to 320 CSS px with no horizontal scroll.

### RTL mirroring rules

The page mirrors from the root `dir` attribute because the design system uses logical properties. Only inherently directional glyphs mirror (forward chevron, flow arrow). Latin numerals, currency codes and product identifiers stay LTR inside an RTL line using an inline direction override. Test every marketing surface in both directions, as the existing RTL tests already do for primitives.

### Dark mode

The token structure is dark-ready but no dark theme is authored, and no `prefers-color-scheme` handling exists. Dark mode is out of scope for the home blueprint and is listed as a separate future step. If added, it is a token swap plus a per-surface audit, not a redesign.

---

## 8. Hero visual specification

One meaningful hero visual that demonstrates Intelligent Clay by showing a business operation being shaped from a simple flow into a useful workspace, using real concepts: customer, work, team, approval, document and cash. It builds on the existing "Living Operations System" visual (`src/app/_home/ProductVisual.tsx`), which already renders a win, work and money spine as inline SVG and CSS on tokens.

- **Composition.** A central work object (a job) sits raised at the focus. To one side, the work it came from (a customer and an accepted quote). To the other, what it becomes (an invoice and a received payment). Feeding the work: a small team chip and an approval chip. The whole is one connected board, badged Illustrative.
- **States.** State A, a simple three-node flow (customer, work, cash). State B, the same flow shaped into a fuller workspace: the team and approval chips appear, one term is shown renamed (for example "Job" to the business's own word), and a small status tracker appears on the work object. The point is that the same real objects were shaped, nothing was invented.
- **Motion sequence.** On scroll into view, once: a single reshape from State A to State B over a short duration, then a slow travelling pulse along the spine to show information moving forward. No looped ambient motion beyond the single quiet pulse.
- **Interaction behaviour.** None required on the public page. The visual is not a live product; it must never look like a real, operable dashboard or present numbers as this visitor's data. Optional later enhancement: a single, clearly labelled control to replay the reshape, keyboard reachable.
- **Static fallback.** State B rendered directly, fully legible, with the connectors and one static pulse dot.
- **Reduced-motion fallback.** Identical to the static fallback. No reshape animation, no travelling pulse.
- **Mobile simplification.** Show State B only, in a single column, with vertical connectors and fewer chips. Drop the reshape animation on small screens for performance and clarity.
- **Arabic and RTL composition.** Mirror the board so the win side is on the right and the money side on the left. The forward arrow and any chevrons mirror. The illustrative amount keeps its currency code LTR. Because it is illustrative, the amount may rotate across currencies to reinforce configurable currency, clearly still illustrative.
- **Build technology.** Code-native inline SVG and CSS on tokens, as today. Not WebGL, not a raster asset, not a video. This keeps it theme-aware, RTL-aware, accessible, and cheap to load, and it avoids a heavy 3D dependency.
- **Performance budget.** No new network requests, no external image, no animation library. Total additional weight under a few kilobytes of markup and CSS. Motion runs on transform and opacity only, to stay off the main-thread layout path.
- **Accessibility treatment.** One `role="img"` with a concise `aria-label` that describes the concept ("Illustrative view of a business operation shaped from a simple flow into a connected workspace"). All internal shapes are `aria-hidden`. A short visible caption states the same point for everyone. The reshape never conveys anything that the static State B does not already show.

The final asset is not built in this step. This section is the specification a later micro-step implements.

---

## 9. Intelligent Clay interaction contract

This defines how future users shape the product, and it fixes what is automatic, what needs consent, and what AI may never do. It is written so that the malleable and intelligent properties can grow without violating the stable, governed, truthful and consent-based properties. Items marked Today exist now; items marked Planned do not and must not be described as shipped.

### Shaping actions

- **Dashboard zones (add, remove, move, resize).** Planned. Today dashboards are composed per role and are not user-movable. When built, layout is a saved, per-user preference by default, with an organization default that an admin can set. Reset to default is always one action away.
- **Rename navigation and business terminology.** Terminology rename is Today (per language, with plural and Arabic gender), applied across the whole workspace through the terminology resolver. Navigation rename and reorder are Planned. Both are configuration changes: logged and reversible.
- **Reorder and group navigation.** Planned. When built, it is an organization configuration change with preview and undo, not an ambient personalization.
- **Create records inline.** Partly Today. A customer can be created inside the New Quote flow. Planned: a general inline-create pattern so any required related record can be created inside the current task without losing the task.
- **Build filtered views.** Today, list pages filter by URL query only, not saved. Planned: named filtered views.
- **Save personal and shared views.** Planned. Personal views are a user preference; shared views are an organization configuration change with permissions, preview and undo. The distinction between personal preference and organization configuration is explicit in the UI at the moment of saving.
- **Ask IdaraWorks to propose a configuration.** Planned as an AI-assisted step. Today the equivalent is the deterministic guided setup at onboarding, which already proposes a starting configuration with visible alternatives.
- **Preview a proposal.** Planned as a screen. The server can already produce a diff; the missing piece is a pre-apply preview UI. This is a near-term, high-value step because it makes consent real.
- **Understand why it was proposed.** Today the onboarding proposal shows why a template was recommended and lists alternatives. Planned: the same explainable pattern for every future proposal, stating what, why and which data supports it.
- **Approve, edit, reject and undo.** Undo is Today for configuration (per-revision undo in the configuration history). Approve and edit-before-apply are Planned as UI, resting on the existing preview and revision infrastructure. Reject is simply not applying a proposal.
- **Recover from a poor configuration.** Today: the configuration history lists revisions and undoes any of them as a new, append-only revision. There is no destructive edit; recovery is always forward and logged.
- **Distinguish personal preferences from organization-wide configuration.** Required in every shaping surface. Personal preferences (layout, saved personal views) never change what other users see. Organization configuration (terminology, shared views, navigation, roles) is permission-gated, previewed, logged and reversible, and is clearly labelled as affecting everyone.

### What is automatic, what needs consent, what AI may never do

- **Automatic, no consent needed.** Rendering the right role dashboard, resolving the business's chosen terminology, applying entitlements and permissions, showing real operational status, and offering to create a missing related record inline. These are safe because they change nothing material and invent nothing.
- **Requires explicit consent (preview then approve).** Any change to terminology, navigation, fields, roles, shared views, workflow or document presentation. Consent means the user sees what will change and approves it, and can undo it afterward. Personal-only preferences may apply immediately but remain per-user and reversible.
- **Forbidden to AI, always.** Writing or executing application code, SQL, DDL, RLS or migrations. Authoring configuration without a person previewing and approving. Changing permissions, entitlements or security rules. Inventing activity, results, goals or business facts. Reading or moving data across the boundary of the current business. Today these are structurally impossible because no provider authors configuration at all; the contract keeps them impossible as capability grows.

The single most valuable near-term step in this contract is the **preview-then-approve screen** for configuration, because it turns the already-shipped reversible pipeline into a genuinely consent-based one, which is the property the current product is closest to completing.

---

## 10. Homepage implementation map

Mapping the proposed home onto existing repository components. No implementation code is written in this step.

### Components to retain

- `src/app/_home/HomePage.tsx` structure and server-rendering approach.
- `src/app/_home/MobileMenu.tsx` (already accessible; reuse as is).
- `src/app/_home/LanguageSwitch.tsx`, `nav.ts`, `pricing.ts`, and `SectionHead`.
- `src/app/_home/ProductVisual.tsx` as the base for the hero visual.
- `src/platform/ui/icons.tsx` icon set and `OrgLogo` pattern.
- The design tokens in `globals.css` and the motion discipline.
- The honesty tests in `tests/unit/home-page.test.ts` and `product-visuals.test.ts`.

### Components to revise

- The built section copy and the region section, to remove the AI-configuration overclaim and to reframe GCC as international-first (copy-only edits in the message catalogs, plus the region section labels).
- `src/app/_home/ProductVisual.tsx`, extended to the two-state shaping hero in Section 8.
- The meta description and Open Graph text in `src/app/page.tsx` to the international-first framing.

### Components to replace

- None outright. The region section becomes the international-and-regional section (same shape, new content). No component is thrown away.

### New components needed

- A trust and privacy strip (small, text-first).
- A shaping before-and-after visual (may live inside the revised `ProductVisual` or as a sibling in `_home`).
- Optional: a small explicit type-scale token set in `globals.css` and a contrast test utility.

### Existing assets that can be reused

- All tokens, the icon set, the two existing product visuals, the legal content in `src/app/_legal/content.ts`, and the entitlement bundles behind pricing.

### New visual assets eventually required

- None as raster. Everything stays inline SVG and CSS. A future favicon or social image would be a separate, honest asset decision, not a marketing illustration.

### Translation keys required

- New or revised keys under `home.*` for: the reworded built section (remove the AI claim), the international-and-regional section (replace `home.gcc.*`), the new trust strip, and the shaping visual captions. Every key added to `en.json` must be added to `ar.json` in the same commit to keep the parity test green, and each is flagged for Spanish only when the Spanish locale is introduced. Spanish keys are not added until a Spanish catalog exists and is professionally reviewed.

### Tests required

- Extend `home-page.test.ts` for the new sections, the removed AI claim, and the international-first framing (no "GCC-only" wording, and no unsupported claim).
- Extend `product-visuals.test.ts` for the two-state hero: still one labelled image, decorative internals hidden, reduced-motion static state, RTL mirrored, no fabricated data.
- Add an automated contrast check for the marketing surfaces (new).
- Keep RTL physical-class safety and reduced-motion gating assertions.

### Performance risks

- The shaping animation must run on transform and opacity only, once, and never loop, to avoid layout thrash. No animation library. No new fonts. No raster.

### Accessibility risks

- The before-and-after visual must not depend on motion or color to make its point; the caption carries it. The trust strip must not become an icon wall. Any new arbitrary type sizes must still reflow at 320 px and 200 percent zoom.

---

## 11. Research decision register

Each material decision is linked to a finding and a source. Source types: Standard (normative), Primary (peer-reviewed study or original publication), Government (public-sector design system), Secondary (recognized practitioner guidance). Where a decision is a product judgment or an inference from a finding rather than a direct result, it is labelled Inference or Product judgment. Dates are given where known; a few practitioner dates are approximate and marked. No source is claimed to prove more than it does.

| Decision | Finding used | Source | URL | Date | Type |
|---|---|---|---|---|---|
| Interactive targets at least 24 px, primary actions and menu button at 44 px | Target Size Minimum is 24x24 CSS px (AA); Enhanced is 44x44 (AAA) | WCAG 2.2 SC 2.5.8, 2.5.5 | https://www.w3.org/TR/WCAG22/#target-size-minimum | 2023-10-05 | Standard |
| Text contrast 4.5:1, large text 3:1 | Contrast Minimum | WCAG 2.2 SC 1.4.3 | https://www.w3.org/TR/WCAG22/#contrast-minimum | 2023-10-05 | Standard |
| Non-text controls and graphical boundaries 3:1 | Non-text Contrast | WCAG 2.2 SC 1.4.11 | https://www.w3.org/TR/WCAG22/#non-text-contrast | 2023-10-05 | Standard |
| Gate all motion behind reduced-motion; provide static equivalents | Respect user motion preference | WCAG 2.2 SC 2.3.3; CSS Media Queries L5 prefers-reduced-motion | https://www.w3.org/TR/WCAG22/#animation-from-interactions | 2023-10-05 | Standard |
| Reflow to 320 px and 200 percent zoom, no horizontal scroll | Reflow | WCAG 2.2 SC 1.4.10 | https://www.w3.org/TR/WCAG22/#reflow | 2023-10-05 | Standard |
| Keep navigation stable and consistent across the site (Stable property) | Consistent Navigation | WCAG 2.2 SC 3.2.3 | https://www.w3.org/TR/WCAG22/#consistent-navigation | 2023-10-05 | Standard |
| Icon never sole carrier of meaning; text label beside every icon | Non-text Content needs a text alternative | WCAG 2.2 SC 1.1.1 | https://www.w3.org/TR/WCAG22/#non-text-content | 2023-10-05 | Standard |
| Accessible disclosure menu pattern for mobile nav | Disclosure and menu button patterns | W3C WAI-ARIA Authoring Practices Guide | https://www.w3.org/WAI/ARIA/apg/ | 2023, revised | Standard |
| Prevent and make recoverable destructive or consequential actions (undo, preview) | Error Prevention; and user control | WCAG 2.2 SC 3.3.4; Nielsen heuristic 5 | https://www.w3.org/TR/WCAG22/#error-prevention-legal-financial-data | 2023-10-05 | Standard |
| Controllability and conformity with user expectations as design tests | Interaction principles: controllability, conformity, self-descriptiveness | ISO 9241-110:2020 | https://www.iso.org/standard/75258.html | 2020 | Standard |
| Human-centred process framing for the whole blueprint | Human-centred design for interactive systems | ISO 9241-210:2019 | https://www.iso.org/standard/77520.html | 2019 | Standard |
| User control and freedom, recognition over recall, consistency, error prevention, system status | Ten usability heuristics | Nielsen, NN/g | https://www.nngroup.com/articles/ten-usability-heuristics/ | 1994, updated 2020 | Secondary |
| Limit choices and simultaneous items per view to reduce load | Working memory limits (about 7, later revised lower) | Miller, G.A., Psychological Review 63(2) | https://doi.org/10.1037/h0043158 | 1956 | Primary |
| Reduce extraneous load; group by outcome; progressive detail | Cognitive load theory | Sweller, J., Cognitive Science 12(2) | https://doi.org/10.1207/s15516709cog1202_4 | 1988 | Primary |
| Progressive disclosure: begin calm, reveal complexity on demand (Progressive property) | Progressive disclosure guidance | Nielsen, NN/g | https://www.nngroup.com/articles/progressive-disclosure/ | 2006 | Secondary |
| Fewer, clearer options on the home and in pricing | Too many options can reduce action | Iyengar and Lepper, JPSP 79(6) | https://doi.org/10.1037/0022-3514.79.6.995 | 2000 | Primary |
| Sensible defaults and clear default-versus-choice (choice architecture) | Defaults and choice architecture | Thaler and Sunstein, Nudge (Yale University Press) | https://yalebooks.yale.edu/book/9780300122237/nudge/ | 2008 | Primary |
| Calibrate trust with transparency; explain recommendations (Explainable, Intelligent) | Trust in automation and appropriate reliance | Lee and See, Human Factors 46(1) | https://doi.org/10.1518/hfes.46.1.50_30392 | 2004 | Primary |
| State what, why and supporting data for every recommendation | Explainability principles | NIST IR 8312, Four Principles of Explainable AI | https://doi.org/10.6028/NIST.IR.8312 | 2021 | Government |
| Keep the user in control; make actions reversible (Reversible, user locus of control) | Internal versus external locus of control | Rotter, J.B., Psychological Monographs 80(1) | https://doi.org/10.1037/h0092976 | 1966 | Primary |
| Support internal locus of control; permit easy reversal of actions | Eight golden rules of interface design | Shneiderman, B. | https://www.cs.umd.edu/~ben/goldenrules.html | 2016 ed. | Secondary |
| One thing per page and minimal fields to cut onboarding and form burden | Structuring forms; ask only what is needed | GOV.UK Service Manual | https://www.gov.uk/service-manual/design/structuring-forms | reviewed 2022 | Government |
| Content patterns and accessible components baseline | Design system patterns | GOV.UK Design System; U.S. Web Design System | https://design-system.service.gov.uk/ | ongoing | Government |
| Mobile-first responsive layout with fluid grids | Responsive web design | Marcotte, E., A List Apart | https://alistapart.com/article/responsive-web-design/ | 2010-05-25 | Primary |
| Correct language and direction markup; bidi handling for Arabic | Right-to-left and language markup guidance | W3C Internationalization | https://www.w3.org/International/questions/qa-html-dir | ongoing | Standard |
| Reduce form fields and friction at signup | Form and checkout usability research | Baymard Institute | https://baymard.com/blog/checkout-flow-average-form-fields | ongoing | Secondary |

Inference and product-judgment items, labelled as such:

- **Trust strip added to the journey.** Inference from Lee and See (trust as a precondition for reliance) plus the observation that the current home has no trust answer. The content only states what the code enforces.
- **International-first framing.** Product judgment and an explicit owner directive, not a research result.
- **No photography at launch.** Product judgment: no honest, rights-cleared, representative library exists, and diagrams communicate operational software more truthfully.
- **Preview-then-approve as the top near-term step.** Inference from the consent-based and explainable principles combined with the audit finding that the reversible pipeline already exists without a preview UI.

---

## 12. Micro-step delivery sequence

Each step is independently reviewable and reversible. Every step states the user outcome, scope, exclusions, likely files, required tests, deployment check and rollback boundary. The first implementation step after approval is deliberately small enough to deploy and visually review without touching authentication, onboarding, the database schema or workspace behaviour.

### First recommended step, H1: Homepage truthfulness and international-first copy

- **User outcome.** A visitor reads an honest, international-first home. The AI-configuration overclaim is gone, and the page no longer reads as GCC-only.
- **Scope.** Copy only, in `en.json` and `ar.json`, plus the meta and Open Graph text and the region section labels. No layout change, no new section, no visual change.
- **Exclusions.** No auth, no onboarding, no schema, no new components, no Spanish (no Spanish catalog exists yet), no visual redesign.
- **Files likely involved.** `src/platform/i18n/messages/en.json`, `ar.json`, `src/app/page.tsx` (metadata), and the region section labels in `HomePage.tsx` if a label is hard-referenced.
- **Required tests.** Extend `tests/unit/home-page.test.ts`: parity, Arabic-is-Arabic, no unsupported claim, no "GCC-only" framing, no AI-configuration claim. Keep the no-numeric-price test.
- **Deployment check.** Visual review of the home in English and Arabic on desktop and at 375 px, confirm the reworded built and region sections, confirm `/api/health` stays healthy.
- **Rollback boundary.** Revert the copy commit. No data or schema touched, so rollback is a single revert.

### Subsequent steps

Each follows the same template. Scope and exclusions are summarized; the same test, deploy-check and rollback discipline applies to all.

- **H2 Header and public navigation.** Outcome: consistent, accessible header and section anchors including the new trust and international sections. Scope: header and nav wiring, reuse the mobile menu. Exclude: auth, visuals.
- **H3 Hero visual, two-state shaping.** Outcome: the hero shows a business shaped from a simple flow into a workspace, illustrative and reduced-motion safe. Scope: `ProductVisual.tsx` extension. Exclude: any real data, WebGL, raster.
- **H4 Product explanation (connected flow).** Outcome: the six-step flow reads clearly and truthfully. Scope: copy and the flow diagram. Exclude: new claims.
- **H5 Intelligent Clay demonstration.** Outcome: the before-and-after shaping section with an honest now-versus-planned split. Scope: one new visual plus copy. Exclude: any claim that dashboards move today or that AI configures.
- **H6 Capability presentation.** Outcome: capabilities by outcome, every chip a shipped module, one honest planned line. Scope: copy and cards. Exclude: unshipped capabilities.
- **H7 International and regional fit.** Outcome: the GCC section becomes international-and-regional. Scope: replace `home.gcc.*` content and labels. Exclude: unsupported tax or compliance claims.
- **H8 Trust and legal surface.** Outcome: a compact trust strip and correct legal links. Scope: new small component plus copy. Exclude: any certification claim.
- **H9 Pricing.** Outcome: honest, outcome-based tiers, no numbers on the page. Scope: copy, reuse `pricing.ts`. Exclude: numeric prices.
- **H10 Footer.** Outcome: complete, correct footer. Scope: copy and links. Exclude: fabricated social links.
- **A1 Signup entry.** Outcome: identity-only signup, Google only when available. Scope: existing gateway. Exclude: schema, provider setup.
- **A2 Login.** Outcome: reliable login with correct locale carry-over. Scope: existing login. Exclude: schema.
- **A3 Email verification.** Outcome: the check-inbox and confirm experience is clear. Scope: existing verify and confirm routes. Exclude: the owner-side hosted settings, which are a separate owner action.
- **A4 Onboarding entry.** Outcome: a calm guided-setup entry. Scope: existing onboarding page. Note: this step does not redesign the guided questions in the home blueprint; it aligns the entry with the public promise.
- **D1 Dashboard shell.** Outcome: a calm workspace shell that scales with capability. Scope: shell only. Exclude: composition changes.
- **D2 Dashboard composition.** Outcome: the right role dashboard, still truthful and empty-safe. Scope: `today` composition. Exclude: user movability.
- **C1 Navigation customization (Planned capability).** Outcome: rename and reorder navigation as an org configuration change with preview and undo. Scope: config pipeline plus a preview UI. Exclude: personal-only changes here.
- **C2 Inline creation framework.** Outcome: create any required related record inside the current task. Scope: generalize the customer-in-quote pattern. Exclude: schema changes beyond what modules already support.
- **E1 Entity workspaces.** Outcome: consistent record workspaces across modules. Scope: shared layout. Exclude: new capabilities.
- **F1 Documents and exports.** Outcome: branded documents and exports reflect the business identity. Scope: existing branding and export. Exclude: new formats without need.
- **CRM1 CRM.** Outcome: customers and the relationship view are coherent. Scope: customers module surfaces. Exclude: unshipped CRM features.
- **W1 Work and project management.** Outcome: jobs, stages and tasks read clearly. Scope: jobs module surfaces.
- **T1 Tasks and planning.** Outcome: tasks and the week plan are legible. Scope: tasks and week.
- **FIN1 Finance.** Outcome: quotes, invoices, payments and AR are coherent and correctly redacted. Scope: finance modules.
- **INV1 Inventory and procurement.** Outcome: material requests, purchase orders, receipts and items read clearly. Scope: supply and items.
- **HR1 People and HR.** Outcome: employees and attendance are coherent. Scope: people and attendance.
- **R1 Reporting and statistics.** Outcome: clear, truthful reports with no invented figures. Scope: reporting surfaces.
- **CFG1 Configuration history and undo (near-term priority).** Outcome: preview-then-approve for configuration, on top of the shipped reversible pipeline. Scope: a preview UI over `previewConfigChange`, plus the existing revision history and undo. Exclude: AI authorship. This is the single most valuable Intelligent Clay step and is close to shippable because the server pipeline already exists.

Two constraints hold across the sequence: no step introduces a public claim the product cannot support, and no step described as a personalization silently changes what other users see.

---

## Appendix A. International and localization architecture

This appendix consolidates the international-first requirements and how each maps to the current codebase, so the blueprint can be applied without re-deriving them.

- **Languages.** English, Arabic and Spanish are the planned first-class languages. Today only English and Arabic exist as catalogs, and the supported set is hard-coded to two. Introducing Spanish means adding a Spanish catalog, extending the supported-locale list, and a professional native review before any Spanish reaches customers. The localization architecture already isolates copy in flat message catalogs resolved through one function, so adding a language does not require redesigning product surfaces.
- **Direction.** Arabic is RTL with complete mirroring from the root `dir` attribute; English and Spanish are LTR. The logical-property discipline means a third LTR language needs no directional rework.
- **Text growth and wrapping.** Spanish and Arabic both run longer than English in places. Every marketing and product surface must be tested with long strings in all three languages, and buttons and chips must wrap or truncate gracefully, not clip. This is a specific test to add.
- **Numbers, dates, times, currencies, percentages.** The product pins Latin numerals even under Arabic, which is deliberate and should continue. Dates, times, currency and percentage formatting must be locale-aware and, where they represent business data, must follow the organization's configured region rather than the reader's language alone.
- **Currency and multi-currency.** Each organization has a configurable base currency, and quotes and invoices carry a currency and an exchange rate per document, so document-level multi-currency exists today. Presentation of currency on the public page stays illustrative and clearly labelled.
- **Taxes and identifiers.** VAT, sales tax and jurisdiction-specific identifiers are configuration. The document identity already captures a tax registration field. The home must not imply a specific tax regime is preconfigured beyond what the product supports.
- **Fiscal year and reporting periods.** These must be configurable rather than assumed. Report period selection should not hard-code a calendar year.
- **Addresses, phone formats, legal identifiers.** Configuration, captured on the document profile today (bilingual address, legal name, licence, signatory). Formats must not be hard-coded to one country.
- **Time zones and daylight saving.** Operational dates must be handled in a defined, configurable time zone per organization, and the public page makes no time-zone claim.
- **Regional document requirements.** Documents carry the business's legal identity and language preference today; additional regional document rules are configuration, described honestly as they ship.
- **Translation fallback and missing-translation detection.** A missing key falls back to English and then to a loud bracketed marker that is visible in testing, never a blank. Catalog parity is enforced by a test. When Spanish is added, the same parity and fallback rules apply, and a missing-Spanish string falls back to English until reviewed.
- **Language switching without losing work.** The language switch must preserve the current page and any in-progress work, and it persists the choice to the user profile so it follows the user across devices. The public switch must not reload to the top of the page.
- **Organization language versus user language.** Today language is a user-level setting; there is no organization default language. If an organization default is introduced, it is a configuration change with the personal-versus-organization distinction made explicit, and an individual can still override it for themselves.
- **Human review for customer-facing translations.** All Arabic and Spanish copy that a customer will read requires professional native review before public use. The Arabic in this document is natural product Arabic drafted for that review, not a substitute for it. The Spanish in this document is draft candidate text only and must not ship without validation.

---

## Final note on scope

This is a design-definition document. It changes no application code, no dependency, no database, no configuration and no generated artifact. The only file created is this blueprint. Implementation begins only after owner approval, starting with step H1, which is copy-only and reversible by a single revert.
