import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { SCENARIOS, type Scenario } from "@/lib/vaultguard/scenarios";
import { planFromPrompt, type JevPlan } from "@/lib/vaultguard/jev";
import { verifyProvider, PROVIDER_REGISTRY } from "@/lib/vaultguard/treg";
import { validatePolicy } from "@/lib/vaultguard/scorton";
import { authorizeTransactions } from "@/lib/vaultguard/gateway.functions";
import { CAMPAIGNS } from "@/lib/vaultguard/greg";
import type { Ledger, OperatingMode, Policy, ScortonResult, TregResult, TxRequest } from "@/lib/vaultguard/types";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "VaultGuard AI — Zero-Trust Gateway for Ad-Buying Agents" },
      { name: "description", content: "Watch Greg, JEV, TREG and Scorton research, propose, verify and authorise ad purchases safely." },
      { property: "og:title", content: "VaultGuard AI — Zero-Trust Gateway for Ad-Buying Agents" },
      { property: "og:description", content: "An autonomous media buyer that never has unrestricted financial authority." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: App,
});

type Verdict = "IDLE" | "APPROVED" | "BLOCKED" | "PENDING_HUMAN" | "PARTIAL";
interface Audit { id: string; time: string; scenario: string; amount: number; provider: string; decision: string; detail: string }
interface Activity { time: string; agent: string; text: string }

const INITIAL_POLICY: Policy = {
  dailyBudget: 500,
  singleTxLimit: 200,
  maxCpc: 2,
  humanApprovalThreshold: 175,
  velocityLimit: 3,
  keywordAllowlist: [...CAMPAIGNS.flatMap((c) => c.seedKeywords)],
  allowedCampaigns: CAMPAIGNS.map((c) => c.id),
  killSwitch: false,
  mode: "AUTONOMOUS",
};

const now = () => new Date().toLocaleTimeString("en-GB");
const eur = (n: number) => `€${n.toLocaleString("en-GB", { maximumFractionDigits: 2 })}`;

