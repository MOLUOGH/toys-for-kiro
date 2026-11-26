# Builds dist\toys-for-kiro-<version>.vsix without vsce (a VSIX is a zip with a manifest).
#   .\scripts\package.ps1
# Install:  & "<Kiro install dir>\bin\kiro.cmd" --install-extension dist\toys-for-kiro-<version>.vsix
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content -Raw -Encoding UTF8 (Join-Path $root 'package.json') | ConvertFrom-Json
$include = @('package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'src', 'media')

function Escape-Xml([string]$s) { [System.Security.SecurityElement]::Escape($s) }

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="$(Escape-Xml $pkg.name)" Version="$(Escape-Xml $pkg.version)" Publisher="$(Escape-Xml $pkg.publisher)" />
    <DisplayName>$(Escape-Xml $pkg.displayName)</DisplayName>
    <Description xml:space="preserve">$(Escape-Xml $pkg.description)</Description>
    <Tags>$(Escape-Xml ($pkg.keywords -join ','))</Tags>
    <Categories>$(Escape-Xml ($pkg.categories -join ','))</Categories>
    <License>extension/LICENSE</License>
    <Icon>extension/$(Escape-Xml $pkg.icon)</Icon>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$(Escape-Xml $pkg.engines.vscode)" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="$(Escape-Xml ($pkg.extensionKind -join ','))" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/$(Escape-Xml $pkg.icon)" Addressable="true" />
  </Assets>
</PackageManifest>
"@

$contentTypes = @'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".css" ContentType="text/css" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".svg" ContentType="image/svg+xml" />
  <Default Extension=".png" ContentType="image/png" />
</Types>
'@

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$vsix = Join-Path $dist "$($pkg.name)-$($pkg.version).vsix"
if (Test-Path $vsix) { Remove-Item $vsix }

$utf8 = New-Object System.Text.UTF8Encoding $false
$zip = [System.IO.Compression.ZipFile]::Open($vsix, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($entry in @(@('[Content_Types].xml', $contentTypes), @('extension.vsixmanifest', $manifest))) {
        $e = $zip.CreateEntry($entry[0])
        $w = New-Object System.IO.StreamWriter($e.Open(), $utf8)
        $w.Write($entry[1])
        $w.Dispose()
    }
    $count = 0
    foreach ($item in $include) {
        $full = Join-Path $root $item
        $files = if (Test-Path $full -PathType Container) { Get-ChildItem $full -Recurse -File } else { Get-Item $full }
        foreach ($f in $files) {
            # Zip entry names must use forward slashes.
            $rel = $f.FullName.Substring($root.Length + 1).Replace('\', '/')
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, "extension/$rel") | Out-Null
            $count++
        }
    }
} finally {
    $zip.Dispose()
}
"Packaged $count files -> $vsix ($([math]::Round((Get-Item $vsix).Length / 1KB, 1)) KB)"
