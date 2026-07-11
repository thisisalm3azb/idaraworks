export function Spinner({ label }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-ink-muted">
      <span
        aria-hidden
        className="size-4 animate-spin rounded-full border-2 border-line-strong border-t-brand"
      />
      {label ? <span className="text-sm">{label}</span> : <span className="sr-only">Loading</span>}
    </span>
  );
}
