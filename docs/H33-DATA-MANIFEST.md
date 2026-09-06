# H33 — Pilot Lab data manifest

Generated from `.pilot-lab/manifest.json` by `npx tsx tooling/pilot-lab/report.ts`.
Every figure below is counted from the database, not estimated.

- **Seed version** `1.0.0`
- **Generated** 2026-09-06T02:44:23.965Z
- **Test project** `zwnnqaryouevnzuwtyaj` (the isolated project; production is refused by construction)
- **Login domain** `pilot-lab.invalid` — reserved, cannot receive mail
- **History** 2023-09-01 → 2026-09-05
- **Completeness checksum** `9535204c276406bc4f3206079538e28cafed021350275e5e0ae63252475fe067`

## Totals

| | |
| --- | --- |
| Rows written | **156,019** |
| Database before | 57.0 MB |
| Database after | **160.3 MB** |
| Growth | 103.3 MB |
| Storage objects | 0.0 MB |
| Ceiling | 300.0 MB (the seeder stops rather than pass it) |

## The five companies

| Company | Organisation | Rows | Families |
| --- | --- | --- | --- |
| **Marjan Gulf Contracting** · مرجان الخليج للمقاولات<br>`gulfbuild` | `17be9c8a-3b2e-4533-b24f-13b22de1ede2` | 33,542 | 15/15 |
| **Sadaf Trading & Distribution** · صدف للتجارة والتوزيع<br>`tradeline` | `65327dcc-d0b8-4b80-9fc4-9714288fbebf` | 66,589 | 15/15 |
| **Nakhla Precision Manufacturing** · نخلة للصناعات الدقيقة<br>`saudimfg` | `738be7c6-04f8-477a-b348-07d6e279fe2c` | 27,407 | 15/15 |
| **Bayan Advisory Partners** · بيان للاستشارات<br>`consult` | `e172fd58-b511-4c17-9cad-32d73ab39791` | 28,481 | 15/15 |
| **Rukn Facilities & Maintenance** · ركن للمرافق والصيانة<br>`facilico` | `af67d571-b154-469c-988e-04acfaa933e2` | 0 | 15/15 |

## Rows by family

| Family | gulfbuild | tradeline | saudimfg | consult | facilico | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `assets` | 1,502 | 849 | 1,312 | 656 | 2,031 | **6,350** |
| `country` | 5 | 5 | 22 | 5 | 5 | **42** |
| `crm` | 3,251 | 13,859 | 2,549 | 3,831 | 2,948 | **26,438** |
| `docstudio` | 1,057 | 812 | 739 | 1,966 | 1,057 | **5,631** |
| `finance` | 349 | 349 | 344 | 349 | 349 | **1,740** |
| `hr` | 5,800 | 4,065 | 4,264 | 3,402 | 6,056 | **23,587** |
| `masters` | 869 | 5,732 | 1,547 | 844 | 1,457 | **10,449** |
| `misc` | 1,027 | 1,788 | 828 | 1,223 | 1,896 | **6,762** |
| `people` | 691 | 554 | 614 | 491 | 753 | **3,103** |
| `sales` | 2,382 | 11,164 | 2,162 | 2,811 | 3,564 | **22,083** |
| `setup` | 350 | 364 | 367 | 325 | 354 | **1,760** |
| `stock` | 2,782 | 8,121 | 1,860 | 370 | 1,447 | **14,580** |
| `studio` | 2,103 | 1,435 | 1,504 | 3,308 | 2,576 | **10,926** |
| `supply` | 2,663 | 10,646 | 2,311 | 483 | 1,928 | **18,031** |
| `work` | 7,242 | 5,567 | 5,824 | 7,017 | 20,872 | **46,522** |

## Rows by table

<details><summary>Every table the lab wrote, counted live</summary>

