<#
.SYNOPSIS
    Bring a bpmn-text install up to date and check that it works: the code, the npm packages, Chromium, the
    build, the bpmn-text command and, optionally, the Docker images, the tests and a running web editor.

.DESCRIPTION
    Run it after every pull, or when something misbehaves after a change. Each step says what it does, and the
    script stops at the first step that fails, with what to do about it. scripts/update.sh does the same on
    Linux and macOS.

    Run from outside a checkout, for example straight from the repository, it clones the repository first (to
    ~\bpmn-text, or -Dir) and carries on there, so one command goes from nothing to a working install:

      & ([scriptblock]::Create((irm https://raw.githubusercontent.com/markbac/bpmn-text/main/scripts/update.ps1))) -Serve

      1. Code       git pull --ff-only (skipped with -NoPull, or when this is not a Git checkout). When the
                    pull changes this script, the new version runs instead, with the same options
      2. Node       Node.js 20.19+ or 22.12+, and npm
      3. Packages   npm ci, when package-lock.json changed since the last one
      4. Chromium   for SVG and PNG output (Playwright's copy); skipped with -NoBrowser
      5. Build      every package and the web editor
      6. Command    bpmn-text on the PATH is this checkout (npm link); -NoLink leaves it alone
      7. Docker     with -Docker: the editor and CLI images, tagged with the version and latest, and the
                    images of earlier versions removed unless -KeepOldImages
      8. Doctor     bpmn-text turns an example into .bpmn and .png
      9. Tests      with -Test: lint, typecheck and the test suite
     10. Serve      with -Serve: the web editor on http://localhost:<Port>, in Docker with -Docker (left
                    running), else in this window until Ctrl+C

.PARAMETER NoPull
    Do not pull: use the code as it is.

.PARAMETER Test
    Also run lint, typecheck and the tests.

.PARAMETER Docker
    Also build the Docker images: bpmn-text-editor (the web editor) and bpmn-text (the CLI).

.PARAMETER Serve
    Start the web editor afterwards.

.PARAMETER Port
    The port for -Serve. Default 8080.

.PARAMETER NoLink
    Do not put bpmn-text on the PATH.

.PARAMETER NoBrowser
    Skip Chromium: .bpmn output works, SVG and PNG do not.

.PARAMETER KeepOldImages
    Keep the Docker images of earlier versions.

.PARAMETER CaFile
    The certificate of a TLS-inspecting proxy, for npm and the Docker builds.

.PARAMETER Dir
    Where to clone the repository when the script does not run from a checkout. Default ~\bpmn-text.

.PARAMETER Repo
    What to clone. Default the GitHub repository.

.EXAMPLE
    .\scripts\update.ps1
.EXAMPLE
    .\scripts\update.ps1 -Serve
.EXAMPLE
    .\scripts\update.ps1 -Docker -Serve -Port 8081
#>
# Options are named only: a stray word such as the "-" of "- Serve" is then reported as itself, rather than
# taken as the value of -Port.
[CmdletBinding(PositionalBinding = $false)]
param(
    [switch]$NoPull,
    [switch]$Test,
    [switch]$Docker,
    [switch]$Serve,
    [int]$Port = 8080,
    [switch]$NoLink,
    [switch]$NoBrowser,
    [switch]$KeepOldImages,
    [string]$CaFile,
    [string]$Dir = (Join-Path $HOME 'bpmn-text'),
    [string]$Repo = 'https://github.com/markbac/bpmn-text.git'
)

Set-StrictMode -Version Latest
# Programs report failure through their exit status, which every step checks. 'Stop' would also turn any line
# a program writes to stderr into an error in Windows PowerShell 5.1, so it is not used.
$ErrorActionPreference = 'Continue'
$script:Step = 0

function Write-Step([string]$Text) {
    $script:Step++
    Write-Host ""
    Write-Host "[$script:Step] $Text" -ForegroundColor Cyan
}

function Write-Ok([string]$Text) { Write-Host "    ok    $Text" -ForegroundColor Green }
function Write-Note([string]$Text) { Write-Host "    note  $Text" -ForegroundColor Yellow }

function Stop-Update([string]$Text, [string]$Advice) {
    Write-Host "    FAIL  $Text" -ForegroundColor Red
    if ($Advice) { Write-Host "          $Advice" -ForegroundColor Red }
    # Run as a script block from the console, exit would close the window.
    if ($PSCommandPath) { exit 1 } else { throw "bpmn-text update failed: $Text" }
}

# Runs a program, shows its output, and stops the update when it fails.
function Invoke-Checked([string]$What, [string]$Advice, [string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { Stop-Update "$What failed (exit status $LASTEXITCODE)" $Advice }
}

# The same, but shows the output only when the program fails.
function Invoke-Quiet([string]$What, [string]$Advice, [string]$Exe, [string[]]$Arguments) {
    $output = & $Exe @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        $output | Select-Object -Last 40 | ForEach-Object { Write-Host $_ }
        Stop-Update "$What failed (exit status $LASTEXITCODE)" $Advice
    }
}

# 0. A checkout: this one, or one cloned now. Run as a script block (piped from the repository), there is no
# script file, so no checkout around it.
$inCheckout = $PSScriptRoot -and (Test-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'packages/cli/package.json'))
if (-not $inCheckout) {
    Write-Step "Checkout"
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Stop-Update "git is not installed" "Install Git for Windows (winget install Git.Git) and open a new terminal"
    }
    if (Test-Path (Join-Path $Dir '.git')) {
        Write-Ok "using the checkout in $Dir"
    } else {
        Invoke-Checked "git clone" "Check that you can reach $Repo (a private repository needs your Git credentials)" git @('clone', '--quiet', $Repo, $Dir)
        Write-Ok "cloned $Repo to $Dir"
    }
    # The checkout's own script carries on, without the options that only matter here.
    $again = @{}
    foreach ($key in $PSBoundParameters.Keys) {
        if ($key -ne 'Dir' -and $key -ne 'Repo') { $again[$key] = $PSBoundParameters[$key] }
    }
    & (Join-Path $Dir 'scripts/update.ps1') @again
    if ($PSCommandPath) { exit $LASTEXITCODE } else { return }
}
$Root = Split-Path -Parent $PSScriptRoot
# PowerShell reads a script once, when it starts: a pull that changes this file needs the new copy started.
$script:SelfHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $PSCommandPath).Hash

