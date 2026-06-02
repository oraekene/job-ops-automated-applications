import { detectAtsByUrl } from "./drivers/ats-detector";
import { fillGreenhouseForm } from "./drivers/greenhouse";
import { fillLeverForm } from "./drivers/lever";
import { JobOpsApi } from "./lib/jobops-api";

const API_BASE = "http://localhost:3005";
const api = new JobOpsApi(API_BASE);

let panelShadow: ShadowRoot | null = null;

function createPanelHTML(): HTMLDivElement {
	const wrapper = document.createElement("div");
	wrapper.id = "jobops-panel";
	wrapper.style.cssText = "all:initial;";
	panelShadow = wrapper.attachShadow({ mode: "closed" });
	panelShadow.innerHTML = `
<div id="root" style="position:fixed;bottom:20px;right:20px;z-index:2147483647;width:320px;background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.15);padding:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#1a1a1a;">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
    <span style="font-weight:600;font-size:16px;">JobOps Copilot</span>
    <span id="badge" style="margin-left:auto;padding:2px 8px;border-radius:20px;font-size:12px;background:#f0f0f0;color:#666;">Loading</span>
  </div>
  <div id="body">
    <div style="text-align:center;color:#666;padding:8px;">Initializing...</div>
  </div>
</div>`;
	return wrapper;
}

function getShadowRoot(): ShadowRoot | null {
	return panelShadow;
}

function updatePanel(
	body: string,
	badgeText?: string,
	badgeBg?: string,
	badgeColor?: string,
) {
	const shadow = getShadowRoot();
	if (!shadow) return;
	const bodyEl = shadow.getElementById("body");
	if (bodyEl) bodyEl.innerHTML = body;
	const badgeEl = shadow.getElementById("badge");
	if (badgeEl) {
		badgeEl.textContent = badgeText || "";
		badgeEl.style.background = badgeBg || "#f0f0f0";
		badgeEl.style.color = badgeColor || "#666";
	}
}

function ensurePanelInjected(): boolean {
	if (document.getElementById("jobops-panel")) return true;
	const panel = createPanelHTML();
	document.documentElement.appendChild(panel);
	return false;
}