| Table | gulfbuild | tradeline | saudimfg | consult | facilico | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `activity` | 1,267 | 1,422 | 971 | 1,352 | 0 | **5,012** |
| `ai_credit_ledger` | 2 | 2 | 2 | 2 | 0 | **8** |
| `ai_entitlement` | 2 | 2 | 2 | 2 | 0 | **8** |
| `ai_privacy_register` | 1 | 1 | 1 | 1 | 0 | **4** |
| `app_settings` | 30 | 30 | 29 | 30 | 0 | **119** |
| `approval` | 28 | 17 | 22 | 30 | 0 | **97** |
| `approval_rule` | 1 | 1 | 1 | 1 | 0 | **4** |
| `asset` | 80 | 45 | 65 | 35 | 0 | **225** |
| `asset_assignment` | 171 | 78 | 136 | 79 | 0 | **464** |
| `asset_category` | 12 | 11 | 12 | 9 | 0 | **44** |
| `asset_depreciation_line` | 955 | 633 | 902 | 493 | 0 | **2,983** |
| `asset_depreciation_run` | 36 | 39 | 44 | 42 | 0 | **161** |
| `asset_disposal` | 4 | 4 | 4 | 4 | 0 | **16** |
| `asset_downtime` | 32 | 13 | 26 | 11 | 0 | **82** |
| `asset_inspection` | 132 | 49 | 96 | 26 | 0 | **303** |
| `asset_maintenance_event` | 127 | 39 | 76 | 17 | 0 | **259** |
| `asset_maintenance_plan` | 75 | 25 | 42 | 6 | 0 | **148** |
| `attendance` | 2,193 | 1,530 | 1,428 | 1,134 | 0 | **6,285** |
| `attendance_event` | 192 | 132 | 108 | 92 | 0 | **524** |
| `audit_log` | 451 | 442 | 418 | 435 | 0 | **1,746** |
| `bank_account` | 3 | 3 | 3 | 3 | 0 | **12** |
| `bank_reconciliation` | 1 | 1 | 1 | 1 | 0 | **4** |
| `bank_statement` | 1 | 1 | 1 | 1 | 0 | **4** |
| `bank_statement_line` | 3 | 3 | 3 | 3 | 0 | **12** |
| `bom` | 0 | 0 | 46 | 0 | 0 | **46** |
| `bom_line` | 0 | 0 | 290 | 0 | 0 | **290** |
| `budget` | 3 | 3 | 3 | 3 | 0 | **12** |
| `budget_line` | 144 | 144 | 144 | 144 | 0 | **576** |
| `candidate` | 14 | 14 | 14 | 14 | 0 | **56** |
| `cash_advance` | 10 | 10 | 10 | 10 | 0 | **40** |
| `comment` | 426 | 476 | 316 | 477 | 0 | **1,695** |
| `company` | 1 | 1 | 1 | 1 | 0 | **4** |
| `config_revision` | 15 | 14 | 15 | 15 | 0 | **59** |
| `cost_centre` | 14 | 13 | 14 | 12 | 0 | **53** |
| `crm_automation` | 4 | 4 | 4 | 4 | 0 | **16** |
| `crm_automation_run` | 38 | 38 | 38 | 38 | 0 | **152** |
| `crm_campaign` | 5 | 5 | 5 | 5 | 0 | **20** |
| `crm_consent` | 54 | 478 | 46 | 77 | 0 | **655** |
| `crm_customer_signal` | 54 | 224 | 49 | 78 | 0 | **405** |
| `crm_deal_canvas` | 4 | 20 | 4 | 8 | 0 | **36** |
| `crm_discount` | 5 | 46 | 9 | 7 | 0 | **67** |
| `crm_forecast_snapshot` | 24 | 24 | 24 | 24 | 0 | **96** |
| `crm_merge` | 1 | 1 | 1 | 1 | 0 | **4** |
| `crm_opportunity_competitor` | 55 | 254 | 37 | 52 | 0 | **398** |
| `crm_opportunity_product` | 220 | 1,142 | 177 | 270 | 0 | **1,809** |
| `crm_opportunity_risk` | 111 | 474 | 82 | 91 | 0 | **758** |
| `crm_opportunity_stakeholder` | 141 | 695 | 126 | 152 | 0 | **1,114** |
| `crm_pipeline` | 1 | 2 | 1 | 2 | 0 | **6** |
| `crm_scenario` | 3 | 3 | 3 | 3 | 0 | **12** |
| `crm_suppression` | 6 | 45 | 5 | 8 | 0 | **64** |
| `crm_target` | 105 | 105 | 105 | 105 | 0 | **420** |
| `crm_territory` | 3 | 3 | 3 | 3 | 0 | **12** |
| `crm_touch` | 228 | 850 | 165 | 200 | 0 | **1,443** |
| `currency_rate` | 39 | 42 | 45 | 45 | 0 | **171** |
| `customer` | 140 | 1,250 | 120 | 200 | 0 | **1,710** |
| `customer_contact` | 279 | 2,499 | 240 | 399 | 0 | **3,417** |
| `customer_update` | 25 | 22 | 22 | 25 | 0 | **94** |
| `daily_report` | 428 | 359 | 327 | 452 | 0 | **1,566** |
| `department` | 14 | 13 | 14 | 12 | 0 | **53** |
| `digest` | 63 | 63 | 61 | 61 | 0 | **248** |
| `disciplinary_record` | 6 | 6 | 6 | 6 | 0 | **24** |
| `doc_comment` | 39 | 30 | 27 | 75 | 0 | **171** |
| `doc_document` | 80 | 60 | 55 | 150 | 0 | **345** |
| `doc_event` | 455 | 343 | 313 | 854 | 0 | **1,965** |
| `doc_folder` | 14 | 14 | 14 | 14 | 0 | **56** |
| `doc_form_link` | 7 | 5 | 5 | 14 | 0 | **31** |
| `doc_form_submission` | 14 | 10 | 10 | 28 | 0 | **62** |
| `doc_obligation` | 84 | 63 | 57 | 150 | 0 | **354** |
| `doc_revision` | 83 | 61 | 56 | 155 | 0 | **355** |
| `doc_saved_view` | 4 | 4 | 4 | 4 | 0 | **16** |
| `doc_signature_request` | 28 | 23 | 20 | 54 | 0 | **125** |
| `doc_signer` | 56 | 46 | 40 | 108 | 0 | **250** |
| `doc_snapshot` | 58 | 43 | 40 | 108 | 0 | **249** |
| `doc_template` | 8 | 8 | 8 | 8 | 0 | **32** |
| `doc_template_version` | 11 | 11 | 11 | 11 | 0 | **44** |
| `doc_workflow` | 2 | 2 | 2 | 2 | 0 | **8** |
| `doc_workflow_run` | 34 | 27 | 24 | 65 | 0 | **150** |
| `doc_workflow_step_run` | 93 | 75 | 66 | 179 | 0 | **413** |
| `document_share` | 9 | 48 | 9 | 12 | 0 | **78** |
| `domain_event` | 73 | 70 | 69 | 76 | 0 | **288** |
| `dunning_attempt` | 28 | 24 | 31 | 29 | 0 | **112** |
| `einvoice_channel` | 0 | 0 | 1 | 0 | 0 | **1** |
| `einvoice_document` | 0 | 0 | 6 | 0 | 0 | **6** |
| `einvoice_event` | 0 | 0 | 6 | 0 | 0 | **6** |
| `employee` | 45 | 34 | 36 | 30 | 0 | **145** |
| `employee_compensation` | 95 | 81 | 82 | 70 | 0 | **328** |
| `employee_contract` | 45 | 34 | 36 | 30 | 0 | **145** |
| `employee_event` | 180 | 162 | 151 | 138 | 0 | **631** |
| `employee_hr` | 45 | 34 | 36 | 30 | 0 | **145** |
| `employee_pay_component` | 111 | 85 | 125 | 82 | 0 | **403** |
| `employee_payment_instruction` | 45 | 34 | 36 | 30 | 0 | **145** |
| `employee_skill` | 89 | 68 | 73 | 57 | 0 | **287** |
| `employee_terms` | 45 | 34 | 36 | 29 | 0 | **144** |
| `establishment` | 0 | 0 | 2 | 0 | 0 | **2** |
| `establishment_privacy` | 0 | 0 | 4 | 0 | 0 | **4** |
| `establishment_registration` | 0 | 0 | 4 | 0 | 0 | **4** |
| `exception` | 64 | 123 | 52 | 51 | 0 | **290** |
| `expense_claim` | 49 | 29 | 35 | 26 | 0 | **139** |
| `expense_claim_line` | 98 | 72 | 82 | 58 | 0 | **310** |
| `file` | 15 | 15 | 15 | 15 | 0 | **60** |
| `fiscal_period` | 48 | 48 | 48 | 48 | 0 | **192** |
| `fiscal_year` | 4 | 4 | 4 | 4 | 0 | **16** |
| `gl_account` | 43 | 43 | 43 | 43 | 0 | **172** |
| `goods_receipt` | 207 | 790 | 175 | 33 | 0 | **1,205** |
| `goods_receipt_line` | 626 | 2,393 | 540 | 100 | 0 | **3,659** |
| `import_batch` | 1 | 1 | 1 | 1 | 0 | **4** |
| `import_row` | 20 | 80 | 20 | 20 | 0 | **140** |
| `invoice` | 260 | 1,250 | 200 | 300 | 0 | **2,010** |
| `invoice_line` | 523 | 2,516 | 398 | 583 | 0 | **4,020** |
| `issue` | 222 | 155 | 157 | 218 | 0 | **752** |
| `item` | 300 | 1,300 | 700 | 120 | 0 | **2,420** |
| `job` | 220 | 180 | 180 | 220 | 0 | **800** |
| `job_crew` | 456 | 347 | 345 | 436 | 0 | **1,584** |
| `job_preset` | 4 | 3 | 4 | 4 | 0 | **15** |
| `job_requisition` | 1 | 1 | 1 | 1 | 0 | **4** |
| `job_stage` | 1,320 | 900 | 1,260 | 1,320 | 0 | **4,800** |
| `journal_entry` | 101 | 101 | 101 | 101 | 0 | **404** |
| `journal_line` | 236 | 236 | 235 | 236 | 0 | **943** |
| `journal_template` | 4 | 4 | 4 | 4 | 0 | **16** |
| `lead` | 300 | 1,250 | 220 | 320 | 0 | **2,090** |
| `leave_ledger` | 1,100 | 765 | 877 | 696 | 0 | **3,438** |
| `leave_policy` | 6 | 6 | 7 | 6 | 0 | **25** |
| `leave_request` | 43 | 28 | 34 | 30 | 0 | **135** |
| `leave_type` | 6 | 6 | 7 | 6 | 0 | **25** |
| `manager_delegation` | 3 | 3 | 3 | 3 | 0 | **12** |
| `material_request` | 165 | 688 | 143 | 33 | 0 | **1,029** |
| `material_request_line` | 420 | 1,723 | 370 | 82 | 0 | **2,595** |
| `membership` | 9 | 9 | 9 | 9 | 0 | **36** |
| `notification` | 355 | 552 | 272 | 408 | 0 | **1,587** |
| `notification_preference` | 9 | 9 | 9 | 9 | 0 | **36** |
| `onboarding_state` | 3 | 3 | 3 | 3 | 0 | **12** |
| `opportunity` | 260 | 1,220 | 200 | 300 | 0 | **1,980** |
| `org_app_brand` | 1 | 1 | 1 | 1 | 0 | **4** |
| `org_branding` | 1 | 1 | 1 | 1 | 0 | **4** |
| `org_holiday_calendar` | 23 | 23 | 21 | 23 | 0 | **90** |
| `org_plan_state` | 1 | 1 | 1 | 1 | 0 | **4** |
| `org_storage_usage` | 1 | 1 | 1 | 1 | 0 | **4** |
| `overtime_request` | 23 | 19 | 21 | 17 | 0 | **80** |
| `pay_component_def` | 5 | 5 | 7 | 5 | 0 | **22** |
| `pay_group` | 2 | 2 | 2 | 2 | 0 | **8** |
| `pay_period` | 61 | 64 | 69 | 67 | 0 | **261** |
| `pay_run` | 25 | 25 | 25 | 25 | 0 | **100** |
| `pay_run_line` | 1,075 | 750 | 850 | 675 | 0 | **3,350** |
| `payment` | 287 | 1,286 | 213 | 328 | 0 | **2,114** |
| `payment_receipt` | 287 | 1,286 | 213 | 328 | 0 | **2,114** |
| `payslip` | 946 | 660 | 748 | 594 | 0 | **2,948** |
| `pipeline_stage` | 7 | 11 | 7 | 12 | 0 | **37** |
| `position` | 18 | 16 | 17 | 16 | 0 | **67** |
| `purchase_order` | 300 | 1,250 | 260 | 60 | 0 | **1,870** |
| `purchase_order_line` | 933 | 3,752 | 813 | 169 | 0 | **5,667** |
| `quote` | 180 | 1,250 | 220 | 260 | 0 | **1,910** |
| `quote_line` | 465 | 3,160 | 559 | 629 | 0 | **4,813** |
| `reference_sequence` | 16 | 15 | 12 | 16 | 0 | **59** |
| `report_labour_cost` | 812 | 672 | 591 | 818 | 0 | **2,893** |
| `report_labour_line` | 815 | 674 | 597 | 826 | 0 | **2,912** |
| `report_material_line` | 442 | 360 | 324 | 240 | 0 | **1,366** |
| `report_work_line` | 651 | 511 | 483 | 680 | 0 | **2,325** |
| `role_definition` | 7 | 7 | 7 | 7 | 0 | **28** |
| `sales_activity` | 1,690 | 7,501 | 1,297 | 2,170 | 0 | **12,658** |
| `schedule_assignment` | 11 | 12 | 12 | 7 | 0 | **42** |
| `share_token` | 12 | 12 | 11 | 11 | 0 | **46** |
| `shift` | 4 | 3 | 4 | 1 | 0 | **12** |
| `sign_in_log` | 50 | 50 | 50 | 50 | 0 | **200** |
| `skill` | 14 | 13 | 14 | 14 | 0 | **55** |
| `stock_balance` | 390 | 1,480 | 401 | 54 | 0 | **2,325** |
| `stock_cost_layer` | 613 | 2,307 | 526 | 92 | 0 | **3,538** |
| `stock_count` | 2 | 4 | 2 | 2 | 0 | **10** |
| `stock_count_line` | 10 | 21 | 10 | 11 | 0 | **52** |
| `stock_layer_consumption` | 63 | 50 | 33 | 24 | 0 | **170** |
| `stock_location` | 33 | 43 | 32 | 7 | 0 | **115** |
| `stock_lot` | 0 | 300 | 66 | 0 | 0 | **366** |
| `stock_lot_balance` | 0 | 300 | 66 | 0 | 0 | **366** |
| `stock_movement` | 710 | 2,395 | 608 | 157 | 0 | **3,870** |
| `stock_movement_lot` | 0 | 300 | 66 | 0 | 0 | **366** |
| `stock_movement_serial` | 476 | 452 | 20 | 0 | 0 | **948** |
| `stock_reservation` | 30 | 30 | 30 | 30 | 0 | **120** |
| `stock_serial` | 476 | 452 | 20 | 0 | 0 | **948** |
| `stock_transfer` | 6 | 15 | 6 | 0 | 0 | **27** |
| `stock_transfer_line` | 6 | 15 | 6 | 0 | 0 | **27** |
| `studio_baseline` | 8 | 6 | 6 | 12 | 0 | **32** |
| `studio_edge` | 1,220 | 830 | 878 | 1,922 | 0 | **4,850** |
| `studio_node` | 825 | 555 | 577 | 1,298 | 0 | **3,255** |
| `studio_plan` | 4 | 3 | 3 | 6 | 0 | **16** |
| `studio_scenario` | 9 | 8 | 8 | 14 | 0 | **39** |
| `studio_scenario_change` | 6 | 6 | 6 | 9 | 0 | **27** |
| `studio_version` | 8 | 6 | 6 | 12 | 0 | **32** |
| `studio_view` | 18 | 14 | 13 | 27 | 0 | **72** |
| `supplier` | 90 | 160 | 100 | 40 | 0 | **390** |
| `supplier_return` | 6 | 25 | 5 | 3 | 0 | **39** |
| `supplier_return_line` | 6 | 25 | 5 | 3 | 0 | **39** |
| `task` | 531 | 321 | 363 | 512 | 0 | **1,727** |
| `task_allocation` | 15 | 8 | 13 | 14 | 0 | **50** |
| `task_dependency` | 153 | 57 | 80 | 138 | 0 | **428** |
| `tax_code` | 5 | 5 | 4 | 5 | 0 | **19** |
| `tax_entry` | 23 | 23 | 0 | 23 | 0 | **69** |
| `tax_return` | 5 | 5 | 0 | 5 | 0 | **15** |
| `team` | 6 | 5 | 6 | 4 | 0 | **21** |
| `unit_of_measure` | 20 | 20 | 20 | 20 | 0 | **80** |
| `usage_event` | 24 | 24 | 24 | 24 | 0 | **96** |
| `warehouse` | 3 | 3 | 3 | 1 | 0 | **10** |
| `week_plan` | 65 | 64 | 66 | 63 | 0 | **258** |
| `week_plan_job` | 642 | 601 | 658 | 637 | 0 | **2,538** |
| `work_location` | 4 | 4 | 3 | 3 | 0 | **14** |
| `work_pattern` | 3 | 3 | 3 | 3 | 0 | **12** |

