# H33 — Pilot Lab data manifest

Generated from `.pilot-lab/manifest.json` by `npx tsx tooling/pilot-lab/report.ts`.
Every figure below is counted from the database, not estimated.

- **Seed version** `1.0.0`
- **Generated** 2026-09-06T08:33:00.518Z
- **Test project** `zwnnqaryouevnzuwtyaj` (the isolated project; production is refused by construction)
- **Login domain** `pilot-lab.invalid` — reserved, cannot receive mail
- **History** 2023-09-01 → 2026-09-05
- **Completeness checksum** `86d289b0818deddb4d7eed9f7138ef6379e5e261616702463a5439c50a86f050`

## Totals

| | |
| --- | --- |
| Rows written | **204,614** |
| Database before | 104.3 MB |
| Database after | **180.3 MB** |
| Growth | 76.0 MB |
| Storage objects | 0.0 MB |
| Ceiling | 300.0 MB (the seeder stops rather than pass it) |

## The five companies

| Company | Organisation | Rows | Families |
| --- | --- | --- | --- |
| **Marjan Gulf Contracting** · مرجان الخليج للمقاولات<br>`gulfbuild` | `4fa7a5d2-f558-4d1e-b552-aefc18e76047` | 32,789 | 15/15 |
| **Sadaf Trading & Distribution** · صدف للتجارة والتوزيع<br>`tradeline` | `aaeb0721-033a-4aca-9c54-3c3f62ac8b24` | 66,562 | 15/15 |
| **Nakhla Precision Manufacturing** · نخلة للصناعات الدقيقة<br>`saudimfg` | `b9162e93-bfcc-43f6-b768-b4b50d994115` | 27,379 | 15/15 |
| **Bayan Advisory Partners** · بيان للاستشارات<br>`consult` | `fe057682-4186-48f9-bd1a-d86cfa863c00` | 28,453 | 15/15 |
| **Rukn Facilities & Maintenance** · ركن للمرافق والصيانة<br>`facilico` | `00f6f44c-cb3e-4870-9d22-bbbde3f604ee` | 49,431 | 15/15 |

## Rows by family

| Family | gulfbuild | tradeline | saudimfg | consult | facilico | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `assets` | 1,502 | 849 | 1,312 | 656 | 2,031 | **6,350** |
| `country` | 5 | 5 | 22 | 5 | 5 | **42** |
| `crm` | 3,251 | 13,859 | 2,549 | 3,831 | 2,948 | **26,438** |
| `docstudio` | 1,057 | 812 | 739 | 1,966 | 1,057 | **5,631** |
| `finance` | 349 | 349 | 344 | 349 | 349 | **1,740** |
| `hr` | 5,776 | 4,041 | 4,240 | 3,378 | 6,032 | **23,467** |
| `masters` | 869 | 5,732 | 1,547 | 844 | 1,457 | **10,449** |
| `misc` | 1,027 | 1,788 | 828 | 1,223 | 1,896 | **6,762** |
| `people` | 691 | 554 | 614 | 491 | 753 | **3,103** |
| `sales` | 2,334 | 11,116 | 2,114 | 2,763 | 3,516 | **21,843** |
| `setup` | 350 | 364 | 367 | 325 | 354 | **1,760** |
| `stock` | 2,055 | 8,122 | 1,860 | 370 | 1,447 | **13,854** |
| `studio` | 2,103 | 1,435 | 1,504 | 3,308 | 2,576 | **10,926** |
| `supply` | 2,663 | 10,646 | 2,311 | 483 | 1,928 | **18,031** |
| `work` | 7,242 | 5,567 | 5,824 | 7,017 | 20,872 | **46,522** |

## Rows by table

<details><summary>Every table the lab wrote, counted live</summary>

