// Content script injection is handled by manifest.json content_scripts entry.
// Background worker tracks extension lifecycle events.
chrome.runtime.onInstalled.addListener(() => {
	console.log("JobOps Copilot installed");
});
