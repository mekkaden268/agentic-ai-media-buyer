/**
 * Scorton — deterministic security gateway. Final authority over every transaction.
 * No AI score is used for authorisation; every rule is an explicit, testable check.
 */
import { verifyProvider } from "./treg";
import type { Check, Ledger, Policy, ScortonResult, TxRequest } from "./types";

export const VELOCITY_WINDOW_MS = 60_000;
export const DUPLICATE_WINDOW_MS = 5 * 60_000;

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export function validatePolicy(p: Policy, committed: number): string[] {
  const errs: string[] = [];
  const fields: [keyof Policy, string][] = [
    ["dailyBudget", "Daily budget"],
    ["singleTxLimit", "Single transaction limit"],
    ["maxCpc", "Max CPC"],
    ["humanApprovalThreshold", "Human approval threshold"],
    ["velocityLimit", "Velocity limit"],
  ];
  for (const [k, label] of fields) {
    const v = p[k];
    if (!isNum(v)) errs.push(`${label} must be a number`);
    else if (v < 0) errs.push(`${label} cannot be negative`);
    else if (v > 1_000_000) errs.push(`${label} exceeds hard ceiling €1,000,000`);
  }
  if (errs.length) return errs;
  if (p.dailyBudget < committed) errs.push(`Daily budget cannot be below committed spend (€${committed})`);
  if (p.singleTxLimit > p.dailyBudget) errs.push("Single transaction limit cannot exceed daily budget");
  if (p.maxCpc <= 0) errs.push("Max CPC must be greater than 0");
  if (!Number.isInteger(p.velocityLimit) || p.velocityLimit < 1) errs.push("Velocity limit must be a whole number ≥ 1");
  if (!["AUTONOMOUS", "SUPERVISED", "LOCKED"].includes(p.mode)) errs.push("Invalid operating mode");
  return errs;
}

export function evaluate(
  req: TxRequest,
  policy: Policy,
  ledger: Ledger,
  opts: { now: number; humanApproved?: boolean },
): ScortonResult {
  const checks: Check[] = [];
  const add = (id: string, label: string, ok: boolean | "REVIEW", detail: string) =>
    checks.push({ id, label, status: ok === "REVIEW" ? "REVIEW" : ok ? "PASS" : "FAIL", detail });

  add("kill", "Emergency kill switch", !policy.killSwitch, policy.killSwitch ? "Kill switch engaged — all spend halted" : "Disengaged");
  add("mode", "Operating mode", policy.mode !== "LOCKED", policy.mode === "LOCKED" ? "Platform LOCKED — purchases blocked" : policy.mode);

  const policyErrs = validatePolicy(policy, ledger.committed);
  add("policy", "Policy integrity", policyErrs.length === 0, policyErrs[0] ?? "Limits valid");

  const amountOk = isNum(req.amount) && req.amount > 0 && isNum(req.bidCpc) && req.bidCpc > 0;
  add("amount", "Amount sanity", amountOk, amountOk ? `€${req.amount}` : "Amount or bid is not a positive number");

  const campaignOk = policy.allowedCampaigns.includes(req.campaignId);
  add("campaign", "Campaign permission", campaignOk, campaignOk ? `${req.campaignId} authorised` : `${req.campaignId} not in agent's permitted campaigns`);

  const treg = verifyProvider(req.domain);
  add("merchant", "Merchant verification (TREG)", treg.status === "VERIFIED", treg.reasons[0]);

  const kwOk = policy.keywordAllowlist.map((k) => k.toLowerCase()).includes(req.keyword.toLowerCase());
  add("keyword", "Keyword allowlist", kwOk, kwOk ? `"${req.keyword}" allowlisted` : `"${req.keyword}" not on allowlist`);

  add("cpc", "Max CPC", req.bidCpc <= policy.maxCpc, `Bid €${req.bidCpc} vs max €${policy.maxCpc}`);
  add("single", "Single transaction limit", req.amount <= policy.singleTxLimit, `€${req.amount} vs limit €${policy.singleTxLimit}`);
  const after = ledger.committed + (isNum(req.amount) ? req.amount : 0);
  add("daily", "Daily budget", after <= policy.dailyBudget, `€${ledger.committed} + €${req.amount} = €${after} / €${policy.dailyBudget}`);

  const dupId = ledger.history.some((h) => h.id === req.id);
  const dupFp = ledger.history.some(
    (h) =>
      opts.now - h.ts < DUPLICATE_WINDOW_MS &&
      h.domain === req.domain &&
      h.keyword === req.keyword &&
      h.amount === req.amount &&
      h.campaignId === req.campaignId,
  );
  add("dup", "Duplicate prevention", !dupId && !dupFp, dupId ? `Transaction ID ${req.id} already executed` : dupFp ? "Identical purchase executed within 5 min" : "Unique");

  const recent = ledger.history.filter((h) => opts.now - h.ts < VELOCITY_WINDOW_MS).length;
  add("velocity", "Rolling velocity limit", recent < policy.velocityLimit, `${recent} tx in last 60s (limit ${policy.velocityLimit})`);

  add("prompt", "Prompt integrity", req.injectionFlags.length === 0, req.injectionFlags[0] ?? "No injection patterns");

  const needsHuman = policy.mode === "SUPERVISED" || req.amount > policy.humanApprovalThreshold;
  add(
    "human",
    "Human approval",
    !needsHuman || opts.humanApproved ? true : "REVIEW",
    needsHuman
      ? opts.humanApproved
        ? "Approved by human operator"
        : policy.mode === "SUPERVISED"
          ? "Supervised mode — operator must approve"
          : `€${req.amount} above €${policy.humanApprovalThreshold} threshold`
      : "Below threshold",
  );

  const fails = checks.filter((c) => c.status === "FAIL");
  const decision = fails.length ? "BLOCKED" : checks.some((c) => c.status === "REVIEW") ? "PENDING_HUMAN" : "APPROVED";
  return { txId: req.id, decision, checks, reasons: fails.map((f) => `${f.label}: ${f.detail}`), amount: req.amount };
}

/** Evaluate sequentially, committing approved spend so later requests see it (velocity/duplicates/budget). */
export function evaluateBatch(
  reqs: TxRequest[],
  policy: Policy,
  ledger: Ledger,
  opts: { now: number; humanApproved?: boolean },
) {
  let l: Ledger = { committed: ledger.committed, history: [...ledger.history] };
  const results: ScortonResult[] = [];
  reqs.forEach((r, i) => {
    const now = opts.now + i * 50;
    const res = evaluate(r, policy, l, { now, humanApproved: opts.humanApproved });
    if (res.decision === "APPROVED") {
      l = {
        committed: Math.round((l.committed + r.amount) * 100) / 100,
        history: [...l.history, { id: r.id, ts: now, amount: r.amount, domain: r.domain, keyword: r.keyword, campaignId: r.campaignId }],
      };
    }
    results.push(res);
  });
  return { results, ledger: l };
}