| Table | gulfbuild | tradeline | saudimfg | consult | facilico | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `activity` | 1,267 | 1,422 | 971 | 1,352 | 4,005 | **9,017** |
| `ai_credit_ledger` | 2 | 2 | 2 | 2 | 2 | **10** |
| `ai_entitlement` | 2 | 2 | 2 | 2 | 2 | **10** |
| `ai_privacy_register` | 1 | 1 | 1 | 1 | 1 | **5** |
| `app_settings` | 30 | 30 | 29 | 30 | 30 | **149** |
| `approval` | 28 | 17 | 22 | 30 | 28 | **125** |
| `approval_rule` | 1 | 1 | 1 | 1 | 1 | **5** |
| `asset` | 80 | 45 | 65 | 35 | 110 | **335** |
| `asset_assignment` | 171 | 78 | 136 | 79 | 202 | **666** |
| `asset_category` | 12 | 11 | 12 | 9 | 11 | **55** |
| `asset_depreciation_line` | 955 | 633 | 902 | 493 | 1,307 | **4,290** |
| `asset_depreciation_run` | 36 | 39 | 44 | 42 | 36 | **197** |
| `asset_disposal` | 4 | 4 | 4 | 4 | 6 | **22** |
| `asset_downtime` | 32 | 13 | 26 | 11 | 41 | **123** |
| `asset_inspection` | 132 | 49 | 96 | 26 | 163 | **466** |
| `asset_maintenance_event` | 127 | 39 | 76 | 17 | 196 | **455** |
| `asset_maintenance_plan` | 75 | 25 | 42 | 6 | 89 | **237** |
| `attendance` | 2,193 | 1,530 | 1,428 | 1,134 | 2,295 | **8,580** |
| `attendance_event` | 192 | 132 | 108 | 92 | 206 | **730** |
| `audit_log` | 449 | 438 | 414 | 431 | 477 | **2,209** |
| `bank_account` | 3 | 3 | 3 | 3 | 3 | **15** |
| `bank_reconciliation` | 1 | 1 | 1 | 1 | 1 | **5** |
| `bank_statement` | 1 | 1 | 1 | 1 | 1 | **5** |
| `bank_statement_line` | 3 | 3 | 3 | 3 | 3 | **15** |
| `bom` | 0 | 0 | 46 | 0 | 0 | **46** |
| `bom_line` | 0 | 0 | 290 | 0 | 0 | **290** |
| `budget` | 3 | 3 | 3 | 3 | 3 | **15** |
| `budget_line` | 144 | 144 | 144 | 144 | 144 | **720** |
| `candidate` | 14 | 14 | 14 | 14 | 14 | **70** |
| `cash_advance` | 10 | 10 | 10 | 10 | 10 | **50** |
| `comment` | 426 | 476 | 316 | 477 | 847 | **2,542** |
| `company` | 1 | 1 | 1 | 1 | 1 | **5** |
| `config_revision` | 15 | 14 | 15 | 15 | 15 | **74** |
| `cost_centre` | 14 | 13 | 14 | 12 | 13 | **66** |
| `crm_automation` | 4 | 4 | 4 | 4 | 4 | **20** |
| `crm_automation_run` | 38 | 38 | 38 | 38 | 38 | **190** |
| `crm_campaign` | 5 | 5 | 5 | 5 | 5 | **25** |
| `crm_consent` | 54 | 478 | 46 | 77 | 115 | **770** |
| `crm_customer_signal` | 54 | 224 | 49 | 78 | 127 | **532** |
| `crm_deal_canvas` | 4 | 20 | 4 | 8 | 4 | **40** |
| `crm_discount` | 5 | 46 | 9 | 7 | 4 | **71** |
| `crm_forecast_snapshot` | 24 | 24 | 24 | 24 | 24 | **120** |
| `crm_merge` | 1 | 1 | 1 | 1 | 1 | **5** |
| `crm_opportunity_competitor` | 55 | 254 | 37 | 52 | 47 | **445** |
| `crm_opportunity_product` | 220 | 1,142 | 177 | 270 | 200 | **2,009** |
| `crm_opportunity_risk` | 111 | 474 | 82 | 91 | 85 | **843** |
| `crm_opportunity_stakeholder` | 141 | 695 | 126 | 152 | 135 | **1,249** |
| `crm_pipeline` | 1 | 2 | 1 | 2 | 2 | **8** |
| `crm_scenario` | 3 | 3 | 3 | 3 | 3 | **15** |
| `crm_suppression` | 6 | 45 | 5 | 8 | 12 | **76** |
| `crm_target` | 105 | 105 | 105 | 105 | 105 | **525** |
| `crm_territory` | 3 | 3 | 3 | 3 | 3 | **15** |
| `crm_touch` | 228 | 850 | 165 | 200 | 166 | **1,609** |
| `currency_rate` | 39 | 42 | 45 | 45 | 39 | **210** |
| `customer` | 140 | 1,250 | 120 | 200 | 300 | **2,010** |
| `customer_contact` | 279 | 2,499 | 240 | 399 | 600 | **4,017** |
| `customer_update` | 25 | 22 | 22 | 25 | 44 | **138** |
| `daily_report` | 428 | 359 | 327 | 452 | 822 | **2,388** |
| `department` | 14 | 13 | 14 | 12 | 13 | **66** |
| `digest` | 63 | 63 | 61 | 61 | 63 | **311** |
| `disciplinary_record` | 6 | 6 | 6 | 6 | 6 | **30** |
| `doc_comment` | 39 | 30 | 27 | 75 | 39 | **210** |
| `doc_document` | 80 | 60 | 55 | 150 | 80 | **425** |
| `doc_event` | 455 | 343 | 313 | 854 | 455 | **2,420** |
| `doc_folder` | 14 | 14 | 14 | 14 | 14 | **70** |
| `doc_form_link` | 7 | 5 | 5 | 14 | 7 | **38** |
| `doc_form_submission` | 14 | 10 | 10 | 28 | 14 | **76** |
| `doc_obligation` | 84 | 63 | 57 | 150 | 84 | **438** |
| `doc_revision` | 83 | 61 | 56 | 155 | 83 | **438** |
| `doc_saved_view` | 4 | 4 | 4 | 4 | 4 | **20** |
| `doc_signature_request` | 28 | 23 | 20 | 54 | 28 | **153** |
| `doc_signer` | 56 | 46 | 40 | 108 | 56 | **306** |
| `doc_snapshot` | 58 | 43 | 40 | 108 | 58 | **307** |
| `doc_template` | 8 | 8 | 8 | 8 | 8 | **40** |
| `doc_template_version` | 11 | 11 | 11 | 11 | 11 | **55** |
| `doc_workflow` | 2 | 2 | 2 | 2 | 2 | **10** |
| `doc_workflow_run` | 34 | 27 | 24 | 65 | 34 | **184** |
| `doc_workflow_step_run` | 93 | 75 | 66 | 179 | 93 | **506** |
| `document_share` | 9 | 48 | 9 | 12 | 14 | **92** |
| `domain_event` | 73 | 70 | 69 | 76 | 81 | **369** |
| `dunning_attempt` | 28 | 24 | 31 | 29 | 26 | **138** |
| `einvoice_channel` | 0 | 0 | 1 | 0 | 0 | **1** |
| `einvoice_document` | 0 | 0 | 6 | 0 | 0 | **6** |
| `einvoice_event` | 0 | 0 | 6 | 0 | 0 | **6** |
| `employee` | 45 | 34 | 36 | 30 | 48 | **193** |
| `employee_compensation` | 95 | 81 | 82 | 70 | 106 | **434** |
| `employee_contract` | 45 | 34 | 36 | 30 | 48 | **193** |
| `employee_event` | 180 | 162 | 151 | 138 | 216 | **847** |
| `employee_hr` | 45 | 34 | 36 | 30 | 48 | **193** |
| `employee_pay_component` | 111 | 85 | 125 | 82 | 116 | **519** |
| `employee_payment_instruction` | 45 | 34 | 36 | 30 | 48 | **193** |
| `employee_skill` | 89 | 68 | 73 | 57 | 101 | **388** |
| `employee_terms` | 45 | 34 | 36 | 29 | 48 | **192** |
| `establishment` | 0 | 0 | 2 | 0 | 0 | **2** |
| `establishment_privacy` | 0 | 0 | 4 | 0 | 0 | **4** |
| `establishment_registration` | 0 | 0 | 4 | 0 | 0 | **4** |
| `exception` | 64 | 123 | 52 | 51 | 168 | **458** |
| `expense_claim` | 49 | 29 | 35 | 26 | 34 | **173** |
| `expense_claim_line` | 98 | 72 | 82 | 58 | 95 | **405** |
| `file` | 15 | 15 | 15 | 15 | 15 | **75** |
| `fiscal_period` | 48 | 48 | 48 | 48 | 48 | **240** |
| `fiscal_year` | 4 | 4 | 4 | 4 | 4 | **20** |
| `gl_account` | 43 | 43 | 43 | 43 | 43 | **215** |
| `goods_receipt` | 207 | 790 | 175 | 33 | 140 | **1,345** |
| `goods_receipt_line` | 626 | 2,393 | 540 | 100 | 444 | **4,103** |
| `import_batch` | 1 | 1 | 1 | 1 | 1 | **5** |
| `import_row` | 20 | 80 | 20 | 20 | 30 | **170** |
| `invoice` | 260 | 1,250 | 200 | 300 | 420 | **2,430** |
| `invoice_line` | 523 | 2,516 | 398 | 583 | 907 | **4,927** |
| `issue` | 222 | 155 | 157 | 218 | 342 | **1,094** |
| `item` | 300 | 1,300 | 700 | 120 | 350 | **2,770** |
| `job` | 220 | 180 | 180 | 220 | 1,210 | **2,010** |
| `job_crew` | 456 | 347 | 345 | 436 | 1,205 | **2,789** |
| `job_preset` | 4 | 3 | 4 | 4 | 4 | **19** |
| `job_requisition` | 1 | 1 | 1 | 1 | 1 | **5** |
| `job_stage` | 1,320 | 900 | 1,260 | 1,320 | 7,260 | **12,060** |
| `journal_entry` | 101 | 101 | 101 | 101 | 101 | **505** |
| `journal_line` | 236 | 236 | 235 | 236 | 236 | **1,179** |
| `journal_template` | 4 | 4 | 4 | 4 | 4 | **20** |
| `lead` | 300 | 1,250 | 220 | 320 | 260 | **2,350** |
| `leave_ledger` | 1,100 | 765 | 877 | 696 | 1,153 | **4,591** |
| `leave_policy` | 6 | 6 | 7 | 6 | 6 | **31** |
| `leave_request` | 43 | 28 | 34 | 30 | 49 | **184** |
| `leave_type` | 6 | 6 | 7 | 6 | 6 | **31** |
| `manager_delegation` | 3 | 3 | 3 | 3 | 4 | **16** |
| `material_request` | 165 | 688 | 143 | 33 | 121 | **1,150** |
| `material_request_line` | 420 | 1,723 | 370 | 82 | 298 | **2,893** |
| `membership` | 9 | 9 | 9 | 9 | 9 | **45** |
| `notification` | 355 | 552 | 272 | 408 | 581 | **2,168** |
| `notification_preference` | 9 | 9 | 9 | 9 | 9 | **45** |
| `onboarding_state` | 3 | 3 | 3 | 3 | 3 | **15** |
| `opportunity` | 260 | 1,220 | 200 | 300 | 230 | **2,210** |
| `org_app_brand` | 1 | 1 | 1 | 1 | 1 | **5** |
| `org_branding` | 1 | 1 | 1 | 1 | 1 | **5** |
| `org_holiday_calendar` | 23 | 23 | 21 | 23 | 23 | **113** |
| `org_plan_state` | 1 | 1 | 1 | 1 | 1 | **5** |
| `org_storage_usage` | 1 | 1 | 1 | 1 | 1 | **5** |
| `overtime_request` | 23 | 19 | 21 | 17 | 29 | **109** |
| `pay_component_def` | 5 | 5 | 7 | 5 | 5 | **27** |
| `pay_group` | 2 | 2 | 2 | 2 | 2 | **10** |
| `pay_period` | 37 | 40 | 45 | 43 | 37 | **202** |
| `pay_run` | 25 | 25 | 25 | 25 | 25 | **125** |
| `pay_run_line` | 1,075 | 750 | 850 | 675 | 1,125 | **4,475** |
| `payment` | 287 | 1,286 | 213 | 328 | 454 | **2,568** |
| `payment_receipt` | 287 | 1,286 | 213 | 328 | 454 | **2,568** |
| `payslip` | 946 | 660 | 748 | 594 | 990 | **3,938** |
| `pipeline_stage` | 7 | 11 | 7 | 12 | 12 | **49** |
| `position` | 18 | 16 | 17 | 16 | 18 | **85** |
| `purchase_order` | 300 | 1,250 | 260 | 60 | 220 | **2,090** |
| `purchase_order_line` | 933 | 3,752 | 813 | 169 | 697 | **6,364** |
| `quote` | 180 | 1,250 | 220 | 260 | 260 | **2,170** |
| `quote_line` | 465 | 3,160 | 559 | 629 | 668 | **5,481** |
| `reference_sequence` | 16 | 15 | 12 | 16 | 16 | **75** |
| `report_labour_cost` | 812 | 672 | 591 | 818 | 1,432 | **4,325** |
| `report_labour_line` | 815 | 674 | 597 | 826 | 1,435 | **4,347** |
| `report_material_line` | 442 | 360 | 324 | 240 | 767 | **2,133** |
| `report_work_line` | 651 | 511 | 483 | 680 | 1,167 | **3,492** |
| `role_definition` | 7 | 7 | 7 | 7 | 7 | **35** |
| `sales_activity` | 1,690 | 7,501 | 1,297 | 2,170 | 1,507 | **14,165** |
| `schedule_assignment` | 11 | 12 | 12 | 7 | 12 | **54** |
| `share_token` | 12 | 12 | 11 | 11 | 20 | **66** |
| `shift` | 4 | 3 | 4 | 1 | 4 | **16** |
| `sign_in_log` | 50 | 50 | 50 | 50 | 50 | **250** |
| `skill` | 14 | 13 | 14 | 14 | 14 | **69** |
| `stock_balance` | 391 | 1,480 | 401 | 54 | 296 | **2,622** |
| `stock_cost_layer` | 613 | 2,307 | 526 | 92 | 437 | **3,975** |
| `stock_count` | 2 | 4 | 2 | 2 | 2 | **12** |
| `stock_count_line` | 10 | 21 | 10 | 11 | 9 | **61** |
| `stock_layer_consumption` | 59 | 51 | 33 | 24 | 63 | **230** |
| `stock_location` | 33 | 43 | 32 | 7 | 35 | **150** |
| `stock_lot` | 0 | 300 | 66 | 0 | 0 | **366** |
| `stock_lot_balance` | 0 | 300 | 66 | 0 | 0 | **366** |
| `stock_movement` | 708 | 2,395 | 608 | 157 | 530 | **4,398** |
| `stock_movement_lot` | 0 | 300 | 66 | 0 | 0 | **366** |
| `stock_movement_serial` | 115 | 452 | 20 | 0 | 34 | **621** |
| `stock_reservation` | 30 | 30 | 30 | 30 | 30 | **150** |
| `stock_serial` | 115 | 452 | 20 | 0 | 34 | **621** |
| `stock_transfer` | 6 | 15 | 6 | 0 | 6 | **33** |
| `stock_transfer_line` | 6 | 15 | 6 | 0 | 6 | **33** |
| `studio_baseline` | 8 | 6 | 6 | 12 | 8 | **40** |
| `studio_edge` | 1,220 | 830 | 878 | 1,922 | 1,506 | **6,356** |
| `studio_node` | 825 | 555 | 577 | 1,298 | 1,009 | **4,264** |
| `studio_plan` | 4 | 3 | 3 | 6 | 4 | **20** |
| `studio_scenario` | 9 | 8 | 8 | 14 | 10 | **49** |
| `studio_scenario_change` | 6 | 6 | 6 | 9 | 9 | **36** |
| `studio_version` | 8 | 6 | 6 | 12 | 8 | **40** |
| `studio_view` | 18 | 14 | 13 | 27 | 15 | **87** |
| `supplier` | 90 | 160 | 100 | 40 | 80 | **470** |
| `supplier_return` | 6 | 25 | 5 | 3 | 4 | **43** |
| `supplier_return_line` | 6 | 25 | 5 | 3 | 4 | **43** |
| `task` | 531 | 321 | 363 | 512 | 1,896 | **3,623** |
| `task_allocation` | 15 | 8 | 13 | 14 | 11 | **61** |
| `task_dependency` | 153 | 57 | 80 | 138 | 122 | **550** |
| `tax_code` | 5 | 5 | 4 | 5 | 5 | **24** |
| `tax_entry` | 23 | 23 | 0 | 23 | 23 | **92** |
| `tax_return` | 5 | 5 | 0 | 5 | 5 | **20** |
| `team` | 6 | 5 | 6 | 4 | 6 | **27** |
| `unit_of_measure` | 20 | 20 | 20 | 20 | 20 | **100** |
| `usage_event` | 24 | 24 | 24 | 24 | 24 | **120** |
| `warehouse` | 3 | 3 | 3 | 1 | 3 | **13** |
| `week_plan` | 65 | 64 | 66 | 63 | 64 | **322** |
| `week_plan_job` | 642 | 601 | 658 | 637 | 662 | **3,200** |
| `work_location` | 4 | 4 | 3 | 3 | 3 | **17** |
| `work_pattern` | 3 | 3 | 3 | 3 | 3 | **15** |

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

- `4fa7a5d2-f558-4d1e-b552-aefc18e76047`
- `aaeb0721-033a-4aca-9c54-3c3f62ac8b24`
- `b9162e93-bfcc-43f6-b768-b4b50d994115`
- `fe057682-4186-48f9-bd1a-d86cfa863c00`
- `00f6f44c-cb3e-4870-9d22-bbbde3f604ee`

