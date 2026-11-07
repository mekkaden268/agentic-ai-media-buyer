import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { evaluateBatch } from "./scorton";

const policySchema = z.object({
  dailyBudget: z.number(),
  singleTxLimit: z.number(),
  maxCpc: z.number(),
  humanApprovalThreshold: z.number(),
  velocityLimit: z.number(),
  keywordAllowlist: z.array(z.string().max(100)).max(100),
  allowedCampaigns: z.array(z.string().max(20)).max(50),
  killSwitch: z.boolean(),
  mode: z.enum(["AUTONOMOUS", "SUPERVISED", "LOCKED"]),
});

const reqSchema = z.object({
  id: z.string().max(64),
  campaignId: z.string().max(20),
  domain: z.string().max(253),
  provider: z.string().max(100),
  keyword: z.string().max(100),
  bidCpc: z.number(),
  amount: z.number(),
  clicks: z.number(),
  injectionFlags: z.array(z.string().max(200)).max(20),
  createdBy: z.literal("JEV"),
});

const inputSchema = z.object({
  requests: z.array(reqSchema).min(1).max(50),
  policy: policySchema,
  ledger: z.object({
    committed: z.number().min(0),
    history: z
      .array(
        z.object({
          id: z.string(),
          ts: z.number(),
          amount: z.number(),
          domain: z.string(),
          keyword: z.string(),
          campaignId: z.string(),
        }),
      )
      .max(500),
  }),
  humanApproved: z.boolean().optional(),
});

/** Server-side Scorton gateway: all authorisation happens here, never in the browser or the agent. */
export const authorizeTransactions = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => inputSchema.parse(d))
  .handler(async ({ data }) => {
    const { results, ledger } = evaluateBatch(data.requests, data.policy, data.ledger, {
      now: Date.now(),
      humanApproved: data.humanApproved,
    });
    return { results, ledger, executor: "SIMULATED" as const };
  });
