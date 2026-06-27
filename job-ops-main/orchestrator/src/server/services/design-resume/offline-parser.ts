import type { DesignResumeJson } from "@shared/types";

type SectionHeading = {
  label: string;
  lineIndex: number;
};

const SECTION_PATTERNS = [
  { label: "experience", patterns: [/^(?:professional\s+)?(?:work\s+)?(?:experience|employment|history|career)/im] },
  { label: "education", patterns: [/^(?:education|academic|training|qualifications?)/im] },
  { label: "skills", patterns: [/^(?:skills?|technical\s+skills?|core\s+competencies?|expertise|technologies)/im] },
  { label: "projects", patterns: [/^(?:projects?|side\s+projects?|open\s+source)/im] },
  { label: "certifications", patterns: [/^(?:certifications?|licenses?|professional\s+certifications?)/im] },
  { label: "publications", patterns: [/^(?:publications?|research|papers?)/im] },
  { label: "awards", patterns: [/^(?:awards?|honors?|achievements?|recognition)/im] },
  { label: "languages", patterns: [/^(?:languages?)/im] },
  { label: "interests", patterns: [/^(?:interests?|volunteer(?:ing)?|community)/im] },
  { label: "references", patterns: [/^(?:references?)/im] },
  { label: "summary", patterns: [/^(?:summary|profile|objective|about\s+me)/im] },
];

function findSectionHeadings(lines: string[]): SectionHeading[] {
  const headings: SectionHeading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    for (const entry of SECTION_PATTERNS) {
      if (entry.patterns.some((p) => p.test(trimmed))) {
        headings.push({ label: entry.label, lineIndex: i });
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
  const match = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return match?.[0] ?? "";
}

function parsePhone(text: string): string {
  const match = text.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  return match?.[0] ?? "";
}

function parseUrls(text: string): string[] {
  const pattern = /(?:https?:\/\/[^\s,;)\]}>!]+|(?<![\/\\])[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.(?:com|org|net|io|dev|co|me|info|edu|gov)(?:\/[^\s,;)\]}>!]*)?)/gi;
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
  for (let i = 0; i < Math.min(3, lines.length); i++) {
    const line = lines[i]?.trim();
    if (line && line.length > 1 && line.length < 60 && !line.includes("@") && !line.includes("http")) {
      return line;
    }
  }
  return "";
}

function detectLocation(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = 1; i < Math.min(8, lines.length); i++) {
    const line = lines[i];
    if (/[A-Z][a-z]+(?:,\s*[A-Z]{2})/.test(line)) {
      return line;
    }
  }
  return "";
}

function detectHeadline(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = 1; i < Math.min(8, lines.length); i++) {
    const line = lines[i];
    if (line.length > 10 && line.length < 120 && !line.includes("@") && !/[A-Z][a-z]+,\s*[A-Z]{2}/.test(line) && !line.includes("http")) {
      return line;
    }
  }
  return "";
}

function findLatestDateOrPresent(text: string): string {
  const match = text.match(/(\d{4})\s*[-–]\s*(Present|Current|Now|\d{4})/i);
  if (match) return match[0];
  return "";
}

