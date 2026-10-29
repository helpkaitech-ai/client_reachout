# Relay: OpenAI-only discovery, contact research and personalized outreach

Date: 2026-10-28, Asia/Kolkata  
Workspace: `D:\NymbarkAIProjects\client_reachout`  
Status: Deployed and verified, 2026-10-30. The required production schema is repaired; product workspaces and real OpenAI discovery/drafting passed validation.
Update: The owner upgraded to Workers Paid. The obsolete one-time cutover is disabled. Current product requirements supersede this original migration design: each product has its own 20-lead/12-email daily ceilings and $50 monthly OpenAI allowance, owner-approved AI targeting, configurable authorized sender, screenshots and remarks. Existing outreach is preserved separately. See README and `artifacts/products-release-verification.json` for the current release and evidence; earlier migration artifacts remain historical checkpoints.

## 1. Decisions confirmed by the owner

| Decision | Confirmed choice |
| --- | --- |
| Total OpenAI allowance | **$50 per calendar month**, shared by discovery, extraction, contact research, business research, solution design, drafts, follow-ups and replies. No transfer of the former Apify allowance. |
| Apify | Completely remove from the active application. No runtime fallback to Apify. |
| Hunter | Remove both contact discovery and deliverability verification. Use public email evidence and owner recipient review. |
| Target businesses | Prioritize **independent small and midsize businesses worldwide**. Keep the existing location selection and country/city rotation. |
| Daily limits (owner update) | **20 distinct businesses researched/day; 12 total prospect emails/day**, including initial messages, follow-ups and replies. Initial messages also have a 12/day ceiling. Quotas reset at UTC midnight. |
| Implementation now | Owner subsequently authorized implementation, complete provider removal, thorough testing and production cutover. |

Preserve the current sender, Gmail connection, owner approval before sending, suppressions, history and 30/45/60-day working-pilot offer policy. Existing unsent drafts are not automatically rewritten or reapproved. These preservation choices avoid spending the new allowance on unsolicited bulk rewrites.

No further product decision blocks the initial implementation plan. Model/tool compatibility, actual yield and measured cost remain implementation validation gates, not assumptions of success.

## 2. Outcome and important limits

The finished pipeline should find a real business, establish its identity, locate its public business email where available, understand its actual operations, identify one plausible opportunity, and prepare a highly specific email offering a bounded working solution.

OpenAI will be the only external discovery, enrichment and reasoning provider. Cloudflare remains the hosting/database platform; Gmail remains the sending/inbox provider; existing owner notifications remain. Replacing the discovery provider does not replace these infrastructure services.

The target is researched opportunities suitable for owner review, rather than an arbitrary number of scraped business rows. A search request for ten businesses may return fewer useful businesses. A business without a supported public email can still have a research record, but cannot become send-ready. Neither an LLM confidence score nor a website citation proves that a mailbox accepts email.

OpenAI search is not an exhaustive directory export or guaranteed crawler. Inaccessible pages, unindexed contacts, obsolete listings, poorly documented companies and conflicting identities must produce visible limitations. Do not invent email patterns, fabricate business problems, bypass access controls, or promise that every prospect will be contactable.

## 3. What the current code actually does

Findings below are from the checkout inspected for this plan. Existing artifacts are historical checkpoints, not a fresh claim about production counts.

