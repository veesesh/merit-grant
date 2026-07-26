// MeritGrant: contribution-verified grants on Vouch.
//
// Paste a merged GitHub PR. The server verifies it against the live GitHub API
// (merged, AI co-authored, real author profile), then enrols the author on Vouch
// and releases a funding level.
//
// Vouch is the system of record: each milestone is a real oracle event, and the
// whole dashboard rebuilds from those events after a restart.
//
// Zero dependencies, Node 18+.  Run: npm start
import http from "node:http";
import fs from "node:fs";

const PAGE = fs.readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const B = "https://api.programmablevouchers.com/api/v1";
const KEY = process.env.VOUCH_API_KEY;
const PORT = process.env.PORT || 4319;
// Program on Vouch. Change this (or set SLUG=...) for a clean slate.
const SLUG = process.env.SLUG || "meritgrant-v2";
const GH_TOKEN = process.env.GITHUB_TOKEN || ""; // optional, raises GitHub rate limit

if (!KEY) {
  console.error("Missing VOUCH_API_KEY.\nCopy .env.example to .env and set your Vouch API key, then:\n  VOUCH_API_KEY=sk_test_... npm start");
  process.exit(1);
}
// "prove you used an AI coding tool" — any of these as a commit co-author counts
const AI_COAUTHOR = /co-?authored-by:[^\n]*\b(codex|claude|copilot|gpt|cursor|devin|gemini)\b/i;

// Every level is earned by a merged PR. Nobody is paid for showing up, so a
// contributor whose PR fails the checks sits at level 0 with nothing released.
const LADDER = [
  { level: 1, label: "First PR", amount: 10 },
  { level: 2, label: "Second PR", amount: 20 },
  { level: 3, label: "Third PR", amount: 30 },
  { level: 4, label: "Capstone", amount: 50 },
];
const amtFor = (l) => LADDER.find(x => x.level === l)?.amount ?? 0;

let S = null;
// credited: PRs already funded, keyed owner/repo#number. A PR can only ever pay once.
const blank = () => ({ slug: null, oracleId: null, people: {}, log: [], eventsRecorded: 0, credited: {} });
const prKey = (v) => `${v.owner}/${v.repo}#${v.number}`.toLowerCase();

