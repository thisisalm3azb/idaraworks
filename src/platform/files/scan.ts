/**
 * Document malware-scan seam (doc 10 #27). The MVP accepts images only (re-encoded + EXIF-stripped,
 * which neutralises image-borne payloads), so there is no live document-upload path yet — but the
 * checklist requires the SCAN INTERFACE to exist before documents (financial_doc / hr_doc) are ever
 * accepted. Provider-neutral, mirroring the billing / e-invoice / AI seams:
 *   - `passthrough` (default off-prod + until a scanner is provisioned): allows everything, so
 *     dev/CI/demo are unblocked.
 *   - `disabled` (production default until SCAN_PROVIDER names a real scanner): REJECTS every
 *     document, so a real document upload can never bypass an unprovisioned scanner in prod.
 * A real provider (ClamAV sidecar, a cloud AV API behind src/platform/http) slots in behind the
 * same interface at document-feature time — no call-site change. Images never reach this seam.
 */
import { isProd } from "@/platform/env";

export type ScanResult = { clean: boolean; provider: string; detail?: string };

export interface DocumentScanner {
  readonly name: string;
  scan(buffer: Buffer, contentType: string): Promise<ScanResult>;
}

const passthroughScanner: DocumentScanner = {
  name: "passthrough",
  async scan() {
    return { clean: true, provider: "passthrough" };
  },
};

const disabledScanner: DocumentScanner = {
  name: "disabled",
  async scan() {
    // No scanner provisioned in production → a document upload is refused, never silently trusted.
    return { clean: false, provider: "disabled", detail: "document scanning not provisioned" };
  },
};

/** Resolve the active scanner. Real providers (SCAN_PROVIDER=<name>) are added here later. */
export function getDocumentScanner(): DocumentScanner {
  const configured = process.env.SCAN_PROVIDER;
  if (configured === "passthrough") return passthroughScanner;
  if (configured === "disabled") return disabledScanner;
  // Default: passthrough off-prod (unblock dev/CI/demo); disabled in prod until a scanner exists.
  return isProd() ? disabledScanner : passthroughScanner;
}

/** Convenience: throw a typed error if a document is not clean. Call before finalising a doc upload. */
export class DocumentRejectedError extends Error {
  constructor(detail: string) {
    super(`document rejected by scanner: ${detail}`);
    this.name = "DocumentRejectedError";
  }
}

export async function assertDocumentClean(buffer: Buffer, contentType: string): Promise<void> {
  const result = await getDocumentScanner().scan(buffer, contentType);
  if (!result.clean) throw new DocumentRejectedError(result.detail ?? result.provider);
}
