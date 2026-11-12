# Minimal static file server for previewing a folder in a browser (no Node/Python needed).
# Defaults to the app UI (ui/); pass -Dir ..\site to preview the website.
param([int]$Port = 8123, [string]$Dir = '..\ui')
$root = (Resolve-Path (Join-Path $PSScriptRoot $Dir)).Path
$mime = @{ '.html'='text/html'; '.js'='text/javascript'; '.css'='text/css'; '.json'='application/json'; '.svg'='image/svg+xml'; '.png'='image/png' }
$l = [System.Net.HttpListener]::new(); $l.Prefixes.Add("http://127.0.0.1:$Port/"); $l.Start()
Write-Host "Serving $root on http://127.0.0.1:$Port/"
while ($l.IsListening) {
  $c = $l.GetContext(); $p = $c.Request.Url.LocalPath.TrimStart('/'); if ($p -eq '') { $p = 'index.html' }
  $f = [System.IO.Path]::GetFullPath((Join-Path $root $p))
  if ($f.StartsWith($root) -and (Test-Path $f -PathType Leaf)) {
    $b = [System.IO.File]::ReadAllBytes($f); $c.Response.ContentType = $mime[[System.IO.Path]::GetExtension($f)]; $c.Response.Headers.Add('Cache-Control','no-store')
    $c.Response.OutputStream.Write($b, 0, $b.Length)
  } else { $c.Response.StatusCode = 404 }
  $c.Response.Close()
}