| Area | Current behavior | Required change |
| --- | --- | --- |
| `src/discovery.ts` | Launches an Apify Google Places Actor, reserves its charge cap, polls its dataset, imports public contact fields; also owns generic lead import and search-history helpers. | Replace Actor submission/polling with OpenAI discovery stages. Extract reusable import/normalization helpers first. |
| `src/research.ts` | Already uses OpenAI Responses web search for individual business research, a bounded second pass for weak evidence, and structured generation for the draft and working pilot. | Keep useful prompt policies; add explicit business/contact/fact/opportunity records and independent validation stages. |
| `src/providers.ts` | Uses `gpt-5.4-mini` for research and `gpt-5.6-sol` for synthesis; four tool calls and 2,800 output tokens on search requests; 110-second request timeout; `store:false`. | Introduce stage-specific limits, request tracking and revised usage accounting. Do not assume changing the provider name is sufficient. |
| `src/engine.ts` | Gates discovery on `APIFY_TOKEN`, manages Actor runs and general jobs; Hunter performs domain search and email verification. | Gate all research/discovery on OpenAI, schedule explicit resumable stages, remove Hunter jobs and calls. |
| `src/index.ts` | Discovery, sync, run attachment, connections and dashboard expose Apify-specific behavior. | Preserve useful discover/status routes, replace their implementation, retire Actor-ID attachment. |
| `src/locations.ts` | Rotates industries across the selectable worldwide catalogue and saved location selections. | Reuse location scheduling; add evidence-based target-fit checks and bounded query variation. |
| Settings and UI | Expose Apify caps, Hunter connection and provider-specific run history. | Show one OpenAI budget, search/research status and concise reasons for holds. |
| Schema | `runs` and `expenses` contain historical provider information; leads lack normalized field-level provenance. | Add new evidence/task data without deleting history or reinterpreting legacy Actor IDs as OpenAI response IDs. |

The recent 88-draft plateau was a backlog/scheduling defect, not proof that Apify alone caused the stall. The replacement must retain the corrected rule: **businesses already drafted and waiting for owner review do not count as unfinished research backlog**. It must also preserve atomic job claims, conservative cost reservations and no blind replay of uncertain paid work.

Existing exact-email uniqueness and domain/company/city deduplication are useful but insufficient for discovery across several public sources. Business identity, shared chain contacts and evidence freshness need explicit treatment.

## 4. Proposed end-to-end flow

```text
Saved locations + target profile + search history
    -> bounded OpenAI business discovery
    -> schema extraction and identity/deduplication checks
    -> public contact research for each accepted business
    -> deeper business/workflow research
    -> solution selection from supported facts
    -> short personalized draft + quality assessment
    -> owner recipient/content review
    -> existing Gmail send flow
```

Each arrow is a durable checkpoint. Some adjacent low-cost transforms may share a request after testing, but do not combine the entire pipeline into one long, uncheckpointed paid request. Start with one paid stage per job invocation and small measured concurrency; tune only from observed runtime and cost.

### Stage A: Select a search scope

1. Reuse saved country/region/city selections and worldwide rotation.
2. Pick an industry and a city using persisted search history, including useful-yield and duplicate-rate information.
3. Use a deterministic query plan: core service plus city; a related service phrase; then a bounded alternative if yield is poor. Queries may use public directories, trade associations and independent business sites through OpenAI search.
4. Default initial target: **up to ten candidates per bounded discovery batch**, subject to benchmark results and budget. This replaces the Actor's 80-row target; it is not an equivalent completeness guarantee.
5. Treat repeat clicks as the same in-progress search. A new campaign/variation requires a distinct recorded intent, not an automatic paid retry after a lost response.

Prefer owner-operated and independent firms with an identifiable product/service and a workflow one builder could improve. Exclude large national chains by default; also filter out directories posing as companies, duplicates, clearly closed businesses and businesses outside the requested scope. Size and independence require evidence; if unknown, mark unknown instead of manufacturing employee/revenue figures.

### Stage B: Discover and normalize candidates

Use Responses API hosted web search to gather candidate identities and source metadata. Then parse candidates into a strict schema, using a separate extraction request if the selected model/tool combination cannot reliably combine search and schema output. Schema validity and factual accuracy are separate gates.

Each candidate must carry:

- Business name, official website/domain where established, location, country and likely industry.
- A short description of the actual product/service and customer type.
- Target-fit status: independent/chain/unknown; small-or-midsize/unknown; supporting evidence.
- Business source URLs, when retrieved, and which fields each source supports.
- Contact details only if publicly observed; absent fields are null/empty with a reason.
- Query, campaign, model, prompt version, request/response references and extraction status.

Normalize names, websites, redirects known from evidence, email case, country and timezones. Keep timezone resolution deterministic from known location data; do not trust arbitrary model-generated timezone strings.

