/**
 * The file access-class rule (doc 01 Appendix A; doc 06 D-6.2). This is the
 * app-layer HALF of a single rule whose other half is app.can_access_file_class
 * (migration 0008). They MUST stay identical — the storage-harness parity test
 * sweeps archetype × pricePrivileged × class × read/write and asserts both walls
 * agree, so a divergence (like the one the Phase E review caught) fails CI.
 *
 * The financial_doc READ gate is the finance.viewPrices FLAG, not an archetype
 * list — the flag is individually togglable per role (an owner may grant a
 * manager margin/price visibility) and both walls read it from the same source
 * (Ctx.pricePrivileged ⇔ role_definition.price_privileged).
 */
import type { FileAccessClass, RoleArchetype } from "@/platform/registries";

/** Archetypes that may WRITE (upload) each class — mirrors the SQL exactly. */
const WRITE_ARCHETYPES: Record<
  Exclude<FileAccessClass, "customer_share">,
  readonly RoleArchetype[]
> = {
  job_media: ["owner", "admin", "manager", "foreman"],
  financial_doc: ["owner", "admin", "manager", "procurement", "accounts"],
  hr_doc: ["owner", "admin"],
};

/**
 * Does (archetype, pricePrivileged) grant read/write on this class?
 * `pricePrivileged` = the caller's finance.viewPrices flag (Ctx.pricePrivileged).
 */
export function canAccessFileClass(
  archetype: RoleArchetype,
  pricePrivileged: boolean,
  cls: FileAccessClass,
  write: boolean,
): boolean {
  switch (cls) {
    case "job_media":
      // Read: any active member (job-visibility). Write: the field/office roles.
      return write ? WRITE_ARCHETYPES.job_media.includes(archetype) : true;
    case "financial_doc":
      // Read: finance.viewPrices flag. Write: the expense/PO creators.
      return write ? WRITE_ARCHETYPES.financial_doc.includes(archetype) : pricePrivileged;
    case "hr_doc":
      return WRITE_ARCHETYPES.hr_doc.includes(archetype);
    default:
      // customer_share: minted by the S5 share surface only — no member path.
      return false;
  }
}
