import { beforeEach, describe, expect, it, vi } from "vitest";

describe("background service worker", () => {
	beforeEach(() => {
		vi.resetModules();
		global.chrome = {
			tabs: { onUpdated: { addListener: vi.fn() } },
			scripting: { executeScript: vi.fn().mockResolvedValue(undefined) },
		} as unknown as typeof chrome;
	});

	it("should register onUpdated listener on init", async () => {
		await import("../background");
		expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled();
	});

	it("should detect greenhouse URLs and inject content script", async () => {
		const listener = vi.fn();
		chrome.tabs.onUpdated.addListener =
			listener as unknown as typeof chrome.tabs.onUpdated.addListener;
		await import("../background");
		const handler = listener.mock.calls[0][0];
		await handler(
			1,
			{ status: "complete" },
			{ url: "https://boards.greenhouse.io/company/jobs/123" },
		);
		expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
			target: { tabId: 1 },
			files: ["content-script.js"],
		});
	});

	it("should detect lever URLs and inject content script", async () => {
		const listener = vi.fn();
		chrome.tabs.onUpdated.addListener =
			listener as unknown as typeof chrome.tabs.onUpdated.addListener;
		await import("../background");
		const handler = listener.mock.calls[0][0];
		await handler(
			2,
			{ status: "complete" },
			{ url: "https://jobs.lever.co/company/role" },
		);
		expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
			target: { tabId: 2 },
			files: ["content-script.js"],
		});
	});

	it("should NOT inject for non-ATS URLs", async () => {
		const listener = vi.fn();
		chrome.tabs.onUpdated.addListener =
			listener as unknown as typeof chrome.tabs.onUpdated.addListener;
		await import("../background");
		const handler = listener.mock.calls[0][0];
		await handler(3, { status: "complete" }, { url: "https://google.com" });
		expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
	});
});