Deduplicate by canonical business identity plus locality, supported domain relationships and normalized email. Use proper registrable-domain handling rather than taking the last two hostname labels. A shared domain is not always the same branch; a shared recipient address must not produce repeated outreach for several branches. Ambiguous merges require review. Never overwrite an owner-edited recipient or existing sent conversation during import.

### Stage C: Find a supported public business email

1. Search the identified business's official contact/about/team/service pages using OpenAI. Start with the confirmed domain, then expand to a corroborated business association/directory only if needed.
2. Extract the **exact address**, source URL, a short supporting excerpt, source type, observation time and business association. Do not guess `firstname@domain`, concatenate likely patterns, or treat an example address as a contact.
3. Prefer a relevant public business contact. Avoid personal/private addresses and mailboxes intended for privacy, abuse, billing, careers or automated messages. A public free-mail address may be valid for a small business if its association is well supported.
4. Distinguish evidence from a full opened page, a search excerpt and an indirect claim. Snippet-only evidence is lower confidence and requires review or another bounded pass.
5. Confirm the contact still belongs to the correct business/location. Conflicting, stale or reassigned-domain evidence creates a hold.
6. If no suitable address is found within the allowed effort, record `no_public_email`. Keep the business and research; do not spend on an indefinite search loop or create a guessed recipient.

Contact extraction returns `publicly_sourced`, `needs_review`, `conflicting` or `not_found`. Deliverability remains `unknown` after Hunter removal. Owner confirmation is recorded separately as recipient review, never relabeled as automated mailbox verification. Historical invalid-email results remain blocking until an explicitly documented correction.

An important evidence boundary: the provider's consulted-URL list proves consultation, not that every generated claim appears on that page. The implementation must cross-check claim/source associations and exposed excerpts, and use a second focused check or owner review for uncertain contact evidence. Without literal source text, the app must not claim deterministic page-text verification. No new custom crawler or non-OpenAI search service is assumed by this plan.

### Stage D: Build the business dossier

Research the company individually, including its website and useful independent sources. Prioritize:

- Actual services/products, service area and customer segment.
- The observed purchase/booking/quotation/repeat-order journey.
- Existing forms, tools, portals, integrations and what already works well.
- Concrete details affecting the workflow: product variants, required specifications, appointment types, locations, service intervals or operational steps.
- Recent, relevant developments where available, with dates and uncertainty.
- Constraints and unknowns: access, internal systems, budgets, decision-maker and actual pain.

Retain the existing baseline of three useful pages across two independent domains for an initial outreach draft, plus at least two meaningful sourced observations. Do not pad source counts with irrelevant directories, mirror copies or repeated URLs. Fewer substantive sources should produce a hold, not an artificially satisfied count.

Persist facts as individually traceable records with a short excerpt, source, observation time and evidence level. Keep an explicit list of **known facts**, **plausible opportunities**, **contradictions** and **unknowns**. An absent feature in search results is not evidence that the business lacks it internally.

### Stage E: Choose one personalized working solution

Internally consider a small number of options and select one using:

| Criterion | Question |
| --- | --- |
| Evidence fit | Which specific observed business details make this useful? |
| Commercial relevance | Could it plausibly improve revenue, acquisition, retention, staff time or cost? |
| Incremental value | Does it complement what the business already has? |
| Feasibility | Can one builder deliver a small operational workflow? |
| Access | What agreed data/integration access would be required? |
| Recipient fit | Is the contact likely to understand or influence this workflow? |
| Uncertainty | Which assumptions need a conversation before a commitment? |

The selected solution record must state: triggering business facts; a **hypothesized** pain/opportunity; actual input/action/output; smallest useful implementation scope; expected benefit framed as an intention; access requirements; evaluation measure; and why a 30, 45 or 60-day pilot fits.

Do not default every business to an enquiry form or follow-up CRM. An equipment supplier's configuration process, a training firm's cohort scheduling, and a maintenance firm's recurring service work require different analysis. These are hypothetical examples, not facts about any existing prospect.

