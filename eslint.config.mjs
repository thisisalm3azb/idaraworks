import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import boundaries from "eslint-plugin-boundaries";
import noHardcodedDomainNouns from "./tooling/eslint-rules/no-hardcoded-domain-nouns.mjs";
import noInlineAuditWrites from "./tooling/eslint-rules/no-inline-audit-writes.mjs";

/**
 * IdaraWorks lint law (BUILD_BIBLE §3, §5, §19).
 * Boundary violations and tenancy tripwires are build failures, not warnings.
 */
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "node_modules/**",
    "playwright-report/**",
    "test-results/**",
    "coverage/**",
  ]),

  // Register the local plugin namespace ONCE — flat config forbids redefining a
  // plugin key across config blocks. The rule blocks below reference these.
  {
    plugins: {
      idaraworks: {
        rules: {
          "no-hardcoded-domain-nouns": noHardcodedDomainNouns,
          "no-inline-audit-writes": noInlineAuditWrites,
        },
      },
    },
  },

  // ── Module boundaries (BUILD_BIBLE §3.3–§3.4) ─────────────────────────────
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { boundaries },
    settings: {
      "boundaries/elements": [
        {
          type: "module-service",
          pattern: "src/modules/*/service.ts",
          mode: "file",
          capture: ["moduleName"],
        },
        { type: "module", pattern: "src/modules/*", capture: ["moduleName"] },
        { type: "platform", pattern: "src/platform" },
        { type: "lib", pattern: "src/lib" },
        { type: "workers", pattern: "src/workers" },
        { type: "app", pattern: "src/app" },
      ],
      "boundaries/include": ["src/**/*"],
    },
    rules: {
      "boundaries/element-types": [
        "error",
        {
          default: "disallow",
          message:
            "Boundary violation (BUILD_BIBLE §3.3): this layer may not import that target. Modules talk to other modules only via their service.ts or domain events; platform never imports modules; lib imports nothing but lib.",
          policies: [
            // Review finding #4: app must not reach module internals (repositories) —
            // service.ts is each module's only public surface (BUILD_BIBLE §3.2).
            // A `module-components` element joins this list when module UI arrives (S2).
            { from: ["app"], allow: ["platform", "lib", "module-service"] },
            { from: ["platform"], allow: ["platform", "lib"] },
            { from: ["lib"], allow: ["lib"] },
            {
              from: ["module"],
              allow: [
                "platform",
                "lib",
                "module-service",
                ["module", { moduleName: "{{from.moduleName}}" }],
              ],
            },
            {
              from: ["module-service"],
              allow: [
                "platform",
                "lib",
                "module-service",
                ["module", { moduleName: "{{from.moduleName}}" }],
              ],
            },
            { from: ["workers"], allow: ["platform", "lib", "module-service"] },
          ],
        },
      ],
    },
  },

  // ── Tenancy tripwire: raw data clients only inside the tenancy layer ──────
  // (phase2/10 item 3; drivers are not installed yet — this rule is armed ahead of Phase B.)
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/platform/tenancy/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "postgres",
              message: "Data access only via src/platform/tenancy (phase2/10 #3).",
            },
            { name: "pg", message: "Data access only via src/platform/tenancy (phase2/10 #3)." },
            {
              name: "drizzle-orm",
              message: "Data access only via src/platform/tenancy (phase2/10 #3).",
            },
            {
              name: "@supabase/supabase-js",
              message:
                "Supabase clients are constructed only in src/platform/tenancy (phase2/10 #1, #3).",
            },
          ],
          patterns: [
            {
              group: ["drizzle-orm/*"],
              message: "Data access only via src/platform/tenancy (phase2/10 #3).",
            },
            {
              group: ["@supabase/*"],
              message:
                "Supabase clients (incl. ssr/postgrest) are constructed only in src/platform/tenancy (phase2/10 #1, #3).",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          // Static-import bans are bypassable via dynamic import().
          selector:
            "ImportExpression > Literal[value=/^(postgres$|pg$|drizzle-orm|@supabase\\u002F)/]",
          message:
            "Dynamic import of data clients is banned outside src/platform/tenancy (phase2/10 #3).",
        },
        {
          // A-B5 pool law: the shared appDb() pool is for withCtx TRANSACTIONS
          // only; bare .execute()/.query() on it can stall the postgres.js queue
          // after an aborted transaction. One-off unscoped needs use a dedicated
          // createAppDb({max:1}) client. (appDb().transaction(...) is fine.)
          selector:
            "CallExpression[callee.object.callee.name='appDb'][callee.property.name=/^(execute|query)$/]",
          message:
            "A-B5: never call .execute()/.query() directly on appDb(); use withCtx (transaction) or a dedicated createAppDb({max:1}) client.",
        },
      ],
    },
  },

  // ── Audit-writer tripwire (BUILD_BIBLE §4 item 5, §19 "the unlogged mutation") ──
  // The audit_log / activity tables are written ONLY through the command path in
  // src/platform/audit (and the two SECURITY DEFINER bootstrap functions in SQL
  // migrations, which lint does not cover). A feature that inlines the insert
  // bypasses the atomic single-writer guarantee — fail the build. A dedicated
  // rule key (not no-restricted-syntax) so it composes with the tenancy tripwires
  // above instead of overriding them.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/platform/audit/**"],
    rules: {
      "idaraworks/no-inline-audit-writes": "error",
    },
  },

  // ── UI rules ──────────────────────────────────────────────────────────────
  {
    files: ["src/**/*.tsx"],
    ignores: ["**/*.test.tsx", "**/*.spec.tsx"],
    rules: {
      "idaraworks/no-hardcoded-domain-nouns": "error",
      "react/no-danger": "error",
    },
  },
]);

export default eslintConfig;
