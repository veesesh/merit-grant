# MeritGrant

Contribution-verified grants. Contributors earn funding by shipping real work: paste a merged GitHub PR, and if it checks out, the author is enrolled on [Vouch](https://api.programmablevouchers.com) and the next funding level is released.

Nothing is mocked. The PR checks hit the live GitHub API, and the funding runs against the live Vouch API.

## How it works

**1. Verify the contribution (GitHub API)**

| Check | Source |
| --- | --- |
| PR is actually merged | `GET /repos/{owner}/{repo}/pulls/{n}` |
| An AI tool co-authored the commits | `Co-authored-by:` trailers in the PR's commits |
| Author is a real person | account age and public repo count |

**2. Fund it (Vouch API)**

The author is enrolled as a Vouch beneficiary, the milestone is recorded as a real oracle event, and a level is released.

| Level | Milestone | Amount |
| --- | --- | --- |
| 1 | Onboarded | $10 |
| 2 | First PR | $20 |
| 3 | 3 PRs | $30 |
| 4 | Capstone | $50 |

## Design notes

**A PR can only ever fund once.** Every credited PR is keyed `owner/repo#number`. The key is the PR's identity, not the submitter, so nobody can claim someone else's PR twice.

**Vouch is the system of record.** Each oracle event carries the full outcome, so the ledger and the funded contributors are rebuilt from Vouch on startup. A restart cannot resurrect spent budget or lose the board.

**Verification is split into two phases** so the UI stays responsive: the GitHub checks return in about a second, then the slower Vouch enrolment runs.

## Run it

Requires Node 18+. There are no dependencies.

```bash
cp .env.example .env      # then add your Vouch API key
VOUCH_API_KEY=sk_test_... npm start
```

Open http://localhost:4319, click **Initialize program**, then paste any merged, AI-co-authored PR URL.

## Deploy

A single Node process serving one static page, so anything that runs Node works. Set `VOUCH_API_KEY` (and ideally `GITHUB_TOKEN`) as environment variables, and bind to the platform's `PORT`, which the server already reads.

## GitHub webhook (optional)

Instead of pasting URLs, point a repo webhook at `POST /webhook/github` with content type `application/json` and the **Pull requests** event. A merged PR then drives the same flow automatically.

## API

| Endpoint | Purpose |
| --- | --- |
| `POST /api/verify-pr` | GitHub checks only, no writes |
| `POST /api/release-pr` | Enrol on Vouch and release a level |
| `POST /api/check-pr` | Both phases in one call |
| `GET /api/state` | Current program state |
| `GET /api/health` | Vouch connectivity |

## Scope

Everything in the app is real: the PR checks hit the GitHub API, and enrolment, the milestone ledger, and the audit trail all run on Vouch.

Two pieces are deliberately absent because the sandbox key cannot reach them. The level ladder lives in this app rather than in a Vouch **policy** (`team_mismatch` on policy creation), and there is no metered spend, which needs the `ai_compute` scope. Both are scope unlocks, not missing work.
