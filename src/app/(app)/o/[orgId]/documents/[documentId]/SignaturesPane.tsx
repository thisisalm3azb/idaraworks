"use client";

/**
 * H26 — the signature room inside the document: open a room with one signer
 * per party (members or external people), send invitations, follow status,
 * revoke or re-invite, sign your own party in-app, and read the evidence.
 * Invitation links appear ONCE, only when email delivery is not provisioned.
 */
import { useState } from "react";
import { Badge, Button } from "@/platform/ui";
import { formatDateTime } from "@/platform/format";
import type { InvitationLink, SignatureRequestRow } from "@/modules/docstudio/service";
import type { ActionResult } from "../studio-actions";
import {
  cancelSignatureRequestAction,
  createSignatureRequestAction,
  reinviteSignerAction,
  revokeSignerAction,
  signAsMemberAction,
} from "../studio-actions";

export type SignaturesDict = {
  title: string;
  notIssued: string;
  noRoom: string;
  parties: string;
  signerKind: string;
  member: string;
  external: string;
  person: string;
  name: string;
  email: string;
  signerTitle: string;
  mode: string;
  parallel: string;
  sequential: string;
  expiresInDays: string;
  message: string;
  open: string;
  linksTitle: string;
  linksHint: string;
  copy: string;
  status: Record<string, string>;
  requestStatus: Record<string, string>;
  delivery: Record<string, string>;
  invitedAt: string;
  signedAt: string;
  viewedAt: string;
  revoke: string;
  reinvite: string;
  cancel: string;
  cancelReason: string;
  signHere: string;
  yourName: string;
  yourTitle: string;
  typed: string;
  consent: string;
  sign: string;
  evidence: string;
  provider: string;
  disclaimer: string;
  expires: string;
};

type Party = string;

