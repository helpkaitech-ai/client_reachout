-- A late research/inbox callback cannot restore a prospect the owner deleted.
CREATE TRIGGER keep_deleted_prospects_deleted
AFTER UPDATE OF status ON leads
WHEN OLD.status='deleted' AND NEW.status<>'deleted'
BEGIN
 UPDATE leads SET status='deleted',next_followup_at=NULL WHERE id=NEW.id;
END;
