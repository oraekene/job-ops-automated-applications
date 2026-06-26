import type { DesignResumeJson } from "@shared/types";

type SectionHeading = {
  label: string;
  lineIndex: number;
};

const SECTION_HEADINGS = [
  /^(?:professional\s+)?(?:work\s+)?(?:experience|employment|history|career)/im,
  /^(?:education|academic|training|qualifications?)/im,
  /^(?:skills?|technical\s+skills?|core\s+competencies?|expertise|technologies)/im,
  /^(?:projects?|side\s+projects?|open\s+source)/im,
  /^(?:certifications?|licenses?|professional\s+certifications?)/im,
  /^(?:publications?|research|papers?)/im,
  /^(?:awards?|honors?|achievements?|recognition)/im,
  /^(?:languages?)/im,
  /^(?:interests?|volunteer(?:ing)?|community)/im,
  /^(?:references?)/im,
  /^(?:summary|profile|objective|about\s+me)/im,
];

function findSectionHeadings(lines: string[]): SectionHeading[] {
  const headings: SectionHeading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    const isShortLine = trimmed.length < 60;
    const hasColon = trimmed.endsWith(":");
    const isAllCaps = trimmed === trimmed.toUpperCase() && trimmed.length > 2;
    if (!isShortLine && !isAllCaps && !hasColon) continue;
    for (const pattern of SECTION_HEADINGS) {
      if (pattern.test(trimmed)) {
        headings.push({ label: trimmed.replace(/:$/, "").trim(), lineIndex: i });
        break;
      }
    }
  }
  return headings;
}

function getSectionLines(lines: string[], headings: SectionHeading[], idx: number): string[] {
  const start = headings[idx].lineIndex + 1;
  const end = idx + 1 < headings.length ? headings[idx + 1].lineIndex : lines.length;
  return lines.slice(start, end).filter((l) => l.trim());
}

function parseEmail(text: string): string {
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match?.[0] ?? "";
}

function parsePhone(text: string): string {
  const match = text.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  return match?.[0] ?? "";
}

function parseUrls(text: string): string[] {
  const pattern = /(?:https?:\/\/[^\s,;)\]}>]+|(?<![\/\\])[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.(?:com|org|net|io|dev|co|me|info|edu|gov)(?:\/[^\s,;)\]}>]*)?)/gi;
  const matches = text.match(pattern) ?? [];
  const unique = new Set<string>();
  const urls: string[] = [];
  for (const raw of matches) {
    let url = raw.replace(/[.,;:!?)]+$/, "");
    if (!url.startsWith("http")) {
      url = `https://${url}`;
    }
    const lower = url.toLowerCase();
    if (!unique.has(lower)) {
      unique.add(lower);
      urls.push(url);
    }
  }
  return urls;
}

function detectName(lines: string[]): string {
  const firstLine = lines[0]?.trim();
  if (firstLine && firstLine.length > 1 && firstLine.length < 60 && !firstLine.includes("@")) {
    return firstLine;
  }
  return "";
}

function detectLocation(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = 1; i < Math.min(5, lines.length); i++) {
    const line = lines[i];
    if (/[A-Z][a-z]+(?:,\s*[A-Z]{2})/.test(line)) {
      return line;
    }
  }
  return "";
}

function detectHeadline(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = 1; i < Math.min(5, lines.length); i++) {
    const line = lines[i];
    if (line.length > 10 && line.length < 120 && !line.includes("@") && !/[A-Z][a-z]+,\s*[A-Z]{2}/.test(line)) {
      return line;
    }
  }
  return "";
}