Reject proposals that depend on invented losses, unobserved broken processes, unlimited free work, guaranteed ROI, unsolicited access to private customer information, or documents as the principal free deliverable. If the solution is just as applicable after swapping the company name, it fails personalization review.

### Stage F: Draft and assess the email

Use the verified dossier and selected solution, not a broad discovery search result. Keep the existing concise researched body, truthful sender introduction, LinkedIn link, footer, 30/45/60-day working-pilot rules and one low-pressure call to action.

Run deterministic checks and a focused quality assessment for unsupported claims, generic text, wrong recipients, source linkage, actual working behavior, feasible scope, consistent duration and invented certainty. A separate assessment request is included in the same $50 budget; it does not search again by default.

Do not silently rewrite owner edits. Save a proposed revision separately or apply an explicit version guard, revoke the old approval if content/recipient changes, and require owner review again. Sent messages remain immutable. Follow-ups preserve the agreed pilot scope and cease when a reply/opt-out/bounce arrives.

Weak cases remain visible with a concise hold reason. A person may correct a recipient or add evidence; a review action must not bypass hard invalid-email, suppression or research-quality blocks.

## 5. OpenAI integration choices

Use the existing Responses API integration rather than introduce another orchestration service. Initially retain the configured `gpt-5.4-mini` research and `gpt-5.6-sol` draft roles to limit simultaneous changes. Add a discovery role using the validated research model. No automatic model upgrade or premium-model fallback is authorized.

Validate the exact chosen model's support for hosted search, requested output format and stage limits during implementation. Use live search, location hints for geographic intent, official-domain filtering for focused contact work, and returned source metadata. Geographic hints assist search; business location still needs evidence. Broad discovery must remain cross-domain. [S1, S3]

Use strict structured extraction where supported. Handle refusal, truncated/incomplete output, empty candidate sets and schema-validation failure explicitly. Schema compliance does not establish truth. Separate search and extraction if required; do not silently fall back to brittle prose parsing. [S2]

Record provider request IDs and response IDs whenever available, plus model/prompt versions and stage outputs. Capture minimal business evidence rather than full unrelated web content. Keep secrets and Gmail content outside research inputs.

Default to bounded foreground stages with `store:false`, each durably persisted before scheduling the next stage. Longer research should first be split into focused requests. Background mode is a possible later option for measured long-running cases, not a required new dependency. It needs a tested submit/poll state machine, prompt result persistence, and an explicit retention review because asynchronous retrieval involves temporary provider storage. Do not assume indefinitely retrievable responses. [S4]

## 6. Durable task, failure and scheduling design

Use distinct logical task stages such as `discover_search`, `discover_extract`, `contact_research`, `business_research`, `solution_design`, `draft_generate` and `draft_assess`. These are proposed identifiers, not required public API names.

Store task state, campaign/business identity, step version, attempt ID, provider request/response IDs, associated reservation, start/heartbeat/completion times, result reference and next eligible time. Add uniqueness constraints for the relevant campaign or lead/stage/version. A terminal result and its downstream scheduling should be committed atomically or through an idempotent transaction pattern.

| Condition | Required handling |
| --- | --- |
| No credits/budget remaining | Pause paid stages with a specific reason; do not convert normal exhaustion into permanent failure. |
| Daily stage allowance reached | Leave eligible work queued for the next UTC day. |
| Search returns no useful businesses | Complete as `no_results`/low yield; rotate a bounded next query, rather than replay the same call blindly. |
| Definitive provider rejection | Record safe error code; release only demonstrably unused reservation. Requeue only through the documented policy. |
| Timeout, lost acknowledgement or uncertain billing | Retain reservation and hold the paid attempt. No automatic resubmission. |
| Completed response but invalid schema | Preserve the response and known usage. Repair extraction in a separate bounded task; do not repeat successful discovery. |
| Worker stops after response is persisted | Resume from stored output; do not repay for the same search. |
| Worker stops before any provider reservation | Recover only when ledger/task evidence proves no paid attempt began. |
| One concurrent task fails | Await sibling task completion before releasing the scheduler lease. |
| Existing held/failed job | Show the reason and a deliberate recovery path; don't strand it behind an invisible provider-specific gate. |