function App() {
  const [policy, setPolicy] = useState<Policy>(INITIAL_POLICY);
  const [ledger, setLedger] = useState<Ledger>({ committed: 0, history: [] });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ dailyBudget: "500", singleTxLimit: "200", maxCpc: "2", humanApprovalThreshold: "175", velocityLimit: "3" });
  const [draftErrs, setDraftErrs] = useState<string[]>([]);

  const [scenario, setScenario] = useState<Scenario>(SCENARIOS[0]);
  const [prompt, setPrompt] = useState(SCENARIOS[0].prompt);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [verdict, setVerdict] = useState<Verdict>("IDLE");
  const [plan, setPlan] = useState<JevPlan | null>(null);
  const [treg, setTreg] = useState<TregResult | null>(null);
  const [results, setResults] = useState<ScortonResult[]>([]);
  const [pending, setPending] = useState<TxRequest[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const [audit, setAudit] = useState<Audit[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [stats, setStats] = useState({ proposed: 0, approved: 0, blocked: 0, nApproved: 0, nBlocked: 0, keywords: 0 });
  const [alerts, setAlerts] = useState<string[]>([]);

  const log = (agent: string, text: string) => setActivity((a) => [{ time: now(), agent, text }, ...a].slice(0, 30));
  const remaining = Math.max(0, policy.dailyBudget - ledger.committed);
  const pct = policy.dailyBudget > 0 ? Math.min(100, (ledger.committed / policy.dailyBudget) * 100) : 100;

  const record = (res: ScortonResult[], reqs: TxRequest[], label: string, newLedger: Ledger) => {
    setLedger(newLedger);
    const a = res.filter((r) => r.decision === "APPROVED");
    const b = res.filter((r) => r.decision === "BLOCKED");
    const p = res.filter((r) => r.decision === "PENDING_HUMAN");
    setStats((s) => ({
      ...s,
      approved: s.approved + a.reduce((t, r) => t + r.amount, 0),
      blocked: s.blocked + b.reduce((t, r) => t + r.amount, 0),
      nApproved: s.nApproved + a.length,
      nBlocked: s.nBlocked + b.length,
    }));
    setAudit((prev) => [
      ...res.map((r, i) => ({
        id: r.txId,
        time: now(),
        scenario: label,
        amount: r.amount,
        provider: reqs[i]?.domain ?? "",
        decision: r.decision === "APPROVED" ? "APPROVED · SIMULATED" : r.decision,
        detail: r.decision === "APPROVED" ? "Simulated execution — no real payment made" : r.decision === "PENDING_HUMAN" ? "Awaiting operator" : r.reasons[0],
      })),
      ...prev,
    ].slice(0, 40));
    b.forEach((r) => setAlerts((al) => [`${now()} · ${r.txId}: ${r.reasons[0]}`, ...al].slice(0, 20)));
    setPending(reqs.filter((_, i) => res[i].decision === "PENDING_HUMAN"));
    const v: Verdict = a.length === res.length ? "APPROVED" : b.length === res.length ? "BLOCKED" : p.length === res.length ? "PENDING_HUMAN" : "PARTIAL";
    setVerdict(v);
    log("Scorton", `${a.length} approved · ${b.length} blocked · ${p.length} pending`);
  };

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const run = async () => {
    if (busy) return;
    setErr(null);
    setBusy(true);
    setResults([]);
    setPending([]);
    setVerdict("IDLE");
    setStep(1);
    const p = planFromPrompt(prompt, policy);
    setPlan(p);
    log("Greg", `Researched ${new Set(p.research.map((r) => r.keyword)).size} keywords across 3 platforms`);
    setStats((s) => ({ ...s, keywords: s.keywords + new Set(p.research.map((r) => r.keyword)).size }));
    await wait(450);
    setStep(2);
    p.rationale.forEach((r) => log("JEV", r));
    await wait(450);
    setStep(3);
    if (!p.requests.length) { setBusy(false); setStep(0); setErr("JEV produced no transaction request."); return; }
    const t = verifyProvider(p.requests[0].domain);
    setTreg(t);
    log("TREG", `${t.normalized}: ${t.status}`);
    await wait(450);
    setStep(4);
    setStats((s) => ({ ...s, proposed: s.proposed + p.requests.reduce((x, r) => x + r.amount, 0) }));
    try {
      const out = await authorizeTransactions({ data: { requests: p.requests, policy, ledger } });
      setResults(out.results);
      record(out.results, p.requests, scenario.name, out.ledger);
      setStep(5);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Gateway error — transaction not authorised");
      setVerdict("BLOCKED");
    }
    setBusy(false);
  };

  const decidePending = async (approve: boolean) => {
    if (!pending.length) return;
    if (!approve) {
      setAudit((prev) => [...pending.map((r) => ({ id: r.id, time: now(), scenario: "Operator review", amount: r.amount, provider: r.domain, decision: "REJECTED BY HUMAN", detail: "Operator declined" })), ...prev]);
      setStats((s) => ({ ...s, blocked: s.blocked + pending.reduce((t, r) => t + r.amount, 0), nBlocked: s.nBlocked + pending.length }));
      log("Operator", `Rejected ${pending.length} pending transaction(s)`);
      setPending([]);
      setVerdict("BLOCKED");
      return;
    }
    setBusy(true);
    log("Operator", "Approved — re-submitting to Scorton for full re-validation");
    try {
      const reqs = pending;
      const out = await authorizeTransactions({ data: { requests: reqs, policy, ledger, humanApproved: true } });
      setResults(out.results);
      record(out.results, reqs, "Operator approval", out.ledger);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Gateway error");
    }
    setBusy(false);
  };

  const openEdit = () => {
    setDraft({
      dailyBudget: String(policy.dailyBudget), singleTxLimit: String(policy.singleTxLimit), maxCpc: String(policy.maxCpc),
      humanApprovalThreshold: String(policy.humanApprovalThreshold), velocityLimit: String(policy.velocityLimit),
    });
    setDraftErrs([]);
    setEditing(true);
  };
  const saveCaps = (e: React.FormEvent) => {
    e.preventDefault();
    const next: Policy = {
      ...policy,
      dailyBudget: draft.dailyBudget.trim() === "" ? NaN : Number(draft.dailyBudget),
      singleTxLimit: draft.singleTxLimit.trim() === "" ? NaN : Number(draft.singleTxLimit),
      maxCpc: draft.maxCpc.trim() === "" ? NaN : Number(draft.maxCpc),
      humanApprovalThreshold: draft.humanApprovalThreshold.trim() === "" ? NaN : Number(draft.humanApprovalThreshold),
      velocityLimit: draft.velocityLimit.trim() === "" ? NaN : Number(draft.velocityLimit),
    };
    const errs = validatePolicy(next, ledger.committed);
    if (errs.length) { setDraftErrs(errs); return; }
    setPolicy(next);
    setEditing(false);
    log("Operator", "Spending policy updated");
  };

  const setMode = (m: OperatingMode) => { setPolicy((p) => ({ ...p, mode: m })); log("Operator", `Mode → ${m}`); };
  const exposure = plan ? plan.requests.reduce((t, r) => t + r.amount, 0) : 0;
  const blockedNow = results.filter((r) => r.decision === "BLOCKED").reduce((t, r) => t + r.amount, 0);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[1720px] flex-col gap-3 p-3.5 text-foreground">
      {/* HEADER */}
      <header className="panel flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 shadow-lg">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 font-mono font-bold text-primary">VG</div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-extrabold tracking-tight">VaultGuard <span className="font-mono text-primary">AI</span></h1>
              <span className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">Greg → JEV → TREG → Scorton</span>
            </div>
            <div className="font-mono text-[10px] text-muted-foreground">Autonomous Ad Buyer · Zero-Trust Gate · Mock data only</div>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-lg border border-border bg-background/80 px-2 py-1.5">
          <span className="font-mono text-[11px] font-semibold text-muted-foreground">Mode</span>
          {(["AUTONOMOUS", "SUPERVISED", "LOCKED"] as OperatingMode[]).map((m) => (
            <button key={m} onClick={() => setMode(m)}
              className={`rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold transition ${policy.mode === m
                ? m === "AUTONOMOUS" ? "glow-ok border-primary/60 bg-primary/15 text-primary" : m === "SUPERVISED" ? "glow-warn border-warning/60 bg-warning/15 text-warning" : "glow-bad border-destructive/60 bg-destructive/15 text-destructive"
                : "border-border text-muted-foreground hover:text-foreground"}`}>{m}</button>
          ))}
          <button onClick={() => { setPolicy((p) => ({ ...p, killSwitch: !p.killSwitch })); log("Operator", policy.killSwitch ? "Kill switch released" : "KILL SWITCH ENGAGED"); }}
            className={`ml-1 rounded-md border px-2.5 py-1 font-mono text-[10px] font-bold ${policy.killSwitch ? "glow-bad border-destructive bg-destructive text-destructive-foreground" : "border-destructive/50 text-destructive hover:bg-destructive/10"}`}>
            {policy.killSwitch ? "■ KILLED — RELEASE" : "KILL SWITCH"}
          </button>
        </div>

        <div className="flex items-center gap-4 rounded-lg border border-border bg-background/80 px-3.5 py-1.5">
          <div className="text-right font-mono">
            <div className="flex items-center justify-end gap-2 text-[11px] text-muted-foreground">
              Daily: <b className="text-foreground">{eur(policy.dailyBudget)}</b> | Tx: <b className="text-foreground">{eur(policy.singleTxLimit)}</b> | CPC: <b className="text-foreground">{eur(policy.maxCpc)}</b>
              <button onClick={openEdit} className="text-[10px] text-accent underline">Edit Caps</button>
            </div>
            <div className="text-[10px] text-muted-foreground">Committed <b className="text-primary">{eur(ledger.committed)}</b> · Remaining <b className="text-foreground">{eur(remaining)}</b></div>
          </div>
          <div className="h-2.5 w-28 overflow-hidden rounded-full border border-border bg-secondary">
            <div className={`h-full transition-all ${pct >= 100 ? "bg-destructive" : pct > 80 ? "bg-warning" : "bg-primary"}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
      </header>

      {editing && (
        <form onSubmit={saveCaps} className="panel flex flex-wrap items-end gap-3 px-4 py-3 font-mono text-xs">
          {([["dailyBudget", "Daily budget €"], ["singleTxLimit", "Single tx €"], ["maxCpc", "Max CPC €"], ["humanApprovalThreshold", "Human approval > €"], ["velocityLimit", "Tx / 60s"]] as const).map(([k, l]) => (
            <label key={k} className="flex flex-col gap-1 text-muted-foreground">{l}
              <input value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                className="w-28 rounded border border-input bg-background px-2 py-1 text-foreground outline-none focus:border-ring" />
            </label>
          ))}
          <button className="rounded bg-primary px-3 py-1.5 font-bold text-primary-foreground">Save</button>
          <button type="button" onClick={() => setEditing(false)} className="rounded border border-border px-3 py-1.5">Cancel</button>
          {draftErrs.length > 0 && <ul className="w-full text-destructive">{draftErrs.map((e) => <li key={e}>✕ {e}</li>)}</ul>}
        </form>
      )}

      {/* DASHBOARD */}
      <section className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
        {[
          ["Campaign budget", eur(policy.dailyBudget), "text-foreground"],
          ["Proposed spend", eur(stats.proposed), "text-accent"],
          ["Approved (simulated)", eur(stats.approved), "text-primary"],
          ["Blocked spend", eur(stats.blocked), "text-destructive"],
          ["Remaining", eur(remaining), "text-foreground"],
          ["Keywords researched", String(stats.keywords), "text-accent"],
          ["Tx approved", String(stats.nApproved), "text-primary"],
          ["Tx rejected", String(stats.nBlocked), "text-destructive"],
        ].map(([l, v, c]) => (
          <div key={l} className="panel px-3 py-2">
            <div className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{l}</div>
            <div className={`font-mono text-lg font-bold ${c}`}>{v}</div>
          </div>
        ))}
      </section>

      <div className="grid flex-1 grid-cols-1 gap-3 lg:grid-cols-12">
        {/* LEFT: scenarios + prompt */}
        <div className="panel flex flex-col gap-2 p-3 lg:col-span-3">
          <div className="flex items-center justify-between border-b border-border pb-1">
            <span className="font-mono text-xs font-bold uppercase tracking-wide">Agent Action Stream</span>
            <span className="font-mono text-[10px] text-muted-foreground">scale / attack vector</span>
          </div>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            {SCENARIOS.map((sc) => (
              <button key={sc.id} onClick={() => { setScenario(sc); setPrompt(sc.prompt); }}
                className={`rounded-lg border p-2 text-left transition ${scenario.id === sc.id ? "border-accent/60 bg-accent/10" : "border-border bg-background/50 hover:border-muted-foreground"}`}>
                <div className={`font-mono text-[9px] font-bold ${sc.tag === "BENCHMARK" ? "text-primary" : "text-destructive"}`}>{sc.tag}</div>
                <div className="text-[11px] font-semibold leading-tight">{sc.name}</div>
              </button>
            ))}
          </div>
          <label className="mt-1 font-mono text-[10px] uppercase text-muted-foreground">Incoming prompt (editable — parsed live)</label>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6}
            className="w-full resize-none rounded-lg border border-input bg-background p-2 font-mono text-[11px] text-foreground outline-none focus:border-ring" />
          <button onClick={run} disabled={busy}
            className="glow-ok rounded-lg bg-primary py-2 font-mono text-xs font-bold text-primary-foreground transition hover:opacity-90 disabled:opacity-50">
            {busy ? "PROCESSING…" : "▶ RUN AGENT PIPELINE"}
          </button>
          <div className="rounded-lg border border-border bg-background/50 p-2 font-mono text-[10px] text-muted-foreground">
            <div>Vector: <span className="text-foreground">{scenario.vector}</span></div>
            <div>Target: <span className="text-foreground">{scenario.component}</span></div>
          </div>
        </div>

        {/* CENTER: pipeline */}
        <div className="flex flex-col gap-3 lg:col-span-6">
          <div className="grid grid-cols-4 gap-2">
            {["Greg · Research", "JEV · Decide", "TREG · Verify", "Scorton · Authorise"].map((s, i) => (
              <div key={s} className={`panel px-2 py-2 text-center font-mono text-[11px] font-bold transition ${step > i + 1 ? "border-primary/50 text-primary" : step === i + 1 ? "glow-warn border-warning/60 text-warning animate-pulse" : "text-muted-foreground"}`}>
                {i + 1}. {s}
              </div>
            ))}
          </div>

          {/* Greg */}
          <div className="panel p-3">
            <div className="mb-1.5 flex justify-between font-mono text-xs font-bold"><span className="text-accent">GREG — Advertising Intelligence</span><span className="text-muted-foreground">mock market data</span></div>
            {plan ? (
              <div className="max-h-56 overflow-auto">
                <table className="w-full font-mono text-[10.5px]">
                  <thead className="text-left text-muted-foreground"><tr><th>Keyword</th><th>Platform</th><th className="text-right">Volume</th><th className="text-right">CPC</th><th>Comp.</th><th className="text-right">Rel.</th><th>Flags</th></tr></thead>
                  <tbody>
                    {plan.research.map((r) => {
                      const sel = plan.selected === r;
                      return (
                        <tr key={r.keyword + r.platform} className={`border-t border-border/50 ${sel ? "bg-primary/10 text-primary" : ""}`}>
                          <td className="py-0.5">{sel ? "▸ " : ""}{r.keyword}</td><td>{r.platform}</td>
                          <td className="text-right">{r.volume.toLocaleString()}</td><td className="text-right">€{r.cpc.toFixed(2)}</td>
                          <td>{r.competition}</td><td className="text-right">{Math.round(r.relevance * 100)}%</td>
                          <td className="text-destructive">{r.suspicious.length ? `⚠ ${r.suspicious[0]}` : ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <Idle />}
          </div>

          {/* JEV */}
          <div className="panel p-3">
            <div className="mb-1.5 flex justify-between font-mono text-xs font-bold"><span className="text-accent">JEV — Decision Engine</span><span className="text-muted-foreground">proposes only · cannot pay</span></div>
            {plan ? (
              <div className="grid gap-2 md:grid-cols-2">
                <ul className="space-y-1 font-mono text-[10.5px]">
                  {plan.rationale.map((r) => <li key={r} className={r.startsWith("Untrusted") ? "text-destructive" : ""}>› {r}</li>)}
                  {plan.injectionFlags.map((f) => <li key={f} className="text-destructive">⚠ Injection: {f}</li>)}
                </ul>
                <pre className="max-h-40 overflow-auto rounded border border-border bg-background p-2 font-mono text-[10px] text-muted-foreground">
{JSON.stringify(plan.requests.length > 1 ? { count: plan.requests.length, first: plan.requests[0] } : plan.requests[0], null, 2)}
                </pre>
              </div>
            ) : <Idle />}
          </div>

          {/* TREG */}
          <div className="panel p-3">
            <div className="mb-1.5 flex justify-between font-mono text-xs font-bold"><span className="text-accent">TREG — Provider Verification</span><span className="text-muted-foreground">exact-domain registry</span></div>
            {treg && step >= 3 ? (
              <div className="font-mono text-[11px]">
                <div className="flex items-center gap-2">
                  <span className={`rounded px-2 py-0.5 font-bold ${treg.status === "VERIFIED" ? "bg-primary/15 text-primary" : "bg-destructive/15 text-destructive"}`}>{treg.status}</span>
                  <span>{treg.normalized}</span>{treg.provider && <span className="text-muted-foreground">({treg.provider})</span>}
                </div>
                <ul className="mt-1 text-[10.5px] text-muted-foreground">{treg.reasons.map((r) => <li key={r}>› {r}</li>)}</ul>
              </div>
            ) : <Idle />}
            <div className="mt-2 flex flex-wrap gap-1">{PROVIDER_REGISTRY.map((p) => <span key={p.domain} className="rounded border border-border px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground">✓ {p.domain}</span>)}</div>
          </div>
        </div>

        {/* RIGHT: Scorton */}
        <div className="flex flex-col gap-3 lg:col-span-3">
          <div className={`panel p-3 ${verdict === "APPROVED" ? "glow-ok border-primary/50" : verdict === "BLOCKED" ? "glow-bad border-destructive/50" : verdict === "IDLE" ? "" : "glow-warn border-warning/50"}`}>
            <div className="font-mono text-xs font-bold text-accent">SCORTON — Final Authority</div>
            <div className={`mt-1 font-mono text-2xl font-extrabold ${verdict === "APPROVED" ? "text-primary" : verdict === "BLOCKED" ? "text-destructive" : verdict === "IDLE" ? "text-muted-foreground" : "text-warning"}`}>
              {verdict === "APPROVED" ? "AUTHORISED" : verdict === "PENDING_HUMAN" ? "AWAITING HUMAN" : verdict}
            </div>
            <div className="font-mono text-[10px] text-muted-foreground">
              {verdict === "APPROVED" || verdict === "PARTIAL" ? "Simulated execution only — no card charged, no ad platform contacted." : verdict === "IDLE" ? "No transaction in flight." : ""}
            </div>
            {err && <div className="mt-1 font-mono text-[10px] text-destructive">{err}</div>}
            {pending.length > 0 && (
              <div className="mt-2 flex gap-2">
                <button disabled={busy} onClick={() => decidePending(true)} className="flex-1 rounded bg-primary py-1.5 font-mono text-[11px] font-bold text-primary-foreground">Approve {eur(pending.reduce((t, r) => t + r.amount, 0))}</button>
                <button disabled={busy} onClick={() => decidePending(false)} className="flex-1 rounded border border-destructive py-1.5 font-mono text-[11px] font-bold text-destructive">Reject</button>
              </div>
            )}
            {results.length > 1 && (
              <div className="mt-2 flex flex-wrap gap-1">{results.map((r, i) => (
                <span key={i} className={`rounded px-1 font-mono text-[9px] ${r.decision === "APPROVED" ? "bg-primary/20 text-primary" : r.decision === "BLOCKED" ? "bg-destructive/20 text-destructive" : "bg-warning/20 text-warning"}`}>#{i + 1}</span>
              ))}</div>
            )}
          </div>

          <div className="panel p-3">
            <div className="mb-1 font-mono text-[10px] font-bold uppercase text-muted-foreground">Security checks {results.length > 1 ? "(last request)" : ""}</div>
            {results.length ? (
              <ul className="space-y-0.5 font-mono text-[10.5px]">
                {results[results.length - 1].checks.map((c) => (
                  <li key={c.id} className="flex gap-1.5">
                    <span className={c.status === "PASS" ? "text-primary" : c.status === "FAIL" ? "text-destructive" : "text-warning"}>{c.status === "PASS" ? "✓" : c.status === "FAIL" ? "✕" : "◷"}</span>
                    <span><b>{c.label}</b> <span className="text-muted-foreground">— {c.detail}</span></span>
                  </li>
                ))}
              </ul>
            ) : <Idle />}
          </div>

          {plan && step === 5 && (
            <div className="panel p-3 font-mono text-[10.5px]">
              <div className="mb-1 text-[10px] font-bold uppercase text-muted-foreground">Attack report</div>
              <div>Vector: <span className="text-foreground">{scenario.vector}</span></div>
              <div>Component: <span className="text-foreground">{scenario.component}</span></div>
              <div>Final decision: <span className="text-foreground">{verdict}</span></div>
              <div>Potential exposure: <span className="text-warning">{eur(exposure)}</span></div>
              <div>Exposure prevented: <span className="text-primary">{eur(blockedNow)}</span></div>
            </div>
          )}
        </div>
      </div>

      {/* BOTTOM */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
        <div className="panel p-3 lg:col-span-6">
          <div className="mb-1 font-mono text-xs font-bold uppercase">Audit Log</div>
          <div className="max-h-52 overflow-auto">
            <table className="w-full font-mono text-[10.5px]">
              <thead className="text-left text-muted-foreground"><tr><th>Tx ID</th><th>Time</th><th>Source</th><th>Amount</th><th>Merchant</th><th>Decision</th><th>Detail</th></tr></thead>
              <tbody>
                {audit.length === 0 && <tr><td colSpan={7} className="py-2 text-muted-foreground">No transactions yet.</td></tr>}
                {audit.map((a, i) => (
                  <tr key={a.id + i} className="border-t border-border/50">
                    <td className="py-0.5">{a.id}</td><td>{a.time}</td><td>{a.scenario}</td><td>{eur(a.amount)}</td><td>{a.provider}</td>
                    <td className={a.decision.startsWith("APPROVED") ? "text-primary" : a.decision === "PENDING_HUMAN" ? "text-warning" : "text-destructive"}>{a.decision}</td>
                    <td className="text-muted-foreground">{a.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel p-3 lg:col-span-3">
          <div className="mb-1 font-mono text-xs font-bold uppercase">Agent Activity</div>
          <ul className="max-h-52 space-y-0.5 overflow-auto font-mono text-[10.5px]">
            {activity.length === 0 && <li className="text-muted-foreground">Idle.</li>}
            {activity.map((a, i) => <li key={i}><span className="text-muted-foreground">{a.time}</span> <span className="text-accent">{a.agent}</span> {a.text}</li>)}
          </ul>
        </div>
        <div className="panel p-3 lg:col-span-3">
          <div className="mb-1 font-mono text-xs font-bold uppercase text-destructive">Security Alerts</div>
          <ul className="max-h-52 space-y-0.5 overflow-auto font-mono text-[10.5px]">
            {alerts.length === 0 && <li className="text-muted-foreground">No alerts.</li>}
            {alerts.map((a, i) => <li key={i} className="text-destructive">⚠ {a}</li>)}
          </ul>
        </div>
      </div>
    </div>
  );
}

function Idle() {
  return <div className="font-mono text-[11px] text-muted-foreground">IDLE — run the pipeline to populate.</div>;
}
