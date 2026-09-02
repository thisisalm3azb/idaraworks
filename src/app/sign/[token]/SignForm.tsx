"use client";

/**
 * The signing form: name and title as signed, typed or drawn signature
 * (drawn = a plain SVG path captured from pointer events), explicit consent.
 * Works with touch on a phone; the drawn path is submitted as text.
 */
import { useRef, useState } from "react";

export type SignDict = {
  name: string;
  title: string;
  typed: string;
  drawn: string;
  typedHint: string;
  drawHint: string;
  clear: string;
  consent: string;
  sign: string;
  decline: string;
  declineReason: string;
  declineConfirm: string;
  cancel: string;
};

export function SignForm({
  action,
  declineAction,
  defaultName,
  consentText,
  dict,
  dir,
}: {
  action: (formData: FormData) => Promise<void>;
  declineAction: (formData: FormData) => Promise<void>;
  defaultName: string;
  consentText: string;
  dict: SignDict;
  dir: "ltr" | "rtl";
}) {
  const [kind, setKind] = useState<"typed" | "drawn">("typed");
  const [typed, setTyped] = useState(defaultName);
  const [path, setPath] = useState("");
  const [consent, setConsent] = useState(false);
  const [declining, setDeclining] = useState(false);
  const drawing = useRef(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const input =
    "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 400;
    const y = ((e.clientY - rect.top) / rect.height) * 120;
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
  };
  const draw = (x: number, y: number, move: boolean) => {
    const c = canvas.current?.getContext("2d");
    if (!c) return;
    c.lineWidth = 2;
    c.lineCap = "round";
    c.strokeStyle = "#111";
    if (move) c.moveTo(x, y);
    else {
      c.lineTo(x, y);
      c.stroke();
    }
  };
  const clear = () => {
    setPath("");
    const c = canvas.current?.getContext("2d");
    if (c && canvas.current) c.clearRect(0, 0, canvas.current.width, canvas.current.height);
    c?.beginPath();
  };
  const ready = consent && (kind === "typed" ? typed.trim().length > 0 : path.length > 10);

  return (
    <div className="flex flex-col gap-3" dir={dir}>
      <form action={action} className="flex flex-col gap-3">
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="path" value={path} />
        <label className="text-xs text-ink-muted">
          {dict.name}
          <input
            name="name"
            required
            defaultValue={defaultName}
            maxLength={200}
            className={input}
          />
        </label>
        <label className="text-xs text-ink-muted">
          {dict.title}
          <input name="title" maxLength={120} className={input} />
        </label>
        <div role="group" className="flex gap-1">
          {(["typed", "drawn"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={`min-h-11 rounded-md px-3 text-sm ${kind === k ? "bg-accent-soft text-ink" : "bg-sunken text-ink-secondary"}`}
            >
              {k === "typed" ? dict.typed : dict.drawn}
            </button>
          ))}
        </div>
        {kind === "typed" ? (
          <label className="text-xs text-ink-muted">
            {dict.typedHint}
            <input
              name="typed"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              maxLength={200}
              className={`${input} font-serif text-2xl italic`}
            />
          </label>
        ) : (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-ink-muted">{dict.drawHint}</span>
            <canvas
              ref={canvas}
              width={400}
              height={120}
              className="h-32 w-full touch-none rounded-md border border-line-strong bg-white"
              onPointerDown={(e) => {
                drawing.current = true;
                e.currentTarget.setPointerCapture(e.pointerId);
                const p = point(e);
                draw(p.x, p.y, true);
                setPath((s) => `${s}M${p.x} ${p.y} `);
              }}
              onPointerMove={(e) => {
                if (!drawing.current) return;
                const p = point(e);
                draw(p.x, p.y, false);
                setPath((s) => `${s}L${p.x} ${p.y} `);
              }}
              onPointerUp={() => {
                drawing.current = false;
              }}
              onPointerLeave={() => {
                drawing.current = false;
              }}
            />
            <button
              type="button"
              onClick={clear}
              className="min-h-9 self-start text-xs text-accent underline"
            >
              {dict.clear}
            </button>
          </div>
        )}
        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            name="consent"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-1"
          />
          <span>{consentText}</span>
        </label>
        <button
          type="submit"
          disabled={!ready}
          className="min-h-12 rounded-md bg-brand px-6 text-base font-medium text-ink-inverse disabled:opacity-50"
        >
          {dict.sign}
        </button>
      </form>
      {!declining ? (
        <button
          type="button"
          onClick={() => setDeclining(true)}
          className="min-h-11 self-start text-sm text-danger underline"
        >
          {dict.decline}
        </button>
      ) : (
        <form
          action={declineAction}
          className="flex flex-col gap-2 rounded-md border border-danger p-3"
        >
          <label className="text-xs text-ink-muted">
            {dict.declineReason}
            <textarea
              name="reason"
              required
              minLength={1}
              maxLength={1000}
              rows={3}
              className={`${input} py-2`}
            />
          </label>
          <div className="flex gap-2">
            <button
              type="submit"
              className="min-h-11 rounded-md bg-danger px-4 text-sm text-ink-inverse"
            >
              {dict.declineConfirm}
            </button>
            <button
              type="button"
              onClick={() => setDeclining(false)}
              className="min-h-11 px-3 text-sm text-ink-secondary"
            >
              {dict.cancel}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
