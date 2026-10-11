# CLAUDE.md — training (سامانه آمادگی)

Persian (RTL) readiness-assessment demo. The product spec is `PRD (1).md`; the original clickable prototype is the bundled `سامانه ارزیابی آمادگی (2).html`.
`readiness-demo-kit (1).zip` holds the PRD, question bank (`data/question-bank.json`), scoring test vectors and reference screenshots.

## Live version (`live/`)
`live/server.js` serves the prototype with state in SQLite, real login and server-side RBAC. Node built-ins only (`node:sqlite`, Node 22+); no `npm install`.

```
cd live
node server.js        # http://localhost:3002  (PORT env var overrides)
```

- `live/source.html` is a copy of the original bundle. **Never edit it by hand.** `server.js` patches it in memory at startup (`buildPage()`), so the original stays untouched.
- The bundle's template is a JSON string: injected code must be JSON-escaped (the `swap()` helper does this, anchors containing quotes are matched in escaped form). Raw newlines or quotes break the page with "Error unpacking".
- `swap()` replaces the first match, so rename old methods (`login` → `loginDemo`) before injecting new ones with the same name.
- The question bank and the scoring module are read from the bundle at startup, so server and UI always use the same data. The server recomputes the finalized-results snapshot itself.

## Auth
- `POST /api/login` → HttpOnly, SameSite=Strict cookie; sessions are stored (hashed) in the `sessions` table, expire after 12 h and survive restarts. 8 failed attempts → 1 minute lock per IP. Passwords are scrypt-hashed in `credentials`.
- Credentials: `admin` / `admin` (change it with the «رمز» button next to logout; min 8 chars; also ends the user's other sessions). Other demo users and newly created users: `Demo@1234`. Admin can reset a user's password to that from the users page.
- Deactivated users cannot log in and their sessions stop working immediately. `admin` cannot be deactivated.
- Writes with an `Origin` header from another host are refused.

## RBAC (enforced in `server.js`, not in the UI)
Client still PUTs its whole view to `/api/db`, but the server only accepts what the role may change and rebuilds everything from validated parts:
- **ASSESSEE**: sees own company/assessment only; reviews, comments and snapshot are stripped until `FINALIZED`. May change responses/evidence of own assessment while `DRAFT`; submitting requires every question answered (409 otherwise). Read-only afterwards.
- **ASSESSOR**: sees only assigned, non-draft assessments (+ their companies/users). May set decisions/comments (never remove them) on `SUBMITTED/IN_REVIEW/READY_TO_FINALIZE`; status moves are computed by the server; finalizing needs all questions scored. `FINALIZED` is immutable.
- **ADMIN**: sees everything; may add companies/users, activate/deactivate, create assessments (one per company), reassign assessor before finalization. Cannot edit answers/reviews. `POST /api/reset` wipes everything (admin only) and the next PUT re-seeds the demo data.
- While the database is empty only `admin` can log in (it seeds the demo data on first login).

## Evidence files
Uploaded via `POST /api/files` (assessee, own `DRAFT` assessment): extension whitelist + magic-byte check, ≤ 50 MB, ≤ 10 per question, random stored names in `live/uploads/` (never served statically). Download via `GET /api/files/:id` only for the owning assessee, the assigned assessor (non-draft) and admin. Evidence entries in a PUT that don't match an uploaded file are dropped; unreferenced files older than 10 min are deleted. Demo "sample" files have no content.

## Data
`live/readiness.db`: `companies`, `users`, `assessments`, `credentials`, `sessions`, `files`. State tables are rewritten in one transaction on every accepted PUT.

## Known limits
- Concurrency is last-write-wins per assessment; two admins editing at once can overwrite each other's user/company edits.
- Login lockout is per IP and in memory.
- Plain HTTP only; put it behind HTTPS and add the `Secure` cookie flag before exposing it beyond localhost, and change `admin`/`admin`.
- Demo tools (autofill, auto-score) are still in the UI for all roles; the server validates what they produce but they are not PRD-gated by `DEMO_MODE`.

## Rules from the PRD to keep in mind
- UI text is Persian only; numbers are shown with Persian digits.
- Do not invent scoring rules, thresholds or weights (PRD §6). Never hand-edit `question-bank.json`.
