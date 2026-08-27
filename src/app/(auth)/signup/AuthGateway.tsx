"use client";

/**
 * Registration gateway form (005B) — the main-panel identity step. Google
 * (shown only when the provider is ready), a divider, then work-email + name +
 * password with a Continue action. Client-held state means a failure keeps the
 * entered values and never puts anything in a URL; the action is
 * non-enumerating. Three states: idle, submitting (loading), and — when email
 * confirmation is required — an inline "check your inbox". Identity only; no
 * business information is requested here.
 */
import { useState, useTransition } from "react";
import Link from "next/link";
import { Button, Field, Icon } from "@/platform/ui";
import type { RegisterResult } from "../actions";

export type GatewayDict = {
  google: string;
  or: string;
  full_name: string;
  email: string;
  email_hint: string;
  password: string;
  password_hint: string;
  submit: string;
  submitting: string;
  have_account: string;
  login: string;
  agree_pre: string;
  terms: string;
  agree_mid: string;
  privacy: string;
  confirm_title: string;
  confirm_body: string;
  errors: Record<string, string>;
};

export function AuthGateway({
  oauthOn,
  loginHref,
  registerAction,
  googleAction,
  googleNext,
  dict,
}: {
  oauthOn: boolean;
  loginHref: string;
  registerAction: (formData: FormData) => Promise<RegisterResult>;
  /** Server action for the Google form (reads provider + next from the form). */
  googleAction: (formData: FormData) => void | Promise<void>;
  /** Safe same-origin invite/workspace next, threaded through the OAuth round trip. */
  googleNext: string;
  dict: GatewayDict;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  function onSubmit(formData: FormData) {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      const res = await registerAction(formData);
      if (res.ok) {
        setConfirm(true); // email confirmation required — show inline notice
        return;
      }
      setError(dict.errors[res.error] ?? dict.errors.failed!);
    });
  }

  if (confirm) {
    return (
      <div
        className="rounded-lg border border-line bg-card p-6 text-center shadow-card"
        role="status"
      >
        <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-success-soft text-success">
          <Icon name="inbox" size={22} aria-hidden />
        </span>
        <h2 className="mt-3 text-lg font-semibold text-ink">{dict.confirm_title}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-secondary">{dict.confirm_body}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {oauthOn ? (
        <>
          {/* googleNext is posted as a hidden field so the invite/next context
              survives the provider round trip. */}
          <form action={googleAction}>
            <input type="hidden" name="provider" value="google" />
            <input type="hidden" name="next" value={googleNext} />
            <button
              type="submit"
              className="flex min-h-12 w-full items-center justify-center gap-2.5 rounded-md border border-line-strong bg-card px-4 text-sm font-medium text-ink hover:bg-sunken"
            >
              <GoogleMark />
              {dict.google}
            </button>
          </form>
          <div className="flex items-center gap-3 text-xs text-ink-muted">
            <span className="h-px flex-1 bg-line" />
            {dict.or}
            <span className="h-px flex-1 bg-line" />
          </div>
        </>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <form action={onSubmit} className="flex flex-col gap-4">
        <Field label={dict.full_name} name="full_name" autoComplete="name" required minLength={2} />
        <Field
          label={dict.email}
          name="email"
          type="email"
          dir="ltr"
          autoComplete="email"
          required
          hint={dict.email_hint}
        />
        <Field
          label={dict.password}
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          hint={dict.password_hint}
        />
        <Button type="submit" disabled={pending} className="min-h-12">
          {pending ? dict.submitting : dict.submit}
        </Button>
      </form>

      <p className="text-center text-sm text-ink-secondary">
        {dict.have_account}{" "}
        <Link href={loginHref} className="font-medium text-brand hover:underline">
          {dict.login}
        </Link>
      </p>

      <p className="text-center text-xs leading-relaxed text-ink-muted">
        {dict.agree_pre}{" "}
        <Link href="/terms" className="text-brand hover:underline">
          {dict.terms}
        </Link>{" "}
        {dict.agree_mid}{" "}
        <Link href="/privacy" className="text-brand hover:underline">
          {dict.privacy}
        </Link>
        .
      </p>
    </div>
  );
}

/** Google "G" mark drawn inline (no external asset, no copied logo file). */
function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5c-.3 1.5-1.1 2.8-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1C3.3 21.3 7.3 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.3 14.3c-.2-.7-.4-1.5-.4-2.3s.1-1.6.4-2.3V6.6H1.3C.5 8.2 0 10 0 12s.5 3.8 1.3 5.4l4-3.1z"
      />
      <path
        fill="#EA4335"
        d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4C18 1.2 15.2 0 12 0 7.3 0 3.3 2.7 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z"
      />
    </svg>
  );
}
