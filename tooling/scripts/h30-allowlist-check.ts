/**
 * H30 LB-1 evidence — how much the OLD s7-cleanup allow-list still protected.
 *
 * Read-only. Kept because the number it prints is the whole argument for the
 * rewrite, and a claim of that size should be reproducible rather than quoted.
 */
import "./load-env";
import postgres from "postgres";

const OLD_PROTECTED_NAMES = ["Alpha Marine", "TESTING"];
const OLD_PROTECTED_IDS = [
  "d22b2098-2e09-436d-ab9e-ee26c8719cd5",
  "9fcaa697-becd-41ec-97d4-6ce2851ead36",
];

async function main() {
  const sql = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} });
  try {
    const [protectedRow] = (await sql`
      select count(*)::int as n from public.org
      where name = any(${OLD_PROTECTED_NAMES}) or id = any(${OLD_PROTECTED_IDS}::uuid[])
    `) as unknown as Array<{ n: number }>;
    const [totalRow] = (await sql`
      select count(*)::int as n from public.org
    `) as unknown as Array<{ n: number }>;
    const [liveRow] = (await sql`
      select count(distinct o.id)::int as n
      from public.org o
      join public.membership m on m.org_id = o.id
      join auth.users u on u.id = m.user_id
      where not (u.email like '%@example.com'
              or u.email like '%@journey.invalid'
              or u.email like '%@test.local')
    `) as unknown as Array<{ n: number }>;

    console.log(`organisations in production:                    ${totalRow!.n}`);
    console.log(`still matched by the old allow-list:            ${protectedRow!.n}`);
    console.log(`the old --apply would have deleted:             ${totalRow!.n - protectedRow!.n}`);
    console.log(`of those, organisations with a real login:      ${liveRow!.n}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
