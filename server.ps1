# LeadRadar Local Server - Powered by .NET HttpListener
# Works on any Windows machine - no Node.js or Python required

param([int]$Port = 3500)

$root = $PSScriptRoot   # Folder where this script lives

# MIME type map
$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.json' = 'application/json'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
  '.woff2'= 'font/woff2'
  '.woff' = 'font/woff'
  '.ttf'  = 'font/ttf'
}

# Files that must NEVER be cached by the browser (always serve fresh)
$noCacheExtensions = @('.js', '.css', '.html')

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()

Write-Host ""
Write-Host "  =================================" -ForegroundColor Cyan
Write-Host "   LeadRadar Server Running!       " -ForegroundColor Green
Write-Host "  =================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Open this URL in your browser:" -ForegroundColor White
Write-Host "  http://localhost:$Port" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Press Ctrl+C to stop the server" -ForegroundColor Gray
Write-Host ""

# Auto-open browser after a short delay so server is ready
Start-Sleep -Milliseconds 300
Start-Process "http://localhost:$Port"

try {
  while ($listener.IsListening) {
    $context  = $listener.GetContext()
    $request  = $context.Request
    $response = $context.Response

    # ── CORS headers (required for Apify API calls from browser) ──
    $response.Headers.Add("Access-Control-Allow-Origin", "*")
    $response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type, Authorization")

    # Handle OPTIONS preflight
    if ($request.HttpMethod -eq 'OPTIONS') {
      $response.StatusCode = 204
      $response.Close()
      continue
    }

    $urlPath = $request.Url.LocalPath
    # Strip query string cache-busters (e.g. ?v=123) — we serve the real file
    if ($urlPath -eq '/' -or $urlPath -eq '') { $urlPath = '/index.html' }

    $filePath = Join-Path $root ($urlPath.TrimStart('/').Replace('/', '\'))
    $filePath = [System.IO.Path]::GetFullPath($filePath)

    # Security: ensure path is inside root
    if (-not $filePath.StartsWith($root)) {
      $response.StatusCode = 403
      $response.Close()
      continue
    }

    if (Test-Path $filePath -PathType Leaf) {
      $ext   = [System.IO.Path]::GetExtension($filePath).ToLower()
      $ct    = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
      $bytes = [System.IO.File]::ReadAllBytes($filePath)

      $response.ContentType     = $ct
      $response.ContentLength64 = $bytes.Length
      $response.StatusCode      = 200

      # ── NO-CACHE for JS, CSS, HTML — browser always gets the latest version ──
      if ($noCacheExtensions -contains $ext) {
        $response.Headers.Add("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        $response.Headers.Add("Pragma", "no-cache")
        $response.Headers.Add("Expires", "0")
      }

      $response.OutputStream.Write($bytes, 0, $bytes.Length)
      Write-Host "  200 GET $urlPath" -ForegroundColor DarkGray
    } else {
      $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $urlPath")
      $response.StatusCode      = 404
      $response.ContentType     = 'text/plain'
      $response.ContentLength64 = $msg.Length
      $response.OutputStream.Write($msg, 0, $msg.Length)
      Write-Host "  404 GET $urlPath" -ForegroundColor DarkYellow
    }

    $response.OutputStream.Close()
  }
} finally {
  $listener.Stop()
  Write-Host "`n  Server stopped." -ForegroundColor Gray
}
