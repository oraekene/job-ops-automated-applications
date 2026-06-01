export type AtsType = 'greenhouse' | 'lever' | 'unknown';

export const ATS_URL_PATTERNS: Array<{ id: AtsType; patterns: string[] }> = [
  { id: 'greenhouse', patterns: ['greenhouse.io'] },
  { id: 'lever', patterns: ['lever.co'] },
];

const DOM_MARKERS: Array<{ id: AtsType; markers: string[] }> = [
  { id: 'greenhouse', markers: ['greenhouse', 'gh_jid'] },
  { id: 'lever', markers: ['lever.co', 'lever-job-listing'] },
];

export function detectAtsByUrl(url: string): AtsType {
  for (const entry of ATS_URL_PATTERNS) {
    if (entry.patterns.some(p => url.includes(p))) return entry.id;
  }
  return 'unknown';
}

export function detectAtsByDom(html: string): AtsType {
  const lower = html.toLowerCase();
  for (const entry of DOM_MARKERS) {
    if (entry.markers.some(m => lower.includes(m))) return entry.id;
  }
  return 'unknown';
}