Keep per-job atomic claims and separate dispatch locking. Avoid a scheduler-wide lease held through the entire business pipeline. Start with bounded claim/persist phases and at most two paid requests concurrently, then validate CPU time, wall time and query counts. A browser disconnect must not be the durability mechanism for paid research.

Separate **discovery target**, **daily businesses researched**, **paid stage attempts**, **qualified drafts** and **emails sent**. Multiple stages for one company must not consume several business-research slots merely because the implementation was split. Charge a business slot once using a unique daily business claim; use separate operational limits for paid requests and follow-up/reply work.

Maintain the fixed undrafted-backlog rule. Pending-review drafts never pause discovery. Distinguish actionable unfinished research from held records needing owner input so a stockpile of unresolved contacts cannot permanently suppress searches. Limit new acquisition by the remaining budget and current actionable workload; do not equate a 20-send cap to a guarantee of 20 drafts.

On month rollover, a task with no submitted paid attempt may resume against the new month's allowance. A previously submitted uncertain attempt keeps its original reservation/month and remains held. Do not erase old reservations to manufacture available funds.

## 7. Data model and compatibility changes

Add an append-only migration; never edit prior migrations already applied to production.

Proposed additions:

| Record | Main purpose |
| --- | --- |
| Discovery batch and candidate records | Campaign/query history, provider/version, supported business identity, candidate outcome and dedupe linkage. |
| Evidence/fact records | Source URL/domain, excerpt, observation time, evidence type, claim association and contradictions. |
| Contact evidence | Exact public address, its supporting source/excerpt, relevance and owner-review status; deliverability stored separately. |
| Research stage/attempt records | Durable checkpoints, explicit paid-attempt identity, provider IDs, reservation and recovery information. |
| Solution assessments | Fact references, hypothesized opportunity, selected workflow, scope, access and quality reasons. |
| Daily business claims | Unique business/day accounting independent of paid stage counts. |

Reuse existing leads/drafts/messages/jobs/expenses where compatible; add only the missing structure. Preserve stable lead IDs, owner edits, draft versions, approvals, Gmail thread/provider IDs, suppression records, sent timestamps and follow-up schedules.

Tag historical runs as legacy Apify records or display them through an archived history view. They must not be included in active OpenAI-run checks or cooldown logic. Keep their spend/reservation history untouched and distinguish it in exports. A legacy uncertain Actor run must not block every new OpenAI search.

Migrate settings to a single active OpenAI budget. Remove active `apifyBudget`, `apifyRunCap` and Hunter allowances while safely ignoring legacy saved keys. Retain useful search target/interval settings with provider-neutral names. Keep the confirmed $50 cap; no existing validator/test should be loosened to $100.

For existing researched prospects, reuse fresh, sufficiently supported evidence to avoid unnecessary spend. Enrich provenance progressively and show legacy limitations honestly. Do not silently declare old imported emails source-verified. Expired or weak evidence requires a bounded refresh before a new approval. Existing paid-uncertain tasks need individual reconciliation, not a blanket reset.

## 8. Budget and throughput under the confirmed $50 cap

Reserve funds atomically **before every paid request**, including discovery extraction, assessment, replies and follow-ups. All stages share provider `openai` in the monthly ledger; stage labels support reporting, not separate spending pools.

Current official pricing lists hosted web search at $10 per 1,000 billable calls, plus model input/output charges. GPT-5.4 mini lists $0.75 input and $4.50 output per million tokens; the current Sol role's registered $4/$20 rates must be rechecked before implementation, including any applicable pricing conditions. [S5, S6]

Illustrative arithmetic, **not a throughput forecast**:

| Scenario | Search fees only |
| --- | --- |
| 600 candidate businesses/month × four billable searches | $24 before tokens, extraction, drafts, assessment or rejected candidates. |
| 600 candidate businesses/month × eight billable searches | $48 before all token and other generation costs. |

