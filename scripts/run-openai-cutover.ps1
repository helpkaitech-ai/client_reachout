$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath 'D:\NymbarkAIProjects\client_reachout'
& 'C:\Program Files\nodejs\node.exe' 'scripts\complete-openai-cutover.mjs' *> 'artifacts\openai-cutover.log'
exit $LASTEXITCODE
