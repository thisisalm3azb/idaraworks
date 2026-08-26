"use client";

/**
 * Archive / Reactivate lifecycle controls (003C). Archive is a destructive-
 * variant confirmation Dialog that explains the impact BEFORE anything
 * happens: disappears from new-record selectors, history stays intact,
 * reversible. Reactivate is an explicit single action. Both call the typed
 * lifecycle action (audited, idempotent) — never a form edit in disguise.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog } from "@/platform/ui";

export type LifecycleDict = {
  archive: string;
  reactivate: string;
  confirm_title: string;
  confirm_body: string;
  impact_selectors: string;
  impact_history: string;
  impact_reversible: string;
  confirm: string;
  cancel: string;
  close: string;
  failed: string;
};

export function CustomerLifecycle({
  active,
  dict,
  action,
}: {
  active: boolean;
  dict: LifecycleDict;
  action: (active: boolean) => Promise<{ ok: boolean }>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();

  function run(next: boolean) {
    if (pending) return;
    setError(false);
    startTransition(async () => {
      const res = await action(next);
      if (!res.ok) {
        setError(true);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  if (!active) {
    return (
      <div className="flex flex-col gap-1">
        <Button type="button" variant="secondary" disabled={pending} onClick={() => run(true)}>
          {dict.reactivate}
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {dict.failed}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        className="text-danger"
        onClick={() => setOpen(true)}
      >
        {dict.archive}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={dict.confirm_title}
        description={dict.confirm_body}
        tone="danger"
        closeLabel={dict.close}
      >
        <ul className="mb-4 list-disc ps-5 text-sm leading-relaxed text-ink-secondary">
          <li>{dict.impact_selectors}</li>
          <li>{dict.impact_history}</li>
          <li>{dict.impact_reversible}</li>
        </ul>
        {error ? (
          <p role="alert" className="mb-3 rounded-md bg-danger-soft p-3 text-sm text-danger">
            {dict.failed}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
            {dict.cancel}
          </Button>
          <Button type="button" variant="danger" disabled={pending} onClick={() => run(false)}>
            {dict.confirm}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
