# H33 — Pilot Lab performance report

Generated from `.pilot-lab/perf-2026-09-06T10-04-04-449Z.json` by `npx tsx tooling/pilot-lab/perf-report.ts`.

## What was measured, and what it is not

Each surface was opened three times with a real browser as a signed-in
persona, and timed from navigation start to network idle. The first run is
reported separately as **cold**, because the development server compiles a
route on its first hit and that compile is not a product characteristic.
The **median** of the three is the figure to read.

This is a development server on a laptop, talking to a database in another
region. It is not production, and the absolute numbers should not be quoted
as such. What it is good for is comparison — which surfaces are heavy, which
companies' volumes hurt, and whether anything is pathological.

- **Where** `http://localhost:3000` · desktop · locale `en`
- **Persona** `owner`
- **Coverage** 27 surfaces × 1 companies = 27 measurements

## Summary

| | |
| --- | --- |
| Median across every surface | **9,673 ms** |
| 95th percentile | 13,524 ms |
| Surfaces over 3 s (median) | 27 |
| Responses that were not 2xx/3xx | 0 |
| Slowest surface | `gulfbuild/studio` at 28,310 ms |
| Slowest cold compile | `gulfbuild/studio` at 31,862 ms |

### How much of this is the development server

The fastest surface's median is 8,537 ms, and 26 of 27 surfaces fall within 1.6x of it. A floor that flat means the figures are dominated by fixed development-server and network cost rather than by how much data a page lists, so they should NOT be read as 'which surfaces are heavy'. Production timings were not measured; treat that as an open question rather than an answered one.

The one figure that does stand clear of the floor is `gulfbuild/studio` at 28,310 ms — 3.3x the fastest surface. That gap is large enough to be a property of the page rather than of the server, and is worth a look before a pilot.

### Over three seconds

| Company | Surface | Median | Slowest | Requests |
| --- | --- | ---: | ---: | ---: |
| gulfbuild | studio | **28,310 ms** | 31,862 ms | 33 |
| gulfbuild | jobs list p2 | **13,524 ms** | 14,088 ms | 33 |
| gulfbuild | jobs list | **13,447 ms** | 16,046 ms | 33 |
| gulfbuild | week | **11,928 ms** | 12,482 ms | 33 |
| gulfbuild | assets | **11,773 ms** | 13,315 ms | 33 |
| gulfbuild | dashboard | **11,213 ms** | 11,384 ms | 34 |
| gulfbuild | leads | **11,098 ms** | 11,355 ms | 33 |
| gulfbuild | attendance | **11,078 ms** | 11,406 ms | 33 |
| gulfbuild | inbox | **11,077 ms** | 13,483 ms | 33 |
| gulfbuild | items list | **10,746 ms** | 11,192 ms | 33 |
| gulfbuild | stock | **10,698 ms** | 12,789 ms | 33 |
| gulfbuild | finance tax | **10,678 ms** | 11,552 ms | 33 |
| gulfbuild | customers list | **9,972 ms** | 11,280 ms | 33 |
| gulfbuild | revenue forecast | **9,673 ms** | 14,327 ms | 35 |
| gulfbuild | people | **9,627 ms** | 12,278 ms | 33 |
| gulfbuild | invoices list | **9,030 ms** | 11,403 ms | 33 |
| gulfbuild | finance reports | **8,903 ms** | 10,881 ms | 33 |
| gulfbuild | opportunities | **8,866 ms** | 11,598 ms | 33 |
| gulfbuild | purchase orders | **8,829 ms** | 11,570 ms | 33 |
| gulfbuild | invoices overdue | **8,828 ms** | 8,933 ms | 33 |
| gulfbuild | finance journals | **8,794 ms** | 11,545 ms | 33 |
| gulfbuild | payroll | **8,780 ms** | 10,977 ms | 33 |
| gulfbuild | documents | **8,769 ms** | 12,233 ms | 36 |
| gulfbuild | quotes list | **8,751 ms** | 12,128 ms | 33 |
| gulfbuild | receivables | **8,629 ms** | 11,100 ms | 33 |
| gulfbuild | revenue pipeline | **8,616 ms** | 8,995 ms | 35 |
| gulfbuild | customers search | **8,537 ms** | 8,561 ms | 33 |

## Every surface, by company

| Surface | gulfbuild |
| --- | ---: |
| dashboard | 11,213 |
| jobs list | 13,447 |
| jobs list p2 | 13,524 |
| customers list | 9,972 |
| customers search | 8,537 |
| items list | 10,746 |
| invoices list | 9,030 |
| invoices overdue | 8,828 |
| quotes list | 8,751 |
| purchase orders | 8,829 |
| stock | 10,698 |
| people | 9,627 |
| attendance | 11,078 |
| payroll | 8,780 |
| leads | 11,098 |
| opportunities | 8,866 |
| revenue pipeline | 8,616 |
| revenue forecast | 9,673 |
| documents | 8,769 |
| studio | 28,310 |
| finance journals | 8,794 |
| finance reports | 8,903 |
| finance tax | 10,678 |
| receivables | 8,629 |
| assets | 11,773 |
| inbox | 11,077 |
| week | 11,928 |

Figures are medians in milliseconds.

## Cold versus warm

The gap between the two is the development server compiling, not the
product thinking. It is reported so nobody reads a first-hit number as a
product characteristic.

| Company | Cold (median of surfaces) | Warm (median) | Difference |
| --- | ---: | ---: | ---: |
| gulfbuild | 11,545 ms | 9,673 ms | 1,872 ms |

