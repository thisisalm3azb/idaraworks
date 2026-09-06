# H33 — Pilot Lab performance report

Generated from `.pilot-lab/perf-2026-09-06T13-03-07-813Z.json` by `npx tsx tooling/pilot-lab/perf-report.ts`.

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
- **Coverage** 27 surfaces × 5 companies = 135 measurements

## Summary

| | |
| --- | --- |
| Median across every surface | **8,898 ms** |
| 95th percentile | 13,478 ms |
| Surfaces over 3 s (median) | 135 |
| Responses that were not 2xx/3xx | 0 |
| Slowest surface | `consult/studio` at 40,942 ms |
| Slowest cold compile | `consult/studio` at 40,942 ms |

### How much of this is the development server

The fastest surface's median is 8,448 ms, and 129 of 135 surfaces fall within 1.6x of it. A floor that flat means the figures are dominated by fixed development-server and network cost rather than by how much data a page lists, so they should NOT be read as 'which surfaces are heavy'. Production timings were not measured; treat that as an open question rather than an answered one.

The one figure that does stand clear of the floor is `consult/studio` at 40,942 ms — 4.8x the fastest surface. That gap is large enough to be a property of the page rather than of the server, and is worth a look before a pilot.

### Over three seconds

| Company | Surface | Median | Slowest | Requests |
| --- | --- | ---: | ---: | ---: |
| consult | studio | **40,942 ms** | 41,949 ms | 32 |
| saudimfg | studio | **31,258 ms** | 32,962 ms | 32 |
| gulfbuild | studio | **30,565 ms** | 31,458 ms | 32 |
| tradeline | studio | **29,330 ms** | 29,552 ms | 32 |
| facilico | jobs list p2 | **14,048 ms** | 14,125 ms | 32 |
| facilico | jobs list | **13,753 ms** | 14,284 ms | 32 |
| consult | jobs list | **13,478 ms** | 14,684 ms | 32 |
| gulfbuild | jobs list p2 | **13,451 ms** | 13,531 ms | 32 |
| consult | jobs list p2 | **13,449 ms** | 13,533 ms | 32 |
| tradeline | jobs list | **13,330 ms** | 13,375 ms | 32 |
| saudimfg | jobs list | **13,314 ms** | 13,684 ms | 32 |
| gulfbuild | jobs list | **13,294 ms** | 13,395 ms | 32 |
| saudimfg | jobs list p2 | **13,265 ms** | 13,312 ms | 32 |
| tradeline | jobs list p2 | **13,236 ms** | 13,648 ms | 32 |
| tradeline | dashboard | **11,359 ms** | 11,616 ms | 34 |
| consult | dashboard | **11,349 ms** | 11,533 ms | 34 |
| saudimfg | dashboard | **11,231 ms** | 11,249 ms | 34 |
| facilico | dashboard | **11,182 ms** | 11,201 ms | 34 |
| gulfbuild | dashboard | **11,146 ms** | 11,202 ms | 34 |
| facilico | assets | **10,846 ms** | 13,085 ms | 33 |
| facilico | attendance | **10,752 ms** | 11,096 ms | 32 |
| consult | assets | **10,750 ms** | 12,896 ms | 32 |
| facilico | stock | **10,743 ms** | 12,786 ms | 32 |
| saudimfg | stock | **10,728 ms** | 13,446 ms | 32 |
| consult | inbox | **10,723 ms** | 10,946 ms | 32 |
| facilico | inbox | **10,713 ms** | 10,801 ms | 33 |
| gulfbuild | inbox | **10,695 ms** | 13,265 ms | 32 |
| tradeline | inbox | **10,677 ms** | 12,884 ms | 32 |
| gulfbuild | stock | **10,674 ms** | 12,903 ms | 32 |
| saudimfg | inbox | **10,671 ms** | 12,899 ms | 32 |
| tradeline | assets | **10,653 ms** | 10,677 ms | 32 |
| gulfbuild | assets | **10,650 ms** | 10,722 ms | 32 |
| tradeline | stock | **10,640 ms** | 13,101 ms | 32 |
| consult | stock | **10,635 ms** | 12,767 ms | 32 |
| saudimfg | assets | **10,607 ms** | 10,811 ms | 32 |
| tradeline | revenue forecast | **10,574 ms** | 10,714 ms | 34 |
| facilico | week | **10,300 ms** | 11,836 ms | 33 |
| consult | revenue forecast | **10,061 ms** | 10,720 ms | 34 |
| consult | documents | **10,057 ms** | 11,458 ms | 35 |
| saudimfg | people | **9,679 ms** | 9,683 ms | 32 |
| tradeline | week | **9,651 ms** | 9,657 ms | 32 |
| facilico | people | **9,618 ms** | 9,647 ms | 32 |
| consult | week | **9,610 ms** | 11,748 ms | 32 |
| tradeline | people | **9,592 ms** | 9,636 ms | 32 |
| gulfbuild | people | **9,582 ms** | 9,670 ms | 32 |
| consult | people | **9,576 ms** | 9,881 ms | 32 |
| gulfbuild | revenue forecast | **9,573 ms** | 10,705 ms | 34 |
| saudimfg | week | **9,566 ms** | 9,619 ms | 32 |
| gulfbuild | week | **9,561 ms** | 9,576 ms | 32 |
| consult | attendance | **9,548 ms** | 10,868 ms | 32 |
| saudimfg | revenue forecast | **9,474 ms** | 10,723 ms | 34 |
| tradeline | opportunities | **9,447 ms** | 11,583 ms | 32 |
| facilico | revenue forecast | **9,329 ms** | 10,645 ms | 34 |
| tradeline | purchase orders | **9,272 ms** | 9,342 ms | 32 |
| saudimfg | finance journals | **9,199 ms** | 10,833 ms | 32 |
| facilico | quotes list | **9,148 ms** | 9,784 ms | 32 |
| gulfbuild | purchase orders | **9,134 ms** | 9,382 ms | 32 |
| saudimfg | invoices list | **9,129 ms** | 9,899 ms | 32 |
| tradeline | invoices list | **9,068 ms** | 9,801 ms | 32 |
| consult | quotes list | **9,052 ms** | 9,647 ms | 32 |
| facilico | purchase orders | **9,050 ms** | 9,161 ms | 32 |
| tradeline | customers list | **8,960 ms** | 9,686 ms | 32 |
| tradeline | quotes list | **8,949 ms** | 9,860 ms | 32 |
| facilico | studio | **8,946 ms** | 11,033 ms | 34 |
| gulfbuild | attendance | **8,936 ms** | 10,999 ms | 32 |
| saudimfg | purchase orders | **8,915 ms** | 8,917 ms | 32 |
| saudimfg | attendance | **8,914 ms** | 9,082 ms | 32 |
| facilico | finance reports | **8,898 ms** | 10,756 ms | 33 |
| consult | customers list | **8,891 ms** | 9,851 ms | 32 |
| saudimfg | finance reports | **8,864 ms** | 9,399 ms | 32 |
| tradeline | attendance | **8,857 ms** | 9,081 ms | 32 |
| gulfbuild | customers list | **8,854 ms** | 9,747 ms | 32 |
| consult | invoices list | **8,829 ms** | 9,180 ms | 32 |
| saudimfg | leads | **8,804 ms** | 9,793 ms | 32 |
| saudimfg | payroll | **8,800 ms** | 10,612 ms | 32 |
| consult | invoices overdue | **8,788 ms** | 8,799 ms | 32 |
| consult | finance journals | **8,785 ms** | 10,900 ms | 32 |
| saudimfg | invoices overdue | **8,783 ms** | 8,784 ms | 32 |
| gulfbuild | invoices overdue | **8,779 ms** | 8,791 ms | 32 |
| tradeline | invoices overdue | **8,772 ms** | 9,065 ms | 32 |
| consult | opportunities | **8,762 ms** | 10,819 ms | 32 |
| gulfbuild | invoices list | **8,747 ms** | 8,887 ms | 32 |
| consult | finance tax | **8,746 ms** | 10,642 ms | 32 |
| saudimfg | quotes list | **8,745 ms** | 9,646 ms | 32 |
| tradeline | leads | **8,735 ms** | 8,768 ms | 32 |
| facilico | customers list | **8,732 ms** | 9,952 ms | 32 |
| facilico | invoices overdue | **8,730 ms** | 8,754 ms | 32 |
| facilico | leads | **8,719 ms** | 11,151 ms | 32 |
| gulfbuild | leads | **8,711 ms** | 8,836 ms | 32 |
| facilico | documents | **8,706 ms** | 8,804 ms | 35 |
| gulfbuild | quotes list | **8,699 ms** | 9,998 ms | 32 |
| consult | leads | **8,696 ms** | 9,437 ms | 32 |
| consult | receivables | **8,695 ms** | 8,982 ms | 32 |
| gulfbuild | documents | **8,688 ms** | 8,698 ms | 35 |
| facilico | invoices list | **8,665 ms** | 8,747 ms | 32 |
| gulfbuild | opportunities | **8,653 ms** | 10,697 ms | 32 |
| facilico | receivables | **8,636 ms** | 8,740 ms | 33 |
| gulfbuild | receivables | **8,634 ms** | 9,582 ms | 32 |
| tradeline | receivables | **8,632 ms** | 8,769 ms | 32 |
| facilico | revenue pipeline | **8,631 ms** | 8,934 ms | 34 |
| facilico | opportunities | **8,628 ms** | 8,718 ms | 32 |
| tradeline | finance tax | **8,624 ms** | 11,050 ms | 32 |
| saudimfg | customers list | **8,613 ms** | 9,766 ms | 32 |
| facilico | finance journals | **8,607 ms** | 8,686 ms | 33 |
| tradeline | documents | **8,602 ms** | 8,968 ms | 35 |
| saudimfg | opportunities | **8,600 ms** | 10,815 ms | 32 |
| facilico | finance tax | **8,596 ms** | 8,602 ms | 33 |
| gulfbuild | items list | **8,593 ms** | 10,999 ms | 32 |
| tradeline | revenue pipeline | **8,576 ms** | 8,588 ms | 34 |
| saudimfg | items list | **8,576 ms** | 8,593 ms | 32 |
| saudimfg | documents | **8,567 ms** | 8,598 ms | 35 |
| tradeline | payroll | **8,565 ms** | 10,665 ms | 32 |
| gulfbuild | finance reports | **8,563 ms** | 8,565 ms | 32 |
| tradeline | items list | **8,563 ms** | 8,598 ms | 32 |
| consult | customers search | **8,557 ms** | 8,864 ms | 32 |
| saudimfg | revenue pipeline | **8,552 ms** | 8,614 ms | 34 |
| tradeline | finance reports | **8,551 ms** | 8,724 ms | 32 |
| tradeline | customers search | **8,547 ms** | 8,700 ms | 32 |
| consult | revenue pipeline | **8,547 ms** | 8,550 ms | 34 |
| consult | payroll | **8,546 ms** | 8,778 ms | 32 |
| saudimfg | receivables | **8,541 ms** | 8,869 ms | 32 |
| gulfbuild | finance tax | **8,529 ms** | 8,609 ms | 32 |
| consult | finance reports | **8,525 ms** | 8,911 ms | 32 |
| tradeline | finance journals | **8,521 ms** | 10,718 ms | 32 |
| saudimfg | customers search | **8,517 ms** | 8,777 ms | 32 |
| consult | purchase orders | **8,507 ms** | 8,589 ms | 32 |
| gulfbuild | payroll | **8,503 ms** | 8,533 ms | 32 |
| consult | items list | **8,501 ms** | 10,681 ms | 32 |
| saudimfg | finance tax | **8,499 ms** | 10,652 ms | 32 |
| gulfbuild | finance journals | **8,484 ms** | 10,617 ms | 32 |
| gulfbuild | revenue pipeline | **8,469 ms** | 8,547 ms | 34 |
| facilico | items list | **8,469 ms** | 10,598 ms | 32 |
| facilico | payroll | **8,469 ms** | 8,648 ms | 32 |
| gulfbuild | customers search | **8,467 ms** | 8,469 ms | 32 |
| facilico | customers search | **8,448 ms** | 8,833 ms | 32 |

