-- Remove retired switches without starting searches or changing product profiles.
-- A legacy paused workspace must not unexpectedly dispatch old email approvals.
UPDATE drafts SET status='pending',approved_hash=NULL,approved_version=NULL,approved_at=NULL
 WHERE status='approved' AND EXISTS(SELECT 1 FROM settings WHERE id=1 AND
 (json_extract(data,'$.outreachPaused')=1 OR json_extract(data,'$.prospectingPaused')=1));
UPDATE settings SET data=json_remove(data,'$.outreachPaused','$.prospectingPaused',
 '$.discoveryPaused','$.discoveryPausedUntil','$.discoveryIntervalDays','$.researchAutomation');
UPDATE jobs SET state='cancelled',error='Recurring searches removed',next_run_at=NULL
 WHERE kind='discover_search' AND state IN ('pending','paused','paused_provider')
 AND coalesce(json_extract(payload,'$.manual'),0)<>1;
UPDATE discovery_batches SET state='cancelled',error='Recurring searches removed'
 WHERE job_id IN (SELECT id FROM jobs WHERE kind='discover_search' AND state='cancelled');
