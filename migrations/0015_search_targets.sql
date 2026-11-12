ALTER TABLE discovery_cycles ADD COLUMN research_limit INTEGER NOT NULL DEFAULT 60;
UPDATE discovery_cycles SET research_limit=max(60,target*5);
-- Old daily quota holds must not be dispatched automatically after the change.
-- Their existing drafts and evidence remain available for the owner's next action.
UPDATE jobs SET state='cancelled',next_run_at=NULL,error='Previous daily quota retired; start a new search'
 WHERE state='paused' AND (error LIKE 'Qualified email target reached%' OR error='Daily business research allowance reached');

-- Requests that expired under the old daily workflow remain expired. New
-- per-search requests can continue across midnight without starting a new run.
UPDATE discovery_cycles SET completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE completed_at IS NULL AND created_at<strftime('%Y-%m-%dT00:00:00.000Z','now');
UPDATE jobs SET state='cancelled',next_run_at=NULL,error='Expired legacy search'
 WHERE kind IN ('research','discover_search') AND state IN ('pending','paused','paused_provider')
 AND json_extract(payload,'$.manual')=1
 AND coalesce(json_extract(payload,'$.campaignDay'),substr(created_at,1,10))<strftime('%Y-%m-%d','now');

DELETE FROM integration_state WHERE key='manual_search_request' AND json_extract(value,'$.day')<strftime('%Y-%m-%d','now');
