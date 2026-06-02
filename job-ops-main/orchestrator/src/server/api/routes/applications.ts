import { badRequest, notFound } from "@infra/errors";
import { asyncRoute, ok } from "@infra/http";
import { applicationService } from "@server/services/applications";
import { type Request, type Response, Router } from "express";

export const applicationRouter = Router();

applicationRouter.get(
	"/prep",
	asyncRoute(async (req: Request, res: Response) => {
		const url = req.query.url as string | undefined;
		const ats = req.query.ats as string | undefined;
		if (!url || !ats) throw badRequest("Missing url or ats parameter");

		const result = await applicationService.prepJob(url, ats);
		ok(res, result);
	}),
);

applicationRouter.post(
	"/payload",
	asyncRoute(async (req: Request, res: Response) => {
		const { jobId, atsType, customQuestions } = req.body;
		if (!jobId || !atsType) throw badRequest("Missing jobId or atsType");

		const result = await applicationService.buildPayload(
			jobId,
			atsType,
			customQuestions || [],
		);
		ok(res, result);
	}),
);

applicationRouter.post(
	"/confirm",
	asyncRoute(async (req: Request, res: Response) => {
		const { jobId, applicationId, confirmationId, submittedAt } = req.body;
		if (!jobId) throw badRequest("Missing jobId");

		const result = await applicationService.confirmSubmission({
			jobId,
			applicationId,
			atsType: req.body.atsType || "",
			confirmationId: confirmationId || "",
			submittedAt: submittedAt || new Date().toISOString(),
			fieldSnapshot: req.body.fieldSnapshot || {},
			answersSnapshot: req.body.answersSnapshot || {},
			screenshotBase64: req.body.screenshotBase64 || "",
		});
		ok(res, result);
	}),
);

applicationRouter.get(
	"/pending",
	asyncRoute(async (_req: Request, res: Response) => {
		const pending = applicationService.getPending();
		ok(res, { applications: pending });
	}),
);
