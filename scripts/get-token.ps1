param(
    [string]$ClientId,
    [string]$Endpoint = "http://localhost:4566",
    [string]$Scope = "backend/transactions"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ClientId)) {
    $ClientId = Read-Host "Cognito app client ID"
}
if ([string]::IsNullOrWhiteSpace($ClientId)) {
    throw "ClientId is required."
}

$ClientSecret = Read-Host "Cognito app client secret" -AsSecureString
$secretPointer = [IntPtr]::Zero
$plainSecret = $null

try {
    $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ClientSecret)
    $plainSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
    $credentials = [Convert]::ToBase64String(
        [Text.Encoding]::UTF8.GetBytes("${ClientId}:${plainSecret}")
    )
    $encodedScope = [Uri]::EscapeDataString($Scope)
    $body = "grant_type=client_credentials&scope=$encodedScope"

    $response = Invoke-RestMethod `
        -Uri "$($Endpoint.TrimEnd('/'))/oauth2/token" `
        -Method Post `
        -Headers @{ Authorization = "Basic $credentials" } `
        -ContentType "application/x-www-form-urlencoded" `
        -Body $body

    if ([string]::IsNullOrWhiteSpace($response.access_token)) {
        throw "MiniStack Cognito did not return an access_token."
    }

    Write-Output $response.access_token
}
catch {
    throw "Could not obtain a Cognito token from MiniStack: $($_.Exception.Message)"
}
finally {
    if ($secretPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
    }
    $plainSecret = $null
    $credentials = $null
}