export function SignaturesPane({
  orgId,
  documentId,
  status,
  parties,
  request,
  members,
  currentUserId,
  canRequest,
  canSign,
  consentText,
  locale,
  dict,
  settle,
}: {
  orgId: string;
  documentId: string;
  status: string;
  parties: Party[];
  request: SignatureRequestRow | null;
  members: Array<{ id: string; name: string }>;
  currentUserId: string;
  canRequest: boolean;
  canSign: boolean;
  consentText: string;
  locale: string;
  dict: SignaturesDict;
  settle: (res: ActionResult<unknown>, okText?: string, quiet?: boolean) => boolean;
}) {
  const l = locale as "en" | "ar";
  const [rows, setRows] = useState(
    parties.map((p) => ({
      party: p,
      kind: "external" as "member" | "external",
      userId: "",
      name: "",
      email: "",
      title: "",
    })),
  );
  const [mode, setMode] = useState<"parallel" | "sequential">("parallel");
  const [days, setDays] = useState(14);
  const [message, setMessage] = useState("");
  const [links, setLinks] = useState<InvitationLink[]>([]);
  const [busy, setBusy] = useState(false);
  const [signName, setSignName] = useState("");
  const [signTitle, setSignTitle] = useState("");
  const [consent, setConsent] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const input =
    "mt-1 min-h-11 w-full rounded-md border border-line-strong bg-card px-3 text-base text-ink";
  const live = request && (request.status === "pending" || request.status === "in_progress");

  if (
    status !== "signature" &&
    status !== "active" &&
    status !== "expired" &&
    status !== "terminated" &&
    status !== "superseded"
  ) {
    return (
      <p className="rounded-md bg-sunken px-3 py-2 text-sm text-ink-secondary">{dict.notIssued}</p>
    );
  }

  const open = async () => {
    setBusy(true);
    const res = await createSignatureRequestAction(orgId, {
      documentId,
      mode,
      expiresInDays: days,
      message: message.trim() || undefined,
      signers: rows.map((r) => ({
        party: r.party,
        kind: r.kind,
        ...(r.kind === "member"
          ? { userId: r.userId, name: members.find((m) => m.id === r.userId)?.name ?? r.name }
          : { name: r.name, email: r.email }),
        ...(r.title.trim() ? { title: r.title.trim() } : {}),
      })),
    });
    setBusy(false);
    if (settle(res)) setLinks(res.ok ? res.data.invitations.filter((i) => i.link) : []);
  };

  return (
    <div className="flex flex-col gap-3">
      {links.length > 0 ? (
        <section className="rounded-lg border border-warning-soft bg-warning-soft p-3">
          <h3 className="text-sm font-semibold text-ink">{dict.linksTitle}</h3>
          <p className="text-xs text-ink-secondary">{dict.linksHint}</p>
          <ul className="mt-2 flex flex-col gap-1">
            {links.map((i) => (
              <li key={i.signerId} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-ink">{i.name}</span>
                <code className="truncate rounded bg-card px-2 py-1 text-xs">
                  <bdi dir="ltr">{i.link}</bdi>
                </code>
                <Button
                  variant="ghost"
                  onClick={() => void navigator.clipboard?.writeText(i.link ?? "")}
                >
                  {dict.copy}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {request ? (
        <section className="rounded-lg border border-line bg-card p-3 shadow-card">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={request.status === "completed" ? "success" : live ? "info" : "danger"}>
              {dict.requestStatus[request.status] ?? request.status}
            </Badge>
            <span className="text-xs text-ink-muted">
              {dict.provider}: {request.provider} · {dict.mode}:{" "}
              {request.mode === "parallel" ? dict.parallel : dict.sequential}
            </span>
            <span className="text-xs text-ink-muted">
              {dict.expires} {formatDateTime(request.expiresAt, { locale: l })}
            </span>
            {live && canRequest ? (
              <span className="ms-auto flex items-center gap-1">
                <input
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  placeholder={dict.cancelReason}
                  className="min-h-9 rounded-md border border-line-strong bg-card px-2 text-xs text-ink"
                />
                <Button
                  variant="danger"
                  disabled={busy || cancelReason.trim().length === 0}
                  onClick={async () => {
                    setBusy(true);
                    settle(
                      await cancelSignatureRequestAction(orgId, {
                        requestId: request.id,
                        reason: cancelReason.trim(),
                      }),
                    );
                    setBusy(false);
                  }}
                >
                  {dict.cancel}
                </Button>
              </span>
            ) : null}
          </div>
          <ul className="mt-2 flex flex-col gap-2">
            {request.signers.map((s) => {
              const mine = s.partyKind === "member" && s.userId === currentUserId;
              const canSignNow =
                mine && canSign && live && (s.status === "invited" || s.status === "viewed");
              return (
                <li key={s.id} className="rounded-md border border-line p-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-sunken px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-muted">
                      {s.party}
                    </span>
                    <span className="font-medium text-ink">{s.name}</span>
                    {s.title ? <span className="text-xs text-ink-secondary">{s.title}</span> : null}
                    {s.email ? <span className="text-xs text-ink-muted">{s.email}</span> : null}
                    <Badge
                      tone={
                        s.status === "signed"
                          ? "success"
                          : s.status === "declined" || s.status === "revoked"
                            ? "danger"
                            : "neutral"
                      }
                    >
                      {dict.status[s.status] ?? s.status}
                    </Badge>
                    {s.delivery ? (
                      <span className="text-xs text-ink-muted">
                        {dict.delivery[s.delivery] ?? s.delivery}
                      </span>
                    ) : null}
                    {s.signedAt ? (
                      <span className="text-xs text-ink-muted">
                        {dict.signedAt} {formatDateTime(s.signedAt, { locale: l })}
                      </span>
                    ) : s.viewedAt ? (
                      <span className="text-xs text-ink-muted">
                        {dict.viewedAt} {formatDateTime(s.viewedAt, { locale: l })}
                      </span>
                    ) : s.invitedAt ? (
                      <span className="text-xs text-ink-muted">
                        {dict.invitedAt} {formatDateTime(s.invitedAt, { locale: l })}
                      </span>
                    ) : null}
                    {live && canRequest && (s.status === "invited" || s.status === "viewed") ? (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          settle(await revokeSignerAction(orgId, { signerId: s.id }));
                          setBusy(false);
                        }}
                      >
                        {dict.revoke}
                      </Button>
                    ) : null}
                    {live &&
                    canRequest &&
                    s.partyKind === "external" &&
                    (s.status === "revoked" ||
                      s.status === "expired" ||
                      s.status === "invited" ||
                      s.status === "viewed") ? (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          const res = await reinviteSignerAction(orgId, { signerId: s.id });
                          setBusy(false);
                          if (settle(res)) setLinks(res.ok ? res.data.filter((i) => i.link) : []);
                        }}
                      >
                        {dict.reinvite}
                      </Button>
                    ) : null}
                  </div>
                  {s.declineReason ? (
                    <p className="mt-1 text-xs text-danger">{s.declineReason}</p>
                  ) : null}
                  {s.evidenceHash ? (
                    <p
                      className="mt-1 truncate font-mono text-[10px] text-ink-muted"
                      title={JSON.stringify(s.evidence)}
                    >
                      {dict.evidence}: <bdi dir="ltr">{s.evidenceHash}</bdi>
                    </p>
                  ) : null}
                  {canSignNow ? (
                    <div className="mt-2 flex flex-col gap-2 rounded-md border border-accent-line bg-accent-soft p-2">
                      <h4 className="text-sm font-semibold text-ink">{dict.signHere}</h4>
                      <label className="text-xs text-ink-muted">
                        {dict.yourName}
                        <input
                          value={signName || s.name}
                          onChange={(e) => setSignName(e.target.value)}
                          className={input}
                        />
                      </label>
                      <label className="text-xs text-ink-muted">
                        {dict.yourTitle}
                        <input
                          value={signTitle}
                          onChange={(e) => setSignTitle(e.target.value)}
                          className={input}
                        />
                      </label>
                      <label className="flex items-start gap-2 text-sm text-ink">
                        <input
                          type="checkbox"
                          checked={consent}
                          onChange={(e) => setConsent(e.target.checked)}
                          className="mt-1"
                        />
                        <span>{consentText}</span>
                      </label>
                      <Button
                        disabled={busy || !consent}
                        onClick={async () => {
                          setBusy(true);
                          settle(
                            await signAsMemberAction(orgId, {
                              signerId: s.id,
                              capture: {
                                kind: "typed",
                                data: (signName || s.name).trim(),
                                name: (signName || s.name).trim(),
                                title: signTitle.trim() || undefined,
                                consent: true,
                                locale: l,
                              },
                            }),
                          );
                          setBusy(false);
                        }}
                      >
                        {dict.sign}
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-[11px] text-ink-muted">{dict.disclaimer}</p>
        </section>
      ) : null}

      {!live && status === "signature" && canRequest ? (
        <section className="flex flex-col gap-2 rounded-lg border border-line bg-card p-3 shadow-card">
          <h3 className="text-sm font-semibold text-ink">{request ? dict.open : dict.noRoom}</h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="text-xs text-ink-muted">
              {dict.mode}
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as typeof mode)}
                className={input}
              >
                <option value="parallel">{dict.parallel}</option>
                <option value="sequential">{dict.sequential}</option>
              </select>
            </label>
            <label className="text-xs text-ink-muted">
              {dict.expiresInDays}
              <input
                type="number"
                min={1}
                max={90}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className={input}
              />
            </label>
            <label className="text-xs text-ink-muted">
              {dict.message}
              <input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={2000}
                className={input}
              />
            </label>
          </div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            {dict.parties}
          </h4>
          {rows.map((r, i) => (
            <div
              key={r.party}
              className="grid grid-cols-1 gap-2 rounded-md border border-line p-2 sm:grid-cols-4"
            >
              <div className="text-sm font-medium text-ink sm:col-span-4">{r.party}</div>
              <label className="text-xs text-ink-muted">
                {dict.signerKind}
                <select
                  value={r.kind}
                  onChange={(e) =>
                    setRows((x) =>
                      x.map((y, j) =>
                        j === i ? { ...y, kind: e.target.value as "member" | "external" } : y,
                      ),
                    )
                  }
                  className={input}
                >
                  <option value="external">{dict.external}</option>
                  <option value="member">{dict.member}</option>
                </select>
              </label>
              {r.kind === "member" ? (
                <label className="text-xs text-ink-muted sm:col-span-2">
                  {dict.person}
                  <select
                    value={r.userId}
                    onChange={(e) =>
                      setRows((x) =>
                        x.map((y, j) => (j === i ? { ...y, userId: e.target.value } : y)),
                      )
                    }
                    className={input}
                  >
                    <option value="">–</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <>
                  <label className="text-xs text-ink-muted">
                    {dict.name}
                    <input
                      value={r.name}
                      onChange={(e) =>
                        setRows((x) =>
                          x.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)),
                        )
                      }
                      className={input}
                    />
                  </label>
                  <label className="text-xs text-ink-muted">
                    {dict.email}
                    <input
                      type="email"
                      value={r.email}
                      onChange={(e) =>
                        setRows((x) =>
                          x.map((y, j) => (j === i ? { ...y, email: e.target.value } : y)),
                        )
                      }
                      className={input}
                    />
                  </label>
                </>
              )}
              <label className="text-xs text-ink-muted">
                {dict.signerTitle}
                <input
                  value={r.title}
                  onChange={(e) =>
                    setRows((x) => x.map((y, j) => (j === i ? { ...y, title: e.target.value } : y)))
                  }
                  className={input}
                />
              </label>
            </div>
          ))}
          <div>
            <Button
              disabled={
                busy ||
                rows.some((r) =>
                  r.kind === "member" ? !r.userId : !r.name.trim() || !r.email.trim(),
                )
              }
              onClick={open}
            >
              {dict.open}
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
