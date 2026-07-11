import postgres from "postgres";

/** Owner connection (DIRECT_URL) — integration-test seeding/inspection only. */
export function ownerSql() {
  const direct = process.env.DIRECT_URL;
  if (!direct) throw new Error("DIRECT_URL missing — integration tests need .env.local / CI env.");
  return postgres(direct, { max: 1, onnotice: () => {} });
}

export function requireIntegrationEnv(): void {
  for (const key of ["DIRECT_URL", "DATABASE_URL", "APP_DB_PASSWORD"] as const) {
    if (!process.env[key]) {
      throw new Error(
        `${key} is not set. Integration tests run against a real database — fill .env.local (hosted) or use the CI local stack.`,
      );
    }
  }
}
