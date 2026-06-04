import type { ResumeProfile } from "@shared/types";
import { parsePhoneNumberFromString } from "libphonenumber-js";

import type { PrepProfile } from "./applications";

/**
 * Normalize a free-form phone string into E.164.
 *
 * Uses libphonenumber-js with a "US" default region (the orchestrator's
 * primary tenant). If the input is missing, blank, or cannot be parsed
 * to a valid number, the raw input is returned unchanged so the caller
 * can still see what the user provided.
 */
export function normalizePhone(input: string | undefined | null): string {
  if (input == null) return "";
  const trimmed = input.trim();
  if (!trimmed) return "";

  const parsed = parsePhoneNumberFromString(trimmed, "US");
  if (parsed?.isValid()) {
    return parsed.number;
  }

  return trimmed;
}

/**
 * Canonicalize a LinkedIn profile URL.
 *
 * The accepted form is `https://www.linkedin.com/in/<slug>` where slug
 * is the path segment after `/in/`, lowercased, with tracking query
 * params stripped. Other forms (no protocol, http, query string,
 * mixed case) are normalized to the canonical form. If the input
 * cannot be recognized as a LinkedIn profile URL (no `/in/` path
 * segment, or unparseable), the raw input is returned unchanged.
 */
export function canonicalizeLinkedInUrl(
  input: string | undefined | null,
): string {
  if (input == null) return "";
  const trimmed = input.trim();
  if (!trimmed) return "";

  let parsed: URL;
  try {
    parsed = new URL(
      trimmed.startsWith("http") ? trimmed : `https://${trimmed}`,
    );
  } catch {
    return trimmed;
  }

  if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname)) {
    return trimmed;
  }

  const inMatch = parsed.pathname.match(/\/in\/([^/?#]+)/i);
  if (!inMatch) {
    return trimmed;
  }
  const slug = inMatch[1].toLowerCase();

  return `https://www.linkedin.com/in/${slug}`;
}

interface ExperienceItem {
  id: string;
  company: string;
  position: string;
  location: string;
  date: string;
  summary: string;
  visible: boolean;
}

interface DateRange {
  startYearMonth: number;
  endYearMonth: number;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * Parse a free-form experience date string into a numeric year-month
 * pair (YYYYMM) for start and end. Accepts inputs like:
 *  - "2024-01"
 *  - "2020-2023"
 *  - "Jan 2020 - Mar 2023"
 *  - "Jan 2020 - Present"
 *  - "Present"
 *  - "2024"
 *
 * Returns NEGATIVE_INFINITY for an unparseable start (treated as the
 * oldest) and POSITIVE_INFINITY for "Present" end dates. Single dates
 * with no range are treated as ongoing (end = POSITIVE_INFINITY).
 */
export function parseExperienceDate(
  date: string | undefined | null,
): DateRange {
  if (date == null) {
    return {
      startYearMonth: Number.NEGATIVE_INFINITY,
      endYearMonth: Number.POSITIVE_INFINITY,
    };
  }

  const trimmed = date.trim();
  if (!trimmed) {
    return {
      startYearMonth: Number.NEGATIVE_INFINITY,
      endYearMonth: Number.POSITIVE_INFINITY,
    };
  }

  if (trimmed.includes(" - ")) {
    const [start, end] = trimmed.split(/\s+-\s+/, 2);
    return {
      startYearMonth: parseOneSide(start) ?? Number.NEGATIVE_INFINITY,
      endYearMonth: parseOneSide(end) ?? Number.NEGATIVE_INFINITY,
    };
  }

  const yearRange = trimmed.match(/^(\d{4})-(\d{4})$/);
  if (yearRange) {
    return {
      startYearMonth: Number(yearRange[1]) * 100,
      endYearMonth: Number(yearRange[2]) * 100,
    };
  }

  const single = parseOneSide(trimmed);
  if (single != null) {
    return {
      startYearMonth: single,
      endYearMonth: Number.POSITIVE_INFINITY,
    };
  }

  return {
    startYearMonth: Number.NEGATIVE_INFINITY,
    endYearMonth: Number.POSITIVE_INFINITY,
  };
}

function parseOneSide(input: string | undefined | null): number | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (isOpenEnded(trimmed)) {
    return Number.POSITIVE_INFINITY;
  }

  const yearMonth = parseYearMonth(trimmed);
  if (yearMonth != null) return yearMonth;

  const year = parseYear(trimmed);
  if (year != null) return year * 100;

  return null;
}

function isOpenEnded(input: string): boolean {
  return /^(present|current|now|today)$/i.test(input.trim());
}

function parseYearMonth(input: string): number | null {
  const match = input.match(/^([A-Za-z]{3,})\s+(\d{4})$/);
  if (match) {
    const month = MONTH_NAMES[match[1].toLowerCase().slice(0, 3)];
    if (month) {
      return Number(match[2]) * 100 + month;
    }
  }
  const ym = input.match(/^(\d{4})[-/](\d{1,2})$/);
  if (ym) {
    const month = Number(ym[2]);
    if (month >= 1 && month <= 12) {
      return Number(ym[1]) * 100 + month;
    }
  }
  return null;
}

function parseYear(input: string): number | null {
  const y = input.match(/^(\d{4})$/);
  if (y) return Number(y[1]);
  return null;
}

/**
 * Pick the current company from a list of experience items, ordered by
 * start date descending and then by end date descending. Items with
 * unparseable dates are treated as the oldest and fall to the end.
 * Returns an empty string if there are no items.
 */
export function pickCurrentCompany(
  items: ExperienceItem[] | undefined | null,
): string {
  if (!items || items.length === 0) return "";

  const decorated = items.map((item, index) => {
    const range = parseExperienceDate(item.date);
    return { item, index, range };
  });

  decorated.sort((a, b) => {
    if (a.range.startYearMonth !== b.range.startYearMonth) {
      return b.range.startYearMonth - a.range.startYearMonth;
    }
    if (a.range.endYearMonth !== b.range.endYearMonth) {
      return b.range.endYearMonth - a.range.endYearMonth;
    }
    return a.index - b.index;
  });

  return decorated[0]?.item.company ?? "";
}

/**
 * Find the first LinkedIn profile URL in a list of profiles and
 * canonicalize it. Returns an empty string if no LinkedIn profile
 * is found.
 */
export function findLinkedInUrl(
  profiles: Array<{ network?: string; url?: string }> | undefined | null,
): string {
  if (!profiles) return "";
  const linkedIn = profiles.find((p) => /linkedin/i.test(p.network ?? ""));
  if (!linkedIn?.url) return "";
  return canonicalizeLinkedInUrl(linkedIn.url);
}

/**
 * Map a full RxResume `ResumeProfile` to the lean `PrepProfile` shape
 * that the extension consumes. Returns null when the required
 * `basics.name` and `basics.email` are missing — the extension
 * surfaces that to the user as "Complete onboarding first".
 *
 * Normalization applied:
 *  - phone → E.164 (US default region; raw passthrough on parse failure)
 *  - LinkedIn URL → `https://www.linkedin.com/in/<slug>`
 *  - current company → most recent by startDate DESC, then endDate DESC
 */
export function mapProfileToPrepProfile(
  profile: ResumeProfile,
): PrepProfile | null {
  const name = (profile.basics?.name ?? "").trim();
  const email = (profile.basics?.email ?? "").trim();

  if (!name || !email) {
    return null;
  }

  const nameParts = name.split(/\s+/);
  const first_name = nameParts[0] ?? "";
  const last_name = nameParts.slice(1).join(" ");

  return {
    first_name,
    last_name,
    email,
    phone: normalizePhone(profile.basics?.phone),
    linkedin_url: findLinkedInUrl(profile.basics?.profiles),
    current_company: pickCurrentCompany(
      profile.sections?.experience?.items as ExperienceItem[] | undefined,
    ),
  };
}
