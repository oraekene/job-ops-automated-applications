export function extractJobTitle(atsType: string): string {
  if (atsType === "greenhouse") {
    const el = document.querySelector<HTMLElement>("h1.section-header");
    return el?.textContent?.trim() ?? "";
  }
  return "";
}

export function extractEmployerName(atsType: string): string {
  if (atsType === "greenhouse") {
    const logo = document.querySelector<HTMLImageElement>('img[alt*="Logo"]');
    if (logo) return logo.alt.replace(/\s+Logo$/, "").trim();
    const match = window.location.pathname.match(/^\/([^/]+)\//);
    if (match) return decodeURIComponent(match[1]);
    return "";
  }
  return "";
}

export function extractJobDescription(atsType: string): string {
  if (atsType === "greenhouse") {
    const el = document.querySelector<HTMLElement>(".job__description.body");
    return el?.textContent?.trim() ?? "";
  }
  return "";
}
