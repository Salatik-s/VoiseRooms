[CmdletBinding()]
param(
    [switch]$PlanOnly,
    [switch]$FirstInstall,
    [switch]$AgreeLetsEncryptTerms,
    [string]$Email = '',
    [string]$PrivateEnvPath = "$env:USERPROFILE\.codex\private\voicerooms\production.env",
    [string]$SourceRoot = '',
    [string]$Python = '',
    [string]$OutputDirectory = '',
    [string]$Server = '157.228.191.231',
    [ValidatePattern('^[a-z_][a-z0-9_-]*$')][string]$User = 'root',
    [ValidateRange(1,65535)][int]$Port = 22
)
$ErrorActionPreference = 'Stop'
if ($User -ne 'root') { throw 'Этот сценарий обновления запускается через root. Другие SSH-пользователи не поддерживаются.' }
if ($Server -ne '157.228.191.231') { throw 'Этот сценарий подготовлен только для хоста 157.228.191.231.' }
if (-not $SourceRoot) { $SourceRoot = Join-Path $PSScriptRoot '..' }
$releaseSource = (Resolve-Path -LiteralPath $SourceRoot).Path
if (-not $Python) {
    $pythonCandidates = @(
        (Join-Path $releaseSource '.venv\Scripts\python.exe'),
        (Join-Path $env:USERPROFILE '.codex\skill-envs\humanizer-ru\Scripts\python.exe'),
        (Join-Path $env:LOCALAPPDATA 'Python\pythoncore-3.14-64\python.exe')
    )
    foreach ($candidate in $pythonCandidates) { if (Test-Path -LiteralPath $candidate -PathType Leaf) { $Python = $candidate; break } }
    if (-not $Python) {
        $availablePython = Get-Command python.exe -ErrorAction SilentlyContinue
        if ($availablePython -and $availablePython.Source -notlike '*WindowsApps*') { $Python = $availablePython.Source }
    }
}
if (-not $Python -or -not (Test-Path -LiteralPath $Python -PathType Leaf)) { throw 'Не найден Python. Установите Python 3.11 или новее либо передайте путь через -Python.' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path ([IO.Path]::GetTempPath()) 'voicerooms-release' }
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$releaseOutput = (Resolve-Path -LiteralPath $OutputDirectory).Path
$releaseId = [Guid]::NewGuid().ToString('N')
$releaseArchive = Join-Path $releaseOutput ('voicerooms-1.2.0-' + $releaseId + '.zip')
$packageArguments = @((Join-Path $PSScriptRoot 'package_release.py'),'--source',$releaseSource,'--output',$releaseArchive)
if ($PlanOnly) { $packageArguments += '--allow-dirty' }
$packageText = & $Python @packageArguments
if ($LASTEXITCODE -ne 0) { throw 'Подготовка выпуска остановлена. На хост ничего не отправлено.' }
$package = $packageText | ConvertFrom-Json
if ($package.sha256 -notmatch '^[a-f0-9]{64}$' -or $package.revision -notmatch '^[a-f0-9]{40}$') { throw 'Неверное описание подготовленного выпуска.' }
& $Python (Join-Path $PSScriptRoot 'update.py') --archive $releaseArchive --sha256 $package.sha256
if ($LASTEXITCODE -ne 0) { throw 'Проверка архива не пройдена. На хост ничего не отправлено.' }
Write-Host ('Архив: ' + $releaseArchive)
Write-Host ('SHA-256: ' + $package.sha256)
if ($PlanOnly) {
    Write-Host 'Проверка завершена. Подключения по SSH и изменений на хосте не было.'
    return
}
if ($FirstInstall) {
    if (-not (Test-Path -LiteralPath $PrivateEnvPath -PathType Leaf)) { throw 'Не найден подготовленный приватный production.env для первой установки VoiceRooms.' }
    if (-not $Email) {
        $emailLine = Get-Content -LiteralPath $PrivateEnvPath | Where-Object { $_ -match '^LE_ACCOUNT_EMAIL=' } | Select-Object -First 1
        if ($emailLine) { $Email = $emailLine.Substring('LE_ACCOUNT_EMAIL='.Length) }
    }
    if ($Email -notmatch '^[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$') { throw 'Для первой установки укажите email через -Email или приватное поле LE_ACCOUNT_EMAIL.' }
}
foreach ($program in @('ssh.exe','scp.exe')) { if (-not (Get-Command $program -ErrorAction SilentlyContinue)) { throw ('Не найден OpenSSH: ' + $program) } }
$remoteTarget = $User + '@' + $Server
$remoteDirectory = '/root/.cache/voicerooms-update-' + $releaseId
$remoteArchive = $remoteDirectory + '/release.zip'
$remoteUpdater = $remoteDirectory + '/update.py'
$updaterPath = Join-Path $PSScriptRoot 'update.py'
$updaterHash = (Get-FileHash -LiteralPath $updaterPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($updaterHash -ne $package.updaterSha256) { throw 'Сценарий обновления изменился после подготовки архива. Повторите запуск; на хост ничего не отправлено.' }
Write-Host 'OpenSSH может запросить пароль. Приватная конфигурация остаётся на хосте.'
& ssh.exe -p $Port $remoteTarget "umask 077; mkdir -p '$remoteDirectory'"
if ($LASTEXITCODE -ne 0) { throw 'Не удалось подготовить передачу. Обновление не начато.' }
& scp.exe -P $Port $releaseArchive "${remoteTarget}:$remoteArchive"
if ($LASTEXITCODE -ne 0) { throw 'Не удалось передать архив. Обновление не начато.' }
& scp.exe -P $Port $updaterPath "${remoteTarget}:$remoteUpdater"
if ($LASTEXITCODE -ne 0) { throw 'Не удалось передать сценарий проверки. Обновление не начато.' }
$remoteMode = '--apply'
if ($FirstInstall) {
    $remotePrivate = $remoteDirectory + '/production.env'
    & scp.exe -P $Port $PrivateEnvPath "${remoteTarget}:$remotePrivate"
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось передать приватную конфигурацию. Установка не начата.' }
    $remoteMode = "--first-install --env-upload '$remotePrivate' --email '$Email'"
    if ($AgreeLetsEncryptTerms) { $remoteMode += ' --agree-terms' }
}
$remoteCommand = "set -eu; printf '%s  %s\n' '$updaterHash' '$remoteUpdater' | sha256sum -c - >/dev/null; python3 '$remoteUpdater' --archive '$remoteArchive' --sha256 '$($package.sha256)' $remoteMode"
& ssh.exe -t -p $Port $remoteTarget $remoteCommand
if ($LASTEXITCODE -ne 0) { throw 'Обновление остановлено. Проверьте сообщение сервера выше; резервная копия остаётся на хосте.' }
Write-Host 'Обновлено: https://voise.24projects.ru/'
