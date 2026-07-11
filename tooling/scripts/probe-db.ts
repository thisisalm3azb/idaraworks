/**
 * Fail-fast connectivity probe (review M2 mitigation): verifies DIRECT_URL and
 * the RAW pooled DATABASE_URL (owner creds — app_user may not exist yet) answer
 * `select 1` BEFORE VC-1 runs, so a wrong pooler URL/tenant-id fails loudly here
 * with a clear message instead of inside the spike.
 */
import "./load-env";
import postgres from "postgres";

async function probe(name: string, url: string | undefined): Promise<void> {
  if (!url) throw new Error(`${name} is not set`);
  const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 10, onnotice: () => {} });
  try {
    const [row] = await sql`select 1 as ok`;
    if (row?.ok !== 1) throw new Error(`${name}: unexpected probe result`);
    console.log(`probe ok: ${name} (${new URL(url).host})`);
  } catch (err) {
    throw new Error(
      `${name} probe FAILED (${new URL(url).host}): ${(err as Error).message}. ` +
        (name === "DATABASE_URL"
          ? "Check the pooler port/tenant-id (local Supavisor: postgres.pooler-dev@127.0.0.1:54329)."
          : "Check the direct connection (note: hosted db.<ref>.supabase.co is IPv6-only — use the Session-pooler URI on IPv4-only networks)."),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

Promise.all([
  probe("DIRECT_URL", process.env.DIRECT_URL),
  probe("DATABASE_URL", process.env.DATABASE_URL),
])
  .then(() => console.log("connectivity probes passed"))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