This is why deeper personalized research cannot honestly guarantee twenty send-ready drafts every day within $50. Budget-aware operation should prefer fewer well-supported candidates over cheaper invented certainty. Shared batch discovery may reduce the discovery component; actual contact yield and discarded candidates must be measured.

For planning the first benchmark, use provisional internal shares of 15% discovery, 20% contacts, 30% business research, 25% solution/draft/assessment and 10% replies/follow-ups. These are scheduling priorities under one cap, not independently spendable budgets. Preserve headroom for replies from already contacted prospects before acquiring more leads. Adjust from measured usage without raising the owner's cap.

Per-stage output tokens and tool-call limits must be explicit. Conservative reservation bounds must cover model input, search content, output/reasoning and maximum billable searches. Do not reduce a reservation merely to improve apparent affordability. Use supported bounded-search controls where available; otherwise retain a defensible worst-case bound.

Revise accounting so search/open/find output items are not all assumed to be equally billable searches. Prefer provider-reported billable tool usage when available and validated; otherwise retain a labeled conservative estimate. Keep token usage and search-fee components separately identifiable. Do not turn a known settled cost into an unknown reservation simply because later parsing failed. Final provider billing remains authoritative. [S3, S5]

Expose spent/estimated, outstanding reservations, available allowance and the exact pause reason. Distinguish local $50 exhaustion, provider `insufficient_quota`, authentication/model rejection and rate limiting. No automatic credit purchase or budget increase.

## 9. File-level implementation checklist

| File or area | Planned work |
| --- | --- |
| `src/discovery.ts` | Replace Actor launch/poll/import with OpenAI candidate search/extraction; reuse generic ingestion through a separate module. |
| New focused source modules | Candidate schemas/normalization, contact evidence, research facts, solution assessment and stage orchestration where needed. |
| `src/providers.ts` | Stage configuration, supported request schemas, request IDs, billable search usage, conservative reservations, clear errors and explicit retry settings. |
| `src/research.ts` | Persist dossier/fact/solution checkpoints; reuse evidence; preserve concise drafts, working-pilot rules and owner version guards. |
| `src/engine.ts` | Remove Apify/Hunter gates and enrichment; schedule stages, recovery, month/day pauses and actionable backlog. |
| `src/index.ts` | Provider-neutral search/status endpoints, pipeline counts and connection checks; retire Actor attachment without ambiguous routing. |
| `src/types.ts`, `src/policy.ts`, `src/db.ts` | Settings/schema compatibility, evidence/contact states, budgets, unique stage/business claims and transactional persistence. |
| `src/locations.ts` | Keep geography; add fit/rotation inputs and bounded low-yield exploration. |
| `src/prospects.ts`, `public/app.js` | Show contact/source status and short hold reasons; remove Apify/Hunter controls; keep the three-page UI. |
| New append-only SQL migration | Add task/evidence/candidate structures, constraints and legacy-provider tagging with verified backfill. |
| `.env.example`, `scripts/env.mjs`, `scripts/doctor.mjs` | Remove required Apify/Hunter keys, add only necessary OpenAI stage settings; update diagnostics. |
| `scripts/deploy.mjs` | Plan explicit obsolete-secret deletion after cutover. Omitting a key from bulk upload does not remove a previously deployed secret. |
| `scripts/smoke-hosted.mjs` | Assert provider-independent discovery and the $50 total; remove Apify budget assertions. |
| Existing tests and new pipeline tests | Replace Actor fixtures and extend stage/cost/provenance/deduplication cases while preserving sending tests. |
| `README.md`, operational scripts and diagnostics | Update setup, recovery, budget explanations, active status and exports. Historical artifacts remain historical. |

Check `scripts/inspect-hosted.mjs`, `scripts/diagnose-stall.mjs`, review/verification helpers and UI fixtures for old run assumptions, not just files containing the word Apify. Remove obsolete runtime calls to `api.apify.com` and `api.hunter.io`; historical text in old artifacts is allowed.

## 10. Minimal product experience

