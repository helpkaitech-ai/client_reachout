# Qualified, send-ready prospects

## Confirmed problem
Discovery imported four job-ad candidates and applied the six-day interval after one batch. Research did not receive the original discovery evidence. All four later failed qualification; empty model messages were nevertheless stored as greeting-only drafts.

## Implementation
1. Preserve original candidate URLs, excerpts, role, location and fit rationale in subsequent OpenAI research. Treat these as leads to verify, never automatically proven facts. Use the same qualification guidance in discovery, fit analysis, drafting and assessment. Keep unknown buying intent/budget and unconfirmed file format conditional unless the owner explicitly requires proof.
2. Stop rejected, unsupported, conflicted or incomplete results before draft insertion. Retain private research/audit records, without putting candidates in the prospect list. Never manufacture a draft to meet a numerical target.
3. Apply one readiness rule to prospect lists, counts and daily admissions: qualified fit, supported business facts, complete subject/body, public contact evidence, no quality hold and no blocked recipient. Preserve sent history and existing owner send approval.
4. Track qualified admissions separately from raw candidates and research attempts. The configured 12-email target counts qualified completed initial drafts. Research attempts retain their independent daily limit and all paid work retains the product's $50 monthly cap.
5. Maintain an active discovery cycle that can search replacements after research finishes, until twelve distinct qualified prospects are ready or an operational limit stops work. Respect workspace/global pauses. Start the six-day gap when a campaign reaches its target; replacement work within the campaign does not trigger that gap. Bound empty-result searches and research attempts so replacement discovery cannot spin indefinitely. The owner confirmed six days between campaigns and twelve different prospects, each with its own initial email.
6. Show only ready drafts on Prospects; remove the Needs attention option from that page. Keep failures and rejected records in Settings activity/export. Preserve inbox/reply and sent-history behavior.
7. Apply the six-day interval only to automatic campaigns. An authenticated Find prospects request bypasses that interval, automatic-only discovery holds and automatic backlog pacing. Mark its queued discovery/research work as manual so it can finish with automatic research off. Reuse an active search and serialize enqueue requests. Keep the hard daily limits, monthly budget, product approval and workspace/global outreach pauses. If targeting edits invalidate approval, Find prospects opens the current product review rather than remaining disabled.

## Validation and release
- Test real worker/database flows with mocked OpenAI responses: four rejected candidates followed by qualified replacements; source handoff; blank drafts; unsupported contacts; valid daily counting; pause, budget and attempt caps; cycle intervals; product isolation; sent history.
- Test existing UI and APIs, typecheck and build. Inspect the deployed UI and read-only live records after release.
- No test may send prospect email or initiate paid research. Existing active owner-authorized automation may resume naturally after deployment; do not force retries of old paid stages.
- Back up production records before applying the additive schema migration. Preserve user settings, product approval, secrets and sent history. Archive existing empty held drafts without deleting research records.

## Operational limits
Twelve is a target and a maximum, not a guarantee: unsupported candidates do not qualify. The daily research allowance, per-product monthly budget, provider availability and owner-selected search schedule can prevent reaching it. Surface the actual reason in Settings/status, without exposing unfinished candidates as prospects.
