/**
 * Object path convention (BUILD_BIBLE §7.1):
 *   <org_id>/<class>/<entity_type>/<entity_id>/<file_id>[.variant].<ext>
 * The org prefix is load-bearing: storage RLS (0008) and the reconcile worker
 * both key on it. Only this module builds or parses paths.
 */
import type { FileAccessClass } from "@/platform/registries";

export type FileVariant = "orig" | "thumb" | "medium";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXT_RE = /^[a-z0-9]{2,5}$/;

export function buildObjectPath(parts: {
  orgId: string;
  accessClass: FileAccessClass;
  attachedToType: string;
  attachedToId: string;
  fileId: string;
  ext: string;
  variant?: FileVariant;
}): string {
  const { orgId, accessClass, attachedToType, attachedToId, fileId, ext, variant } = parts;
  if (!UUID_RE.test(orgId) || !UUID_RE.test(attachedToId) || !UUID_RE.test(fileId)) {
    throw new Error("object path parts must be UUIDs");
  }
  if (!EXT_RE.test(ext)) {
    throw new Error("invalid file extension");
  }
  const name = variant ? `${fileId}.${variant}.${ext}` : `${fileId}.${ext}`;
  return `${orgId}/${accessClass}/${attachedToType}/${attachedToId}/${name}`;
}

export type ParsedObjectPath = {
  orgId: string;
  accessClass: string;
  attachedToType: string;
  attachedToId: string;
  fileId: string;
  variant: FileVariant | null;
  ext: string;
};

export function parseObjectPath(path: string): ParsedObjectPath | null {
  const segments = path.split("/");
  if (segments.length !== 5) return null;
  const [orgId, accessClass, attachedToType, attachedToId, name] = segments as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (!UUID_RE.test(orgId) || !UUID_RE.test(attachedToId)) return null;
  const nameParts = name.split(".");
  if (nameParts.length < 2 || nameParts.length > 3) return null;
  const fileId = nameParts[0]!;
  if (!UUID_RE.test(fileId)) return null;
  const ext = nameParts[nameParts.length - 1]!;
  if (!EXT_RE.test(ext)) return null;
  const variant = nameParts.length === 3 ? (nameParts[1] as string) : null;
  if (variant !== null && variant !== "orig" && variant !== "thumb" && variant !== "medium") {
    return null;
  }
  return { orgId, accessClass, attachedToType, attachedToId, fileId, variant, ext };
}

/** Extension for a mime type we accept (classmap ALLOWED_UPLOAD_MIMES). */
export function extForMime(mime: string): string | null {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return null;
  }
}
