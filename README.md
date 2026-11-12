# Relay - client outreach

Website: [Relay](https://prepyr-outreach.prepyr-data.workers.dev)

## Relay and workspace controls

Click **Search prospects** to start a background search. New products, edited products and changed locations automatically generate and apply the current customer profile before searching. There are no profile-approval or Relay/workspace pause controls. Old pause settings are ignored and removed by migration. Each email still requires its own Send action.

There are **no recurring prospect searches and no campaign interval**. The minute worker advances requested work, inbox monitoring and existing conversations; it never starts a new prospect campaign. An unfinished search request expires at the UTC day boundary. Click Search prospects again on each day you want new prospects.

OpenAI discovers independent small and midsize businesses worldwide, researches their public contacts and actual workflows, and prepares a business-specific working-pilot proposal for owner review. Cloudflare hosts the app and D1 database; Gmail handles sending and inbox synchronization.

## Product workspaces

Open **Products -> Add product**. Enter its name, website, description, sender email and optional remarks. Upload up to three PNG/JPEG/WebP screenshots of 500 KB each. Remarks can specify preferred prospects, exclusions, geography, product points and email tone. OpenAI analyzes the website, supplied details and screenshots, then proposes customer types, buyer roles, qualification criteria, search scopes, uncertainties and email guidance. Click **Search prospects** to generate and apply the profile automatically and continue discovery in the background.

Use the **Product workspace** selector to switch between products and **Existing outreach**. Each product has independent prospects, conversation threads, source evidence, drafts, sender identity, daily usage and OpenAI expense ledger. A business/email can appear independently in multiple products. Replies are matched to their actual product conversation; global opt-outs block all products. Existing history stays in Existing outreach.

Each workspace defaults to **12 distinct qualified prospects per UTC day** and **60 candidate research attempts per UTC day**, including rejected candidates. Product research allowances can be raised to 100, qualified targets to 20, while actual sending stays capped at 12 total emails per UTC day. Discovery continues across replacement batches until the qualified target or a displayed research/search/provider/budget limit is reached. The $50 monthly OpenAI ceiling is retained; sufficient provider credit, evidence and budget are necessary to reach the target. Missing or guessed addresses never count.

**Prospects, Dashboard and Settings remain in the selected workspace**, including when switching products from any of those tabs. Sender name, sender email, postal address, locations, daily prospect/research/email limits, follow-ups, sending hours/weekends, offer, portfolio/pricing, monthly budget, candidates per search and service-policy confirmation are independent per product. OpenAI/Gmail/Telegram connections, deployment activation switches, billing-stop state and notification destinations are shared. Activity, expenses, exports and dashboard/prospect records are scoped to the selected workspace; the notification bell remains a shared feed.

Set **Customer targeting** when adding/editing a product or in its Settings: B2B, B2C market/distribution partners, public individual professionals/creators, agencies, startups or other. Describe the ideal customer and add targeting comments/exclusions. These settings, offer, portfolio/pricing and location selections enter every OpenAI request, from target-profile analysis through discovery, qualification and email assessment. Product location selections constrain geography while search topics remain OpenAI-derived. Worldwide rotates across countries even if the generated profile scopes initially mention a single country. Internal file formats, buying willingness and purchasing budget remain unknown unless evidenced; they are not mandatory public-proof requirements unless the owner explicitly asks for that confirmation. Private consumers are not discovered or profiled by addiction, health conditions, financial vulnerability or other sensitive personal traits; relevant organizations or professional providers may be proposed for owner approval instead.

Changes to customer targeting, locations, offer or portfolio/pricing invalidate the previous profile and revoke unsent email approvals while preserving draft text and sent history. The next Search prospects request regenerates and applies the current profile automatically. Routine numerical limit changes preserve the profile. Sender changes still require an authorized Gmail send-as identity.

Each product sender must be an accepted send-as identity in the connected Gmail mailbox. Use **Check sender** to verify it; an arbitrary From address does not authorize sending. Product-specific Google mailbox OAuth connections are not configured by merely changing the sender address.

**What you offer is workspace-specific.** Text entered under Existing outreach affects that workspace’s future targeting, qualification and email drafts. It does not change Prepyr or another product. Select the actual product before saving its offer, customer types, workflow, benefits, exclusions and pricing. Previously generated drafts keep their text until explicitly improved.

Product campaigns and qualification are inferred by OpenAI from the automatically applied profile and remarks. They do not use the legacy fixed industry/location rotation or a universal SMB filter. Product emails describe the actual product and documented terms. Set the product’s **Free offer** field to include that exact authorized offer in every initial email; the independent assessment reviews the complete email. No extra trials, discounts or custom implementation are invented. Every email still requires owner review and Send approval.

Editing product details, screenshots, remarks or sender creates a new revision. Its next requested search automatically regenerates and applies the profile. Existing draft text and sent history remain preserved; changed targeting requires reviewing or improving older drafts. Public email evidence does not verify mailbox deliverability.

The nontechnical audience rule applies during discovery, enrichment and qualification: explicit professional software-development or technical-platform-building responsibilities are a mismatch when the owner targets nontechnical users. A technical title alone is not disqualifying. This remains an evidence-based model judgment; rejected candidates never count as qualified prospects.

Search counters, product research and advanced settings use expandable details. Notifications contain the ready-email count, actionable issues and a workspace link; empty automatic digests are skipped.

## Deployment and recovery safeguards

The missing OpenAI schema migration was repaired after a full database export. All existing outreach records were retained. The obsolete one-time cutover task is disabled so it cannot replace this release later.

Deployments now regenerate per-product migration definitions, apply D1 migrations, verify required migration records/tables/columns, and only then deploy code. Each isolated product workspace also applies missing migrations transactionally. `/health` returns `schemaReady`; missing schema produces `SCHEMA_REQUIRED`, rather than being hidden as a healthy saved-copy workspace. Genuine D1 outages may still serve the read-only Existing outreach backup with a clear saved-copy label.

Product data lives in separate Cloudflare SQLite Durable Objects; product configuration and global suppressions live in D1. Workers Paid is required for the deployed configuration. Cloudflare usage beyond included allowances can incur additional charges.

Evidence and validation artifacts are local under `artifacts/`; database exports contain personal/business data and should remain private. `artifacts/products-live-validation.json` records the bounded real-provider, no-send validation. A failed or uncertain validation is not completion and must be investigated without replaying unknown paid requests.

## Research and review in Existing outreach

1. **Search prospects** queues a durable OpenAI search for each selected location. Worldwide selection rotates industries and locations. The maximum is ten candidates per search; supported independent SMBs are imported and deduplicated. Chains, uncertain identity/size and weak evidence stay in the search review record.
2. Public-email research starts with official pages, then permits one bounded corroboration pass. Emails must occur literally in the saved report and quoted excerpt and have a consulted source URL. Missing emails remain missing; conflicting identities/shared recipients require review.
3. Business research gathers multiple pages across at least two registrable domains. A dossier separates observed facts, strengths, hypotheses, unknowns and contradictions.
4. Solution design chooses one small workflow with concrete inputs, actions, outputs, access needs, scope and an intended measurable benefit. The offer is a free 30, 45 or 60 day working software pilot after agreement. No invented losses, missing systems or guaranteed outcomes.
5. A separate assessment holds generic, unsupported or infeasible drafts. Contact and research evidence are available inside the prospect. Public sourcing does **not** establish mailbox deliverability; the owner must document recipient review and eligibility before sending.
6. **Open email -> Send** saves and approves the exact version. Sender/recipient/content changes invalidate approval. Existing edits, approvals, sent history and suppressions are preserved; existing drafts are not bulk rewritten. Replies stop follow-ups; opt-outs and bounces suppress the address.

The qualified-prospect target and actual sending limits are separate. Only distinct qualified recipients with complete, sourced drafts count toward the prospect target. Rejected or duplicate candidates trigger replacement research within the independent candidate-attempt allowance. Search progress shows qualified count, research attempts, rejections, searches and any limiting reason.

## Spending and durable work

Click **Search prospects** to search on demand. No discovery interval or automatic campaign switch is used. The saved budget still applies to requested searches and their background research.

Each product workspace has its own **$50 maximum OpenAI allowance per UTC calendar month**, shared across that product's discovery, extraction, product/screenshot analysis, contact research, business research, solution design, drafts, follow-ups and replies. Existing outreach retains its own historical ledger and allowance. Acquisition stages use up to 90% of it, keeping the remaining headroom for existing conversations. A conservative reservation is made before each request and reconciled with usage afterward. The provider invoice remains authoritative; Relay cannot see unrelated applications spending on the same key.

Provider responses, request/response IDs and stage outcomes are saved before downstream parsing. Completed stages resume without another provider call. Unknown outcomes retain their reservation and are never silently replayed. Definitive rate/quota rejections require an explicit retry after the underlying problem is corrected; malformed or incomplete saved output remains held for inspection. A deliberate retry may run one separately metered structured-extraction repair from the saved evidence; it does not repeat successful search. Budget pauses resume when enough allowance is available. Optional Apify discovery and verified professional work-email enrichment follow the same durable checkpoint and budget rules.

The Workers Paid deployment advances up to **three checkpoint stages per scheduler cycle per enabled workspace** (`AI_STAGES_PER_CYCLE=3`), with no overlapping scheduler for that workspace. Each checkpoint makes at most one paid call; previously completed calls replay from cache. Installations without this setting retain the single-stage default and its tested 50-query bound. Discovery imports remain bounded to three candidates per checkpoint. Inbox/dispatch processing takes priority. Daily and monthly limits still apply. See [D1 invocation limits](https://developers.cloudflare.com/d1/platform/limits/) and [scheduled execution limits](https://developers.cloudflare.com/workers/platform/limits/).

A confirmed OpenAI credit/billing rejection now stops further AI work across the shared key immediately. Unspent definitively rejected research claims are released; successful or uncertain paid work keeps its accounting. The stop survives restarts. After funding the actual OpenAI project used by Relay, choose **I updated OpenAI billing** in Settings, then deliberately retry affected tasks. This does not resume workspaces, retry uncertain requests, or verify the balance through a paid test.

Contact fallback runs when evidence is unsupported, not only when the model returns an empty address. Formatting-normalized exact excerpts are accepted without fuzzy paraphrase matching. Missing contacts get one extraction from the later saved business report, without another search; guessed addresses, conflicting identities and unrelated directory mailboxes remain blocked.

Solution review uses OpenAI to distinguish material conflicts from warnings. A statement that no contradiction was found, an irrelevant detail discrepancy or unknown internal systems no longer automatically blocks an otherwise evidenced proposal. Source/quote/identity requirements remain enforced, snippet provenance is preserved, and one bounded saved-evidence repair is allowed. Real evidence gaps remain held with a specific reason. Existing held drafts are never bulk cleared or sent. Prospect status includes the latest job state/error, so stopped jobs no longer appear to be actively finding a contact.

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
# Existing production install with no local runtime secrets:
# npm run deploy -- --existing-secrets
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

## Email-first, product-specific discovery

New searches first establish a published business email with an exact source quote
and a product-relevant workflow. Candidates without both stay in search history;
they do not consume a business-enrichment slot or appear as qualified prospects.
A source-proven contact is reused during enrichment instead of searched again.
Published addresses still have unknown mailbox deliverability.

Product profiles now contain specific buyer workflows, supported capabilities with
source evidence, observable fit signals, poor-fit signals and focused search
phrases. Discovery and independent enrichment must map facts to one of those
supported use cases; an industry label alone is insufficient. The email review
shows the observed workflow, matching product capability, source and unknowns.
Older unsent product drafts are held for renewed fit review, preserving their text
and sent history. Open Settings → Earlier drafts to reassess to review them after
the profile refresh; Improve this email rechecks their fit. Profiles regenerate automatically on the next Search prospects
request. Search and monthly budget limits remain in force.

The separate [agentic search research](AGENTIC_SEARCH_RESEARCH.md) proposes an
experiment and evaluation criteria. It does not implement an agent architecture.

## LinkedIn and OpenAI discovery

Select **LinkedIn via Apify + OpenAI** in the workspace Settings to combine public professional-profile discovery with OpenAI company research, product-fit assessment and drafting. OpenAI-only mode remains available. Searches start only from Search prospects; there is no recurring Apify schedule.

Add `APIFY_TOKEN` as a **Secret** under Cloudflare → Workers & Pages → `prepyr-outreach` → Settings → Variables and Secrets, then save/deploy. For local development only, put it in the ignored `.dev.vars` file. Never put tokens in Git, a URL or the browser preferences form. A browser login or ChatGPT MCP connection does not authenticate the deployed Worker. Check connections verifies the token without starting a paid actor.

The integration uses `harvestapi/linkedin-profile-search`, build `0.0.298`, in Full mode: up to 25 public professional profiles per bounded run. For startup targeting, OpenAI first finds current startup companies and sourced LinkedIn company URLs; Apify uses its current-company filter so past startup employment does not drive the pool. Role and sector angles rotate without a size or founder-only filter. It preserves profile-source text and run provenance, then researches current employment, relevant responsibilities, geography and public business email evidence. Enriched email fields are never treated as publicly sourced email. With the explicit **Allow verified professional work-email enrichment** preference, Relay separately runs `harvestapi/linkedin-profile-scraper` build `0.0.141` for at most six researched professionals and `thirdwatch/email-verifier` build `2.0.12` for independent per-address checks. Only work addresses matching the current company, with a valid SMTP result and no catch-all, disposable, free-provider or role-mailbox flags, qualify. The saved record retains both run IDs, verification details and timestamp. These contacts are labeled **Work email verified (Apify)**. Unknown or risky results are rejected. Neither public evidence nor verification guarantees future delivery.

Each workspace has an Apify monthly budget (default $10) and per-run cap (default $1), separate from OpenAI. Submitted run IDs and completed results are persisted. Uncertain submissions stop for reconciliation rather than creating duplicate paid runs. Failed actors are visible in Activity; no silent fallback claims that LinkedIn worked. Provider invoices remain authoritative.

Recurring reports, fixed reporting cadence, founder status, small company size and documented pain are not universal qualification rules. Relevant professional responsibilities or data-related business activity can establish plausible fit; identity, source evidence and actual product capabilities remain required. Technical proficiency, internal files and buying intent remain unknown unless evidenced.

`scripts/prepyr-targeting.json` records the owner-authorized Prepyr description, targeting and bounded free first-dataset offer. It is release input, not a startup migration: ordinary deployments never overwrite owner edits.
