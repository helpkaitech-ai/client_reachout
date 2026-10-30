-- Every existing workspace must be explicitly resumed after this release.
-- Product setup/analysis is controlled separately by the Relay emergency pause.
UPDATE settings SET data=json_set(data,'$.prospectingPaused',json('true'),'$.discoveryPaused',json('true'),'$.discoveryIntervalDays',6,'$.discoveryPausedUntil','') WHERE id=1;
-- Preserve the last confirmed credit rejection as a shared-key circuit breaker.
INSERT OR IGNORE INTO integration_state(key,value)
SELECT 'openai_credit_block',json_object('code','credit_balance_exhausted','at',a.created_at,'message','OpenAI rejected the deployed key for exhausted credits. Update billing and confirm in Settings before retrying.')
FROM ai_attempts a WHERE a.state='rejected' AND a.error LIKE '%credit_balance_exhausted%'
AND NOT EXISTS(SELECT 1 FROM ai_attempts newer JOIN expenses e ON e.id=newer.expense_id WHERE newer.created_at>a.created_at AND newer.state='complete' AND e.actual>0)
ORDER BY a.created_at DESC LIMIT 1;
