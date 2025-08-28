$ErrorActionPreference = 'Stop'

function Show($label, $resp) {
  Write-Host ''
  Write-Host ("=== $label ===")
  if ($resp.PSObject.Properties['StatusCode']) { Write-Host ("STATUS: {0}" -f $resp.StatusCode) }
  if ($resp.Headers) {
    foreach ($h in @('X-RateLimit-Limit','X-RateLimit-Remaining','X-RateLimit-Reset','Retry-After')) {
      if ($resp.Headers[$h]) { Write-Host ($h + ': ' + $resp.Headers[$h]) }
    }
  }
  if ($resp.Content) { Write-Host $resp.Content }
}

function Request($label, $method, $uri, $body, $session) {
  try {
    if ($null -ne $body -and $body -ne '') {
      $r = Invoke-WebRequest -Uri $uri -Method $method -Body $body -ContentType 'application/json' -WebSession $session
    } else {
      $r = Invoke-WebRequest -Uri $uri -Method $method -WebSession $session
    }
    Show $label $r
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $content = $sr.ReadToEnd()
      $obj = [pscustomobject]@{ StatusCode = [int]$resp.StatusCode; Headers = $resp.Headers; Content = $content }
      Show $label $obj
    } else {
      Write-Host ('ERROR: ' + $_)
    }
  }
}

$base = 'http://localhost:8000'
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

# 1) Health
Request 'Health' 'GET' ($base + '/health') $null $session

# Prepare test creds
$ts    = Get-Date -Format 'yyyyMMddHHmmssfff'
$email = "tester+$ts@example.com"
$pwd   = 'Passw0rd!'
$name  = 'Tester'

# 2) Register
$regBody = @{ email=$email; password=$pwd; name=$name } | ConvertTo-Json -Compress
Request ("Register $email") 'POST' ($base + '/auth/register') $regBody $session

# 3) Login
$loginBody = @{ email=$email; password=$pwd } | ConvertTo-Json -Compress
Request 'Login' 'POST' ($base + '/auth/login') $loginBody $session

# 4) Me
Request 'Me' 'GET' ($base + '/auth/me') $null $session

# 5) Refresh
Request 'Refresh' 'POST' ($base + '/auth/refresh') $null $session

# 6) Logout
Request 'Logout' 'POST' ($base + '/auth/logout') $null $session

# 7) Me after logout (expect 401)
Request 'Me after logout (expect 401)' 'GET' ($base + '/auth/me') $null $session

# 8) Login rate limit (6 attempts; 6th => 429)
$badBody = @{ email=$email; password='wrong12' } | ConvertTo-Json -Compress
for ($i=1; $i -le 6; $i++) {
  Request ("Login bad attempt $i") 'POST' ($base + '/auth/login') $badBody $session
}

# 9) Register rate limit (3 allowed/hour; 4th => 429)
for ($i=1; $i -le 4; $i++) {
  $e = "tester+$ts+$i@example.com"
  $b = @{ email=$e; password=$pwd; name=$name } | ConvertTo-Json -Compress
  Request ("Register attempt $i") 'POST' ($base + '/auth/register') $b $session
}
