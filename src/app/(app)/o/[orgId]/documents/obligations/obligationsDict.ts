/** H26H — copy for the obligations board, built on the server and passed as props. */
export type ObligationsDict = {
  title: string;
  subtitle: string;
  views: Record<string, string>;
  kpi: Record<string, string>;
  kinds: Record<string, string>;
  statuses: Record<string, string>;
  dueStates: Record<string, string>;
  sides: Record<string, string>;
  risk: Record<string, string>;
  filters: Record<string, string>;
  fields: Record<string, string>;
  actions: Record<string, string>;
  empty: string;
  emptyDoc: string;
  evidenceHint: string;
  reasonHint: string;
  escalateHint: string;
  saved: string;
  failed: string;
  confirm: string;
  cancel: string;
  close: string;
  daysLeft: string;
  daysOver: string;
  today: string;
  months: string[];
  weekdays: string[];
};

export function obligationsDict(t: (k: string) => string): ObligationsDict {
  const k = (x: string) => t(`docstudio.ob.${x}`);
  const rec = (prefix: string, keys: string[]) =>
    Object.fromEntries(keys.map((x) => [x, k(`${prefix}.${x}`)]));
  return {
    title: k("title"),
    subtitle: k("subtitle"),
    views: rec("view", ["list", "timeline", "calendar", "relationships"]),
    kpi: rec("kpi", ["overdue", "due_soon", "upcoming", "done"]),
    kinds: rec("kind", ["obligation", "payment", "renewal", "notice", "review", "risk"]),
    statuses: rec("status", ["open", "done", "waived", "cancelled"]),
    dueStates: rec("due", ["overdue", "due_soon", "upcoming", "closed"]),
    sides: rec("side", ["ours", "theirs"]),
    risk: rec("risk", ["low", "medium", "high"]),
    filters: rec("filter", ["open_only", "mine", "all_kinds", "any_state"]),
    fields: rec("field", [
      "document",
      "kind",
      "title",
      "description",
      "due_on",
      "owner",
      "side",
      "amount",
      "currency",
      "recurrence",
      "requires_evidence",
      "risk_level",
      "clause",
      "evidence_note",
      "reason",
      "escalate_to",
      "note",
    ]),
    actions: rec("action", [
      "new",
      "complete",
      "waive",
      "cancel",
      "reopen",
      "escalate",
      "edit",
      "open_document",
      "renew",
    ]),
    empty: k("empty"),
    emptyDoc: k("empty_doc"),
    evidenceHint: k("evidence_hint"),
    reasonHint: k("reason_hint"),
    escalateHint: k("escalate_hint"),
    saved: t("docstudio.saved"),
    failed: t("docstudio.failed"),
    confirm: t("docstudio.ws.confirm"),
    cancel: t("docstudio.cancel"),
    close: t("docstudio.ws.close"),
    daysLeft: k("days_left"),
    daysOver: k("days_over"),
    today: k("today"),
    months: k("months").split("|"),
    weekdays: k("weekdays").split("|"),
  };
}
