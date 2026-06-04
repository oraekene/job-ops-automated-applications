/**
 * Persistence helpers for job suitability scores.
 *
 * Lives in its own module so the LLM scoring function (`scoreJobSuitability`
 * in `./scorer`) is referenced through a normal import boundary rather than a
 * module-level closure. This lets tests mock `./scorer` and observe the call
 * from `recomputeAndPersistSuitabilityScore`.
 */

import type { Job } from "@shared/types";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import { getActiveTenantId } from "../tenancy/context";
import { scoreJobSuitability } from "./scorer";

/**
 * Returns a `drizzle()` wrapper bound to the current singleton connection.
 * Resolved on each call so callers always see a live database even if the
 * connection is re-opened (e.g. between tests when `closeDb()` runs).
 */
function currentDb() {
	return drizzle(getDb(), { schema });
}

/**
 * Recompute a job's suitability score and persist the result along with
 * the current timestamp in `suitabilityComputedAt`. Used by prepJob when
 * the stored score is older than the staleness threshold.
 */
export async function recomputeAndPersistSuitabilityScore(
	job: Job,
	profile: Record<string, unknown>,
): Promise<{ score: number; reason: string }> {
	const result = await scoreJobSuitability(job, profile);
	const now = new Date().toISOString();
	currentDb()
		.update(schema.jobs)
		.set({
			suitabilityScore: result.score,
			suitabilityReason: result.reason,
			suitabilityComputedAt: now,
		})
		.where(sql`${schema.jobs.id} = ${job.id}`)
		.run();
	return result;
}

/**
 * Mark all jobs in the active tenant as having a stale suitability
 * score by clearing their `suitabilityComputedAt` timestamp. Called
 * from `onProfileChange` so the next prepJob triggers a recompute.
 */
export function invalidateSuitabilityForActiveTenant(): number {
	const tenantId = getActiveTenantId();
	const result = currentDb()
		.update(schema.jobs)
		.set({ suitabilityComputedAt: null })
		.where(sql`${schema.jobs.tenantId} = ${tenantId}`)
		.run();
	return result.changes ?? 0;
}
