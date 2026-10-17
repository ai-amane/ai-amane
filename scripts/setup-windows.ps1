# AI あまね かんたんセットアップ（Windows）の最初の段
#  Node.js・Python・Claude Code を調べて、足りなければ入れる。そのあと scripts/setup.js に引き継ぐ。
#  --check: 調べるだけ（何も入れない）。引数は scripts/setup.js にもそのまま渡す。
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'

$check = $args -contains '--check'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Say($msg) { Write-Host $msg }

# 入れたあとに、この窓の PATH を読み直す（窓を開き直さなくても続けられるように）
function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @()
  foreach ($p in (@($machine, $user, $env:Path) -join ';').Split(';')) {
    if ($p -and ($parts -notcontains $p)) { $parts += $p }
  }
  $env:Path = $parts -join ';'
}

# 手で入れる案内を出して止まる
function Stop-Setup($name, $readme, $url) {
  Say ''
  Say "[失敗] $name を入れられませんでした。"
  Say "  手で入れる場合は、README の $readme を見てください。"
  Say "  公式のページ: $url"
  exit 1
}

function Get-NodeMajor {
  try {
    $v = (& node -v 2>$null | Out-String).Trim()
    if ($v -match '^v(\d+)\.') { return [int]$Matches[1], $v }
  } catch { }
  return $null
}

# Python の (メジャー, マイナー) を返す。無い・Microsoft Store の入口だけのときは $null
function Get-PythonVersion {
  try {
    $out = (& python -c "import sys;print(sys.version_info[0],sys.version_info[1])" 2>$null | Out-String).Trim()
    if ($out -match '^(\d+) (\d+)$') { return @([int]$Matches[1], [int]$Matches[2]) }
  } catch { }
  return $null
}

function Test-ClaudeCode {
  return [bool](Get-Command claude -ErrorAction SilentlyContinue)
}

function Add-UserPath($dir) {
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $has = ($user -split ';') -contains $dir
  if (-not $has) {
    [Environment]::SetEnvironmentVariable('Path', ((@($user, $dir) | Where-Object { $_ }) -join ';'), 'User')
  }
}

Say '=== AI あまね かんたんセットアップ ==='
if ($check) { Say '（--check: 調べるだけです。何も入れません）' }
Update-SessionPath

# --- 何が足りないか調べる ---
$nodeInfo = Get-NodeMajor
$nodeOk = $nodeInfo -and ($nodeInfo[0] -ge 18)
$py = Get-PythonVersion
$pyOk = $py -and ($py[0] -eq 3) -and ($py[1] -ge 10) -and ($py[1] -le 12)
$claudeOk = Test-ClaudeCode
$hasWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)
$needWinget = (-not $nodeOk) -or (-not $pyOk)

if ($needWinget -and -not $hasWinget) {
  if ($check) {
    Say 'winget: 見つかりません（実行するときは、Microsoft Store で「アプリ インストーラー」を更新してください）'
  } else {
    Say 'winget（Windows のソフトの入れ方）が見つかりません。'
    Say 'Microsoft Store で「アプリ インストーラー」を更新してください。'
    Say '更新できないときは、次のページを開きますので、手で入れてください（README の 3-2、3-3）。'
    if (-not $nodeOk) { Say '  Node.js: https://nodejs.org/ja'; Start-Process 'https://nodejs.org/ja' }
    if (-not $pyOk) { Say '  Python 3.12: https://www.python.org/downloads/ （「Add python.exe to PATH」に必ずチェック）'; Start-Process 'https://www.python.org/downloads/' }
    Say '入れ終わったら、setup.bat をもう一度ダブルクリックしてください。'
    exit 1
  }
}

if ($needWinget -and -not $check) {
  Say ''
  Say '管理者の許可を求める画面（UAC）が出ることがあります。許可を求められたら「はい」を押してください。'
}

# --- Node.js ---
if ($nodeOk) {
  Say "Node.js: すでに入っています（$($nodeInfo[1])）"
} elseif ($check) {
  Say 'Node.js: 入れる予定です（winget で OpenJS.NodeJS.LTS）'
} else {
  if ($nodeInfo) { Say "Node.js: 古い版です（$($nodeInfo[1])）。18 以上を入れます…" } else { Say 'Node.js を入れます…' }
  & winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  Update-SessionPath
  $nodeInfo = Get-NodeMajor
  if ($nodeInfo -and $nodeInfo[0] -ge 18) { Say "Node.js: 入れました（$($nodeInfo[1])）" }
  else { Stop-Setup 'Node.js' 'README の 3-2' 'https://nodejs.org/ja' }
}

# --- Python ---
if ($pyOk) {
  Say "Python: すでに入っています（$($py[0]).$($py[1])）"
} elseif ($check) {
  if ($py) { Say "Python: $($py[0]).$($py[1]) が入っていますが、3.10〜3.12 ではないので、3.12 を入れる予定です" }
  else { Say 'Python: 入れる予定です（winget で Python.Python.3.12）' }
} else {
  if ($py -and $py[1] -gt 12) { Say "Python: $($py[0]).$($py[1]) が入っていますが、音声認識には 3.10〜3.12 が必要です。3.12 を入れます…" }
  elseif ($py) { Say "Python: $($py[0]).$($py[1]) は古いので、3.12 を入れます…" }
  else { Say 'Python を入れます…' }
  & winget install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements --override "/quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1 Include_test=0"
  Update-SessionPath
  $py = Get-PythonVersion
  if ($py -and $py[0] -eq 3 -and $py[1] -ge 10 -and $py[1] -le 12) { Say "Python: 入れました（$($py[0]).$($py[1])）" }
  else {
    if ($py) { Say "  いま使われる python は $($py[0]).$($py[1]) です。古い Python を一度アンインストールするか、窓を開き直してもう一度 setup.bat を押してください。" }
    Stop-Setup 'Python' 'README の 3-3' 'https://www.python.org/downloads/'
  }
}

# --- Claude Code ---
if ($claudeOk) {
  $cv = ''
  try { $cv = (& claude --version 2>$null | Out-String).Trim() } catch { }
  Say "Claude Code: すでに入っています（$cv）"
} elseif ($check) {
  Say 'Claude Code: 入れる予定です（公式の install.ps1）'
} else {
  Say 'Claude Code を入れます…'
  & powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"
  Add-UserPath (Join-Path $env:USERPROFILE '.local\bin')
  Update-SessionPath
  if (Test-ClaudeCode) { Say 'Claude Code: 入れました' }
  else { Stop-Setup 'Claude Code' 'README の 3-4' 'https://code.claude.com/docs/en/setup' }
}

# --- 残りの段（Node.js 側） ---
if ($check -and -not $nodeOk) {
  Say ''
  Say 'Node.js が無いので、残りの段（.env・パッケージ・ログイン・AivisSpeech）は Node.js を入れてから調べます。'
  exit 0
}
Say ''
& node (Join-Path $root 'scripts\setup.js') @args
exit $LASTEXITCODE
