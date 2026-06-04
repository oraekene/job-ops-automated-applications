import { describe, expect, it } from "vitest";
import { mapProfileToPrepProfile } from "./profileNormalize";

const minimalProfile = {
  basics: { name: "Ada Lovelace", email: "ada@example.com" },
} as const;

describe("mapProfileToPrepProfile normalization (US-029)", () => {
  it("normalizes a US phone number to E.164", () => {
    const result = mapProfileToPrepProfile({
      ...minimalProfile,
      basics: { ...minimalProfile.basics, phone: "(415) 555-1234" },
    } as any);

    expect(result).not.toBeNull();
    expect(result?.phone).toBe("+14155551234");
  });

  it("normalizes a UK phone number to E.164 using the + prefix as region hint", () => {
    const result = mapProfileToPrepProfile({
      ...minimalProfile,
      basics: { ...minimalProfile.basics, phone: "+44 7000 000000" },
    } as any);

    expect(result).not.toBeNull();
    expect(result?.phone).toBe("+447000000000");
  });

  it("falls back to the raw phone string when the number is not parseable", () => {
    const result = mapProfileToPrepProfile({
      ...minimalProfile,
      basics: { ...minimalProfile.basics, phone: "invalid" },
    } as any);

    expect(result).not.toBeNull();
    expect(result?.phone).toBe("invalid");
  });

  it("returns the raw phone string for an empty input (not 'undefined' or '+')", () => {
    const result = mapProfileToPrepProfile({
      ...minimalProfile,
      basics: { ...minimalProfile.basics, phone: "" },
    } as any);

    expect(result).not.toBeNull();
    expect(result?.phone).toBe("");
  });

  it("canonicalizes a non-canonical LinkedIn URL to https://www.linkedin.com/in/<slug>", () => {
    const result = mapProfileToPrepProfile({
      ...minimalProfile,
      basics: {
        ...minimalProfile.basics,
        profiles: [
          {
            network: "LinkedIn",
            url: "linkedin.com/in/John-Doe?utm_source=x&utm_medium=email",
          },
        ],
      },
    } as any);

    expect(result).not.toBeNull();
    expect(result?.linkedin_url).toBe("https://www.linkedin.com/in/john-doe");
  });

  it("leaves a canonical LinkedIn URL unchanged", () => {
    const result = mapProfileToPrepProfile({
      ...minimalProfile,
      basics: {
        ...minimalProfile.basics,
        profiles: [
          { network: "LinkedIn", url: "https://www.linkedin.com/in/johndoe" },
        ],
      },
    } as any);

    expect(result).not.toBeNull();
    expect(result?.linkedin_url).toBe("https://www.linkedin.com/in/johndoe");
  });

  it("skips non-LinkedIn profiles and picks the first LinkedIn match", () => {
    const result = mapProfileToPrepProfile({
      ...minimalProfile,
      basics: {
        ...minimalProfile.basics,
        profiles: [
          { network: "GitHub", url: "https://github.com/johndoe" },
          { network: "LinkedIn", url: "https://www.linkedin.com/in/johndoe" },
          { network: "Twitter", url: "https://twitter.com/johndoe" },
        ],
      },
    } as any);

    expect(result).not.toBeNull();
    expect(result?.linkedin_url).toBe("https://www.linkedin.com/in/johndoe");
  });

  it("selects the current company by startDate DESC (most recent first)", () => {
    const result = mapProfileToPrepProfile({
      ...minimalProfile,
      sections: {
        experience: {
          items: [
            {
              id: "1",
              company: "Old Co",
              position: "Engineer",
              location: "London",
              date: "2018-01",
              summary: "",
              visible: true,
            },
            {
              id: "2",
              company: "Newest Co",
              position: "Engineer",
              location: "London",
              date: "2024-03",
              summary: "",
              visible: true,
            },
            {
              id: "3",
              company: "Middle Co",
              position: "Engineer",
              location: "London",
              date: "2020-06",
              summary: "",
              visible: true,
            },
          ],
        },
      },
    } as any);

    expect(result).not.toBeNull();
    expect(result?.current_company).toBe("Newest Co");
  });

  it("treats a 'Present' endDate as the most recent when startDates are equal", () => {
    const result = mapProfileToPrepProfile({
      ...minimalProfile,
      sections: {
        experience: {
          items: [
            {
              id: "1",
              company: "Left Co",
              position: "Engineer",
              location: "London",
              date: "2020-01 - 2022-01",
              summary: "",
              visible: true,
            },
            {
              id: "2",
              company: "Current Co",
              position: "Engineer",
              location: "London",
              date: "2020-01 - Present",
              summary: "",
              visible: true,
            },
          ],
        },
      },
    } as any);

    expect(result).not.toBeNull();
    expect(result?.current_company).toBe("Current Co");
  });

  it("returns empty strings for phone, linkedin, and current_company when profile has none of them", () => {
    const result = mapProfileToPrepProfile({
      basics: { name: "Ada Lovelace", email: "ada@example.com" },
    } as any);

    expect(result).not.toBeNull();
    expect(result?.phone).toBe("");
    expect(result?.linkedin_url).toBe("");
    expect(result?.current_company).toBe("");
  });

  it("returns null when required name+email are missing (no throw)", () => {
    const result = mapProfileToPrepProfile({
      basics: { name: "", email: "" },
    } as any);

    expect(result).toBeNull();
  });
});
