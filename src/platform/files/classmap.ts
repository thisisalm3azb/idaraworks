/**
 * File access-class shape (doc 01 Appendix A; BUILD_BIBLE §7.1). The class's
 * bucket + retention; the ACCESS RULE (who may read/write) lives in access.ts
 * (canAccessFileClass), mirrored by the SQL app.can_access_file_class.
 */
import type { FileAccessClass } from "@/platform/registries";

export type ClassSpec = {
  bucket: "tenant-media" | "tenant-docs";
  /** Appendix A: originals retained only for financial_doc / hr_doc. */
  retainOriginal: boolean;
  /** Whether org members have any upload path (customer_share: no). */
  hasMemberPath: boolean;
};

export const CLASS_MAP: Record<FileAccessClass, ClassSpec> = {
  job_media: { bucket: "tenant-media", retainOriginal: false, hasMemberPath: true },
  financial_doc: { bucket: "tenant-docs", retainOriginal: true, hasMemberPath: true },
  hr_doc: { bucket: "tenant-docs", retainOriginal: true, hasMemberPath: true },
  // Minted by the S5 share surface (watermarked derivative); no member path.
  customer_share: { bucket: "tenant-media", retainOriginal: false, hasMemberPath: false },
};

/** S0 accepts images only — documents (PDF + malware scanning) land S4 (checklist deviation #2). */
export const ALLOWED_UPLOAD_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;

/** Per-bucket upload caps (checklist §13). */
export const BUCKET_MAX_BYTES: Record<ClassSpec["bucket"], number> = {
  "tenant-media": 15 * 1024 * 1024,
  "tenant-docs": 25 * 1024 * 1024,
};
