import { cn } from "@/lib/cn";
import type { HTMLAttributes, ReactNode } from "react";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-lg border border-line bg-card p-4 shadow-sm", className)}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  meta,
  className,
}: {
  title: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex items-start justify-between gap-3", className)}>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {meta ? <div className="text-xs text-ink-muted">{meta}</div> : null}
    </div>
  );
}
