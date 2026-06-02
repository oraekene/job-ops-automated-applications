import { describe, expect, it } from "vitest";
import { detectAtsByDom, detectAtsByUrl } from "../ats-detector";

describe("detectAtsByUrl", () => {
  it("returns greenhouse for boards.greenhouse.io URLs", () => {
    expect(
      detectAtsByUrl("https://boards.greenhouse.io/company/jobs/123"),
    ).toBe("greenhouse");
  });
  it("returns lever for hire.lever.co URLs", () => {
    expect(detectAtsByUrl("https://hire.lever.co/company/role")).toBe("lever");
  });
  it("returns lever for jobs.lever.co URLs", () => {
    expect(detectAtsByUrl("https://jobs.lever.co/company/role")).toBe("lever");
  });
  it("returns unknown for unrecognized URLs", () => {
    expect(detectAtsByUrl("https://company.workday.com/careers")).toBe(
      "unknown",
    );
  });
  it("returns unknown for empty string", () => {
    expect(detectAtsByUrl("")).toBe("unknown");
  });
});

describe("detectAtsByDom", () => {
  it("returns greenhouse when HTML contains gh_jid", () => {
    expect(
      detectAtsByDom('<html><script>window._gh_jid="123"</script></html>'),
    ).toBe("greenhouse");
  });
  it("returns lever when HTML contains lever markers", () => {
    expect(
      detectAtsByDom('<html><div class="lever-job-listing"></div></html>'),
    ).toBe("lever");
  });
  it("returns unknown when no ATS markers found", () => {
    expect(detectAtsByDom("<html><body>Hello</body></html>")).toBe("unknown");
  });
});