## Every surface, by company

| Surface | gulfbuild | tradeline | saudimfg | consult | facilico |
| --- | ---: | ---: | ---: | ---: | ---: |
| dashboard | 11,146 | 11,359 | 11,231 | 11,349 | 11,182 |
| jobs list | 13,294 | 13,330 | 13,314 | 13,478 | 13,753 |
| jobs list p2 | 13,451 | 13,236 | 13,265 | 13,449 | 14,048 |
| customers list | 8,854 | 8,960 | 8,613 | 8,891 | 8,732 |
| customers search | 8,467 | 8,547 | 8,517 | 8,557 | 8,448 |
| items list | 8,593 | 8,563 | 8,576 | 8,501 | 8,469 |
| invoices list | 8,747 | 9,068 | 9,129 | 8,829 | 8,665 |
| invoices overdue | 8,779 | 8,772 | 8,783 | 8,788 | 8,730 |
| quotes list | 8,699 | 8,949 | 8,745 | 9,052 | 9,148 |
| purchase orders | 9,134 | 9,272 | 8,915 | 8,507 | 9,050 |
| stock | 10,674 | 10,640 | 10,728 | 10,635 | 10,743 |
| people | 9,582 | 9,592 | 9,679 | 9,576 | 9,618 |
| attendance | 8,936 | 8,857 | 8,914 | 9,548 | 10,752 |
| payroll | 8,503 | 8,565 | 8,800 | 8,546 | 8,469 |
| leads | 8,711 | 8,735 | 8,804 | 8,696 | 8,719 |
| opportunities | 8,653 | 9,447 | 8,600 | 8,762 | 8,628 |
| revenue pipeline | 8,469 | 8,576 | 8,552 | 8,547 | 8,631 |
| revenue forecast | 9,573 | 10,574 | 9,474 | 10,061 | 9,329 |
| documents | 8,688 | 8,602 | 8,567 | 10,057 | 8,706 |
| studio | 30,565 | 29,330 | 31,258 | 40,942 | 8,946 |
| finance journals | 8,484 | 8,521 | 9,199 | 8,785 | 8,607 |
| finance reports | 8,563 | 8,551 | 8,864 | 8,525 | 8,898 |
| finance tax | 8,529 | 8,624 | 8,499 | 8,746 | 8,596 |
| receivables | 8,634 | 8,632 | 8,541 | 8,695 | 8,636 |
| assets | 10,650 | 10,653 | 10,607 | 10,750 | 10,846 |
| inbox | 10,695 | 10,677 | 10,671 | 10,723 | 10,713 |
| week | 9,561 | 9,651 | 9,566 | 9,610 | 10,300 |

Figures are medians in milliseconds.

## Cold versus warm

The gap between the two is the development server compiling, not the
product thinking. It is reported so nobody reads a first-hit number as a
product characteristic.

| Company | Cold (median of surfaces) | Warm (median) | Difference |
| --- | ---: | ---: | ---: |
| gulfbuild | 9,134 ms | 8,779 ms | 355 ms |
| tradeline | 9,177 ms | 8,960 ms | 217 ms |
| saudimfg | 9,199 ms | 8,914 ms | 285 ms |
| consult | 9,494 ms | 8,891 ms | 603 ms |
| facilico | 8,898 ms | 8,898 ms | 0 ms |

