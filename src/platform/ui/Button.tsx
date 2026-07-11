import { cn } from "@/lib/cn";
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "md" | "lg";

const variants: Record<Variant, string> = {
  primary: "bg-brand text-ink-inverse hover:bg-brand-strong",
  secondary: "bg-card text-ink border border-line-strong hover:bg-sunken",
  ghost: "bg-transparent text-ink hover:bg-sunken",
  danger: "bg-danger text-ink-inverse hover:opacity-90",
};

const sizes: Record<Size, string> = {
  // min-h enforces the 44px touch target (BUILD_BIBLE §9.2)
  md: "min-h-11 px-4 text-sm",
  lg: "min-h-12 px-6 text-base",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

export function Button({ variant = "primary", size = "md", className, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