Push-Location $Root
try {
    Write-Host "bpmn-text update in $Root"
    if ($CaFile) {
        if (-not (Test-Path -LiteralPath $CaFile)) { Stop-Update "-CaFile $CaFile does not exist" }
        $CaFile = (Resolve-Path -LiteralPath $CaFile).Path
        $env:NODE_EXTRA_CA_CERTS = $CaFile
        $env:npm_config_cafile = $CaFile
    }

    # 1. Code ------------------------------------------------------------------------------------
    Write-Step "Code"
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($NoPull) {
        Write-Note "not pulled (-NoPull)"
    } elseif (-not $git -or -not (Test-Path (Join-Path $Root '.git'))) {
        Write-Note "not a Git checkout, so nothing to pull"
    } else {
        $branch = (& git rev-parse --abbrev-ref HEAD).Trim()
        if ($branch -ne 'main') { Write-Note "on branch $branch, not main" }
        $dirty = & git status --porcelain --untracked-files=no
        if ($dirty) { Write-Note "local changes to tracked files are kept; a pull that would touch them stops here" }
        Invoke-Checked "git pull" "Pull or merge by hand (the pull only fast-forwards), or run with -NoPull" git @('pull', '--ff-only')
        Write-Ok "$branch at $((& git log -1 --format='%h %s').Trim())"
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $PSCommandPath).Hash -ne $script:SelfHash) {
            Write-Note "the pull changed this script, so the new version runs now, with the same options"
            $again = @{}
            foreach ($key in $PSBoundParameters.Keys) { $again[$key] = $PSBoundParameters[$key] }
            $again['NoPull'] = $true
            & $PSCommandPath @again
            exit $LASTEXITCODE
        }
    }

    # 2. Node ------------------------------------------------------------------------------------
    Write-Step "Node"
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Stop-Update "node is not installed" "Install Node.js 22 LTS from https://nodejs.org (winget install OpenJS.NodeJS.LTS)"
    }
    $nodeVersion = (& node -p 'process.versions.node').Trim()
    & node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit((a === 20 && b >= 19) || (a === 22 && b >= 12) || a > 22 ? 0 : 1)'
    if ($LASTEXITCODE -ne 0) { Stop-Update "Node.js $nodeVersion is too old" "bpmn-text needs Node.js 20.19+ or 22.12+; install 22 LTS" }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Stop-Update "npm is not installed" "It comes with Node.js; reinstall Node.js" }
    Write-Ok "Node.js $nodeVersion, npm $((& npm --version).Trim())"

    # 3. Packages --------------------------------------------------------------------------------
    Write-Step "Packages"
    $installed = Join-Path $Root 'node_modules/.package-lock.json'
    $lock = Join-Path $Root 'package-lock.json'
    if ((Test-Path $installed) -and (Get-Item $lock).LastWriteTimeUtc -le (Get-Item $installed).LastWriteTimeUtc) {
        Write-Ok "up to date with package-lock.json"
    } else {
        Invoke-Checked "npm ci" "Read npm's message above; behind a proxy, set HTTPS_PROXY or use -CaFile" npm @('ci', '--no-audit', '--no-fund')
        Write-Ok "installed from package-lock.json"
    }

    # 4. Chromium --------------------------------------------------------------------------------
    Write-Step "Chromium"
    if ($NoBrowser) {
        Write-Note "skipped (-NoBrowser): .bpmn output works, SVG and PNG do not"
    } else {
        Invoke-Checked "installing Chromium" "Read the message above; behind a proxy, set HTTPS_PROXY or use -CaFile" npx @('--no-install', 'playwright-core', 'install', 'chromium')
        Write-Ok "Chromium for SVG and PNG output"
    }

    # 5. Build -----------------------------------------------------------------------------------
    Write-Step "Build"
    Invoke-Quiet "npm run build" "The compiler's message is above. Run with -Test to see which test fails" npm @('run', 'build')
    $version = (& node -p 'require("./packages/cli/package.json").version').Trim()
    Write-Ok "bpmn-text $version, and the web editor in apps/editor/dist"

    # 6. Command ---------------------------------------------------------------------------------
    Write-Step "Command"
    $cli = Join-Path $Root 'packages/cli/dist/cli.js'
    if ($NoLink) {
        Write-Note "PATH left alone (-NoLink); run node $cli"
    } else {
        & npm link -w packages/cli --no-audit --no-fund --silent 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "bpmn-text is linked to this checkout"
        } else {
            Write-Note "npm link could not write to $((& npm prefix -g).Trim()); run this in a terminal that may, or use -NoLink"
        }
        $command = Get-Command bpmn-text -ErrorAction SilentlyContinue
        if ($command) {
            Write-Ok "bpmn-text on the PATH: $($command.Source) (open a new terminal if it is not found there)"
        } else {
            Write-Note "bpmn-text is not on the PATH yet: open a new terminal"
        }
    }

    # 7. Docker ----------------------------------------------------------------------------------
    if ($Docker) {
        Write-Step "Docker"
        if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Stop-Update "docker is not installed" "Install Docker Desktop, or Docker Engine in WSL 2" }
        & docker info *> $null
        if ($LASTEXITCODE -ne 0) { Stop-Update "the Docker engine does not answer" "Start Docker Desktop (or the engine in WSL 2) and run this again" }
        $secret = @()
        if ($CaFile) { $secret = @('--secret', "id=ca,src=$CaFile") }
        foreach ($target in @('editor', 'cli')) {
            $image = if ($target -eq 'editor') { 'bpmn-text-editor' } else { 'bpmn-text' }
            Invoke-Checked "building the $target image" "Read the build output above; behind a proxy, use -CaFile" docker (@('build') + $secret + @('--target', $target, '-t', "${image}:$version", '-t', "${image}:latest", '.'))
            Write-Ok "${image}:$version"
            if (-not $KeepOldImages) {
                foreach ($old in @(& docker images $image --format '{{.Tag}}' | Where-Object { $_ -and $_ -ne 'latest' -and $_ -ne $version })) {
                    & docker rmi "${image}:$old" *> $null
                    if ($LASTEXITCODE -eq 0) { Write-Note "removed ${image}:$old" }
                }
            }
        }
    }

    # 8. Doctor ----------------------------------------------------------------------------------
    Write-Step "Doctor"
    $out = Join-Path ([System.IO.Path]::GetTempPath()) "bpmn-text-doctor-$PID"
    New-Item -ItemType Directory -Force -Path $out | Out-Null
    try {
        Invoke-Checked "bpmn-text build" "The message above says what went wrong" node @($cli, 'build', 'examples/01-simple.bpmnt', '-o', (Join-Path $out '01-simple.bpmn'))
        Write-Ok "examples/01-simple.bpmnt -> .bpmn"
        if (-not $NoBrowser) {
            Invoke-Checked "PNG output" "Run again without -NoBrowser, or read the message above" node @($cli, 'build', 'examples/01-simple.bpmnt', '-f', 'png', '-o', (Join-Path $out '01-simple.png'))
            Write-Ok "examples/01-simple.bpmnt -> .png"
        }
        if ($Docker) {
            Copy-Item (Join-Path $Root 'examples/01-simple.bpmnt') $out
            Invoke-Checked "the CLI image" "Rebuild it: .\scripts\update.ps1 -Docker" docker @('run', '--rm', '-v', "${out}:/work", "bpmn-text:$version", 'build', '01-simple.bpmnt', '-f', 'png', '-o', 'docker.png')
            Write-Ok "the CLI image turns an example into .png"
        }
    } finally {
        Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
    }

    # 9. Tests -----------------------------------------------------------------------------------
    if ($Test) {
        Write-Step "Tests"
        Invoke-Checked "lint" "Run npm run format, or fix what ESLint reports" npm @('run', 'lint', '--silent')
        Invoke-Checked "typecheck" "Fix the type errors above" npm @('run', 'typecheck', '--silent')
        Invoke-Checked "tests" "A test failed: see above" npm @('test', '--silent')
        Write-Ok "lint, typecheck and tests pass"
    }

    # 10. Serve ----------------------------------------------------------------------------------
    if ($Serve) {
        Write-Step "Serve"
        if ($Docker) {
            $env:BPMN_TEXT_PORT = "$Port"
            Invoke-Checked "starting the editor" "Is port $Port free? Choose another with -Port" docker @('compose', 'up', '-d', '--force-recreate', 'editor')
            Write-Ok "the web editor runs at http://localhost:$Port (docker compose down to stop it)"
        } else {
            Write-Ok "the web editor at http://localhost:$Port (Ctrl+C to stop)"
            # '--' is quoted, or PowerShell would take it for itself when npm is npm.ps1.
            & npm @('run', 'preview', '-w', 'apps/editor', '--', '--port', "$Port", '--strictPort')
            exit $LASTEXITCODE
        }
    }

    Write-Host ""
    Write-Host "bpmn-text $version is up to date." -ForegroundColor Green
    Write-Host "  Use it:        bpmn-text build diagram.bpmnt -f svg"
    Write-Host "  Web editor:    $PSCommandPath -Serve"
    Write-Host "  Update later:  $PSCommandPath"
} finally {
    Pop-Location
}
