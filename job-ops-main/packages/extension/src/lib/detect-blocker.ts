export interface BlockerResult {
  blocked: boolean;
  reason?: string;
}

export function detectBlocker(): BlockerResult {
  const body = document.body;
  if (!body) return { blocked: false };

  const iframes = body.querySelectorAll("iframe");
  for (const iframe of Array.from(iframes)) {
    const src = iframe.getAttribute("src")?.toLowerCase() ?? "";
    if (src.includes("recaptcha")) {
      return { blocked: true, reason: "reCAPTCHA detected" };
    }
    if (src.includes("hcaptcha")) {
      return { blocked: true, reason: "hCaptcha detected" };
    }
  }

  const modals = body.querySelectorAll(
    "[role='dialog'], .modal, .modal-overlay",
  );
  for (const modal of Array.from(modals)) {
    const style = window.getComputedStyle(modal);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const modalText = modal.textContent?.toLowerCase() ?? "";
    if (/sign in|log in|authenticate/i.test(modalText)) {
      return { blocked: true, reason: "sign-in required" };
    }
  }

  return { blocked: false };
}
