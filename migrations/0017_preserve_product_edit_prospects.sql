-- Product edits affect future searches, not previously admitted prospects.
-- Restore only recorded qualified drafts hidden by the old blanket edit holds.
-- Actual qualification failures, deleted prospects and delivery states stay intact.
UPDATE drafts SET quality_hold='',status='pending',approved_hash=NULL,
 approved_version=NULL,approved_at=NULL
WHERE status IN ('pending','approved')
 AND quality_hold IN (
  'Product details changed; review or improve this draft against the refreshed profile',
  'Workspace targeting or offer changed; review or improve this draft against the refreshed profile'
 )
 AND EXISTS(SELECT 1 FROM qualified_prospects q WHERE q.draft_id=drafts.id AND q.lead_id=drafts.lead_id);