Keep **Prospects, Dashboard and Settings**. Avoid a new provider-management console or a stage-by-stage technical interface.

- Find prospects uses saved locations and the independent-SMB target profile.
- Show concise human statuses: Searching, Finding contact, Researching, Email ready, Needs review, No public email, Budget paused.
- Inside a prospect, show the public email source, a compact business summary, the opportunity rationale and supporting sources. Keep operational details collapsed.
- Show one monthly OpenAI allowance and a readable pause reason in Settings.
- Owner still opens the email, reviews recipient/content and clicks Send. Neither migration nor a high model score approves anything.

Retain export compatibility, history pagination, location persistence and the fixed review-backlog behavior. Show total attention counts from the whole database rather than only the latest sixty jobs.

## 11. Validation and acceptance criteria

### Automated and local checks

1. Discovery and research work with no Apify or Hunter variables present. Unexpected HTTP calls to either provider fail the test.
2. Repeated searches, cron overlap and repeated import pages do not create duplicate paid attempts, prospects, drafts or emails.
3. Similar business names, shared domains, franchise locations, redirects and shared contact addresses are handled without unsafe merges or repeat outreach.
4. Missing/conflicting email evidence, irrelevant sources and uncertain company identity produce explicit states, not fabricated fields.
5. A plausible email absent from supporting evidence is rejected; owner review is distinct from deliverability verification.
6. Prompt injection in business pages/directories cannot change budgets, recipient, sender, system instructions or sending behavior.
7. The three-page UI remains minimal, works on mobile and shows truthful reasons for holds/pauses.
8. Every paid stage reserves the shared allowance atomically; concurrent reservations cannot exceed $50. Missing usage retains funds. Month/day rollover and reply headroom behave correctly.
9. Worker termination at every boundary resumes stored work safely. Known completed requests are reused; uncertain paid requests are not replayed. Parent leases are not released while siblings run.
10. Pipeline stage splitting does not consume several daily business slots for the same company. Existing 88+ pending drafts never pause new discovery.
11. Migration preserves every existing prospect/message/suppression/approval/version/thread ID and handles legacy active/uncertain Actor records without blocking new search.
12. Existing quality holds, truthful 30/45/60-day working pilots, recipient eligibility, approval hashes, Gmail sending limits, opt-outs and reply cancellation still pass.

### Bounded real-provider benchmark after implementation authorization

Use a small predeclared set: approximately six existing businesses and two discovery scopes across different industries/locations, within a **maximum $2 allocation taken from the same $50 cap**. Reserve room before running; stop early if needed. Never send prospect emails during migration validation.

Measure candidate accuracy, independent-SMB fit, exact public-email yield, duplicates, substantive source coverage, personalized-solution quality, per-stage latency, interrupted-run recovery, costs per accepted candidate and costs per qualified draft. Include weak/no-email, conflicting identity and generic-pitch cases. The benchmark must report the full funnel, including failures and discarded candidates, so cost-per-draft is not understated.

Small-sample success is not a promise of worldwide yield. Acceptance requires zero fabricated recipients, zero unapproved sends, zero new calls to removed providers, preserved records, budget enforcement and honestly represented holds. Owner review of benchmark drafts decides whether personalization is useful enough to expand.

Run `npm run check`, then hosted smoke checks against the deployed version after authorized cutover. Account/model compatibility and actual web-search behavior must be verified in that benchmark; no paid API experiment was performed for this planning task.

## 12. Safe production cutover and recovery

