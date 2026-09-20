# Mobile usability and first use — release report

Six improvements, one release: installation help, trial copy, the guided
tutorial, the onboarding flow, the mobile bottom bar and dashboard
customisation. This document records what changed, how each part behaves,
how it was verified, and what still needs a real phone.

## 1. Installation (company app)

**Where it lives.** Signed in on a phone (below 768px), a compact card sits
at the top of the workspace: the company's own mark and name, one line of
why, and one action. On a laptop the quiet header button behaves as before.
A permanent entry, **Account → Install company app**, opens
`/o/<org>/install`: the company's identity, the real state on this device
(browser version, or installed), the Install button when the browser offers a
prompt, and the step guide.

**States.** Prompt available → direct **Install** (Chrome/Edge on Android and
desktop, when the browser fires `beforeinstallprompt`). Prompt dismissed by
the browser → the card explains and the guide takes over. Unsupported or
unknown → the guide only. Standalone → nothing is shown; the install page says
"Installed on this device". "Not now" hides the card for 14 days on that device
and that company only; `appinstalled` retires it permanently on that device.
The product never claims that "no prompt" means "installed".

**Browser detection.** `detectRoute(userAgent)` distinguishes Safari, Chrome
(`CriOS`), Firefox (`FxiOS`), Edge (`EdgiOS`) and in-app browsers on iPhone;
Chrome, Samsung Internet, Edge and Firefox on Android; Chrome, Edge, Safari and
Firefox on a computer. Each route has three icon steps in en/ar/es. iPhone
steps are Share → Add to Home Screen → Add for Safari, Chrome, Edge and
Firefox (iOS 16.4+ third-party browsers install from their Share menu; verified
against the WebKit release notes and Google's Chrome help). An in-app browser
is told to open the address in Safari or Chrome first. Every guide ends with
"we cannot confirm installation from here".

**Unchanged.** Manifest identity, scope, versioned icons and the
multi-company behaviour from H31.

## 2. Trial copy

Three shared keys carry the trial everywhere: `trial.promise.headline`
("30 days free. No credit card needed."), `trial.promise.after_short`
("Afterwards, continue on Free or choose a paid plan.") and
`trial.promise.details` ("See details"). The onboarding Ready screen, the
workspace banner and the subscription page all use them; the long facts
(what is included, dates, what happens after, no restart) sit behind a
disclosure. No duration, date, price, entitlement or billing rule changed.

## 3. Guided tutorial (version 2)

Action-driven. Each step highlights one real control and asks for one tap:

| Tour (roles) | Steps |
| --- | --- |
| owner (owner, admin, manager) | Tap Work → look at the new-work form (Next) → Tap More (phone only) → Tap Customers → Tap + → Done |
| finance (accounts) | Tap Invoices → Tap New invoice → Tap Payments → Tap + → Done |
| supply (procurement) | Tap Material requests → Tap Purchase orders → Tap Suppliers → Tap + → Done |
| field (foreman, viewer) | Tap Work → Tap Report → Tap Issues → Tap More (phone only) → Tap Week → Done |

A step ends only on evidence: the route now matches (`/jobs`), a click landed
on the highlighted control, or Next on a look step. Steps are filtered by
permission; the More step is skipped silently on a laptop; a control that is
not on the screen after 2.5 s produces "This control is not on the current
screen" with Skip this step and Exit. The card follows route changes (it is
mounted in the organisation layout), scrolls a late-appearing control into
view, and on a phone sits above the bottom bar so the tabs stay tappable. No
backdrop intercepts clicks; there is no focus trap; Escape exits. Exit and Not
now record `skipped`, never `completed`. Nothing is written except the
person's own `onboarding_state` row.

**Old state.** `TOUR_VERSION` is 2. Completed and skipped rows from version 1
are untouched and never re-greeted. An in-progress version-1 row resumes at
step 1 of version 2 (`resumeIndex`), and the monotonic step guard yields when
the stored version differs. The auto-start cutoff date did not move.

## 4. Onboarding (four screens)

1. **Your business** — company name, country (sets currency and time zone),
   language. Required: name, country, language.
2. **How you work** — one card from the template catalogue. Required.
3. **What matters now** — up to five priority chips and a team-size band.
   Optional (defaults apply).
4. **Ready to start** — a summary, the trial in two lines, See details, and
   **Open my workspace**.

