"use client";

/**
 * Job photo upload — binds the Phase E upload state machine to this job's
 * sign/confirm server actions (job_media class, EXIF-stripped server-side).
 */
import { useRouter } from "next/navigation";
import { FileUploadButton } from "@/platform/ui";
import { confirmJobUploadAction, signJobUploadAction } from "./actions";

import type { FileUploadLabels } from "@/platform/ui";

export function JobPhotoUpload({
  orgId,
  jobId,
  labels,
}: {
  orgId: string;
  jobId: string;
  labels: FileUploadLabels;
}) {
  const router = useRouter();
  return (
    <FileUploadButton
      labels={labels}
      capture
      sign={(file) => signJobUploadAction(orgId, jobId, file)}
      confirm={(fileId) => confirmJobUploadAction(orgId, fileId)}
      onDone={() => router.refresh()}
    />
  );
}