1. Obtain explicit implementation authorization and record the confirmed choices above.
2. Before editing, record a file-change baseline; this checkout has no Git repository, so prepare a narrow local change manifest/backup or establish version control within the authorized implementation scope. Do not rely on an unavailable `git revert`.
3. Build and validate locally with activation disabled in the test environment. Keep the live application unchanged until the release is ready.
4. At cutover, briefly pause new discovery/research claims, inspect existing provider work and back up D1/export records. Do not launch a fresh Apify batch to finish the migration.
5. If an old Actor is already running, document its known results/cost. Prefer one final authorized bounded reconciliation of that existing run; if incomplete or uncertain, archive it as a legacy hold. Do not silently discard it, relaunch it, or erase its reservation. After cutover, no Apify polling remains.
6. Apply the additive migration and validate counts, stable IDs and representative owner edits before activation. Preserve suppression and sending history first.
7. Deploy the new runtime with new discovery temporarily paused; verify provider-neutral health, settings and history. Remove Apify/Hunter local configuration and deployed Worker secrets only after the cutover reconciliation. Do not revoke account-wide tokens used by another application or change third-party subscriptions automatically.
8. Run the bounded OpenAI benchmark, review evidence and drafts, then enable the new automated discovery/research path under the same $50 allowance. Preserve the existing sending activation and exact-content approval requirements.
9. Observe several scheduled cycles and one interval/day-boundary simulation locally. Verify useful candidates, new drafts, visible pauses, no provider fallback, no duplication and no silent stalls.
10. Publish concise deployment/version/evidence notes and current measured outcomes. Do not reuse old screenshots or test results as proof of the new system.

Rollback means pause the new paid pipeline and deploy a compatible known release against the additive schema while preserving new records. It does **not** silently reactivate Apify/Hunter. Any temporary return to those providers would require a separate owner decision. Continue to preserve known/uncertain costs during recovery.

## 13. Implementation order and completion evidence

| Phase | Deliverable | Exit condition |
| --- | --- | --- |
| 1. Contracts and preservation | Data/stage contracts, model compatibility notes, additive migration and existing-data fixtures. | Schema/backfill preserves records; no active legacy block. |
| 2. OpenAI discovery | Query rotation, candidate extraction, provenance, identity checks and deduplication. | Finds supported SMB candidates without Apify/Hunter calls. |
| 3. Contact and personalized solution | Public email evidence, business dossier, selected working pilot and quality review. | No guessed email; reviewed examples pass specificity and source checks. |
| 4. Durable operations and budget | Checkpoints, request accounting, shared $50 cap, recovery and clear pauses. | Failure/concurrency/rollover tests pass. |
| 5. Product/config cleanup | Minimal UI, diagnostics, exports, documentation and obsolete-secret removal steps. | No required removed-provider key or operational dependency. |
| 6. Controlled release | Full checks, bounded live benchmark, authorized deploy and scheduled-cycle observations. | New candidates/drafts progress automatically with preserved history and zero unapproved emails. |

Implementation is complete only when the deployed app demonstrates the new pipeline, the cost/quality funnel is recorded, and missing-contact/weak-evidence cases stop honestly. Removing an Apify button or changing an API key is not completion.

## 14. Sources and verification boundaries

Public official documentation inspected on October 28, 2026:

- **S1:** [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search) — Responses search, focused domains, source metadata, location hints and search/open actions.
- **S2:** [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) — schemas, refusal/incomplete handling and factual limitations.
- **S3:** [Responses API reference](https://developers.openai.com/api/reference/python/resources/responses/methods/create) — request/output controls and usage contracts. Check the live selected-model schema again during implementation, including optional tool-usage availability.
- **S4:** [OpenAI background mode](https://developers.openai.com/api/docs/guides/background) — asynchronous generation/polling and storage/retention implications.
- **S5:** [OpenAI API pricing](https://developers.openai.com/api/docs/pricing) — search plus token charges; recheck before the benchmark.
- **S6:** [GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini) — current role's model/pricing information; account-specific feature access remains to be tested.

Repository evidence: `src/discovery.ts`, `src/research.ts`, `src/providers.ts`, `src/engine.ts`, `src/index.ts`, `src/types.ts`, `src/policy.ts`, `src/db.ts`, `src/locations.ts`, migrations, UI, setup/deployment scripts and existing tests. Prior operational artifacts such as `artifacts/rca-resolution.json` and `artifacts/sender-audit.json` informed preservation risks; their counts are timestamped historical snapshots.

This document specifies a design and an implementation/validation sequence. It does not claim tested email-extraction yield, guaranteed mailbox delivery, a proven cost per qualified draft or a production migration already performed.
