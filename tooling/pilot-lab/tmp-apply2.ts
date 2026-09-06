import { loadLabEnv } from "./guard";
import { openOwner } from "./db";
import { findLabOrg } from "./provision";

async function main() {
  const env = loadLabEnv();
  const sql = openOwner(env);
  try {
    const org = await findLabOrg(sql, "facilico");
    const [owner] = (await sql`
      select u.id::text as id from auth.users u
      where u.email = 'h33.facilico.owner@pilot-lab.invalid'
    `) as unknown as Array<{ id: string }>;
    const [sc] = (await sql`
      select id::text as id from public.studio_scenario
      where org_id = ${org} and status = 'approved' limit 1
    `) as unknown as Array<{ id: string }>;
    if (!owner || !sc) { console.log("missing owner or scenario"); return; }
    const ctx = {
      orgId: org!, userId: owner.id, costPrivileged: true, pricePrivileged: true,
      requestId: "h33-facilico-diag",
    } as never;
    const { applyScenario } = await import("@/modules/studio/scenarios");
    try {
      const r = await applyScenario(ctx, "owner", { scenarioId: sc.id });
      console.log("APPLIED OK", JSON.stringify(r));
    } catch (e) {
      console.log(`REFUSED: ${(e as Error).message}`);
    }
  } finally {
    await sql.end();
  }
}
void main();
