# H31 — what "your own company app" actually means

The sentence we may use, and what every part of it is true about. Anyone writing
a proposal, a website page or a sales email should read this first, because the
difference between the approved wording and the tempting wording is the
difference between a happy customer and a refund.

---

## The approved description

> **Your company. Your branding. Your own installable business app — powered and
> maintained by IdaraWorks.**

Every clause is defensible:

| Clause | Why it is true |
| --- | --- |
| "Your company" | The app opens directly into that company's workspace, with that company's data and nobody else's. |
| "Your branding" | Its name, short name, colours, icon and launch screen are the customer's, on their home screen and in their taskbar. |
| "Your own installable business app" | It genuinely installs. It is a separate application to the operating system, with its own icon and its own window. |
| "powered and maintained by IdaraWorks" | We host it, secure it and update it. The customer does none of that. |

---

## What we must never say

| Never say | Why |
| --- | --- |
| "We build you your own app" / "your own codebase" | It is one shared platform. Saying otherwise implies bespoke software, bespoke pricing and bespoke liability. |
| "A native Windows / macOS / iOS / Android app" | There is no native package. It is an installable web application, and the words are not interchangeable to a buyer's IT department. |
| "Available on the App Store / Google Play / Microsoft Store" | It is not. H31 ships no store submission of any kind. |
| "Works offline" | It does not, deliberately. See below. |
| "Your data is on your device" | It is not, deliberately. See below. |
| "Your own domain included" | A company address under `idaraworks.com` needs a step from us; a domain the customer owns needs their DNS and is not yet activated. |

---

## What the customer actually gets, today

1. **A direct address into their workspace** that skips the IdaraWorks marketing
   site entirely.
2. **An installable application** with their name, colours and icon.
3. **Automatic updates.** No installers, no version numbers, no IT ticket.
4. **The same security as the browser version**, because it *is* the browser
   version wearing their identity.

---

## The two honest limitations, stated plainly

### It does not work offline, on purpose

The app needs a connection to show business records. That is a decision, not a
gap.

Every company in IdaraWorks is served from the same addresses. Storing one
company's invoices on a device so they can be read offline would mean a cache
that could hand them to the next person who signs in on that device. We chose
not to build that. When there is no connection, the app says so on a clean
screen and nothing is stored.

The same reasoning means the app will never accept a form while disconnected and
claim it saved. If it says a record was saved, the record was saved.

### Installation differs by device, and we do not pretend otherwise

| Device | What happens |
| --- | --- |
| **Windows / Chrome or Edge** | An Install button appears in the app. One click. |
| **Android / Chrome** | An Install button appears in the app. One tap. |
| **macOS / Safari 17+** | No button; the user chooses **File → Add to Dock**. The app tells them so. |
| **iPhone / iPad (iOS 16.4+)** | No button exists on iOS at all. The user taps **Share → Add to Home Screen**, in Safari, Chrome, Edge or Firefox. The app shows those words on iOS and nowhere else. |
| **Desktop Firefox** | Firefox cannot install web apps from a manifest. The app says so plainly and suggests Chrome, Edge or Safari, or using it as an ordinary bookmark. |

Source: MDN, *Making PWAs installable*, read 2026-09-04. We do not claim an
identical experience on every device, because there is not one.

---

## Addresses: three different things, often confused

| | What it is | Who provides DNS | State |
| --- | --- | --- | --- |
| **Standard address** | `www.idaraworks.com/o/…` | us | **works today** |
| **Company subdomain** | `yourcompany.idaraworks.com` | us — one record per company | **built; needs one step from IdaraWorks per company** |
| **Customer-owned domain** | `app.yourcompany.com` | the customer | **foundation only; not activated** |

A customer does **not** need to buy a domain to get a branded installable app.
That is the point of the standard address, and it should be the first thing said
rather than a fallback mentioned last.

---

## One more thing worth saying out loud

If a customer later moves from the standard address to a company subdomain,
anyone who already installed the app will need to install it again from the new
address. That is how operating systems identify installed apps, not something we
can smooth over — so the settings screen says it before anyone commits, and a
salesperson should say it too.
