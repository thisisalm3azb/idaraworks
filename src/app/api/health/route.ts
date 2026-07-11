import { NextResponse } from "next/server";
import { createAppDb, sql } from "@/platform/tenancy";

export const dynamic = "force-dynamic";

/** Health check (BUILD_BIBLE §15.5). Dedicated client per the A-B5 pool law. */
export async function GET() {
  let db = false;
  try {
    const client = createAppDb({ max: 1 });
    try {
      const rows = (await client.db.execute(sql`select 1 as ok`)) as unknown as Array<{
        ok: number;
      }>;
      db = rows[0]?.ok === 1;
    } finally {
      await client.end();
    }
  } catch {
    db = false;
  }
  return NextResponse.json(
    { ok: db, db, uptime_s: Math.round(process.uptime()) },
    { status: db ? 200 : 503 },
  );
}
