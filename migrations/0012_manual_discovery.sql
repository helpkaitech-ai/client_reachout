-- Explicit searches replace all recurring discovery schedules. Preserve inbox,
-- conversation history, provider billing holds and per-email send approvals.
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
