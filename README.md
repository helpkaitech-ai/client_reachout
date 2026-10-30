# Relay - client outreach

Website: https://prepyr-outreach.prepyr-data.workers.dev

## Outreach pause and discovery controls

Outreach is paused indefinitely until the owner uses **Resume outreach** in the top bar. This blocks paid OpenAI work, discovery, product analysis, follow-up/reply drafting, external status messages and prospect sending, including previously approved queued emails. Existing records and approvals are retained. Passive inbox monitoring and in-app reply notifications remain available. The pause has no automatic expiry.

Each prospect workspace has a separate **Resume discovery / Pause discovery** control. Resuming the overall program leaves currently paused discovery paused. Enable only the desired workspace's discovery; approved product targeting is still required. Automatic searches use a **six-day interval**, measured from the previous search start, and still respect the research backlog and spending limits. New products start with discovery paused. The previous three-day schedule and timed hold are superseded. Pausing discovery alone allows existing business research and approved outreach to continue; pausing outreach stops those too. Settings forms cannot override the dedicated pause controls.

OpenAI discovers independent small and midsize businesses worldwide, researches their public contacts and actual workflows, and prepares a business-specific working-pilot proposal for owner review. Cloudflare hosts the app and D1 database; Gmail handles sending and inbox synchronization.

## Product workspaces

Open **Products -> Add product**. Enter its name, website, description, sender email and optional remarks. Upload up to three PNG/JPEG/WebP screenshots of 500 KB each. Remarks can specify preferred prospects, exclusions, geography, product points and email tone. OpenAI analyzes the website, supplied details and screenshots, then proposes customer types, buyer roles, qualification criteria, search scopes, uncertainties and email guidance. Review the actual profile and choose **Approve target profile & enable searches** before prospect searches begin.

Use the **Product workspace** selector to switch between products and **Existing outreach**. Each product has independent prospects, conversation threads, source evidence, drafts, sender identity, daily usage and OpenAI expense ledger. A business/email can appear independently in multiple products. Replies are matched to their actual product conversation; global opt-outs block all products. Existing history stays in Existing outreach.

Each product has a maximum of **20 newly imported and 20 distinct researched businesses per UTC day, 12 total prospect emails per UTC day (initial messages, follow-ups and replies combined), and $50 OpenAI spending per UTC month**. Lower limits are configurable in that workspace's Settings. Four fully used products can therefore use up to $200/month OpenAI, separately from hosting and mailbox charges. Provider account credit and rate limits still apply across the shared OpenAI account.

Each product sender must be an accepted send-as identity in the connected Gmail mailbox. Use **Check sender** to verify it; an arbitrary From address does not authorize sending. Product-specific Google mailbox OAuth connections are not configured by merely changing the sender address.

Product campaigns and qualification are inferred by OpenAI from the approved profile and remarks. They do not use the legacy fixed industry/location rotation or a universal SMB filter. Product emails describe the actual product and documented terms; they do not automatically offer custom consulting, free work or a standard pilot. Every email still requires owner review and Send approval.

Editing product details, screenshots, remarks or sender creates a new revision and requires renewed target-profile approval. Existing draft text is preserved, unsent approvals are revoked and drafts are held for review/improvement. Sent messages remain unchanged. Pausing a product stops its scheduled research/sending. Customer profiles, public contacts and proposed benefits still require owner judgment; public email evidence does not verify mailbox deliverability.

## Deployment and recovery safeguards

The missing OpenAI schema migration was repaired after a full database export. All existing outreach records were retained. The obsolete one-time cutover task is disabled so it cannot replace this release later.

Deployments now regenerate per-product migration definitions, apply D1 migrations, verify required migration records/tables/columns, and only then deploy code. Each isolated product workspace also applies missing migrations transactionally. `/health` returns `schemaReady`; missing schema produces `SCHEMA_REQUIRED`, rather than being hidden as a healthy saved-copy workspace. Genuine D1 outages may still serve the read-only Existing outreach backup with a clear saved-copy label.

Product data lives in separate Cloudflare SQLite Durable Objects; product configuration and global suppressions live in D1. Workers Paid is required for the deployed configuration. Cloudflare usage beyond included allowances can incur additional charges.

Evidence and validation artifacts are local under `artifacts/`; database exports contain personal/business data and should remain private. `artifacts/products-live-validation.json` records the bounded real-provider, no-send validation. A failed or uncertain validation is not completion and must be investigated without replaying unknown paid requests.

## Research and review in Existing outreach