function showReadyPanel(jobTitle: string, employer: string, score?: number) {
	ensurePanelInjected();
	updatePanel(
		`
    ${jobTitle ? `<div style="margin-bottom:4px;font-weight:500;">${escapeHtml(jobTitle)}</div>` : ""}
    ${employer ? `<div style="margin-bottom:8px;color:#666;font-size:13px;">${escapeHtml(employer)}</div>` : ""}
    ${score !== undefined ? `<div style="margin-bottom:8px;"><span style="font-size:13px;color:#666;">Fit Score: </span><span style="font-weight:600;color:${score >= 70 ? "#2e7d32" : score >= 40 ? "#e65100" : "#c62828"};">${score}/100</span></div>` : ""}
    <button id="fill-btn" style="width:100%;padding:10px;background:#1976d2;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:14px;">Fill Application</button>
    <div style="margin-top:8px;font-size:11px;color:#999;text-align:center;">Requires JobOps server on localhost:3005</div>
  `,
		"Ready",
		"#e3f2fd",
		"#1565c0",
	);

	const shadow = getShadowRoot();
	shadow?.getElementById("fill-btn")?.addEventListener("click", () => {
		updatePanel(
			'<div style="text-align:center;color:#666;padding:8px;">Filling application...</div>',
			"Filling",
			"#fff3e0",
			"#e65100",
		);
		setTimeout(doFill, 100);
	});
}

function showOfflinePanel() {
	ensurePanelInjected();
	updatePanel(
		`
    <div style="margin-bottom:8px;font-size:13px;color:#c62828;">Server offline</div>
    <button id="fill-btn" style="width:100%;padding:10px;background:#1976d2;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:14px;">Demo: Fill Form</button>
    <div style="margin-top:8px;font-size:11px;color:#999;">Fills with demo placeholder data for visual testing</div>
  `,
		"Demo",
		"#fff3e0",
		"#e65100",
	);

	const shadow = getShadowRoot();
	shadow?.getElementById("fill-btn")?.addEventListener("click", () => {
		updatePanel(
			'<div style="text-align:center;color:#666;padding:8px;">Filling application...</div>',
			"Filling",
			"#fff3e0",
			"#e65100",
		);
		setTimeout(doFill, 100);
	});
}

function escapeHtml(text: string): string {
	const d = document.createElement("div");
	d.textContent = text;
	return d.innerHTML;
}

async function waitForPageStability(): Promise<void> {
	if (document.readyState !== "complete") {
		await new Promise<void>((resolve) => {
			document.addEventListener(
				"readystatechange",
				() => {
					resolve();
				},
				{ once: true },
			);
		});
	}
	await new Promise<void>((resolve) => {
		setTimeout(resolve, 2000);
	});
}

function doFill() {
	console.log("JobOps: fill triggered");
	const profile = {
		first_name: "John",
		last_name: "Doe",
		email: "john@example.com",
		phone: "+1234567890",
		linkedin_url: "https://linkedin.com/in/johndoe",
		current_company: "Acme Corp",
		cover_letter: "I am excited about this opportunity...",
		salary: "$120,000",
	};

	const atsType = detectAtsByUrl(window.location.href);
	const atsFiller =
		atsType === "greenhouse" ? fillGreenhouseForm : fillLeverForm;
	try {
		const atsResult = atsFiller({ ...profile, screening_answers: {} });
		console.log("JobOps: ATS driver result:", atsResult);
	} catch (err) {
		console.log("JobOps: ATS driver error, using fallback:", err);
	}

	const labelResult = fillFormByLabels(profile);
	console.log(
		"JobOps: label-based filler filled",
		labelResult.filled,
		"fields",
	);

	updatePanel(
		'<div style="text-align:center;font-size:13px;color:#2e7d32;font-weight:500;">\u2713 Fields filled. Please review and submit manually.</div>',
		"Review",
		"#e6f7e6",
		"#2e7d32",
	);
	startConfirmationMonitoring();
}

function fillFormByLabels(data: Record<string, string>): { filled: number } {
	const LABEL_MAP: Record<string, string> = {
		"first name": "first_name",
		"last name": "last_name",
		email: "email",
		phone: "phone",
		linkedin: "linkedin_url",
		"linkedin profile": "linkedin_url",
		company: "current_company",
		"current company": "current_company",
		"cover letter": "cover_letter",
		salary: "salary",
		"salary expectations": "salary",
	};

	let filled = 0;

	const fields = document.querySelectorAll<HTMLElement>(
		'input:not([type="hidden"]):not([type="file"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea, select',
	);
	fields.forEach((field) => {
		const label = findLabel(field);
		if (!label) return;

		const labelLower = label.toLowerCase().trim();
		for (const [pattern, key] of Object.entries(LABEL_MAP)) {
			if (labelLower.includes(pattern) && data[key]) {
				if (field instanceof HTMLSelectElement) {
					const option = Array.from(field.options).find((o) =>
						o.text.toLowerCase().includes(data[key].toLowerCase().slice(0, 10)),
					);
					if (option) {
						field.value = option.value;
						field.dispatchEvent(new Event("change", { bubbles: true }));
						filled++;
					}
				} else {
					const input = field as HTMLInputElement | HTMLTextAreaElement;
					const proto =
						input.tagName === "TEXTAREA"
							? HTMLTextAreaElement.prototype
							: HTMLInputElement.prototype;
					const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
					if (setter) {
						setter.call(input, data[key]);
						input.dispatchEvent(new Event("input", { bubbles: true }));
						input.dispatchEvent(new Event("change", { bubbles: true }));
						filled++;
					}
				}
				break;
			}
		}
	});

	return { filled };
}

function findLabel(el: HTMLElement): string | null {
	const id = el.id;
	if (id) {
		const label = document.querySelector<HTMLLabelElement>(
			`label[for="${id}"]`,
		);
		if (label) return label.innerText;
	}
	let parent = el.parentElement;
	for (let i = 0; i < 5 && parent; i++) {
		const label = parent.querySelector<HTMLElement>(
			":scope > label, :scope > span, :scope > div",
		);
		if (label && label !== el) {
			const text = label.innerText?.trim();
			if (text) return text;
		}
		parent = parent.parentElement;
	}
	const ariaLabel = el.getAttribute("aria-label");
	if (ariaLabel) return ariaLabel;
	const placeholder = el.getAttribute("placeholder");
	if (placeholder) return placeholder;
	return null;
}

function extractCustomQuestions(atsType: string): string[] {
	if (atsType === "greenhouse") {
		return Array.from(
			document.querySelectorAll<HTMLElement>('[data-qa^="question_"] label'),
		)
			.map((el) => el.innerText?.trim())
			.filter(Boolean);
	}
	if (atsType === "lever") {
		return Array.from(
			document.querySelectorAll<HTMLElement>(
				"li.application-question.custom-question .application-label",
			),
		)
			.map((el) => el.innerText?.trim())
			.filter(Boolean);
	}
	return [];
}

function startConfirmationMonitoring(): void {
	let settled = false;
	function done(confirmationId?: string): void {
		if (settled) return;
		settled = true;
		updatePanel(
			'<div style="text-align:center;padding:8px;color:#2e7d32;font-weight:500;">✓ Application submitted successfully!</div>',
			"Done",
			"#e6f7e6",
			"#2e7d32",
		);
	}
	function fallback(): void {
		if (settled) return;
		settled = true;
		updatePanel(
			'<div style="text-align:center;padding:8px;color:#e65100;font-weight:500;">Did the submission go through?</div><button id="confirm-btn" style="width:100%;padding:8px;background:#2e7d32;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;margin-top:8px;">Confirm</button>',
			"Pending",
			"#fff3e0",
			"#e65100",
		);
		const shadow = getShadowRoot();
		shadow
			?.getElementById("confirm-btn")
			?.addEventListener("click", () => done());
	}
	function checkUrl(): boolean {
		if (
			/^\/(confirmation|thank-you|apply\/success)/i.test(
				window.location.pathname,
			)
		) {
			done();
			return true;
		}
		return false;
	}
	function checkDom(): boolean {
		const text = document.body?.innerText ?? "";
		if (
			/\b(?:Your application has been submitted|Thank you for applying|Application received)\b/i.test(
				text,
			)
		) {
			done();
			return true;
		}
		return false;
	}
	if (checkUrl() || checkDom()) return;
	const observer = new MutationObserver(() => {
		if (checkUrl() || checkDom()) observer.disconnect();
	});
	observer.observe(document.body, { childList: true, subtree: true });
	setTimeout(() => {
		observer.disconnect();
		fallback();
	}, 30000);
}

async function main() {
	console.log("JobOps: content script loaded on", window.location.href);
	const url = window.location.href;
	const atsType = detectAtsByUrl(url);
	console.log("JobOps: detected ATS:", atsType);
	if (atsType === "unknown") {
		console.log("JobOps: unknown ATS, exiting");
		return;
	}

	ensurePanelInjected();

	await waitForPageStability();

	const FORCE_PANEL_TIMEOUT = 5000;
	let panelShown = false;

	setTimeout(() => {
		if (!panelShown) {
			console.log("JobOps: server timeout, showing demo panel");
			panelShown = true;
			showOfflinePanel();
		}
	}, FORCE_PANEL_TIMEOUT);

	try {
		console.log("JobOps: calling server at", API_BASE);
		const prep = await api.prepJob(url, atsType);
		if (panelShown) return;
		panelShown = true;
		console.log("JobOps: server responded", prep);
		showReadyPanel(
			prep.job?.title || "",
			prep.job?.employer || "",
			prep.job?.suitabilityScore,
		);
	} catch (err) {
		if (panelShown) return;
		panelShown = true;
		console.log("JobOps: server error, showing demo:", err);
		showOfflinePanel();
	}
}

main().catch(console.error);
