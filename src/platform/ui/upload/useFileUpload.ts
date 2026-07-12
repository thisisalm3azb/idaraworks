"use client";

/**
 * Upload state machine (S0 checklist §6 item 6): compress → sign → PUT (with
 * progress + retry/backoff) → confirm. The surface that owns the upload wires
 * the two server actions in — this hook is transport only and knows nothing
 * about entities or classes.
 *
 * XHR (not fetch) for the PUT: fetch has no upload-progress events.
 */
import { useCallback, useRef, useState } from "react";
import { compressImage } from "./compress";
import { MAX_UPLOAD_ATTEMPTS, retryDelayMs, shouldRetry } from "./backoff";

export type SignResult = {
  fileId: string;
  signedUrl: string;
  /**
   * Headers the PUT must carry (e.g. the public `apikey` for the storage
   * gateway). Supplied by the server action that mints the URL so this hook
   * stays transport-generic and knows nothing about the storage provider.
   */
  headers?: Record<string, string>;
  quotaWarn?: boolean;
};

export type UploadPhase =
  "idle" | "compressing" | "signing" | "uploading" | "confirming" | "done" | "error";

export type UploadState = {
  phase: UploadPhase;
  progress: number; // 0..1 of the PUT
  attempt: number;
  fileId: string | null;
  quotaWarn: boolean;
  errorMessage: string | null;
};

const IDLE: UploadState = {
  phase: "idle",
  progress: 0,
  attempt: 0,
  fileId: null,
  quotaWarn: false,
  errorMessage: null,
};

export type UseFileUploadArgs = {
  /** Server action: validates + quota-checks + returns the signed PUT target. */
  sign: (file: { name: string; mime: string; sizeBytes: number }) => Promise<SignResult>;
  /** Server action: queues the ingest pipeline. */
  confirm: (fileId: string) => Promise<void>;
  onDone?: (fileId: string) => void;
};

function putWithProgress(
  url: string,
  body: Blob,
  mime: string,
  headers: Record<string, string>,
  onProgress: (ratio: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", mime);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error("network error during upload"));
    xhr.send(body);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useFileUpload({ sign, confirm, onDone }: UseFileUploadArgs) {
  const [state, setState] = useState<UploadState>(IDLE);
  const busy = useRef(false);

  const reset = useCallback(() => {
    if (!busy.current) setState(IDLE);
  }, []);

  const upload = useCallback(
    async (file: File) => {
      if (busy.current) return;
      busy.current = true;
      try {
        setState({ ...IDLE, phase: "compressing" });
        const compressed = await compressImage(file);
        const blob = compressed?.blob ?? file;
        const mime = compressed?.mime ?? file.type;

        setState((s) => ({ ...s, phase: "signing" }));
        const signed = await sign({ name: file.name, mime, sizeBytes: blob.size });
        setState((s) => ({
          ...s,
          fileId: signed.fileId,
          quotaWarn: signed.quotaWarn ?? false,
        }));

        // PUT with retry/backoff — transient network drops on workshop floors
        // are the norm, not the exception.
        for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
          setState((s) => ({ ...s, phase: "uploading", attempt, progress: 0 }));
          try {
            await putWithProgress(signed.signedUrl, blob, mime, signed.headers ?? {}, (ratio) =>
              setState((s) => ({ ...s, progress: ratio })),
            );
            break;
          } catch (err) {
            if (!shouldRetry(attempt)) throw err;
            await sleep(retryDelayMs(attempt));
          }
        }

        setState((s) => ({ ...s, phase: "confirming", progress: 1 }));
        for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
          try {
            await confirm(signed.fileId);
            break;
          } catch (err) {
            if (!shouldRetry(attempt)) throw err;
            await sleep(retryDelayMs(attempt));
          }
        }

        setState((s) => ({ ...s, phase: "done" }));
        onDone?.(signed.fileId);
      } catch (err) {
        setState((s) => ({
          ...s,
          phase: "error",
          errorMessage: err instanceof Error ? err.message : "upload failed",
        }));
      } finally {
        busy.current = false;
      }
    },
    [sign, confirm, onDone],
  );

  return { state, upload, reset };
}
