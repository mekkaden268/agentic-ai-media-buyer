export type OperatingMode = "AUTONOMOUS" | "SUPERVISED" | "LOCKED";

export interface Policy {
  dailyBudget: number;
  singleTxLimit: number;
  maxCpc: number;
  humanApprovalThreshold: number;
  velocityLimit: number; // max transactions per rolling 60s window
  keywordAllowlist: string[];
  allowedCampaigns: string[];
  killSwitch: boolean;
  mode: OperatingMode;
}

export interface LedgerEntry {
  id: string;
  ts: number;
  amount: number;
  domain: string;
  keyword: string;
  campaignId: string;
}

export interface Ledger {
  committed: number;
  history: LedgerEntry[];
}

export interface TxRequest {
  id: string;
  campaignId: string;
  domain: string;
  provider: string;
  keyword: string;
  bidCpc: number;
  amount: number;
  clicks: number;
  injectionFlags: string[];
  createdBy: "JEV";
}

export type CheckStatus = "PASS" | "FAIL" | "REVIEW";
export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export type Decision = "APPROVED" | "BLOCKED" | "PENDING_HUMAN";

export interface ScortonResult {
  txId: string;
  decision: Decision;
  checks: Check[];
  reasons: string[];
  amount: number;
}

export type TregStatus = "VERIFIED" | "SPOOFED" | "LOOKALIKE" | "UNVERIFIED" | "INVALID";
export interface TregResult {
  input: string;
  normalized: string;
  status: TregStatus;
  provider?: string;
  reasons: string[];
}