function parseExperience(lines: string[]): Array<{
  company: string;
  position: string;
  location: string;
  period: string;
  description: string;
}> {
  const items: Array<{
    company: string;
    position: string;
    location: string;
    period: string;
    description: string;
  }> = [];
  let current: {
    company: string;
    position: string;
    location: string;
    period: string;
    description: string;
  } | null = null;
  const descParts: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const periodMatch = trimmed.match(/(\w+(?:\.)?\s+\d{4})\s*[-–]\s*(\w+(?:\.)?\s+\d{4}|Present|Current|Now)/i);
    const hasOrgIndicator = /^[A-Z][A-Za-z0-9\s&.,'/-]{2,50}$/.test(trimmed) && periodMatch;

    const companyOnlyMatch = /^([A-Z][A-Za-z0-9\s&.,'/-]{2,50})\s*$/.test(trimmed) && /\d{4}/.test(trimmed);

    if (periodMatch) {
      if (current) {
        current.description = descParts.join("\n").trim();
        items.push(current);
        descParts.length = 0;
      }
      current = {
        company: trimmed,
        position: "",
        location: "",
        period: periodMatch[0],
        description: "",
      };

      const pipeMatch = trimmed.match(/^([A-Za-z0-9\s&.,'/-]+?)\s*[|]\s*(.+)/);
      if (pipeMatch) {
        current.company = pipeMatch[1].trim();
        current.position = pipeMatch[2].trim().replace(periodMatch[0], "").replace(/[-–]\s*$/, "").trim();
      }
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

  let currentSchool: string | null = null;
  let currentDegree = "";
  let currentArea = "";
  let currentPeriod: { start: string; end: string } = { start: "", end: "" };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const periodMatch = trimmed.match(/(\d{4})\s*[-–]\s*(\d{4}|Present|Current)/i);
    const schoolKeywords = /(University|College|Institute|School|Academy|Polytechnic)/i;
    const schoolMatch = schoolKeywords.test(trimmed);

    if (schoolMatch && trimmed.length < 80) {
      if (currentSchool) {
        items.push({
          school: currentSchool,
          degree: currentDegree,
          area: currentArea,
          period: currentPeriod,
        });
        currentDegree = "";
        currentArea = "";
        currentPeriod = { start: "", end: "" };
      }
      currentSchool = trimmed.replace(periodMatch?.[0] ?? "", "").trim();
      if (periodMatch) {
        currentPeriod = { start: periodMatch[1], end: periodMatch[2] };
      }
    } else if (currentSchool) {
      const degreeMatch = trimmed.match(/^(B\.?[A-Z]\.?|M\.?[A-Z]\.?|Ph\.?D|Bachelor|Master|Doctor|Associate|MBA|BS|BA|MS|MA)/i);
      if (degreeMatch) {
        currentDegree = trimmed.replace(periodMatch?.[0] ?? "", "").trim();
        if (periodMatch) {
          currentPeriod = { start: periodMatch[1], end: periodMatch[2] };
        }
      } else if (!periodMatch) {
        currentArea = currentArea ? `${currentArea}, ${trimmed}` : trimmed;
      }
    }
  }

  if (currentSchool) {
    items.push({
      school: currentSchool,
      degree: currentDegree,
      area: currentArea,
      period: currentPeriod,
    });
  }

  return items;
}

function parseSkills(lines: string[]): string[] {
  const all: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/[,;|•\n]+/).map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      if (part.length > 1 && !part.startsWith("http") && !part.includes("@")) {
        all.push(part);
      }
    }
  }
  return all;
}

function parseProjects(lines: string[]): Array<{
  name: string;
  period: string;
  description: string;
  website: string;
}> {
  const items: Array<{
    name: string;
    period: string;
    description: string;
    website: string;
  }> = [];
  let current: {
    name: string;
    period: string;
    description: string;
    website: string;
  } | null = null;
  const descParts: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const periodMatch = trimmed.match(/(\w+(?:\.)?\s+\d{4})\s*[-–]\s*(\w+(?:\.)?\s+\d{4}|Present|Current|Now)/i);
    const urlInLine = parseUrls(trimmed);

    if (periodMatch && trimmed.length < 100) {
      if (current) {
        current.description = descParts.join("\n").trim();
        items.push(current);
        descParts.length = 0;
      }
      current = {
        name: trimmed.replace(periodMatch[0], "").replace(/[-–]\s*$/, "").trim(),
        period: periodMatch[0],
        description: "",
        website: urlInLine[0] ?? "",
      };
    } else if (urlInLine.length > 0 && current) {
      if (!current.website) {
        current.website = urlInLine[0];
      }
      descParts.push(trimmed);
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

export async function parseResumeOffline(text: string, links: { page: number; url: string }[]): Promise<DesignResumeJson> {
  const lines = text.split("\n");
  const nonEmptyLines = lines.map((l) => l.trim()).filter(Boolean);
  const headings = findSectionHeadings(lines);

  const rawText = text;
  const linkUrls = links.map((l) => l.url);
  const allUrls = [...new Set([...parseUrls(text), ...linkUrls])];

  const name = detectName(nonEmptyLines);
  const email = parseEmail(text);
  const phone = parsePhone(text);
  const location = detectLocation(text);
  const headline = detectHeadline(text);

  const profileUrl = allUrls.find((u) => /linkedin\.com/i.test(u)) ?? "";
  const githubUrl = allUrls.find((u) => /github\.com/i.test(u)) ?? "";

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
      username: profileUrl.split("/").filter(Boolean).pop() ?? "",
      website: { url: profileUrl, label: "LinkedIn" },
      icon: "",
    });
  }
  if (githubUrl) {
    profiles.push({
      id: "github",
      hidden: false,
      network: "GitHub",
      username: githubUrl.split("/").filter(Boolean).pop() ?? "",
      website: { url: githubUrl, label: "GitHub" },
      icon: "",
    });
  }

  const otherUrls = allUrls.filter((u) => !/linkedin\.com/i.test(u) && !/github\.com/i.test(u));
  const basicsWebsite = otherUrls.length > 0 ? { url: otherUrls[0], label: "" } : { url: "", label: "" };

  let expLines: string[] = [];
  let eduLines: string[] = [];
  let skillsLines: string[] = [];
  let projectsLines: string[] = [];
  let summaryText = "";

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const sectionLines = getSectionLines(lines, headings, i);
    if (h.label === "experience") {
      expLines = sectionLines;
    } else if (h.label === "education") {
      eduLines = sectionLines;
    } else if (h.label === "skills") {
      skillsLines = sectionLines;
    } else if (h.label === "projects") {
      projectsLines = sectionLines;
    } else if (h.label === "summary") {
      summaryText = sectionLines.join("\n").trim();
    }
  }

  const experience = parseExperience(expLines).map((item, idx) => ({
    id: `exp-${idx}`,
    hidden: false,
    company: item.company,
    position: item.position,
    location: item.location,
    period: { start: "", end: "" },
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

  const projects = parseProjects(projectsLines).map((item, idx) => ({
    id: `proj-${idx}`,
    hidden: false,
    name: item.name,
    period: item.period,
    website: { url: item.website, label: item.name },
    description: item.description,
    options: { showLinkInTitle: false },
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
      website: basicsWebsite,
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
      projects: {
        title: "Projects",
        columns: 1,
        hidden: false,
        items: projects,
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
    },
    customSections: [],
    metadata: {
      template: "onyx",
      layout: {
        sidebarWidth: 35,
        pages: [{ fullWidth: false, main: ["summary", "experience", "education", "projects", "skills"], sidebar: ["profiles"] }],
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