</details>

## Logins

No password exists for any of these accounts. `npm run lab:open -- <company> <persona>`
mints a one-time link that dies on first use.

| Persona | Role | Email pattern |
| --- | --- | --- |
| `owner` | owner | `h33.<company>.owner@pilot-lab.invalid` |
| `admin` | admin | `h33.<company>.admin@pilot-lab.invalid` |
| `manager` | manager | `h33.<company>.manager@pilot-lab.invalid` |
| `finance` | accounts | `h33.<company>.finance@pilot-lab.invalid` |
| `hr` | manager | `h33.<company>.hr@pilot-lab.invalid` |
| `warehouse` | procurement | `h33.<company>.warehouse@pilot-lab.invalid` |
| `field` | foreman | `h33.<company>.field@pilot-lab.invalid` |
| `restricted` | foreman | `h33.<company>.restricted@pilot-lab.invalid` |
| `auditor` | viewer | `h33.<company>.auditor@pilot-lab.invalid` |

## Volumes the profiles asked for

One company crosses the 1,205-row pagination boundary on each major
surface; the rest stay substantial without paying for it five times over.

| Knob | gulfbuild | tradeline | saudimfg | consult | facilico |
| --- | ---: | ---: | ---: | ---: | ---: |
| customers | 140 | 1,250 | 120 | 200 | 300 |
| suppliers | 90 | 160 | 100 | 40 | 80 |
| items | 300 | 1,300 | 700 | 120 | 350 |
| employees | 45 | 34 | 36 | 30 | 48 |
| projects | 130 | 100 | 100 | 130 | 200 |
| jobs | 220 | 180 | 180 | 220 | 1,210 |
| leads | 300 | 1,250 | 220 | 320 | 260 |
| opportunities | 260 | 1,220 | 200 | 300 | 230 |
| quotes | 180 | 1,250 | 220 | 260 | 260 |
| invoices | 260 | 1,250 | 200 | 300 | 420 |
| purchaseOrders | 300 | 1,250 | 260 | 60 | 220 |
| documents | 80 | 60 | 55 | 150 | 80 |
| assets | 80 | 45 | 65 | 35 | 110 |

## Cleanup

The lab is **retained** on purpose. When the owner is finished with it:

```bash
npm run lab:cleanup-preview          # shows exactly what would go
npx tsx tooling/pilot-lab/cleanup.ts --confirm "delete-the-five-h33-companies-in-zwnnqaryouevnzuwtyaj"
```

It deletes only organisations carrying `h33.pilot_lab` at seed
version `1.0.0`, refuses to run unless exactly five are
found, and re-checks the marker inside the transaction.

Organisation ids it will accept:

- `17be9c8a-3b2e-4533-b24f-13b22de1ede2`
- `65327dcc-d0b8-4b80-9fc4-9714288fbebf`
- `738be7c6-04f8-477a-b348-07d6e279fe2c`
- `e172fd58-b511-4c17-9cad-32d73ab39791`
- `af67d571-b154-469c-988e-04acfaa933e2`

