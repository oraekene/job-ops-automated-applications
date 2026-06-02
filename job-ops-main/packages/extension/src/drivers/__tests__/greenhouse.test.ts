import { describe, expect, it } from "vitest";
import { fillGreenhouseForm } from "../greenhouse";

describe("fillGreenhouseForm", () => {
	it("fills standard fields using data-qa selectors", () => {
		document.body.innerHTML = `
      <div data-qa="first-name-field"><input></div>
      <div data-qa="last-name-field"><input></div>
      <div data-qa="email-field"><input></div>
      <div data-qa="phone-field"><input></div>
    `;
		fillGreenhouseForm({
			first_name: "John",
			last_name: "Doe",
			email: "john@test.com",
			phone: "123-456-7890",
			linkedin_url: "",
			current_company: "",
			cover_letter: "",
			screening_answers: {},
		});
		expect(
			document.querySelector<HTMLInputElement>(
				'[data-qa="first-name-field"] input',
			)!.value,
		).toBe("John");
		expect(
			document.querySelector<HTMLInputElement>('[data-qa="email-field"] input')!
				.value,
		).toBe("john@test.com");
	});

	it("fills cover letter textarea when present", () => {
		document.body.innerHTML = `<textarea data-qa="cover-letter-text-input"></textarea>`;
		fillGreenhouseForm({
			first_name: "",
			last_name: "",
			email: "",
			phone: "",
			linkedin_url: "",
			current_company: "",
			cover_letter: "I am excited...",
			screening_answers: {},
		});
		expect(document.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(
			"I am excited...",
		);
	});

	it("fills custom screening questions", () => {
		document.body.innerHTML = `<div data-qa="question_1"><label>Why work here?</label><textarea></textarea></div>`;
		fillGreenhouseForm({
			first_name: "",
			last_name: "",
			email: "",
			phone: "",
			linkedin_url: "",
			current_company: "",
			cover_letter: "",
			screening_answers: { "Why work here?": "Great culture" },
		});
		expect(document.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(
			"Great culture",
		);
	});
});
