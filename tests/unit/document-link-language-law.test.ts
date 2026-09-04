/**
 * H30 LB-6 — a document link must carry the language it is going to render in.
 *
 * The document route defaults to English when no `lang` parameter is present.
 * Several links omitted it, so an Arabic-speaking user reading an Arabic invoice
 * pressed "Download PDF" and received an English document with no indication
 * that anything had changed. In Document Studio, Print and Download PDF sat side
 * by side and disagreed: Print carried the language, the PDF did not.
 *
 * This is a source scan rather than a render test on purpose. The defect was
 * never in the renderer — it was in the URL a button pointed at, and the only
 * way it comes back is somebody writing another link that forgets. So the rule
 * is enforced where it is broken: on the href.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP_DIR = join(process.cwd(), "src", "app");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * Links into the RECORD document route — `/api/o/<org>/documents/<kind>/<id>`.
 *
 * Scoped to that one route because it is the one that defaults to English when
 * no language is given. Two other PDF producers exist and neither has the
 * defect: the revenue report reads the locale from the request cookie, and
 * Document Studio renders the document's own stored language, which is the right
 * answer for an authored document — an issued contract does not change language
 * because of who opens it.
 */
function pdfLinks(): Array<{ file: string; snippet: string }> {
  const found: Array<{ file: string; snippet: string }> = [];
  for (const file of walk(APP_DIR)) {
    // The API route itself reads the parameter; it is not a link.
    if (file.includes(join("app", "api"))) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/href=\{`([^`]*format=pdf[^`]*)`\}/g)) {
      const snippet = m[1]!;
      if (!/\/documents\//.test(snippet) && !/\$\{(withLang|docLink)/.test(snippet)) continue;
      if (/\/documents\/studio\//.test(snippet)) continue;
      found.push({ file: file.replace(process.cwd(), ""), snippet });
    }
  }
  return found;
}

describe("document links", () => {
  it("finds the PDF links it is meant to be checking", () => {
    // A scan that silently matches nothing would pass forever.
    expect(pdfLinks().length).toBeGreaterThan(5);
  });

  it("every PDF link carries a language", () => {
    const offenders = pdfLinks().filter(
      // Either a literal lang=, or a variable that resolves to one — both forms
      // appear in the codebase and both are acceptable.
      (l) => !/[?&]lang=/.test(l.snippet) && !/\$\{(withLang|docLink)/.test(l.snippet),
    );
    expect(
      offenders.map((o) => `${o.file}: ${o.snippet}`),
      "a PDF link with no language renders English whatever the reader chose",
    ).toEqual([]);
  });

  it("no PDF link hard-codes a language that ignores the reader", () => {
    // `lang=en` and `lang=ar` are legitimate where a screen deliberately offers
    // BOTH as separate buttons (payslips do). They are a defect where a screen
    // offers only one. Both payslip surfaces offer the pair, so a file carrying
    // a hard-coded language must carry both.
    const byFile = new Map<string, string[]>();
    for (const l of pdfLinks()) {
      const m = /[?&]lang=(en|ar)\b/.exec(l.snippet);
      if (m) byFile.set(l.file, [...(byFile.get(l.file) ?? []), m[1]!]);
    }
    for (const [file, langs] of byFile) {
      expect(
        [...new Set(langs)].sort(),
        `${file} hard-codes a document language without offering the other`,
      ).toEqual(["ar", "en"]);
    }
  });
});
