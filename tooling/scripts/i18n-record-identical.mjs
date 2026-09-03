/**
 * H29 — record, once and explicitly, every string in a translated catalogue that
 * is legitimately byte-identical to its English one: product names, standard
 * acronyms, bare ICU placeholders, keyboard shortcuts, and the words the
 * language happens to share with English.
 *
 *   node tooling/scripts/i18n-record-identical.mjs <locale>
 *
 * The parity test then needs no cleverness: an identical value is untranslated
 * UNLESS it is listed in <locale>.same.json. That keeps "a translator looked at
 * this and left it" a recorded fact rather than something a regular expression
 * guesses at afresh on every run.
 *
 * Keys the rule cannot explain are REPORTED, never recorded. Those need a person
 * to look at them and add them deliberately, which is the point of the file.
 */
import fs from "node:fs";
import { LEGITIMATELY_IDENTICAL } from "./i18n-identical.mjs";

const locale = process.argv[2];
if (!locale || !/^[a-z]{2}$/.test(locale)) {
  console.error("usage: i18n-record-identical.mjs <locale>");
  process.exit(1);
}

const EN = "src/platform/i18n/messages/en.json";
const TARGET = `src/platform/i18n/messages/${locale}.json`;
const SAME = `src/platform/i18n/messages/${locale}.same.json`;

const en = JSON.parse(fs.readFileSync(EN, "utf8"));
const target = JSON.parse(fs.readFileSync(TARGET, "utf8"));
const same = new Set(fs.existsSync(SAME) ? JSON.parse(fs.readFileSync(SAME, "utf8")) : []);

const unexplained = [];
let added = 0;
for (const [key, value] of Object.entries(en)) {
  if (target[key] !== value) continue;
  if (same.has(key)) continue;
  if (!LEGITIMATELY_IDENTICAL(value)) {
    unexplained.push(`${key} = ${JSON.stringify(value)}`);
    continue;
  }
  same.add(key);
  added++;
}

fs.writeFileSync(SAME, `${JSON.stringify([...same].sort(), null, 2)}\n`);
console.log(`${locale}: recorded ${added} legitimately identical key(s), ${same.size} total`);
if (unexplained.length > 0) {
  console.error(`${unexplained.length} identical key(s) with no explanation:`);
  for (const line of unexplained) console.error(`  ${line}`);
  process.exit(1);
}