1. **Find prospects** queues a durable OpenAI search for each selected location. Worldwide selection rotates industries and locations. The maximum is ten candidates per search; supported independent SMBs are imported and deduplicated. Chains, uncertain identity/size and weak evidence stay in the search review record.
2. Public-email research starts with official pages, then permits one bounded corroboration pass. Emails must occur literally in the saved report and quoted excerpt and have a consulted source URL. Missing emails remain missing; conflicting identities/shared recipients require review.
3. Business research gathers multiple pages across at least two registrable domains. A dossier separates observed facts, strengths, hypotheses, unknowns and contradictions.
4. Solution design chooses one small workflow with concrete inputs, actions, outputs, access needs, scope and an intended measurable benefit. The offer is a free 30, 45 or 60 day working software pilot after agreement. No invented losses, missing systems or guaranteed outcomes.
5. A separate assessment holds generic, unsupported or infeasible drafts. Contact and research evidence are available inside the prospect. Public sourcing does **not** establish mailbox deliverability; the owner must document recipient review and eligibility before sending.
6. **Open email -> Send** saves and approves the exact version. Sender/recipient/content changes invalidate approval. Existing edits, approvals, sent history and suppressions are preserved; existing drafts are not bulk rewritten. Replies stop follow-ups; opt-outs and bounces suppress the address.

The configured limits are 20 distinct businesses researched per UTC day and 12 total prospect emails per UTC day, including initial emails, follow-ups and replies. The initial-email cap is also 12. These are ceilings, not guaranteed output. Deep research, public-source availability, the monthly cap and hosting limits determine actual draft yield.

## Spending and durable work

Automatic discovery runs at most once every **six days per workspace** while both the overall program and that workspace discovery are enabled. It also waits for active searches, the backlog and spending limits. Use the pause/resume controls above; the former timed three-day hold and its one-time command are retired.

Each product workspace has its own **$50 maximum OpenAI allowance per UTC calendar month**, shared across that product's discovery, extraction, product/screenshot analysis, contact research, business research, solution design, drafts, follow-ups and replies. Existing outreach retains its own historical ledger and allowance. Acquisition stages use up to 90% of it, keeping the remaining headroom for existing conversations. A conservative reservation is made before each request and reconciled with usage afterward. The provider invoice remains authoritative; Relay cannot see unrelated applications spending on the same key.

Provider responses, request/response IDs and stage outcomes are saved before downstream parsing. Completed stages resume without another provider call. Unknown outcomes retain their reservation and are never silently replayed. Definitive rate/quota rejections require an explicit retry after the underlying problem is corrected; malformed or incomplete saved output remains held for inspection. A deliberate retry may run one separately metered structured-extraction repair from the saved evidence; it does not repeat successful search. Budget pauses resume when enough allowance is available. No alternative discovery/enrichment provider is used.

The scheduler performs at most one paid stage per minute, imports at most three discovered candidates per invocation, pages one new inbox message per cycle, and separates dispatch/inbound processing from paid research. Completed contact/dossier results are checkpointed to avoid repeated writes. Indexes reduce queue and history scans. These protections bound tested invocation queries; Cloudflare's separate daily row allowances and CPU limits still require live observation. No hosting upgrade has been purchased.

## Gmail identity

The top-right notification bell shows unread replies, automatic replies, bounces, opt-outs and prepared follow-up drafts across all product workspaces. Notifications persist between logins; click one to mark it read and open the matching prospect, or use **Mark all read**. Gmail inbox sync runs on the minute scheduler and the notification dropdown refreshes every 30 seconds while Relay is visible. Delivery acceptance remains **Sent**; Relay does not claim inbox delivery or email opening. A reply, bounce, automatic response or opt-out stops the follow-up sequence, and a human reply queues a response draft for owner review.

