import { AppShell, Badge, Button, Card, CardHeader, EmptyState } from "@/platform/ui";

/**
 * Temporary landing surface for S0. Replaced by the auth flow (Phase C)
 * and role-scoped Today screens (S5+). Copy is deliberately domain-neutral —
 * domain nouns arrive only via the terminology resolver (Phase F).
 */
export default function Home() {
  return (
    <AppShell brand={<span>IdaraWorks</span>} actions={<Badge tone="brand">S0 · bedrock</Badge>}>
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title="Platform status" meta="Phase A" />
          <p className="text-sm text-ink-secondary">
            Foundation build in progress: tooling, boundaries, design system. Identity, tenancy, and
            storage arrive in the next phases of S0.
          </p>
        </Card>
        <EmptyState
          title="Nothing to see yet"
          description="This surface becomes the sign-in screen once identity ships."
          action={
            <Button variant="secondary" disabled>
              Sign in — coming in Phase C
            </Button>
          }
        />
      </div>
    </AppShell>
  );
}
