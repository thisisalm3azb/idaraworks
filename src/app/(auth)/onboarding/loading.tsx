import { Skeleton } from "@/platform/ui/dashboard";

/** Route-level skeleton while a wizard step resolves (draft read + step render). */
export default function Loading() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6" aria-busy="true">
      <Skeleton className="h-2 w-full" />
      <Skeleton className="h-64" />
      <Skeleton className="h-11 w-40" />
    </div>
  );
}