Every screen has Back, "Step X of 4", autosave, and resume on refresh.
Everything the long journey asked is now implied from the chosen card
(`impliedAnswersFor`), defaulted, or deferred to Settings: logo, invitations,
terminology, addresses, tax registration. No tax registration, legal address
or financial setting is invented. Priorities are recorded to
`app_settings.onboarding.priorities` as a choice and seed the dashboard
default. The confirm chain is unchanged (one organisation per draft, idempotent
claim, 30-day trial rules untouched). Old long-journey drafts resume at the
first screen they lack with their answers kept; members with an organisation
never see the flow; invitees continue to the invited company.

## 5. Mobile bottom navigation

Each tab is one target (the whole cell, 78×56 at 390px), with pressed and
selected states, `aria-current="page"`, safe-area padding, and content
clearance in the page (`pb-[calc(6rem+env(safe-area-inset-bottom))]`). The
tour's welcome card no longer covers the bar. Hit-testing at the icon, label,
edges and padding lands inside the link before and after the tour greeting.

## 6. Dashboard customisation

**Edit dashboard** is on every dashboard a person can see. Widgets: Needs
your attention, Next, Business pulse, In progress (blueprint workspaces);
Today overview (workspaces without a blueprint: the whole classic composition
as one widget); My tasks, Approvals, Active work, Quotes awaiting action,
Receivables, Stock alerts, Team actions, Recent activity, Quick actions. Each
widget names the permission its data needs, its capability and any release
flag; the loader re-checks permission before every read and every service
call asserts its own action. Add, remove, hide/show, Move up / Move down
(buttons, no drag), three sizes, Save, Cancel and Reset to default, with
announced feedback. Only shown widgets are fetched; hidden ones cost nothing.

**Defaults.** By role, with the widgets that serve the company's stated
priorities pulled forward. A workspace without a blueprint defaults to the
Today overview alone, so nothing changes for an existing company until
somebody edits. Layouts are per person per company (`user_dashboard_pref`,
migration 0141, RLS on org AND user, column-scoped update). A saved key that
is unknown, retired or no longer permitted is dropped on read and the page
says so.

## Verification

Automated on the isolated TEST project, with real signed-in browsers on
Playwright's Chromium (phone 390×844 and laptop 1280×800 viewports). None of
the install checks exercised a native install sheet; those are emulation of
browser identities and events. The per-check records and screenshots live in
`.demo-showcase/mobile/` (untracked).

| Check | Method | Result |
| --- | --- | --- |
| Onboarding walk (four screens, back, resume, double tap, trial rules, invitee, old draft) | signed-in browser, phone | 21/21 |
| Tour walk (owner, phone + laptop; newcomer; version-1 resume) | signed-in browser, real taps | 37/37 |
| Dashboard walk (legacy laptop; blueprint phone; Arabic) | signed-in browser | 24/24 |
| Install walk (Android Chrome, synthetic prompt, standalone, iPhone Safari/Chrome/Firefox/in-app, Samsung, laptop) | browser-identity emulation | 35/35 |
| Bottom-bar hit test (icon, label, edges, padding; before and after the greeting) | DOM hit-testing at 390px | all inside the link |
| Unit tests | vitest | 128 files green |
| Integration (dashboard board, guided onboarding, onboarding draft, logo round-trip) | vitest against TEST Postgres | 8 + 17 + 7 + 3 |
| Tour e2e spec (`tests/e2e/h32-show-me-around.spec.ts`) | Playwright, desktop + mobile-375 projects | see release notes |

Not verified here: a native Android install sheet, an iPhone Share menu, and
a real installed (standalone) launch. Those are the hands-on checklist below.

## Hands-on phone checklist (owner)

1. iPhone Safari: open the workspace, tap **How to install**, follow Share →
   Add to Home Screen → Add; open the icon; the workspace opens standalone
   with the company name and icon.
2. iPhone Chrome: same card, Chrome's own steps; confirm Add to Home Screen is
   offered in Chrome's Share menu (iOS 16.4+).
3. Android Chrome: **Install** appears when Chrome offers it; otherwise
   **How to install** → ⋮ → Install and create shortcut.
4. Tap **Not now**; reload; the card stays hidden. Switch company; the card
   for the other company still shows.
5. Account → Install company app: the state line matches the device.
6. Start **Show me around** from the Account menu on the phone; tap through
   Work, More, Customers, +; confirm the bottom bar stays tappable and the
   card never covers it; exit with Escape or ×.
7. Edit dashboard on the phone: add, move, hide, save, reload, reset.
8. Switch to Arabic and repeat 6 and 7.
