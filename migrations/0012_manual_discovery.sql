-- Explicit searches replace all recurring discovery schedules. Preserve inbox,
-- conversation history and provider billing holds. Unpausing must not dispatch
-- older approved emails: require a fresh Send action, preserving their text.
UPDATE drafts SET status='pending',approved_hash=NULL,approved_version=NULL,approved_at=NULL
 WHERE status='approved';
-- Existing profiles may require unobservable buying intent or internal file
-- formats. Regenerate on the next explicit search using the shared fit policy.
-- Keep the previous analysis available for reference; do not start paid work.
UPDATE products SET revision=revision+1,state='draft',approved_revision=NULL,error=NULL
 WHERE state IN ('approved','target_review');
UPDATE settings SET data=json_set(data,
 '$.outreachPaused',json('false'),'$.prospectingPaused',json('false'),
 '$.discoveryPaused',json('true'),'$.researchAutomation',json('false'),
 '$.discoveryPausedUntil','','$.dailyLeadLimit',12,
 '$.dailyResearchLimit',CASE WHEN coalesce(json_extract(data,'$.dailyResearchLimit'),20)<60 THEN 60 ELSE coalesce(json_extract(data,'$.dailyResearchLimit'),60) END)
 WHERE id=1;
UPDATE jobs SET state='cancelled',error='Recurring discovery retired; use Find prospects',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE kind='discover_search' AND state IN ('pending','paused','paused_provider')
 AND coalesce(json_extract(payload,'$.manual'),0)=0;
UPDATE discovery_batches SET state='cancelled',error='Recurring discovery retired; use Find prospects'
 WHERE job_id IN (SELECT id FROM jobs WHERE kind='discover_search' AND state='cancelled');
