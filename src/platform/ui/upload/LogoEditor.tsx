"use client";

/**
 * A small logo editor (item 4, 2026-09-20): fit or crop to a square, zoom and
 * reposition with a live preview, and hand back a clean 2000 × 2000 PNG.
 *
 * Why in the browser: the person needs to SEE the crop before it is saved, and
 * a square, well-padded, transparent-safe PNG is what every consumer downstream
 * wants (documents, the app icon, the header). The server still validates the
 * bytes, the type, the decoded dimensions and the size; this only prepares a
 * good candidate and refuses the obvious ones early with a plain reason.
 *
 * Accessibility: zoom is a labelled range input; position moves with the
 * arrow keys on the preview or with the nudge buttons; nothing depends on
 * dragging alone. Works at phone width (the preview scales to its container).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../Button";

export type LogoEditorLabels = {
  title: string;
  zoom: string;
  fit: string;
  fill: string;
  moveHint: string;
  nudgeUp: string;
  nudgeDown: string;
  nudgeLeft: string;
  nudgeRight: string;
  reset: string;
  use: string;
  cancel: string;
  working: string;
  blurryWarning: string;
  tooLarge: string;
  unsupported: string;
  decodeFailed: string;
  transparencyKept: string;
  transparencyNone: string;
};

export type LogoEditorResult = { file: File; width: number; height: number };

const OUTPUT_PX = 2000;
const MAX_BYTES = 2 * 1024 * 1024;
/** Below this on the shorter edge, an upscaled square will look soft. */
const BLURRY_BELOW_PX = 800;
const ACCEPTED = ["image/png", "image/jpeg", "image/webp"];

type Loaded = { bitmap: ImageBitmap; width: number; height: number; hasAlpha: boolean };

async function decode(file: File): Promise<Loaded> {
  if (!ACCEPTED.includes(file.type)) throw new Error("unsupported");
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("decode");
  });
  // Transparency check: sample the alpha channel of a small render.
  const probe = document.createElement("canvas");
  const side = 64;
  probe.width = side;
  probe.height = side;
  const pctx = probe.getContext("2d");
  let hasAlpha = false;
  if (pctx && file.type !== "image/jpeg") {
    pctx.drawImage(bitmap, 0, 0, side, side);
    const data = pctx.getImageData(0, 0, side, side).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i]! < 250) {
        hasAlpha = true;
        break;
      }
    }
  }
  return { bitmap, width: bitmap.width, height: bitmap.height, hasAlpha };
}

