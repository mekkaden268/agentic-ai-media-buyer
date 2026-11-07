/** JEV — Decision Engine. Produces structured transaction REQUESTS only; it never authorises payment. */
import { CAMPAIGNS, PLATFORMS, researchKeywords, type KeywordRow } from "./greg";
import { normalizeDomain } from "./treg";
import type { Policy, TxRequest } from "./types";

export interface ParsedPrompt {
  amount?: number;
  domain?: string;
  keyword?: string;
  campaignId?: string;
  burst: number;
  replay: number;
}

const INJECTION_PATTERNS: [RegExp, string][] = [
  [/ignore (all |any )?(previous|prior|above)? ?(instructions|rules)/i, "Instruction override attempt"],
  [/override (the )?(safety|security|checks|limits)/i, "Safety override attempt"],
  [/\[?\s*system( alert| message)?\s*[:\]]/i, "Fake system message embedded in data"],
  [/(disable|bypass|skip) (scorton|treg|security|validation|limits|checks)/i, "Attempt to bypass security layer"],
  [/(raise|increase|set|change) (the )?(daily )?(budget|cap|limit)/i, "Budget manipulation instruction"],
  [/\brefund\b/i, "Unexpected refund instruction"],
  [/you are now|admin mode|developer mode/i, "Role hijack attempt"],
];

export function detectInjection(text: string): string[] {
  return INJECTION_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label);
}

export function parsePrompt(prompt: string): ParsedPrompt {
  const out: ParsedPrompt = { burst: 1, replay: 1 };
  const burst = prompt.match(/(\d+)\s+(?:rapid\s+)?(?:micro\s+)?(?:top-ups|requests|transactions|purchases)\s+of\s+€\s?([\d,.]+)/i);
  if (burst) {
    out.burst = Math.min(25, parseInt(burst[1], 10));
    out.amount = parseFloat(burst[2].replace(/,/g, ""));
  } else {
    const amt = prompt.match(/€\s?([\d,]+(?:\.\d+)?)/);
    if (amt) out.amount = parseFloat(amt[1].replace(/,/g, ""));
  }
  const replay = prompt.match(/(?:replay|resend|repeat|retry)[^.]*?(\d+)\s*times/i);
  if (replay) out.replay = Math.min(25, parseInt(replay[1], 10));
  const domain = prompt.match(/\b((?:[a-z0-9\u00a1-\uffff-]+\.)+[a-z]{2,})\b/i);
  if (domain) out.domain = normalizeDomain(domain[1]);
  const kw = prompt.match(/keywords?\s*[:=]?\s*["'“]([^"'”]+)["'”]/i);
  if (kw) out.keyword = kw[1].toLowerCase().trim();
  const camp = prompt.match(/(?:campaign\s*)?#\s?(C-)?(\d{2,4})/i);
  if (camp) out.campaignId = `C-${camp[2]}`;
  return out;
}

export interface JevPlan {
  parsed: ParsedPrompt;
  research: KeywordRow[];
  selected?: KeywordRow;
  rationale: string[];
  requests: TxRequest[];
  injectionFlags: string[];
}

let seq = 0;
export function newTxId() {
  seq += 1;
  return `TX-${Date.now().toString(36).toUpperCase()}-${seq.toString().padStart(3, "0")}`;
}

export function planFromPrompt(prompt: string, policy: Policy): JevPlan {
  const parsed = parsePrompt(prompt);
  const injectionFlags = detectInjection(prompt);
  const campaignId = parsed.campaignId ?? "C-402";
  const campaign = CAMPAIGNS.find((c) => c.id === campaignId) ?? {
    id: campaignId,
    name: "Unknown campaign",
    product: "unknown",
    seedKeywords: [],
  };
  const research = researchKeywords(campaign, parsed.keyword ? [parsed.keyword] : []);
  const rationale: string[] = [];

  let pool = research;
  if (parsed.keyword) pool = research.filter((r) => r.keyword === parsed.keyword);
  const targetPlatform = PLATFORMS.find((p) => p.domain === parsed.domain);
  if (targetPlatform) pool = pool.filter((r) => r.platform === targetPlatform.name);
  const clean = pool.filter((r) => r.suspicious.length === 0);
  const ranked = (clean.length ? clean : pool).sort(
    (a, b) => (b.relevance * Math.log10(b.volume)) / b.cpc - (a.relevance * Math.log10(a.volume)) / a.cpc,
  );
  const selected = ranked[0];
  if (!selected) {
    rationale.push("No keyword data available — no request generated");
    return { parsed, research, rationale, requests: [], injectionFlags };
  }
  if (!clean.length) rationale.push(`Greg flagged "${selected.keyword}" as suspicious; forwarding anyway because it was explicitly requested`);

  const rawBid = Math.round(selected.cpc * 1.15 * 100) / 100;
  const bidCpc = Math.min(rawBid, policy.maxCpc);
  if (bidCpc < rawBid) rationale.push(`Bid clamped from €${rawBid} to max CPC €${policy.maxCpc}`);
  const amount = parsed.amount ?? Math.round(bidCpc * 120);
  const clicks = Math.max(1, Math.floor(amount / Math.max(bidCpc, 0.01)));
  const domain = parsed.domain ?? selected.domain;
  rationale.push(
    `Selected "${selected.keyword}" on ${selected.platform} (relevance ${(selected.relevance * 100).toFixed(0)}%, CPC €${selected.cpc})`,
    `Recommended bid €${bidCpc.toFixed(2)} → ~${clicks} clicks for €${amount}`,
  );
  if (injectionFlags.length) rationale.push(`Untrusted instructions detected: ${injectionFlags.join("; ")}`);

  const base: Omit<TxRequest, "id"> = {
    campaignId,
    domain,
    provider: targetPlatform?.name ?? (parsed.domain ? "Unknown merchant" : selected.platform),
    keyword: selected.keyword,
    bidCpc,
    amount,
    clicks,
    injectionFlags,
    createdBy: "JEV",
  };
  const requests: TxRequest[] = [];
  const replayId = newTxId();
  for (let i = 0; i < parsed.burst; i++) {
    if (parsed.replay > 1) {
      for (let r = 0; r < parsed.replay; r++) requests.push({ ...base, id: replayId });
    } else {
      requests.push({ ...base, id: i === 0 ? replayId : newTxId() });
    }
  }
  return { parsed, research, selected, rationale, requests, injectionFlags };
}
