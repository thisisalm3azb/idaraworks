# Header menu fix — quick-create "New" & Account (DEFECT 4)

## Root cause — native `<details>`

The header quick-create ("New") menu and the Account menu in
`src/app/(app)/o/[orgId]/layout.tsx` were built as native
`<details className="…relative"><summary …>…</summary><ul/div className="absolute …">`
disclosure widgets.

Native `<details open>` toggles **only** via its `<summary>`. It does **not**:

- close on an outside click,
- close on `Escape`,
- close when you pick an item (the inner `<Link>`s navigate, but `open` persists),
- close on client-side navigation.

So once opened, the panel stayed `open`. Because App-Router navigations do not
remount the layout, the absolutely-positioned panel **lingered across routes**
and overlapped page content — and, being a real rendered element with a high
`z-index`, it kept intercepting clicks on whatever sat beneath it. Both header
menus had this defect (the org switcher is a section _inside_ the Account menu,
not a separate `<details>`), so both were migrated.

## The fix — an accessible `<Menu>` popover

`src/platform/ui/Menu.tsx` — a reusable client component (no new dependencies).
It is a controlled popover with a trigger button and a panel of items. Pure
roving-focus index math lives in `src/platform/ui/menu-nav.ts` (`nextFocusIndex`)
so it is unit-testable without a DOM (`tests/unit/menu-nav.test.ts`).

The server layout computes the menu data (labels already resolved via `t()` +
terminology) and passes plain view-models to the client `<Menu>`:

- **Quick-create**: one section of link items (`buildQuickCreate`).
- **Account**: account links → optional **Workspace** switcher section (only with
  `> 1` org) → logout, rendered as a `<form action={logoutAction}>` submit item.

Item kinds supported: `href` (renders `next/link`), `onSelect` (client button),
`formAction` (server-action `<form>` submit, used for logout). Sections carry an
optional `heading` and get a top separator after the first — reproducing the
original visuals, items, links, labels and icons exactly.

## Closure conditions — and how each is implemented

| Condition | Implementation |
|---|---|
| Toggle open | Trigger `<button onClick>` flips `open` state. |
| **Outside click** closes | `document` **`pointerdown`** listener (added only while open); ignores targets inside the trigger or the panel, otherwise `setOpen(false)`. |
| **Escape** closes + returns focus | `document` `keydown` listener: `setOpen(false)` then `triggerRef.focus()`. |
| **Selecting an item** closes | Link item `onClick` → `setOpen(false)` (Link captures the navigation synchronously, so it closes **then** navigates); button item runs `onSelect` then closes. |
| **Route navigation** closes (the lingering-across-pages fix) | `usePathname()` compared to `lastPath` at render time (React-sanctioned derived-state adjustment, mirroring `MobileNav`); a changed path closes the menu. |
| **Org change** closes | Org change navigates to a new `/o/[orgId]` path → covered by the route-change handler. |
| **Locale change** closes | The language toggle re-renders / changes the path → covered by the route-change handler (the toggle is also outside the panel, so its click closes any open menu). |
| **Logout** (server action) closes | The `formAction` submit redirects to `/login`; the route-change handler closes the menu. We deliberately do **not** force-unmount on the submit click, to avoid aborting the in-flight server action. |
| **Tab** closes, focus continues naturally | Panel `keydown` handler closes on `Tab` without `preventDefault`, so the browser moves focus onward — no focus trap. |
| No lingering overlay | There is **no** full-screen overlay element. Outside detection is a document listener, and the panel is **removed from the DOM** when closed, so nothing intercepts clicks after close. |

## Accessibility model (WAI-ARIA menu button)

- **Trigger**: `<button>` with `aria-haspopup="menu"`, `aria-expanded`
  (true/false), `aria-controls` (the panel id, only while open), and an
  `aria-label` (the accessible name).
- **Panel**: `role="menu"`, `aria-orientation="vertical"`,
  `aria-labelledby` → the trigger (so it inherits the trigger's name, e.g.
  "New" / "Account" — no redundant string needed).
- **Items**: `role="menuitem"`, rendered as `next/link`, `<button>`, or a
  server-action `<form>` submit button; all ≥ 44px tall.
- **Focus**: opening moves focus to the first item; `ArrowUp`/`ArrowDown`
  rove and wrap; `Home`/`End` jump to first/last; `Escape` returns focus to the
  trigger; `Tab` closes and leaves the menu (no trap). Roving `tabIndex`
  (only the first item is Tab-reachable) keeps a single tab stop.
- **RTL-safe**: logical `end-0` positioning (no physical left/right classes), so
  it flips under `dir="rtl"`. `z-40` above content; `shadow-pop`; `w-56`
  (quick-create) / `w-64` (account). No ancestor clips it (the header has no
  `overflow` clip), so no portal is needed.

## Tests

- **Unit** — `tests/unit/menu-nav.test.ts`: `nextFocusIndex` roving/wrap math,
  Home/End, empty and single-item menus. Runs in `pnpm test` (node env).
- **E2E** — `tests/e2e/quick-menu.spec.ts` (double-gated like
  `founder-onboarding.spec.ts`: `E2E_MENU=1` + a localhost-only Supabase URL, so
  it never touches the hosted DB; serial, one signup creates the org). Covers:
  open/toggle + `aria-expanded`; closed = no `role="menu"` in the DOM; outside
  click; `Escape` + focus return + next-click-passes-through; switching triggers;
  item selection closing **and** not lingering on the destination page; reopen;
  arrow/Home/End roving focus; logout (server-action item) closing via
  navigation; a 375px pass with no horizontal overflow. The suite requires the
  seeded local integration stack; it typechecks and is discovered by
  `pnpm exec playwright test quick-menu --list`.

## Notes / follow-ups

- No new i18n strings were required — every menu label reuses existing keys
  (`nav.create.*`, `nav.subscription`, `nav.logout`, `auth.account.title`,
  `members.title`, `org.switcher.label`), present in both `en.json` and
  `ar.json`; the `role="menu"` name comes from the trigger via `aria-labelledby`.
  The en/ar parity test (`tests/unit/i18n.test.ts`) stays green.
- **Coordination**: `tests/e2e/founder-onboarding.spec.ts:275` selects the
  Account trigger with `page.locator('summary[aria-label="Account"]')`. The
  trigger is now a `<button>`, so that line must become
  `page.getByRole("button", { name: "Account", exact: true })`. That file is
  owned by the onboarding track and was left untouched here.
