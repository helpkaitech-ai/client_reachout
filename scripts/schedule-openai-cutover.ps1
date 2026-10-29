$ErrorActionPreference = 'Stop'
$taskName = 'Relay-OpenAI-Cutover-20261029'
$workspace = 'D:\NymbarkAIProjects\client_reachout'
$scriptPath = Join-Path $workspace 'scripts\run-openai-cutover.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) { throw 'Cutover runner is missing' }
$cutoverUtc = [DateTime]::SpecifyKind([DateTime]'2026-10-29 00:05:00', [DateTimeKind]::Utc)
$cutoverLocal = [TimeZoneInfo]::ConvertTimeFromUtc($cutoverUtc, [TimeZoneInfo]::Local)
$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $scriptPath + '"') -WorkingDirectory $workspace
$trigger = New-ScheduledTaskTrigger -Once -At $cutoverLocal
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$settings.Hidden = $true
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and -not ($existing.Actions.Arguments -like ('*' + $scriptPath + '*'))) { throw 'Task name belongs to another command; refusing to replace it' }
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'One-time Relay migration after D1 free allowance reset; capped OpenAI validation, no prospect sending.' -Force | Out-Null
$task = Get-ScheduledTask -TaskName $taskName
$info = Get-ScheduledTaskInfo -TaskName $taskName
$result = [ordered]@{taskName=$taskName;state=[string]$task.State;scheduledUtc=$cutoverUtc.ToString('o');scheduledIndia='2026-10-29 05:35 IST';nextRunLocal=$info.NextRunTime.ToString('o');hidden=$task.Settings.Hidden;startWhenAvailable=$task.Settings.StartWhenAvailable;requiresUserSessionAndInternet=$true;statusFile=(Join-Path $workspace 'artifacts\openai-cutover-status.json')}
$result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $workspace 'artifacts\openai-cutover-schedule.json') -Encoding utf8
$result | ConvertTo-Json
