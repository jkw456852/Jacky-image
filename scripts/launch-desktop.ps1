# Keep this file encoded as UTF-8 with BOM for Windows PowerShell 5.1.
param(
  [ValidateSet('menu', 'smart', 'preview', 'debug', 'rebuild', 'final', 'make', 'logs', 'shortcut')]
  [string]$Mode = 'menu'
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = $Utf8NoBom
try {
  [Console]::InputEncoding = $Utf8NoBom
  [Console]::OutputEncoding = $Utf8NoBom
} catch {
  # Console encoding can be unavailable when the launcher is redirected.
}
$RootDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RuntimeDirectory = Join-Path $RootDirectory 'build\desktop-runtime'
$RuntimeBackend = Join-Path $RuntimeDirectory 'backend\server.js'
$RuntimeFrontend = Join-Path $RuntimeDirectory 'frontend\out\index.html'
$RuntimeMarker = Join-Path $RuntimeDirectory '.prepared.json'
$RootElectron = Join-Path $RootDirectory 'node_modules\electron\dist\electron.exe'
$FrontendNext = Join-Path $RootDirectory 'frontend\node_modules\next\package.json'
$BackendPackage = Join-Path $RootDirectory 'backend\package.json'
$RuntimeLog = Join-Path $env:APPDATA 'Jacky Image\logs\jacky-image.log'
$PublicDirectory = if ($env:PUBLIC) { $env:PUBLIC } else { 'C:\Users\Public' }
$FinalExecutable = Join-Path $PublicDirectory 'JackyImageBuild\out\Jacky Image-win32-x64\Jacky Image.exe'

Set-Location $RootDirectory

function Write-Section([string]$Text) {
  Write-Host ''
  Write-Host ('=' * 68) -ForegroundColor DarkCyan
  Write-Host "  $Text" -ForegroundColor Cyan
  Write-Host ('=' * 68) -ForegroundColor DarkCyan
}

function Invoke-Npm([string[]]$Arguments, [string]$WorkingDirectory = $RootDirectory) {
  Push-Location $WorkingDirectory
  try {
    & npm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "npm 命令执行失败，退出码：$LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Assert-NodeEnvironment {
  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    throw '没有找到 Node.js，请先安装项目要求的 Node.js 版本。'
  }
  if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw '没有找到 npm，请检查 Node.js 安装。'
  }
}

function Ensure-Dependencies {
  Assert-NodeEnvironment

  if (-not (Test-Path $RootElectron)) {
    Write-Section '首次准备：安装根目录 Electron 和打包依赖'
    Invoke-Npm @('install')
  }

  if (-not (Test-Path $FrontendNext)) {
    Write-Section '首次准备：安装前端依赖'
    Invoke-Npm @('ci') (Join-Path $RootDirectory 'frontend')
  }

  if (-not (Test-Path (Join-Path $RootDirectory 'backend\node_modules'))) {
    Write-Section '首次准备：安装后端开发依赖'
    Invoke-Npm @('ci') (Join-Path $RootDirectory 'backend')
  }
}

function Test-DevelopmentAppRunning {
  $electronRunning = Get-Process electron -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $RootElectron } |
    Select-Object -First 1
  $backendRunning = Get-Process node -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq (Join-Path $RuntimeDirectory 'node.exe') } |
    Select-Object -First 1
  return [bool]($electronRunning -or $backendRunning)
}

function Get-LatestSourceWriteTime {
  $sourcePaths = @(
    (Join-Path $RootDirectory 'frontend\src'),
    (Join-Path $RootDirectory 'frontend\next.config.ts'),
    (Join-Path $RootDirectory 'frontend\package.json'),
    (Join-Path $RootDirectory 'frontend\package-lock.json'),
    (Join-Path $RootDirectory 'backend\server.js'),
    (Join-Path $RootDirectory 'backend\prompts.json'),
    (Join-Path $RootDirectory 'backend\seat-cover-prompts'),
    (Join-Path $RootDirectory 'backend\blacklist.json'),
    (Join-Path $RootDirectory 'backend\package.json'),
    (Join-Path $RootDirectory 'backend\package-lock.json'),
    (Join-Path $RootDirectory 'scripts\prepare-electron-runtime.mjs')
  )

  $latest = [DateTime]::MinValue
  foreach ($sourcePath in $sourcePaths) {
    if (-not (Test-Path $sourcePath)) { continue }
    $item = Get-Item $sourcePath
    if ($item.PSIsContainer) {
      $candidate = Get-ChildItem $sourcePath -Recurse -File |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
      if ($candidate -and $candidate.LastWriteTimeUtc -gt $latest) {
        $latest = $candidate.LastWriteTimeUtc
      }
    } elseif ($item.LastWriteTimeUtc -gt $latest) {
      $latest = $item.LastWriteTimeUtc
    }
  }
  return $latest
}

function Test-DesktopRebuildRequired {
  if (-not (Test-Path $RuntimeBackend) -or -not (Test-Path $RuntimeFrontend) -or -not (Test-Path $RuntimeMarker)) {
    return $true
  }

  $runtimeTime = (Get-Item $RuntimeMarker).LastWriteTimeUtc

  return ((Get-LatestSourceWriteTime) -gt $runtimeTime)
}

function Prepare-Desktop([bool]$Force = $false) {
  Ensure-Dependencies
  if ($Force -or (Test-DesktopRebuildRequired)) {
    if (Test-DevelopmentAppRunning) {
      throw '开发版仍在后台运行，无法覆盖桌面运行环境。请在 Windows 系统托盘中右键 Jacky Image 并选择“退出 Jacky Image”，然后再重新构建。'
    }
    Write-Section '检测到源码变化，正在重新构建桌面运行环境'
    Invoke-Npm @('run', 'desktop:prepare')
  } else {
    & node.exe (Join-Path $RootDirectory 'scripts\remove-intelligent-conversation-residue.mjs')
    if ($LASTEXITCODE -ne 0) {
      throw "智能对话模式残留清理失败，退出码：$LASTEXITCODE"
    }
    Write-Host '桌面运行环境已经是最新状态，跳过构建。' -ForegroundColor Green
  }
}

