param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId
)

$ErrorActionPreference = 'Stop'
$installDirectory = Join-Path $env:LOCALAPPDATA 'BrowserImageDownloader\ClipboardHost'
$hostExecutable = Join-Path $installDirectory 'ClipboardHost.exe'
$manifestPath = Join-Path $installDirectory 'host.json'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (!(Test-Path -LiteralPath $compiler)) { throw '需要 Windows .NET Framework 4.x 才能安装本机小助手' }
[IO.Directory]::CreateDirectory($installDirectory) | Out-Null
& $compiler /nologo /target:winexe "/out:$hostExecutable" /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll (Join-Path $PSScriptRoot 'ClipboardHost.cs')
if ($LASTEXITCODE -ne 0) { throw '本机小助手编译失败' }
$manifest = @{
    name = 'com.browser_image_downloader.clipboard'
    description = 'Copy downloaded post media files to the Windows clipboard'
    path = $hostExecutable
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json
[IO.File]::WriteAllText($manifestPath, $manifest, (New-Object Text.UTF8Encoding($false)))
$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.browser_image_downloader.clipboard'
New-Item -Path $registryPath -Force | Out-Null
Set-Item -LiteralPath $registryPath -Value $manifestPath
Write-Output "本机小助手已安装：$installDirectory"
Write-Output '请重新加载扩展，再打开插件弹窗复制文件。更换扩展 ID 后需重新运行此安装脚本。'
