-- Upgrade profiles only on the next owner-requested search; no paid work starts
-- during deployment. Preserve previous analysis, email text and sent history.
UPDATE products SET revision=revision+1,state='draft',approved_revision=NULL,error=NULL
 WHERE state IN ('approved','target_review','analyzing');
UPDATE drafts SET status='pending',quality_hold='Product-fit rules updated; this earlier draft needs a new fit review',
 approved_hash=NULL,approved_version=NULL,approved_at=NULL
 WHERE kind='initial' AND status IN ('pending','approved')
 AND CASE WHEN json_valid(free_offer) THEN json_extract(free_offer,'$.type')='product' ELSE 0 END;
UPDATE discovery_cycles SET completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE completed_at IS NULL;
UPDATE jobs SET state='cancelled',error='Email-first discovery replaces this older search; use Find prospects',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE kind='discover_search' AND state IN ('pending','paused','paused_provider')
 AND coalesce(json_extract(payload,'$.emailFirst'),0)=0;
UPDATE discovery_batches SET state='cancelled',error='Email-first discovery replaces this older search; use Find prospects'
 WHERE job_id IN (SELECT id FROM jobs WHERE kind='discover_search' AND state='cancelled');