function Start-Preview([bool]$OpenDevTools, [bool]$ForceRebuild = $false) {
  if (Test-DevelopmentAppRunning) {
    Write-Host 'Jacky Image 开发版已经在运行或隐藏到系统托盘。请从托盘重新打开；切换模式或重建前请在托盘中选择“退出 Jacky Image”。' -ForegroundColor Yellow
    return
  }
  Prepare-Desktop $ForceRebuild
  if ($OpenDevTools) {
    Write-Section '启动 Jacky Image 调试模式（自动打开 DevTools）'
    Invoke-Npm @('run', 'desktop:debug')
  } else {
    Write-Section '启动 Jacky Image 预览模式'
    Invoke-Npm @('run', 'desktop:preview')
  }
}

function Start-FinalBuild {
  if (-not (Test-Path $FinalExecutable)) {
    Write-Host '没有找到最终打包版。' -ForegroundColor Yellow
    $answer = Read-Host '是否现在生成 Windows 安装包和便携版？(Y/N)'
    if ($answer -notmatch '^[Yy]$') { return }
    Build-Distributables
  }

  if (Test-Path $FinalExecutable) {
    Write-Section '启动最终打包版'
    Start-Process -FilePath $FinalExecutable
  }
}

function Build-Distributables {
  Ensure-Dependencies
  Write-Section '生成 Windows 安装包和便携 ZIP'
  Invoke-Npm @('run', 'desktop:make')
  Write-Host ''
  Write-Host "构建完成：$RootDirectory\release" -ForegroundColor Green
  Start-Process explorer.exe -ArgumentList (Join-Path $RootDirectory 'release')
}

function Open-RuntimeLog {
  if (Test-Path $RuntimeLog) {
    Start-Process notepad.exe -ArgumentList $RuntimeLog
    return
  }

  $logDirectory = Split-Path $RuntimeLog
  if (Test-Path $logDirectory) {
    Start-Process explorer.exe -ArgumentList $logDirectory
  } else {
    Write-Host '运行日志尚未生成，请先启动一次应用。' -ForegroundColor Yellow
  }
}

function New-DesktopShortcut {
  $launcherPath = Join-Path $RootDirectory '启动 Jacky Image 开发版.cmd'
  $desktopDirectory = [Environment]::GetFolderPath('Desktop')
  $shortcutPath = Join-Path $desktopDirectory 'Jacky Image 开发启动.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $launcherPath
  $shortcut.WorkingDirectory = $RootDirectory
  $shortcut.Description = '启动 Jacky Image 开发预览和调试工具'
  if (Test-Path $FinalExecutable) {
    $shortcut.IconLocation = "$FinalExecutable,0"
  } elseif (Test-Path $RootElectron) {
    $shortcut.IconLocation = "$RootElectron,0"
  }
  $shortcut.Save()
  Write-Host "桌面快捷方式已创建：$shortcutPath" -ForegroundColor Green
}

function Show-Menu {
  Clear-Host
  Write-Host 'Jacky Image Studio - 开发快捷启动器' -ForegroundColor Cyan
  Write-Host "项目：$RootDirectory" -ForegroundColor DarkGray
  Write-Host ''
  Write-Host '[1] 智能启动（推荐：源码有变化时自动构建，预览模式）'
  Write-Host '[2] 快速预览（使用最近构建，不打开 DevTools）'
  Write-Host '[3] 调试模式（使用最近构建，自动打开 DevTools）'
  Write-Host '[4] 强制重新构建并调试'
  Write-Host '[5] 启动最终打包版'
  Write-Host '[6] 生成 Windows 安装包和便携 ZIP'
  Write-Host '[7] 查看运行日志'
  Write-Host '[8] 创建桌面快捷方式'
  Write-Host '[Q] 退出'
  Write-Host ''

  $selection = Read-Host '请选择（直接回车默认 1）'
  if ([string]::IsNullOrWhiteSpace($selection)) { $selection = '1' }

  switch ($selection.ToUpperInvariant()) {
    '1' { Start-Preview $false $false }
    '2' {
      Ensure-Dependencies
      if (-not (Test-Path $RuntimeBackend) -or -not (Test-Path $RuntimeFrontend) -or -not (Test-Path $RuntimeMarker)) {
        Prepare-Desktop $true
      }
      Write-Host '提示：快速预览不会检查源码是否比构建结果更新。' -ForegroundColor Yellow
      Invoke-Npm @('run', 'desktop:preview')
    }
    '3' { Start-Preview $true $false }
    '4' { Start-Preview $true $true }
    '5' { Start-FinalBuild }
    '6' { Build-Distributables }
    '7' { Open-RuntimeLog }
    '8' { New-DesktopShortcut }
    'Q' { return }
    default { throw "未知选项：$selection" }
  }
}

try {
  switch ($Mode) {
    'smart' { Start-Preview $false $false }
    'preview' { Start-Preview $false $false }
    'debug' { Start-Preview $true $false }
    'rebuild' { Start-Preview $true $true }
    'final' { Start-FinalBuild }
    'make' { Build-Distributables }
    'logs' { Open-RuntimeLog }
    'shortcut' { New-DesktopShortcut }
    default { Show-Menu }
  }
} catch {
  Write-Host ''
  Write-Host "启动失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host '可查看 DEVELOPMENT_LOG.md 或应用运行日志继续排查。' -ForegroundColor Yellow
  exit 1
}
