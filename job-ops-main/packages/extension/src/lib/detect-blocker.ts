export interface BlockerResult {
  blocked: boolean;
  reason?: string;
}

export function detectBlocker(): BlockerResult {
  const body = document.body;
  if (!body) return { blocked: false };

  const text = body.textContent?.toLowerCase() ?? "";

  if (
    /verify your identity/i.test(text) ||
    /confirm your identity/i.test(text)
  ) {
    return { blocked: true, reason: "MFA prompt detected" };
  }

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
    ".modal, .modal-overlay, [role='dialog']",
  );
  for (const modal of Array.from(modals)) {
    const modalText = modal.textContent?.toLowerCase() ?? "";
    if (/sign in/i.test(modalText)) {
      return { blocked: true, reason: "sign-in required" };
    }
  }

  return { blocked: false };
}
