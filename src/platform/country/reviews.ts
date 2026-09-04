import "server-only";
/**
 * H29 — what review each country-pack version has actually had.
 *
 * The readiness centre reads these to decide whether an establishment is
 * `legally_reviewed`, and no amount of filled-in configuration can imply one.
 * Recording a review is therefore the owner action that unblocks that state,
 * and it needs a door: without one the only way to record it would be to write
 * SQL against production, which is not a thing to ask of anybody.
 *
 * Platform state, not tenant state: a pack version is the same for every
 * organisation. Only a platform operator may write, enforced by the database.
 */
import { sql, withUserCtx } from "@/platform/tenancy";
import { COUNTRY_PACKS } from "./registry";
import { REVIEW_KINDS, REVIEW_STATES, type ReviewKind, type ReviewState } from "./types";

export type PackReviewRow = {
  packKey: string;
  kind: ReviewKind;
  state: ReviewState;
  reviewer: string | null;
  note: string | null;
  decidedAt: string | null;
};

export type PackReviewView = {
  packKey: string;
  country: string;
  status: string;
  effectiveFrom: string;
  /** One entry per review kind, whether or not a row exists for it. */
  reviews: Array<PackReviewRow & { recorded: boolean }>;
};

/**
 * Every shipped version with its reviews, filled out for every kind.
 *
 * A kind with no row is returned as `not_started` rather than omitted: an
 * absent record and a record saying "nobody has started" mean the same thing to
 * a reader, and only one of them is visible.
 */
export async function packReviews(userId: string): Promise<PackReviewView[]> {
  const rows = (await withUserCtx(userId, (tx) =>
    tx.execute(sql`
      select pack_key, kind, state, reviewer, note, decided_at::text as decided_at
        from public.country_pack_review`),
  )) as unknown as Array<Record<string, unknown>>;
  const byPack = new Map<string, Map<string, PackReviewRow>>();
  for (const r of rows) {
    const packKey = String(r.pack_key);
    if (!byPack.has(packKey)) byPack.set(packKey, new Map());
    byPack.get(packKey)!.set(String(r.kind), {
      packKey,
      kind: String(r.kind) as ReviewKind,
      state: String(r.state) as ReviewState,
      reviewer: (r.reviewer as string | null) ?? null,
      note: (r.note as string | null) ?? null,
      decidedAt: (r.decided_at as string | null) ?? null,
    });
  }
  return COUNTRY_PACKS.map((pack) => ({
    packKey: pack.packKey,
    country: pack.country,
    status: pack.status,
    effectiveFrom: pack.effectiveFrom,
    reviews: REVIEW_KINDS.map((kind) => {
      const existing = byPack.get(pack.packKey)?.get(kind);
      return existing
        ? { ...existing, recorded: true }
        : {
            packKey: pack.packKey,
            kind,
            state: "not_started" as ReviewState,
            reviewer: null,
            note: null,
            decidedAt: null,
            recorded: false,
          };
    }),
  }));
}

/**
 * Record one review. The database asserts an active platform operator, stamps
 * the decision time itself for a decided state, and writes its own audit entry.
 */
export async function setPackReview(
  userId: string,
  input: {
    packKey: string;
    kind: ReviewKind;
    state: ReviewState;
    reviewer: string | null;
    note: string | null;
  },
): Promise<void> {
  if (!REVIEW_KINDS.includes(input.kind)) throw new Error(`unknown review kind ${input.kind}`);
  if (!REVIEW_STATES.includes(input.state)) throw new Error(`unknown review state ${input.state}`);
  // A decided review with nobody's name on it is a claim, not a record. The
  // language centre refuses the same thing for the same reason.
  if ((input.state === "passed" || input.state === "failed") && !input.reviewer?.trim())
    throw new Error("a decided review needs a named reviewer");
  await withUserCtx(userId, (tx) =>
    tx.execute(sql`
      select app.country_pack_review_set(${input.packKey}, ${input.kind}, ${input.state},
                                         ${input.reviewer}, ${input.note})`),
  );
}
