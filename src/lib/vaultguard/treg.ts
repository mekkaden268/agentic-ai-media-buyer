import type { TregResult } from "./types";

/** Approved advertising provider registry. Exact-domain matches only. */
export const PROVIDER_REGISTRY = [
  { domain: "ads.google.com", provider: "Google Ads", platform: "google" },
  { domain: "ads.microsoft.com", provider: "Microsoft Advertising", platform: "microsoft" },
  { domain: "advertising.amazon.com", provider: "Amazon Ads", platform: "amazon" },
  { domain: "adsmanager.meta.com", provider: "Meta Ads", platform: "meta" },
] as const;

const BRAND_TOKENS = ["google", "microsoft", "bing", "amazon", "meta", "facebook"];
const RISKY_TLDS = ["pw", "xyz", "top", "click", "zip", "icu", "tk", "gq", "ru"];

export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, "");
  d = d.split(/[/?#]/)[0];
  d = d.replace(/:\d+$/, "");
  d = d.replace(/^www\./, "");
  d = d.replace(/\.$/, "");
  return d;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return dp[a.length][b.length];
}

export function verifyProvider(input: string): TregResult {
  const normalized = normalizeDomain(input || "");
  const reasons: string[] = [];
  if (!normalized || !/^[^\s.]+(\.[^\s.]+)+$/.test(normalized)) {
    return { input, normalized, status: "INVALID", reasons: ["Not a valid domain"] };
  }
  const exact = PROVIDER_REGISTRY.find((p) => p.domain === normalized);
  if (exact) {
    return {
      input,
      normalized,
      status: "VERIFIED",
      provider: exact.provider,
      reasons: [`Exact match in approved registry (${exact.provider})`],
    };
  }

  let status: TregResult["status"] = "UNVERIFIED";
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(normalized) || normalized.includes("xn--")) {
    status = "SPOOFED";
    reasons.push("Contains non-ASCII / punycode characters (homoglyph attack)");
  }
  const brand = BRAND_TOKENS.find((b) => normalized.includes(b));
  if (brand) {
    status = "SPOOFED";
    reasons.push(`Uses trusted brand "${brand}" but is not a registered provider domain`);
  }
  const near = PROVIDER_REGISTRY.find((p) => {
    const dist = levenshtein(normalized, p.domain);
    return dist > 0 && dist <= 3;
  });
  if (near) {
    if (status === "UNVERIFIED") status = "LOOKALIKE";
    reasons.push(`Lookalike of registered domain ${near.domain}`);
  }
  const tld = normalized.split(".").pop() ?? "";
  if (RISKY_TLDS.includes(tld)) reasons.push(`High-risk TLD ".${tld}"`);
  reasons.push("Merchant not found in approved provider registry — rejected");
  return { input, normalized, status, reasons };
}