function parseExperience(lines: string[]): Array<{
  company: string;
  position: string;
  location: string;
  period: { start: string; end: string };
  description: string;
}> {
  const items: Array<{
    company: string;
    position: string;
    location: string;
    period: { start: string; end: string };
    description: string;
  }> = [];
  let current: {
    company: string;
    position: string;
    location: string;
    period: { start: string; end: string };
    description: string;
  } | null = null;
  const descParts: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const orgMatch = trimmed.match(/^([A-Z][A-Za-z0-9\s&.,-]+?)\s*[|]\s*(.+)/);
    const periodMatch = trimmed.match(/(\w+\s+\d{4})\s*[-–]\s*(\w+\s+\d{4}|Present|Current|Now)/i);
    if (orgMatch && periodMatch) {
      if (current) {
        current.description = descParts.join("\n").trim();
        items.push(current);
        descParts.length = 0;
      }
      current = {
        company: orgMatch[1].trim(),
        position: orgMatch[2].trim(),
        location: "",
        period: { start: periodMatch[1], end: periodMatch[2] },
        description: "",
      };
    } else if (periodMatch && !current) {
      current = {
        company: "",
        position: "",
        location: "",
        period: { start: periodMatch[1], end: periodMatch[2] },
        description: "",
      };
    } else if (current) {
      descParts.push(trimmed);
    }
  }
  if (current) {
    current.description = descParts.join("\n").trim();
    items.push(current);
  }
  return items;
}

function parseEducation(lines: string[]): Array<{
  school: string;
  degree: string;
  area: string;
  period: { start: string; end: string };
}> {
  const items: Array<{
    school: string;
    degree: string;
    area: string;
    period: { start: string; end: string };
  }> = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const periodMatch = trimmed.match(/(\d{4})\s*[-–]\s*(\d{4}|Present|Current)/i);
    const schoolMatch = trimmed.match(/([A-Z][A-Za-z\s&.]+(?:University|College|Institute|School|Academy))/);
    if (schoolMatch) {
      items.push({
        school: schoolMatch[1].trim(),
        degree: "",
        area: "",
        period: {
          start: periodMatch?.[1] ?? "",
          end: periodMatch?.[2] ?? "",
        },
      });
    }
  }
  return items;
}

function parseSkills(lines: string[]): string[] {
  const all: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/[,|•\n]+/).map((s) => s.trim()).filter(Boolean);
    all.push(...parts);
  }
  return all;
}

