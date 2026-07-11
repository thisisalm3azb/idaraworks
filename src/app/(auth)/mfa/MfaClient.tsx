"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/platform/tenancy/supabase";
import { Button, Card, Field, Spinner } from "@/platform/ui";
import { t } from "@/platform/i18n/t";
import { logMfaEventAction } from "../actions";

type Mode = "loading" | "enroll" | "challenge" | "done";

export function MfaClient() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("loading");
  const [qr, setQr] = useState<string | null>(null);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const supabase = supabaseBrowser();

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.auth.mfa.listFactors();
      const verified = data?.totp?.find((f) => f.status === "verified");
      if (verified) {
        setFactorId(verified.id);
        setMode("challenge");
      } else {
        const { data: enroll, error: enrollErr } = await supabase.auth.mfa.enroll({
          factorType: "totp",
        });
        if (enrollErr || !enroll) {
          setError(enrollErr?.message ?? "enroll failed");
          return;
        }
        setFactorId(enroll.id);
        setQr(enroll.totp.qr_code);
        setMode("enroll");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function verify() {
    if (!factorId) return;
    setError(null);
    const { data: challenge, error: chErr } = await supabase.auth.mfa.challenge({ factorId });
    if (chErr || !challenge) {
      setError(chErr?.message ?? "challenge failed");
      return;
    }
    const wasEnrolling = mode === "enroll";
    const { error: vErr } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.id,
      code,
    });
    if (vErr) {
      setError(vErr.message);
      void logMfaEventAction("mfa_challenge_failure");
      return;
    }
    void logMfaEventAction(wasEnrolling ? "mfa_enrolled" : "mfa_challenge_success");
    setMode("done");
    router.push("/");
    router.refresh();
  }

  return (
    <Card>
      <h1 className="mb-4 text-lg font-semibold text-ink">{t("auth.mfa.title")}</h1>
      {error ? (
        <p className="mb-3 rounded-md bg-danger-soft p-3 text-sm text-danger">{error}</p>
      ) : null}
      {mode === "loading" ? <Spinner label={t("common.loading")} /> : null}
      {mode === "enroll" && qr ? (
        <div className="mb-4 flex flex-col items-center gap-3">
          <p className="text-sm text-ink-secondary">{t("auth.mfa.enroll")}</p>
          {/* Supabase returns the QR as an SVG data URI */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={qr}
            alt="TOTP QR code"
            width={176}
            height={176}
            className="rounded-md border border-line"
          />
        </div>
      ) : null}
      {mode === "enroll" || mode === "challenge" ? (
        <div className="flex flex-col gap-4">
          <Field
            label={t("auth.mfa.code")}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={6}
          />
          <Button onClick={verify} disabled={code.length !== 6}>
            {t("auth.mfa.verify")}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
