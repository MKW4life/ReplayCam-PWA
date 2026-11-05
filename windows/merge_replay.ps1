param(
  [Parameter(Mandatory=$true)]
  [string]$ZipPath
)
$ErrorActionPreference = 'Stop'
$ZipPath = (Resolve-Path -LiteralPath $ZipPath).Path
if (-not $ZipPath.EndsWith('.zip', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'ReplayCamが書き出したZIPファイルを指定してください。'
}
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  throw 'FFmpegが見つかりません。FFmpegをインストールし、PATHに追加してから再実行してください。'
}
$tmp = Join-Path $env:TEMP ('ReplayCam_' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $tmp -Force
  $videos = @(Get-ChildItem -LiteralPath $tmp -File | Where-Object { $_.Extension -in @('.mp4', '.webm') } | Sort-Object Name)
  if ($videos.Count -eq 0) { throw 'ZIP内に動画が見つかりません。' }
  $ext = $videos[0].Extension.ToLowerInvariant()
  if (@($videos | Where-Object { $_.Extension.ToLowerInvariant() -ne $ext }).Count -gt 0) {
    throw '動画形式が混在しています。すべて同じ形式にしてください。'
  }
  $list = Join-Path $tmp 'input.txt'
  $lines = @($videos | ForEach-Object { "file '" + $_.Name.Replace("'", "'\''") + "'" })
  [System.IO.File]::WriteAllLines($list, [string[]]$lines, ([System.Text.UTF8Encoding]::new($false)))
  $out = [System.IO.Path]::ChangeExtension($ZipPath, $ext)
  Write-Host "動画を結合中: $($videos.Count) 区間"
  & ffmpeg -hide_banner -y -f concat -safe 0 -i $list -c copy $out
  if ($LASTEXITCODE -ne 0) {
    throw '結合に失敗しました。区間のコーデックやタイムスタンプが異なる可能性があります。'
  }
  Write-Host "完了: $out"
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
