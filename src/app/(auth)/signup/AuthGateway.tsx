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
import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Button, Field, Icon } from "@/platform/ui";
import type { RegisterResult, ResendResult } from "../actions";

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
  confirm_sent_to: string;
  confirm_explain: string;
  confirm_spam: string;
  confirm_expired: string;
  resend: string;
  resend_cooldown: string; // "{s}"
  resend_sent: string;
  resend_rate: string;
  change_email: string;
  verified_already: string;
  errors: Record<string, string>;
};

/** Mask an email for display: keep the first char + domain, hide the rest.
 * Never a security control — just avoids showing the full address on screen. */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain || !local) return email;
  const head = local.slice(0, 1);
  return `${head}${"•".repeat(Math.max(1, Math.min(local.length - 1, 4)))}@${domain}`;
}

export function AuthGateway({
  oauthOn,
  loginHref,
  registerAction,
  resendAction,
  googleAction,
  googleNext,
  dict,
}: {
  oauthOn: boolean;
  loginHref: string;
  registerAction: (formData: FormData) => Promise<RegisterResult>;
  resendAction: (formData: FormData) => Promise<ResendResult>;
  /** Server action for the Google form (reads provider + next from the form). */
  googleAction: (formData: FormData) => void | Promise<void>;
  /** Safe same-origin invite/workspace next, threaded through the OAuth round trip. */
  googleNext: string;
  dict: GatewayDict;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmEmail, setConfirmEmail] = useState<string | null>(null);

  function onSubmit(formData: FormData) {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      const res = await registerAction(formData);
      if (res.ok) {
        setConfirmEmail(res.email); // email confirmation required — show the inbox state
        return;
      }
      setError(dict.errors[res.error] ?? dict.errors.failed!);
    });
  }

  if (confirmEmail !== null) {
    return (
      <CheckInbox
        email={confirmEmail}
        loginHref={loginHref}
        resendAction={resendAction}
        onChangeEmail={() => setConfirmEmail(null)}
        dict={dict}
      />
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

const RESEND_COOLDOWN_S = 30;

/**
 * "Check your inbox" state (005B.1) — masked email, plain-language explanation
 * that verification continues setup (no second login), a rate-limited resend
 * with a client cooldown and non-enumerating feedback, a start-over path, spam
 * + expiry guidance, and a Log-in link for someone who already verified.
 */
function CheckInbox({
  email,
  loginHref,
  resendAction,
  onChangeEmail,
  dict,
}: {
  email: string;
  loginHref: string;
  resendAction: (formData: FormData) => Promise<ResendResult>;
  onChangeEmail: () => void;
  dict: GatewayDict;
}) {
  const [pending, startTransition] = useTransition();
  const [cooldown, setCooldown] = useState(0);
  const [note, setNote] = useState<{ kind: "ok" | "rate"; text: string } | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  function resend() {
    if (pending || cooldown > 0) return;
    setNote(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("email", email);
      const res = await resendAction(fd);
      if (res.ok) {
        setNote({ kind: "ok", text: dict.resend_sent });
        setCooldown(RESEND_COOLDOWN_S);
      } else {
        setNote({ kind: "rate", text: dict.resend_rate });
        setCooldown(RESEND_COOLDOWN_S);
      }
    });
  }

  return (
    <div
      className="rounded-lg border border-line bg-card p-6 text-center shadow-card"
      role="status"
    >
      <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-success-soft text-success">
        <Icon name="inbox" size={22} aria-hidden />
      </span>
      <h2 className="mt-3 text-lg font-semibold text-ink">{dict.confirm_title}</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-secondary">
        {dict.confirm_sent_to}{" "}
        <span dir="ltr" className="font-medium text-ink">
          {maskEmail(email)}
        </span>
      </p>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-secondary">{dict.confirm_explain}</p>

      {note ? (
        <p
          role="status"
          className={
            "mt-3 rounded-md p-2.5 text-sm " +
            (note.kind === "ok" ? "bg-success-soft text-success" : "bg-warning-soft text-warning")
          }
        >
          {note.text}
        </p>
      ) : null}

      <div className="mt-4 flex flex-col gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={resend}
          disabled={pending || cooldown > 0}
        >
          {cooldown > 0 ? dict.resend_cooldown.replace("{s}", String(cooldown)) : dict.resend}
        </Button>
        <button
          type="button"
          onClick={onChangeEmail}
          className="min-h-9 text-sm font-medium text-brand hover:underline"
        >
          {dict.change_email}
        </button>
      </div>

      <p className="mt-4 text-xs leading-relaxed text-ink-muted">{dict.confirm_spam}</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">{dict.confirm_expired}</p>
      <p className="mt-3 text-sm text-ink-secondary">
        {dict.verified_already}{" "}
        <Link href={loginHref} className="font-medium text-brand hover:underline">
          {dict.login}
        </Link>
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
