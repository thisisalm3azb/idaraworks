/**
 * H26 — the signature room (ADR-23). Slice 6 fills this file in; the
 * render seam exists from the foundation so the PDF route has one shape to
 * print signatures and evidence from.
 */
import { assertCan } from "@/platform/authz";
import type { RoleArchetype } from "@/platform/registries";
import type { Ctx } from "@/platform/tenancy";
import type { SignatureRender } from "./render";

export type SignaturesForRender = {
  rows: SignatureRender[];
  /** Human-readable evidence lines appended to the issued PDF. */
  evidenceLines: string[];
};

export async function listSignaturesForRender(
  ctx: Ctx,
  archetype: RoleArchetype,
  documentId: string,
): Promise<SignaturesForRender> {
  assertCan(archetype, "documents.view");
  void ctx;
  void documentId;
  return { rows: [], evidenceLines: [] };
}
