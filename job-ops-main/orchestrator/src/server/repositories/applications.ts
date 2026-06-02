import type { ApplicationStatus } from "@shared/types";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "../db";
import { getActiveTenantId } from "../tenancy/context";

const { applications } = schema;

function generateId(): string {
	return (
		"app_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
	);
}

export interface CreateApplicationInput {
	jobId: string;
	atsType: "greenhouse" | "lever";
	status: ApplicationStatus;
}

export interface UpdateApplicationInput {
	status?: ApplicationStatus;
	fieldPayload?: string | null;
	screeningAnswers?: string | null;
	customQuestions?: string | null;
	confirmationId?: string | null;
	submittedAt?: string | null;
	screenshotPath?: string | null;
	errorMessage?: string | null;
}

export type ApplicationRow = {
	id: string;
	tenantId: string;
	jobId: string;
	atsType: string;
	status: string;
	fieldPayload: string | null;
	screeningAnswers: string | null;
	customQuestions: string | null;
	confirmationId: string | null;
	submittedAt: string | null;
	screenshotPath: string | null;
	errorMessage: string | null;
	createdAt: string;
	updatedAt: string;
};

export const applicationRepository = {
	findByJobId(jobId: string): ApplicationRow | undefined {
		return db
			.select()
			.from(applications)
			.where(
				and(
					eq(applications.jobId, jobId),
					eq(applications.tenantId, getActiveTenantId()),
				),
			)
			.get() as ApplicationRow | undefined;
	},

	findPending(): ApplicationRow[] {
		return db
			.select()
			.from(applications)
			.where(
				and(
					eq(applications.status, "ready_for_review"),
					eq(applications.tenantId, getActiveTenantId()),
				),
			)
			.orderBy(desc(applications.createdAt))
			.all() as ApplicationRow[];
	},

	create(input: CreateApplicationInput): ApplicationRow {
		const now = new Date().toISOString();
		const row = {
			id: generateId(),
			tenantId: getActiveTenantId(),
			jobId: input.jobId,
			atsType: input.atsType,
			status: input.status,
			fieldPayload: null,
			screeningAnswers: null,
			customQuestions: null,
			confirmationId: null,
			submittedAt: null,
			screenshotPath: null,
			errorMessage: null,
			createdAt: now,
			updatedAt: now,
		};
		db.insert(applications).values(row).run();
		return row;
	},

	update(id: string, input: UpdateApplicationInput): void {
		db.update(applications)
			.set({ ...input, updatedAt: new Date().toISOString() })
			.where(eq(applications.id, id))
			.run();
	},
};