export function LogoEditor({
  file,
  labels,
  onDone,
  onCancel,
}: {
  file: File;
  labels: LogoEditorLabels;
  onDone: (result: LogoEditorResult) => void;
  onCancel: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  // zoom 1 = the image fits inside the square; >1 enlarges (crops the edges).
  const [zoom, setZoom] = useState(1);
  // offset in fractions of the square (-0.5..0.5), applied after zoom.
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    let alive = true;
    decode(file)
      .then((l) => {
        if (alive) setLoaded(l);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message === "unsupported" ? labels.unsupported : labels.decodeFailed);
      });
    return () => {
      alive = false;
    };
  }, [file, labels.unsupported, labels.decodeFailed]);

  // The geometry, shared by the preview and the export: the image is scaled so
  // its longer edge fits the square (fit), then multiplied by zoom, then moved.
  const draw = useCallback(
    (canvas: HTMLCanvasElement, side: number) => {
      if (!loaded) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = side;
      canvas.height = side;
      ctx.clearRect(0, 0, side, side);
      const base = side / Math.max(loaded.width, loaded.height);
      const scale = base * zoom;
      const w = loaded.width * scale;
      const h = loaded.height * scale;
      const x = (side - w) / 2 + offset.x * side;
      const y = (side - h) / 2 + offset.y * side;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(loaded.bitmap, x, y, w, h);
    },
    [loaded, zoom, offset],
  );

  useEffect(() => {
    const c = previewRef.current;
    if (c) draw(c, 320);
  }, [draw]);

  const blurry = useMemo(
    () => loaded !== null && Math.min(loaded.width, loaded.height) < BLURRY_BELOW_PX,
    [loaded],
  );

  function nudge(dx: number, dy: number) {
    setOffset((o) => ({
      x: Math.max(-0.5, Math.min(0.5, o.x + dx)),
      y: Math.max(-0.5, Math.min(0.5, o.y + dy)),
    }));
  }

  async function exportSquare() {
    if (!loaded) return;
    setBusy(true);
    setError(null);
    try {
      const out = document.createElement("canvas");
      draw(out, OUTPUT_PX);
      // PNG keeps transparency. A photo-like source with no alpha may not fit
      // 2 MB as PNG; then WebP (lossless-ish, no alpha needed) is offered
      // instead. Never JPEG for a logo with transparency.
      let blob: Blob | null = await new Promise((r) => out.toBlob(r, "image/png"));
      let type = "image/png";
      if (blob && blob.size > MAX_BYTES && !loaded.hasAlpha) {
        blob = await new Promise((r) => out.toBlob(r, "image/webp", 0.92));
        type = "image/webp";
      }
      if (!blob) throw new Error("encode");
      if (blob.size > MAX_BYTES) {
        setError(labels.tooLarge);
        return;
      }
      const name =
        file.name.replace(/\.[a-z0-9]+$/i, "") + (type === "image/png" ? ".png" : ".webp");
      onDone({ file: new File([blob], name, { type }), width: OUTPUT_PX, height: OUTPUT_PX });
    } catch {
      setError(labels.decodeFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-logo-editor>
      <p className="text-sm font-medium text-ink">{labels.title}</p>
      {error ? (
        <p role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {loaded ? (
        <>
          <div className="flex flex-col items-center gap-2">
            <canvas
              ref={previewRef}
              role="img"
              aria-label={labels.title}
              tabIndex={0}
              className="h-auto w-full max-w-[320px] cursor-move touch-none rounded-md border border-line bg-[linear-gradient(45deg,#d4d4d4_25%,transparent_25%),linear-gradient(-45deg,#d4d4d4_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#d4d4d4_75%),linear-gradient(-45deg,transparent_75%,#d4d4d4_75%)] bg-[length:16px_16px] outline-none focus-visible:ring-2 focus-visible:ring-brand"
              onKeyDown={(e) => {
                const step = 0.02;
                if (e.key === "ArrowUp") nudge(0, -step);
                else if (e.key === "ArrowDown") nudge(0, step);
                else if (e.key === "ArrowLeft") nudge(-step, 0);
                else if (e.key === "ArrowRight") nudge(step, 0);
                else if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(4, z + 0.1));
                else if (e.key === "-") setZoom((z) => Math.max(0.5, z - 0.1));
                else return;
                e.preventDefault();
              }}
              onPointerDown={(e) => {
                drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
                (e.target as HTMLElement).setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!drag.current) return;
                const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
                const dx = (e.clientX - drag.current.x) / rect.width;
                const dy = (e.clientY - drag.current.y) / rect.height;
                setOffset({
                  x: Math.max(-0.5, Math.min(0.5, drag.current.ox + dx)),
                  y: Math.max(-0.5, Math.min(0.5, drag.current.oy + dy)),
                });
              }}
              onPointerUp={() => {
                drag.current = null;
              }}
            />
            <p className="text-xs text-ink-muted">{labels.moveHint}</p>
          </div>

          <label className="flex flex-col gap-1 text-sm text-ink">
            <span>
              {labels.zoom} <span className="text-ink-muted">({Math.round(zoom * 100)}%)</span>
            </span>
            <input
              type="range"
              min={0.5}
              max={4}
              step={0.05}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="w-full"
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" onClick={() => setZoom(1)}>
              {labels.fit}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                setZoom(
                  Math.max(loaded.width, loaded.height) / Math.min(loaded.width, loaded.height),
                )
              }
            >
              {labels.fill}
            </Button>
            <span
              className="inline-flex items-center gap-1"
              role="group"
              aria-label={labels.moveHint}
            >
              <Button
                type="button"
                variant="ghost"
                aria-label={labels.nudgeLeft}
                onClick={() => nudge(-0.05, 0)}
              >
                ←
              </Button>
              <Button
                type="button"
                variant="ghost"
                aria-label={labels.nudgeUp}
                onClick={() => nudge(0, -0.05)}
              >
                ↑
              </Button>
              <Button
                type="button"
                variant="ghost"
                aria-label={labels.nudgeDown}
                onClick={() => nudge(0, 0.05)}
              >
                ↓
              </Button>
              <Button
                type="button"
                variant="ghost"
                aria-label={labels.nudgeRight}
                onClick={() => nudge(0.05, 0)}
              >
                →
              </Button>
            </span>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setZoom(1);
                setOffset({ x: 0, y: 0 });
              }}
            >
              {labels.reset}
            </Button>
          </div>

          <p className="text-xs text-ink-muted">
            {loaded.width} × {loaded.height} px ·{" "}
            {loaded.hasAlpha ? labels.transparencyKept : labels.transparencyNone}
          </p>
          {blurry ? (
            <p role="status" className="rounded-md bg-warning/10 p-2 text-xs text-ink">
              {labels.blurryWarning}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={exportSquare}
              disabled={busy}
              aria-busy={busy || undefined}
            >
              {busy ? labels.working : labels.use}
            </Button>
            <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
              {labels.cancel}
            </Button>
          </div>
        </>
      ) : !error ? (
        <p className="text-sm text-ink-muted">{labels.working}</p>
      ) : null}
    </div>
  );
}
