param([Parameter(Mandatory = $true)][string]$ExtensionId)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$hostExecutable = Join-Path $env:LOCALAPPDATA 'BrowserImageDownloader\ClipboardHost\ClipboardHost.exe'
$origin = "chrome-extension://$ExtensionId/"

function Invoke-HostRequest($Request, $Caller = $origin) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $hostExecutable
    $start.Arguments = $Caller
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $process = [Diagnostics.Process]::Start($start)
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes(($Request | ConvertTo-Json -Compress))
        $process.StandardInput.BaseStream.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
        $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
        $process.StandardInput.Close()
        $reader = New-Object IO.BinaryReader($process.StandardOutput.BaseStream)
        $length = $reader.ReadInt32()
        $reply = [Text.Encoding]::UTF8.GetString($reader.ReadBytes($length)) | ConvertFrom-Json
        if (!$process.WaitForExit(10000)) { $process.Kill(); throw 'Host timed out' }
        return $reply
    } finally { $process.Dispose() }
}

function Assert-True($Value, $Label) {
    if (!$Value) { throw "FAILED: $Label" }
    Write-Output "PASS: $Label"
}

Assert-True (Invoke-HostRequest @{action='ping'}).ok 'native messaging framing and health check'
Assert-True (!(Invoke-HostRequest @{action='ping'} 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/').ok) 'reject unregistered extension'
Assert-True (!(Invoke-HostRequest @{action='copyFiles';paths=@()}).ok) 'reject empty list'
Assert-True (!(Invoke-HostRequest @{action='copyFiles';paths=@('C:\missing-media-file.jpg')}).ok) 'reject missing file'
Assert-True (!(Invoke-HostRequest @{action='copyFiles';paths=@('C:\Windows\notepad.exe')}).ok) 'reject non-media file'
Assert-True (!(Invoke-HostRequest @{action='copyFiles';paths=@('\\server\share\photo.jpg')}).ok) 'reject network path'

$testDirectory = Join-Path ([IO.Path]::GetTempPath()) ('ClipboardHost-test-' + [guid]::NewGuid())
[IO.Directory]::CreateDirectory($testDirectory) | Out-Null
$picture = Join-Path $testDirectory '原图.jpg'
$video = Join-Path $testDirectory '视频.mp4'
[IO.File]::WriteAllBytes($picture, [byte[]]@(1,2,3))
[IO.File]::WriteAllBytes($video, [byte[]]@(4,5,6))
$snapshot = New-Object Windows.Forms.DataObject
$previous = [Windows.Forms.Clipboard]::GetDataObject()
if ($null -ne $previous) {
    foreach ($format in $previous.GetFormats($false)) {
        $data = $previous.GetData($format, $false)
        if ($null -ne $data) { $snapshot.SetData($format, $false, $data) }
    }
}
try {
    $result = Invoke-HostRequest @{action='copyFiles';paths=@($picture,$video,$picture)}
    Assert-True ($result.ok -and $result.count -eq 2) 'copy multiple files and deduplicate'
    $copied = [Windows.Forms.Clipboard]::GetFileDropList()
    Assert-True ($copied.Count -eq 2 -and $copied.Contains($picture) -and $copied.Contains($video)) 'persistent Windows file clipboard and Unicode paths'
    Assert-True (!(Invoke-HostRequest @{action='copyFiles';paths=@($picture,'C:\missing-media-file.jpg')}).ok) 'reject incomplete set'
    $unchanged = [Windows.Forms.Clipboard]::GetFileDropList()
    Assert-True ($unchanged.Count -eq 2 -and $unchanged.Contains($video)) 'failure preserves clipboard'
} finally {
    [Windows.Forms.Clipboard]::SetDataObject($snapshot, $true)
    # Leave the tiny fixtures in the temporary directory for inspection.
    Write-Output "Fixtures: $testDirectory"
}
