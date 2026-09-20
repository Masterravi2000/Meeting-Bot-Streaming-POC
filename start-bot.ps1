$stopFile = "STOP_BOT.txt"
if (Test-Path $stopFile) { Remove-Item $stopFile }

try {
    node src/bot.js
}
finally {
    if (-not (Test-Path $stopFile)) {
        Write-Host "`nCtrl+C detected - creating stop signal for the bot..."
        New-Item $stopFile | Out-Null
    }
}