export async function parseResumeOffline(text: string, links: string[]): Promise<DesignResumeJson> {
  const lines = text.split("\n");
  const nonEmptyLines = lines.map((l) => l.trim()).filter(Boolean);
  const headings = findSectionHeadings(lines);

  const rawText = text;
  const allUrls = [...new Set([...parseUrls(text), ...links])];

  const name = detectName(nonEmptyLines);
  const email = parseEmail(text);
  const phone = parsePhone(text);
  const location = detectLocation(text);
  const headline = detectHeadline(text);

  const profileUrl = allUrls.find((u) => u.includes("linkedin.com")) ?? "";
  const githubUrl = allUrls.find((u) => u.includes("github.com")) ?? "";

  const profiles: Array<{
    id: string;
    hidden: boolean;
    network: string;
    username: string;
    website: { url: string; label: string };
    icon: string;
  }> = [];
  if (profileUrl) {
    profiles.push({
      id: "linkedin",
      hidden: false,
      network: "LinkedIn",
      username: profileUrl.split("/").pop() ?? "",
      website: { url: profileUrl, label: "LinkedIn" },
      icon: "",
    });
  }
  if (githubUrl) {
    profiles.push({
      id: "github",
      hidden: false,
      network: "GitHub",
      username: githubUrl.split("/").pop() ?? "",
      website: { url: githubUrl, label: "GitHub" },
      icon: "",
    });
  }

  let expLines: string[] = [];
  let eduLines: string[] = [];
  let skillsLines: string[] = [];
  let summaryText = "";

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const sectionLines = getSectionLines(lines, headings, i);
    if (/experience|employment|history/i.test(h.label)) {
      expLines = sectionLines;
    } else if (/education|academic/i.test(h.label)) {
      eduLines = sectionLines;
    } else if (/skills?|competenc|technical/i.test(h.label)) {
      skillsLines = sectionLines;
    } else if (/summary|profile|objective/i.test(h.label)) {
      summaryText = sectionLines.join("\n").trim();
    }
  }

  const experience = parseExperience(expLines).map((item, idx) => ({
    id: `exp-${idx}`,
    hidden: false,
    company: item.company,
    position: item.position,
    location: item.location,
    period: { start: item.period.start, end: item.period.end },
    website: { url: "", label: "" },
    description: item.description,
    roles: [] as Array<{ id: string; position: string; period: { start: string; end: string }; description: string }>,
  }));

  const education = parseEducation(eduLines).map((item, idx) => ({
    id: `edu-${idx}`,
    hidden: false,
    school: item.school,
    degree: item.degree,
    area: item.area,
    grade: "",
    location: "",
    period: { start: item.period.start, end: item.period.end },
    website: { url: "", label: "" },
    description: "",
  }));

  const skills = parseSkills(skillsLines).map((name, idx) => ({
    id: `skill-${idx}`,
    hidden: false,
    name,
    proficiency: 0,
    level: 0,
    keywords: [] as string[],
    icon: "",
  }));

  const result: DesignResumeJson = {
    picture: {
      hidden: true,
      url: "",
      size: 80,
      rotation: 0,
      aspectRatio: 1,
      borderRadius: 50,
      borderColor: "rgba(0, 0, 0, 0.5)",
      borderWidth: 0,
      shadowColor: "rgba(0, 0, 0, 0.5)",
      shadowWidth: 0,
    },
    basics: {
      name,
      headline,
      email,
      phone,
      location,
      website: { url: "", label: "" },
      customFields: [],
    },
    summary: {
      title: "Summary",
      columns: 1,
      hidden: false,
      content: summaryText,
    },
    sections: {
      profiles: {
        title: "Profiles",
        columns: 1,
        hidden: false,
        items: profiles,
      },
      experience: {
        title: "Experience",
        columns: 1,
        hidden: false,
        items: experience,
      },
      education: {
        title: "Education",
        columns: 1,
        hidden: false,
        items: education,
      },
      skills: {
        title: "Skills",
        columns: 1,
        hidden: false,
        items: skills,
      },
      languages: { title: "Languages", columns: 1, hidden: true, items: [] },
      interests: { title: "Interests", columns: 1, hidden: true, items: [] },
      awards: { title: "Awards", columns: 1, hidden: true, items: [] },
      certifications: { title: "Certifications", columns: 1, hidden: true, items: [] },
      publications: { title: "Publications", columns: 1, hidden: true, items: [] },
      volunteer: { title: "Volunteer", columns: 1, hidden: true, items: [] },
      references: { title: "References", columns: 1, hidden: true, items: [] },
      projects: { title: "Projects", columns: 1, hidden: true, items: [] },
    },
    customSections: [],
    metadata: {
      template: "onyx",
      layout: {
        sidebarWidth: 35,
        pages: [{ fullWidth: false, main: ["summary", "experience", "education", "skills"], sidebar: ["profiles"] }],
      },
      css: { enabled: false, value: "" },
      page: {
        gapX: 4,
        gapY: 6,
        marginX: 14,
        marginY: 12,
        format: "a4",
        locale: "en-US",
        hideIcons: false,
      },
      design: {
        level: { icon: "", type: "hidden" },
        colors: { primary: "#1a1a1a", text: "#333333", background: "#ffffff" },
      },
      typography: {
        body: { fontFamily: "Inter", fontWeights: ["400"], fontSize: 10, lineHeight: 1.5 },
        heading: { fontFamily: "Inter", fontWeights: ["700"], fontSize: 14, lineHeight: 1.3 },
      },
      notes: "",
    },
    _parsedOffline: true,
    _rawText: rawText,
  } as unknown as DesignResumeJson;

  return result;
}
