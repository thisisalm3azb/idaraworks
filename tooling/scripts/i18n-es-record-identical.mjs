/**
 * H29 — record, once and explicitly, every Spanish string that is legitimately
 * byte-identical to its English one: product names, standard acronyms, bare ICU
 * placeholders and the words Spanish shares with English.
 *
 * The parity test then needs no cleverness: an identical value is untranslated
 * UNLESS it is listed here. That keeps "reviewed and left alone" a recorded
 * fact rather than something a regular expression guesses at each run.
 */
import fs from "node:fs";
import { LEGITIMATELY_IDENTICAL } from "./i18n-identical.mjs";

const EN = "src/platform/i18n/messages/en.json";
const ES = "src/platform/i18n/messages/es.json";
const SAME = "src/platform/i18n/messages/es.same.json";

const en = JSON.parse(fs.readFileSync(EN, "utf8"));
const es = JSON.parse(fs.readFileSync(ES, "utf8"));
const same = new Set(JSON.parse(fs.readFileSync(SAME, "utf8")));

const unexplained = [];
let added = 0;
for (const [key, value] of Object.entries(en)) {
  if (es[key] !== value) continue;
  if (same.has(key)) continue;
  if (!LEGITIMATELY_IDENTICAL(value)) {
    unexplained.push(`${key} = ${JSON.stringify(value)}`);
    continue;
  }
  same.add(key);
  added++;
}

fs.writeFileSync(SAME, `${JSON.stringify([...same].sort(), null, 2)}\n`);
console.log(`recorded ${added} legitimately identical key(s), ${same.size} total`);
if (unexplained.length > 0) {
  console.error(`${unexplained.length} identical key(s) with no explanation:`);
  for (const line of unexplained) console.error(`  ${line}`);
  process.exit(1);
}
