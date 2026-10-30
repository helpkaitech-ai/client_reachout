UPDATE settings SET data=json_set(data,'$.outreachPaused',json('true'),'$.discoveryPaused',json('true'),'$.discoveryIntervalDays',6,'$.discoveryPausedUntil','') WHERE id=1;
