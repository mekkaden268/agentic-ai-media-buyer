/** Greg — Advertising Intelligence (mock research data, no real ad accounts). */
export type Platform = "Google Ads" | "Microsoft Advertising" | "Amazon Ads";
export const PLATFORMS: { name: Platform; domain: string }[] = [
  { name: "Google Ads", domain: "ads.google.com" },
  { name: "Microsoft Advertising", domain: "ads.microsoft.com" },
  { name: "Amazon Ads", domain: "advertising.amazon.com" },
];

export interface KeywordRow {
  keyword: string;
  platform: Platform;
  domain: string;
  volume: number;
  cpc: number;
  competition: "LOW" | "MEDIUM" | "HIGH";
  relevance: number; // 0..1
  suspicious: string[];
}

export interface Campaign {
  id: string;
  name: string;
  product: string;
  seedKeywords: string[];
}

export const CAMPAIGNS: Campaign[] = [
  {
    id: "C-402",
    name: "Spring Running Shoes",
    product: "running shoes",
    seedKeywords: ["running shoes", "trail running shoes", "marathon trainers", "buy running shoes"],
  },
  {
    id: "C-118",
    name: "Hydration Packs",
    product: "hydration pack",
    seedKeywords: ["hydration pack", "running water bottle"],
  },
];

const KNOWN: Record<string, { volume: number; cpc: number; relevance: number }> = {
  "running shoes": { volume: 246000, cpc: 1.12, relevance: 0.96 },
  "trail running shoes": { volume: 74000, cpc: 0.94, relevance: 0.93 },
  "marathon trainers": { volume: 18100, cpc: 0.81, relevance: 0.88 },
  "buy running shoes": { volume: 33100, cpc: 1.38, relevance: 0.97 },
  "hydration pack": { volume: 40500, cpc: 0.72, relevance: 0.95 },
  "running water bottle": { volume: 12100, cpc: 0.55, relevance: 0.86 },
  "free bitcoin giveaway": { volume: 900000, cpc: 0.04, relevance: 0.05 },
  "cheap nike replica": { volume: 60500, cpc: 0.31, relevance: 0.22 },
};

const PLATFORM_MULT: Record<Platform, { v: number; c: number }> = {
  "Google Ads": { v: 1, c: 1 },
  "Microsoft Advertising": { v: 0.28, c: 0.74 },
  "Amazon Ads": { v: 0.46, c: 1.21 },
};

function hash(s: string) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

function baseFor(keyword: string, campaign: Campaign) {
  if (KNOWN[keyword]) return KNOWN[keyword];
  const h = hash(keyword);
  const words = campaign.product.split(" ");
  const related = words.some((w) => keyword.includes(w));
  return {
    volume: 2000 + (h % 50000),
    cpc: 0.4 + (h % 120) / 100,
    relevance: related ? 0.7 + (h % 25) / 100 : 0.15 + (h % 20) / 100,
  };
}

export function researchKeywords(campaign: Campaign, extra: string[] = []): KeywordRow[] {
  const keywords = Array.from(new Set([...campaign.seedKeywords, ...extra.map((k) => k.toLowerCase())]));
  const rows: KeywordRow[] = [];
  for (const kw of keywords) {
    const base = baseFor(kw, campaign);
    for (const p of PLATFORMS) {
      const m = PLATFORM_MULT[p.name];
      const volume = Math.round(base.volume * m.v);
      const cpc = Math.round(base.cpc * m.c * 100) / 100;
      const suspicious: string[] = [];
      if (base.relevance < 0.4) suspicious.push("Low relevance to campaign product");
      if (volume > 200000 && cpc < 0.1) suspicious.push("Volume/CPC ratio indicates bot traffic");
      if (/(free|giveaway|replica|bitcoin|crypto)/.test(kw)) suspicious.push("Policy-sensitive term");
      const competition = cpc > 1.1 ? "HIGH" : cpc > 0.7 ? "MEDIUM" : "LOW";
      rows.push({ keyword: kw, platform: p.name, domain: p.domain, volume, cpc, competition, relevance: base.relevance, suspicious });
    }
  }
  return rows;
}
