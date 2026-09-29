# schz-e2e-install-latest.ps1 -- the action of the magi-win scheduled task
# `schz-e2e-install` (runs as the local test account schztest, session 0).
#
# Deployed copy: E:\schz-e2e\install-latest.ps1 on magi-win. This file is the
# source of truth; after editing it, scp it over that path.
#
# WHY. Until 2026-09-29 the task's action was the literal
# `E:\schz-e2e\Scheherazade-Setup-0.3.0.exe /S`. Four releases later it was still
# installing 0.3.0, and nothing about a hard-coded filename could ever notice.
# So the task no longer names a version at all: it asks the public release feed
# which installer is current, the same way every installed copy's updater does.
#
# WHAT IT DOES.
#   1. GET <feed>/latest.yml from the releases repo's `latest` release (public,
#      no credentials: schztest has none) and read version / path / sha512.
#   2. If E:\schz-e2e\<path> is already there with the right sha512, reuse it;
#      otherwise download it to <path>.part, check sha512, then rename.
#   3. Run it with /S (silent NSIS, per-user install into schztest's profile).
#   Every step is appended to E:\schz-e2e\install-latest.log. Any failure exits
#   non-zero, so `schtasks /query /v` shows it in Last Result instead of
#   quietly installing whatever happened to be lying in the folder.
#
#   -ResolveOnly   print which release it WOULD install, download nothing.

param([switch]$ResolveOnly)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # PS 5.1's progress bar makes a 150 MB download crawl
$Feed = 'https://github.com/Mino-is-me/scheherazade-releases/releases/latest/download'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Log = Join-Path $Dir 'install-latest.log'

function Say([string]$m) {
  $line = "$(Get-Date -Format s) [$env:USERNAME] $m"
  Write-Output $line
  try { Add-Content -Path $Log -Value $line } catch { }
}

# electron-updater's sha512 is base64 of the raw digest; Get-FileHash gives hex.
function HashB64([string]$file) {
  $hex = (Get-FileHash -Algorithm SHA512 -Path $file).Hash
  $bytes = New-Object byte[] ($hex.Length / 2)
  for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }
  [Convert]::ToBase64String($bytes)
}

function YmlKey([string]$yml, [string]$key) {
  $m = [regex]::Match($yml, "(?m)^${key}:\s*(\S+)\s*$")
  if (-not $m.Success) { return $null }
  $m.Groups[1].Value.Trim("'", '"')
}

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $resp = Invoke-WebRequest -UseBasicParsing -Uri "$Feed/latest.yml"
  $yml = $resp.Content
  if ($yml -is [byte[]]) { $yml = [Text.Encoding]::UTF8.GetString($yml) }
  $version = YmlKey $yml 'version'
  $name = YmlKey $yml 'path'
  $sha = YmlKey $yml 'sha512'
  if (-not $version -or -not $name -or -not $sha) { throw "latest.yml did not carry version/path/sha512:`n$yml" }
  # The name becomes a local path; accept only the shape electron-builder writes.
  if ($name -notmatch '^Scheherazade-Setup-[0-9][0-9A-Za-z.\-]*\.exe$') { throw "unexpected installer name in latest.yml: $name" }
  Say "feed says latest = $version ($name)"
  if ($ResolveOnly) { exit 0 }

  $exe = Join-Path $Dir $name
  $have = (Test-Path $exe) -and ((HashB64 $exe) -eq $sha)
  if ($have) {
    Say "already staged with matching sha512: $exe"
  } else {
    $part = "$exe.part"
    if (Test-Path $part) { Remove-Item -Force $part }
    Say "downloading $Feed/$name"
    Invoke-WebRequest -UseBasicParsing -Uri "$Feed/$name" -OutFile $part
    $got = HashB64 $part
    if ($got -ne $sha) { Remove-Item -Force $part; throw "sha512 mismatch for ${name}: feed $sha, download $got" }
    Move-Item -Force $part $exe
    Say "staged $exe ($((Get-Item $exe).Length) B, sha512 ok)"
  }

  $p = Start-Process -FilePath $exe -ArgumentList '/S' -Wait -PassThru
  Say "installer $name /S exit $($p.ExitCode)"
  exit $p.ExitCode
} catch {
  Say "FAIL $($_.Exception.Message)"
  exit 1
}
