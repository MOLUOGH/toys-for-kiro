# Runs Node.js scripts. Uses `node` from PATH when available, otherwise Kiro's
# bundled Electron in Node mode (same runtime as the extension host).
#   .\scripts\node.ps1 --test test\
#   .\scripts\node.ps1 scripts\inspect.js
$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    & $node.Source @args
    exit $LASTEXITCODE
}

$kiro = $env:KIRO_EXE
if (-not $kiro) {
    $candidates = @(
        (Get-Process -Name Kiro -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path),
        "$env:LOCALAPPDATA\Programs\Kiro\Kiro.exe",
        "$env:ProgramFiles\Kiro\Kiro.exe"
    ) | Where-Object { $_ -and (Test-Path $_) }
    $kiro = $candidates | Select-Object -First 1
}
if (-not $kiro) { throw 'Node.js not found. Install Node 22.13+ or set KIRO_EXE to Kiro.exe.' }

# Kiro.exe is a GUI-subsystem binary: its stdout only reaches us through redirection.
$out = [IO.Path]::GetTempFileName()
$err = [IO.Path]::GetTempFileName()
$quoted = $args | ForEach-Object { if ("$_" -match '\s') { '"' + $_ + '"' } else { "$_" } }
$prev = $env:ELECTRON_RUN_AS_NODE
$env:ELECTRON_RUN_AS_NODE = '1'
try {
    $p = Start-Process -FilePath $kiro -ArgumentList $quoted -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $out -RedirectStandardError $err
    Get-Content -Encoding UTF8 $out
    Get-Content -Encoding UTF8 $err | Where-Object { $_ -notmatch 'ExperimentalWarning|--trace-warnings' }
    exit $p.ExitCode
} finally {
    $env:ELECTRON_RUN_AS_NODE = $prev
    Remove-Item $out, $err -ErrorAction SilentlyContinue
}