Assessment calls reserve 1,600 output tokens, including reasoning headroom: the API output limit includes reasoning as well as visible JSON ([OpenAI documentation](https://developers.openai.com/api/docs/guides/reasoning)). A deliberate retry of a stored incomplete assessment uses the saved draft and research and makes only one separately metered assessment repair; it does not repeat completed discovery or email generation.

Follow-up drafts are prepared automatically after a send, ahead of their due dates. **Open Follow Up** opens the next draft and shows its due date and sequence number. The default schedule is days **4, 10 and 18**, with a hard maximum of **three follow-ups**. The offsets imply gaps of 4, 6 and 8 days after actual sends, so delayed approvals do not bunch messages together. Owner approval is required for each draft; early approval schedules it for its due date. A fresh thread check before dispatch stops sending if an incoming message is found. Existing source evidence, product details, remarks and the prior conversation inform each OpenAI draft. Configured daily email and monthly OpenAI limits continue to apply.

**Improve this email** works for introductions, follow-ups and replies. It supplies the current draft and its quality issue to OpenAI, preserves the conversation kind and follow-up due date, and leaves the revised version unapproved. Access to internal systems or customer data must remain conditional on future agreement and authorization.

The previously verified mailbox is `data@prepyr.com`; `rushi@prepyr.com` is its configured sending alias. Sign into the underlying Google Workspace mailbox to view Sent mail. An alias is not a separate Google login. The migration preserves the existing OAuth connection and sender settings; sender authorization was checked in live release validation.

## Development and deployment

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

Configuration keys are listed without credentials in `.env.example`. Keep `.env` private. `npm run doctor` checks required field presence without calling paid services. `npm run setup` prepares a new installation; do not recreate an existing production database or secrets to perform this migration.

For a new Gmail connection, enable Gmail API in Google Cloud, configure the OAuth consent audience and authorized local callback shown by `npm run google:auth`, then authorize the underlying business mailbox. The connection needs sending, read-only inbox access and sender-alias settings access. External OAuth projects left in Testing can have expiring refresh tokens; configure the intended production audience accordingly.

`npm run deploy` applies migrations, deploys code, uploads the active local runtime secrets and removes obsolete Worker provider secrets. The previous one-time cutover is obsolete. Take a backup before production changes and use the schema-verified deployment script. `npm run smoke:hosted` performs authenticated hosted checks without sending prospect emails.

Optional local development: copy runtime settings into ignored `.dev.vars`, keep sending/notification activation false, run `npm run db:local`, then `npm run dev`. Never use real recipient sending to test research changes.

## Recovery

Use Settings -> Activity & costs in the relevant product workspace. Unknown OpenAI request outcomes retain their reservations; uncertain Gmail sends require Sent-mail reconciliation. Never delete an expense or replay an unknown request to bypass a hold. A failed structured extraction can be repaired from its saved search; unsupported evidence remains held instead of fabricating prospects.

The production pre-repair export is `artifacts/pre-products-live.sql`. Preserved-record checks are recorded in `artifacts/products-release-verification.json`; these artifacts contain or reference private business data. The prior one-time cutover scripts and schedule are historical and must not be used for the current release.

```powershell
npm run check
npm run deploy
node scripts/verify-schema.mjs
npm run smoke:hosted
```

Deployment applies and verifies migrations before publishing code. Product stores independently apply missing migrations on initialization. If the API reports `SCHEMA_REQUIRED`, finish the required schema deployment; do not mask the error or mark the release complete.

## Authentication availability

Login throttling and 12-hour sessions use the separate SQLite-backed `RelayAuthStore` Durable Object, not D1. Its binding and `auth-v1` migration are deployed with the Worker; no D1 migration or secret rotation is needed. Existing D1 sessions require one fresh login after rollout. Logout revokes the stored session immediately. Authentication fails closed if its own storage is unavailable.

`GET /api/session` validates authentication without accessing workspace data. D1 daily-limit errors return HTTP 503 with `DATABASE_DAILY_LIMIT` and a reset time. When a verified workspace backup exists, the UI opens its saved prospects, complete drafts and email history, dashboard filters, previews and settings in read-only mode, with a visible capture time. If no saved copy exists, it shows the availability message. Live changes and sending require restored D1 access.

Authentication checks: `npm run smoke:auth` verifies hosted login, independent session validation, logout revocation, and the UI without sending emails or calling paid providers. It accepts either healthy workspace data or the explicit database quota response. For an isolated reproduction, run `npx wrangler dev --config tests/auth-runtime.wrangler.jsonc --local --port 8791 --persist-to .wrangler/auth-isolated`, then `npm run smoke:auth:local`. This fixture injects the production D1 quota error and uses local-only credentials.

## Workspace access during D1 outages

`WorkspaceBackup` is a separate SQLite-backed Durable Object containing only the ten workspace-view tables listed in `src/workspace-schema.ts`. It excludes login sessions, attempts, integration state and credentials. Every saved read remains authenticated. The app falls back on D1 errors and exposes capture time/read-only status; it keeps search, pagination, dashboard filters, email bodies/history, previews and saved settings accessible. Mutations are disabled in the UI, and the saved database adapter rejects writes. A failed, invalid or older refresh cannot replace the active copy. There is no fallback that fabricates empty records or marks emails as sent.

The existing scheduled worker attempts a checkpoint at most every five minutes, after its normal cycle. Checkpoints copy the workspace tables transactionally, write only changed records, and retain the last successful copy if D1 is unavailable. The capture time shows the exact freshness of that copy. UI dashboard requests omit redundant complete email datasets and refresh once per minute; saved-mode refreshes are limited to once per five minutes.

For the approved outage recovery, `npm run backup:import` loads `artifacts/relay-workspace-records.sql` into the protected backup through an authenticated, same-origin import, verifies all table counts and a SHA-256 digest, and logs no private record contents. Production D1 is never restored or overwritten by this operation. Keep the SQL recovery file private. The streamed import accepts only workspace columns/tables and publishes the replacement atomically. Regenerate the schema after future D1 schema changes with `npm run backup:schema`.

`npm run smoke:workspace` requires usable pages; a 503 does not count as success. It checks every recovered prospect detail, all draft bodies and previews, fetched email history, all dashboard filters, full pagination/search, saved settings, UI navigation/reload, export integrity, origin protection and logout revocation. Evidence is saved in `artifacts/workspace-hosted-smoke.json` without email content. The isolated local fixture deliberately throws the production D1 quota error; its real-browser screenshots are in `output/playwright/relay-outage-*.png`.