async function api(label, method, path, body, silent = false) {
  const t0 = Date.now();
  let status = "ERR", data = {};
  try {
    const res = await fetch(B + path, { method, headers: { "x-api-key": KEY, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    status = res.status; try { data = await res.json(); } catch {}
  } catch (e) { data = { error: String(e) }; }
  // Every row in the log is written here and only here, so a row exists if and
  // only if a real request went out. `at` lets the UI show when it happened.
  if (S && !silent) S.log.push({ label, method, path: path.replace(B, ""), status, ms: Date.now() - t0, at: new Date().toISOString() });
  return { status, data };
}

// ---- GitHub API ----
async function gh(path) {
  try {
    const res = await fetch("https://api.github.com" + path, { headers: { "Accept": "application/vnd.github+json", "User-Agent": "meritgrant", ...(GH_TOKEN ? { "Authorization": "Bearer " + GH_TOKEN } : {}) } });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  } catch (e) { return { status: "ERR", data: { message: String(e) } }; }
}
function parsePrUrl(u) {
  const m = String(u || "").match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { owner: m[1], repo: m[2], number: m[3] } : null;
}
async function verifyPR(owner, repo, number) {
  const pr = await gh(`/repos/${owner}/${repo}/pulls/${number}`);
  if (pr.status === 403) return { ok: false, reason: "GitHub rate limit (set GITHUB_TOKEN for more)" };
  if (pr.status !== 200) return { ok: false, reason: `PR not found on GitHub (${pr.status})` };
  const author = pr.data.user?.login;
  const merged = !!pr.data.merged;
  const commits = await gh(`/repos/${owner}/${repo}/pulls/${number}/commits`);
  const text = (Array.isArray(commits.data) ? commits.data : []).map(c => c.commit?.message || "").join("\n") + "\n" + (pr.data.body || "");
  const m = text.match(AI_COAUTHOR);
  const aiCoauthor = !!m, aiTool = m ? m[1] : null;
  const prof = await gh(`/users/${author}`);
  const p = prof.data || {};
  const ageDays = p.created_at ? Math.round((Date.now() - Date.parse(p.created_at)) / 86400000) : 0;
  const profileOk = ageDays > 30 && (p.public_repos || 0) >= 1;
  return { ok: true, owner, repo, number, title: pr.data.title, author, merged, aiCoauthor, aiTool,
    profileOk, profile: { ageDays, public_repos: p.public_repos || 0, followers: p.followers || 0 } };
}

// ---- Vouch helpers ----
async function ensureOracle() {
  if (S?.oracleId) return;
  const list = await api("find oracle", "GET", `/programs/${S.slug}/oracles`);
  S.oracleId = (list.data?.oracles || [])[0]?.id;
}
async function ensureProgram() {
  if (S?.slug) return;
  S = S || blank();
  const slug = SLUG; S.slug = slug;
  const p = await api("check program", "GET", `/programs/${slug}`);
  if (p.status === 404) await api("create program", "POST", "/programs", { slug, name: "MeritGrant", currency: "USD", currencySymbol: "$", maxParticipants: 1000 });
  const list = await api("find oracle", "GET", `/programs/${slug}/oracles`);
  S.oracleId = (list.data?.oracles || [])[0]?.id;
  if (!S.oracleId) {
    const oc = await api("create oracle", "POST", `/programs/${slug}/oracles`, { name: "GitHub", provider: "github", urlTemplate: "https://api.github.com/x", deliveryMode: "push", eventTypes: ["pr.merged"], active: true });
    S.oracleId = oc.data?.oracle?.id; await ensureOracle();
    if (S.oracleId) await api("create trigger", "POST", `/programs/${slug}/oracles/${S.oracleId}/triggers`, { name: "Release on PR", eventType: "pr.merged", actionType: "activate_vouchers", conditionDsl: {}, scopeFilter: {} });
  }
  await restoreCredited(); // runs once per state init, since we return early when slug is set
}
// enrol a contributor on Vouch if we haven't yet (keyed by github login or seed id)
async function ensurePerson({ id, name, github, verified }) {
  if (S.people[id]) return S.people[id];
  const suf = (Date.now() % 1000000000).toString();
  const phone = "+9198" + suf.slice(0, 8);
  const e = await api(`enrol ${name}`, "POST", `/programs/${S.slug}/enrol`, { phone, fields: { fullName: name, github } });
  // Level 0, nothing released. Funding only starts once a PR passes the checks.
  S.people[id] = { id, name, github, verified, level: 0, released: 0, tokenId: e.data?.beneficiary?.tokenId, heldAtNext: false, prs: [] };
  return S.people[id];
}

async function setup() {
  S = blank();
  await ensureProgram();
  return view();
}
function payloadOf(e) {
  let p = e?.payload ?? e?.data ?? {};
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { p = {}; } }
  return p && typeof p === "object" ? p : {};
}
async function refreshEvents() {
  if (!S?.slug) return [];
  const oe = await api("read oracle-events", "GET", `/programs/${S.slug}/oracle-events`);
  const evs = oe.data?.events || [];
  S.eventsRecorded = evs.length;
  return evs;
}
// Vouch is the system of record: rebuild both the credited-PR ledger and the
// funded contributors from the events it stores, so a restart or Reset restores
// the real state instead of showing an empty board.
// Events arrive newest first, so the first one seen for a contributor is their latest state.
async function restoreCredited() {
  const evs = await refreshEvents();
  let nPr = 0, nPeople = 0;
  for (const e of evs) {
    const p = payloadOf(e);
    const key = p.prKey || (p.repo && p.pr != null ? `${p.repo}#${p.pr}`.toLowerCase() : null);
    if (key && !S.credited[key]) {
      S.credited[key] = { author: p.github || "someone", decision: String(p.decision || "release").toLowerCase() };
      nPr++;
    }
    const id = p.contributor || (p.github ? "gh_" + String(p.github).toLowerCase() : null);
    if (id && p.github && p.level != null) {
      if (!S.people[id]) {
        // First sighting is the newest event, so it carries their current standing.
        S.people[id] = {
          id, name: p.name || p.github, github: p.github, verified: p.verified !== false,
          level: p.level, released: p.released ?? 0, tokenId: p.tokenId,
          heldAtNext: !!p.heldNext, prs: [],
        };
        nPeople++;
      }
      // Every event is one PR they submitted. Unshift so the list ends up oldest first.
      if (p.repo && p.pr != null) {
        S.people[id].prs.unshift({ repo: p.repo, pr: p.pr, decision: p.decision || "RELEASE", level: p.level });
      }
    }
  }
  // Deliberately not logged. The log is a record of real HTTP calls to Vouch,
  // and this restore is local work over the response that refreshEvents already
  // logged. A synthetic row here would be indistinguishable from a real request.
  return nPr;
}

// record a merged-PR milestone → real ingest + release
// v carries { owner, repo, number } so the event on Vouch identifies the PR globally
async function releaseFor(person, v, codexCoauthor) {
  await ensureOracle();
  let decision, reason;
  if (!person.verified) { decision = "HOLD"; reason = "Contributor profile not verified (KYC)"; person.heldAtNext = true; }
  else if (!codexCoauthor) { decision = "HOLD"; reason = "PR missing AI co-author, can't confirm tool usage"; person.heldAtNext = true; }
  else if (person.level >= LADDER.length) { decision = "HOLD"; reason = "Already at top level"; }
  else { decision = "RELEASE"; person.level += 1; person.released += amtFor(person.level); person.heldAtNext = false; reason = `Merged with AI co-author, released level ${person.level}`; }
  // The event carries the full outcome, so the whole dashboard can be rebuilt
  // from Vouch alone after a restart. Vouch is the system of record.
  const repo = `${v.owner}/${v.repo}`;
  (person.prs ||= []).push({ repo, pr: v.number, decision, level: person.level });
  await api(`ingest PR ${person.name}`, "POST", `/oracles/${S.oracleId}/ingest`, {
    event_type: "pr.merged", contributor: person.id, github: person.github, name: person.name,
    pr: v.number, repo, prKey: prKey(v), codexCoauthor,
    verified: person.verified, decision, level: person.level, released: person.released,
    tokenId: person.tokenId, heldNext: !!person.heldAtNext,
  });
  await refreshEvents();
  return { decision, reason };
}

// REAL GitHub flow — PHASE 1: GitHub verification only (fast, no Vouch calls)
async function verifyOnly({ url }) {
  const info = parsePrUrl(url);
  if (!info) return { ok: false, reason: "Paste a full PR URL like https://github.com/owner/repo/pull/123" };
  const v = await verifyPR(info.owner, info.repo, info.number);
  if (v.ok) {
    v.gate = { merged: v.merged, aiCoauthor: v.aiCoauthor, profileOk: v.profileOk };
    // surface duplicates in phase 1, before any slow Vouch calls
    const prev = S?.credited?.[prKey(v)];
    if (prev) { v.duplicate = true; v.decision = "DUPLICATE"; v.reason = `Already counted for @${prev.author} (${prev.decision.toLowerCase()})`; }
  }
  return v;
}
// PHASE 2: record on Vouch + release (enrol only if new; skip for unmerged)
async function releasePR({ verify: v }) {
  await ensureProgram();
  if (!v || !v.ok) return { verify: v, state: view() };
  if (!v.merged) { v.decision = "SKIP"; v.reason = "PR isn't merged, nothing to release"; return { verify: v, state: view() }; }
  // a PR can only ever fund once, no matter who submits it or how often
  const key = prKey(v);
  const prev = S.credited[key];
  if (prev) {
    v.decision = "DUPLICATE";
    v.reason = `Already counted for @${prev.author} (${prev.decision.toLowerCase()}), no level released`;
    return { verify: v, state: view() };
  }
  const id = "gh_" + v.author.toLowerCase();
  const person = await ensurePerson({ id, name: v.author, github: v.author, verified: v.profileOk });
  const r = await releaseFor(person, v, v.aiCoauthor);
  v.decision = r.decision; v.reason = r.reason;
  S.credited[key] = { author: v.author, decision: r.decision, level: person.level };
  return { verify: v, state: view() };
}
// one-shot (used by the webhook) = phase 1 + phase 2
async function checkPR({ url }) {
  const v = await verifyOnly({ url });
  return releasePR({ verify: v });
}

function view() {
  if (!S || !S.slug) return { contributors: null };
  const people = Object.values(S.people).map(p => ({ id: p.id, name: p.name, github: p.github, verified: p.verified, tokenId: p.tokenId, level: p.level, released: p.released, heldNext: p.heldAtNext ? p.level + 1 : 0, prs: p.prs || [] }));
  return {
    ladder: LADDER, contributors: people, log: S.log.slice(-40),
    summary: {
      contributors: people.length,
      total_released: people.reduce((a, c) => a + c.released, 0),
      held: people.filter(c => c.heldNext).length,
      vouch_events: S.eventsRecorded,
    },
  };
}

const server = http.createServer(async (req, res) => {
  const send = (o, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  try {
    if (req.url === "/" || req.url === "/index.html") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(PAGE); }
    if (req.url === "/api/health") { const r = await api("health", "GET", "/programs", null, true); return send({ ok: r.status === 200, status: r.status, count: (r.data?.programs || []).length }); }
    if (req.url === "/api/state") return send(view());
    if (req.method === "POST") {
      const body = await new Promise(r => { let d = ""; req.on("data", c => d += c); req.on("end", () => { try { r(JSON.parse(d || "{}")); } catch { r({}); } }); });
      if (req.url === "/api/setup") return send(await setup());
      if (req.url === "/api/reset") { S = blank(); return send(view()); }
      if (req.url === "/api/verify-pr") return send(await verifyOnly(body));
      if (req.url === "/api/release-pr") return send(await releasePR(body));
      if (req.url === "/api/check-pr") return send(await checkPR(body));
      if (req.url === "/webhook/github") {
        const pr = body.pull_request;
        if (body.action === "closed" && pr && pr.merged) {
          const url = `https://github.com/${body.repository?.full_name}/pull/${pr.number}`;
          const out = await checkPR({ url }); return send({ ok: true, ...out });
        }
        return send({ ok: true, ignored: true });
      }
    }
    res.writeHead(404); res.end("not found");
  } catch (e) { send({ error: String(e) }, 500); }
});
server.listen(PORT, () => console.log(`MeritGrant running on http://localhost:${PORT}  (program: ${SLUG})`));
