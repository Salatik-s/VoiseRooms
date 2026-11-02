[CmdletBinding()]
param(
    [string]$Server = '157.228.191.231',
    [string]$Email = '',
    [string]$PrivateEnvPath = "$env:USERPROFILE\.codex\private\voicerooms\production.env",
    [switch]$AgreeLetsEncryptTerms,
    [switch]$SkipPortfolio
)
$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if ($Server -ne '157.228.191.231') { throw 'This reviewed script targets 157.228.191.231 only.' }
$pythonPath = Join-Path $sourceRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) { throw 'Local Python environment is missing. Install Python and recreate .venv before deployment.' }
$sourceEnvPath = Join-Path $env:USERPROFILE '.codex\private\voicerooms\local.env'
if (-not (Test-Path -LiteralPath $sourceEnvPath)) { $sourceEnvPath = Join-Path $sourceRoot '.generated\.env' }
& $pythonPath (Join-Path $PSScriptRoot 'prepare.py') --source $sourceEnvPath --target $PrivateEnvPath
if ($LASTEXITCODE -ne 0) { throw 'Private configuration preparation failed.' }
if (-not $Email) {
    $emailLine = Get-Content -LiteralPath $PrivateEnvPath | Where-Object { $_ -match '^LE_ACCOUNT_EMAIL=' } | Select-Object -First 1
    if ($emailLine) { $Email = $emailLine.Substring('LE_ACCOUNT_EMAIL='.Length) }
}
if ($Email -notmatch '^[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$') { throw 'Set certificate email in the private LE_ACCOUNT_EMAIL field or pass -Email.' }
$remoteUrl = (& git -C $sourceRoot remote get-url origin).Trim()
if ($LASTEXITCODE -ne 0 -or $remoteUrl -ne 'https://github.com/Salatik-s/VoiseRooms.git') { throw 'Unexpected repository. No files transferred.' }
$dirty = & git -C $sourceRoot status --porcelain --untracked-files=no
if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Commit the reviewed public source before deploying. No files transferred.' }
$revision = (& git -C $sourceRoot rev-parse HEAD).Trim()
if ($revision -notmatch '^[a-f0-9]{40}$') { throw 'Invalid source revision.' }
$qaRoot = Join-Path $sourceRoot '.qa'
New-Item -ItemType Directory -Force -Path $qaRoot | Out-Null
$archive = Join-Path $qaRoot 'voicerooms-public.zip'
& git -C $sourceRoot archive --format=zip --output=$archive HEAD
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the public source archive.' }
$sha = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
$uploadName = 'voicerooms-' + [Guid]::NewGuid().ToString('N')
$upload = '/root/.cache/' + $uploadName
$target = 'root@' + $Server
function Invoke-RemoteScript([string]$ScriptText) {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($ScriptText.Replace("`r",'')))
    & ssh.exe $target "printf %s $encoded | base64 -d | bash"
    if ($LASTEXITCODE -ne 0) { throw 'Server step stopped. Existing projects and persistent data were preserved.' }
}
$preflightCode = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'preflight.py'))
$preflight = "set -euo pipefail`npython3 - <<'VOICE_PREFLIGHT'`n" + $preflightCode + "`nVOICE_PREFLIGHT`numask 077`nmkdir -p '$upload'`n"
Write-Host 'Checking the exact host and DNS. OpenSSH may ask for your root password.'
Invoke-RemoteScript $preflight
$settingsFile = Join-Path $qaRoot 'deploy-settings.json'
$settings = @{email=$Email;agreeTerms=[bool]$AgreeLetsEncryptTerms;publishPortfolio=(-not [bool]$SkipPortfolio);sha256=$sha;revision=$revision}
[IO.File]::WriteAllText($settingsFile,($settings | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
# The private file is uploaded separately; it is never added to the public ZIP.
$privateName = [IO.Path]::GetFileName($PrivateEnvPath)
if ($privateName -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Use an ASCII filename for the private environment file.' }
& scp.exe $archive $PrivateEnvPath $settingsFile "${target}:$upload/"
if ($LASTEXITCODE -ne 0) { throw 'Transfer failed; no installation was started.' }
$bootstrap = @'
set -euo pipefail
umask 077
python3 - <<'VOICE_EXTRACT'
import hashlib,json,os,stat,subprocess,zipfile
from pathlib import Path
upload=Path('__UPLOAD__')
if upload.is_symlink() or not upload.resolve().is_relative_to(Path('/root/.cache')):raise SystemExit('Unsafe upload path')
settings=json.loads((upload/'deploy-settings.json').read_text())
if settings['sha256']!='__SHA__' or settings['revision']!='__REVISION__':raise SystemExit('Upload contract differs')
archive=upload/'voicerooms-public.zip'
if hashlib.sha256(archive.read_bytes()).hexdigest()!=settings['sha256']:raise SystemExit('Source SHA256 mismatch')
base=Path('/opt/voicerooms');releases=base/'releases'
if base.is_symlink() or releases.is_symlink():raise SystemExit('Unsafe release directory')
releases.mkdir(parents=True,exist_ok=True)
release=releases/settings['revision']
if release.is_symlink():raise SystemExit('Unsafe release path')
release.mkdir(parents=True,exist_ok=True);release.chmod(0o755)
with zipfile.ZipFile(archive) as z:
 if len(z.infolist())>1000 or sum(i.file_size for i in z.infolist())>25*1024*1024:raise SystemExit('Unexpected archive size')
 for i in z.infolist():
  p=Path(i.filename)
  if p.is_absolute() or '..' in p.parts or any(x in {'android','.git','.generated','.venv','.qa','node_modules'} for x in p.parts) or p.name=='.env' or p.suffix in {'.apk','.jks','.keystore'} or stat.S_ISLNK(i.external_attr>>16):raise SystemExit('Private or unsafe archive entry')
  target=release/p
  if not target.resolve().is_relative_to(release.resolve()) or target.is_symlink():raise SystemExit('Unsafe source path')
  if i.is_dir():target.mkdir(parents=True,exist_ok=True);target.chmod(0o755);continue
  target.parent.mkdir(parents=True,exist_ok=True)
  for parent in target.parents:
   if parent==release:break
   parent.chmod(0o755)
  if target.exists() and target.read_bytes()!=z.read(i):raise SystemExit('An existing release was modified; refusing overwrite')
  target.write_bytes(z.read(i));target.chmod(0o644)
private=upload/'__PRIVATE__';private.chmod(0o600)
command=['python3',str(release/'deploy/install.py'),'--env-upload',str(private),'--email',settings['email']]
if settings['agreeTerms']:command.append('--agree-terms')
if settings['publishPortfolio']:command.append('--publish-portfolio')
subprocess.run(command,check=True)
private.unlink()
print('Completed release '+settings['revision'][:12]+'. Private transfer file removed.')
VOICE_EXTRACT
'@
$bootstrap = $bootstrap.Replace('__UPLOAD__',$upload).Replace('__SHA__',$sha).Replace('__REVISION__',$revision).Replace('__PRIVATE__',$privateName)
Write-Host "Public source: $revision; SHA256 verified on the host. Private configuration travels separately."
Invoke-RemoteScript $bootstrap
Write-Host 'Ready: https://voise.24projects.ru/ and https://24projects.ru/projects/voicerooms'
