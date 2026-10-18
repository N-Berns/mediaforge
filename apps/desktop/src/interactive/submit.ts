import { getProfile } from "@mediaforge/media-profiles";
import type { JobOrigin } from "@mediaforge/shared-types";
import type { CoreConnector } from "../core/connect.ts";
import { jobIdOf, type StartPayload } from "../core/job-watch.ts";
import { candidateFor } from "../download.ts";
import type { Plan } from "./flow.ts";

/** The `download.start` payload for a plan from the wizard or the batch flow. */
export function startPayload(plan: Plan, origin: JobOrigin): StartPayload {
  const profile = getProfile(plan.profileId);
  if (!profile) throw new Error(`Unknown profile: ${plan.profileId}`);
  // Without a lookup the title is the link itself, which says nothing new.
  const title = plan.title && plan.title !== plan.url ? plan.title : undefined;
  return {
    candidate: candidateFor(plan.url, profile.kind, title),
    profileId: profile.id,
    outputDir: plan.outputDir,
    origin,
    kind: plan.kind,
    ...(plan.formatSelector && { formatSelector: plan.formatSelector }),
    ...(plan.steps && { plan: plan.steps }),
  };
}

/**
 * Start each plan in the core, in order, without watching them: the manager's table shows them.
 * Returns the new ids and the messages of the plans that could not start.
 */
export async function submitPlans(
  connect: CoreConnector,
  plans: readonly Plan[],
  origin: JobOrigin,
): Promise<{ ids: string[]; errors: string[] }> {
  const ids: string[] = [];
  const errors: string[] = [];
  const client = await connect();
  try {
    for (const plan of plans) {
      try {
        const id = jobIdOf(await client.request("download.start", startPayload(plan, origin)));
        if (id) ids.push(id);
        else errors.push("MediaForge did not start the download.");
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    client.close();
  }
  return { ids, errors };
}
