/**
 * H28 — the dock's server mount (ADR-58/64). Renders NOTHING unless the
 * release flag is the exact "1", the person may use Idara and the
 * organisation has not disabled AI. The launcher island it mounts is tiny;
 * the working window and the workspace load on demand.
 */
import { idaraGateFor } from "@/platform/ai";
import { can } from "@/platform/authz";
import { idaraEnabled } from "@/platform/flags";
import { directionFor, type Locale } from "@/platform/i18n";
import { getT } from "@/platform/i18n/server";
import type { RoleArchetype } from "@/platform/registries";
import type { Ctx } from "@/platform/tenancy";
import { addressableAgents } from "@/modules/idara/service";
import { dictFor } from "./dict";
import type { DockDict } from "./IdaraDock";
import { IdaraDockClient } from "./IdaraDockClient";

export async function IdaraDockMount({
  orgId,
  ctx,
  archetype,
  locale,
  userId,
}: {
  orgId: string;
  ctx: Ctx;
  archetype: RoleArchetype;
  locale: Locale;
  userId: string;
}) {
  if (!idaraEnabled()) return null;
  if (!can(archetype, "idara.use")) return null;
  const gate = await idaraGateFor(ctx);
  if (!gate.surfaceOn) return null;
  const t = await getT();
  const dict: DockDict = dictFor(t);
  const agents = addressableAgents(archetype).map((id) => ({
    id,
    name: t(`idara.agents.${id}.name`),
    description: t(`idara.agents.${id}.purpose`),
  }));
  return (
    <IdaraDockClient
      orgId={orgId}
      userId={userId}
      locale={locale}
      dir={directionFor(locale)}
      dict={dict}
      agents={agents}
      modelAvailable={gate.modelAvailable}
      reason={gate.reason}
      ownerAction={gate.ownerAction}
      canConfirm={can(archetype, "idara.actions.confirm")}
    />
  );
}
