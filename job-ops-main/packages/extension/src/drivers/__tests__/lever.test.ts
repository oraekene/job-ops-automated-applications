import { describe, expect, it } from "vitest";
import { fillLeverForm } from "../lever";

describe("fillLeverForm", () => {
  it("fills fields by name attribute", () => {
    document.body.innerHTML = `<input name="name"><input name="email"><input name="phone"><input name="org"><input name="urls[LinkedIn]">`;
    fillLeverForm({
      first_name: "John",
      last_name: "Doe",
      email: "john@test.com",
      phone: "123",
      linkedin_url: "https://linkedin.com/in/john",
      current_company: "Acme",
      cover_letter: "",
      screening_answers: {},
    });
    expect(
      document.querySelector<HTMLInputElement>('[name="name"]')?.value,
    ).toBe("John Doe");
    expect(
      document.querySelector<HTMLInputElement>('[name="email"]')?.value,
    ).toBe("john@test.com");
  });

  it("fills custom questions", () => {
    document.body.innerHTML = `<li class="application-question custom-question"><span class="application-label">Why us?</span><textarea></textarea></li>`;
    fillLeverForm({
      first_name: "",
      last_name: "",
      email: "",
      phone: "",
      linkedin_url: "",
      current_company: "",
      cover_letter: "",
      screening_answers: { "Why us?": "Because..." },
    });
    expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "Because...",
    );
  });
});
