# send-clear-content.ps1 — Limpa cache de um conteudo especifico nos players
# Uso (display especifico): .\send-clear-content.ps1 -ContentCode "CONT-123" -Codigo "SP-001"
# Uso (device especifico):  .\send-clear-content.ps1 -ContentCode "CONT-123" -DeviceId "device_abc"
# Uso (todos os devices):   .\send-clear-content.ps1 -ContentCode "CONT-123"

param(
    [Parameter(Mandatory=$true)]
    [string]$ContentCode,
    [string]$DeviceId = "",
    [string]$Codigo   = ""
)

$SUPABASE_URL = "https://base.muraltv.com.br"
$SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UiLCJpYXQiOjE3NTI4MDc2MDAsImV4cCI6MTkxMDU3NDAwMH0.esQoLg29oRu4yg0nzcZSym4_QI4fxe5q0c45laaBsLI"

$headers = @{
    "Authorization" = "Bearer $SUPABASE_KEY"
    "apikey"        = $SUPABASE_KEY
    "Content-Type"  = "application/json"
    "Prefer"        = "return=minimal"
}

function Enviar-ClearContent($id) {
    $body = @{
        device_id = $id
        command   = "clear_content"
        executed  = $false
        payload   = @{ content_code = $ContentCode }
    } | ConvertTo-Json -Depth 3
    try {
        Invoke-RestMethod -Method POST `
            -Uri "$SUPABASE_URL/rest/v1/device_commands" `
            -Headers $headers `
            -Body $body | Out-Null
        Write-Host "  Comando enviado para: $id" -ForegroundColor Green
    } catch {
        Write-Host "  ERRO para $id : $_" -ForegroundColor Red
    }
}

Write-Host "Limpando cache do conteudo: $ContentCode" -ForegroundColor Cyan

if ($DeviceId) {
    Enviar-ClearContent $DeviceId

} elseif ($Codigo) {
    $disp = Invoke-RestMethod `
        -Uri "$SUPABASE_URL/rest/v1/dispositivos?codigo_display=eq.$Codigo&is_ativo=eq.true&select=device_id" `
        -Headers $headers
    if ($disp.Count -eq 0) { Write-Host "Nenhum dispositivo ativo para $Codigo" -ForegroundColor Yellow; exit }
    $disp | ForEach-Object { Enviar-ClearContent $_.device_id }

} else {
    $todos = Invoke-RestMethod `
        -Uri "$SUPABASE_URL/rest/v1/dispositivos?is_ativo=eq.true&select=device_id" `
        -Headers $headers
    if ($todos.Count -eq 0) { Write-Host "Nenhum dispositivo ativo encontrado" -ForegroundColor Yellow; exit }
    Write-Host "$($todos.Count) dispositivo(s) encontrado(s)" -ForegroundColor Cyan
    $todos | ForEach-Object { Enviar-ClearContent $_.device_id }
}

Write-Host ""
Write-Host "Pronto! O cache do conteudo '$ContentCode' sera limpo nos players em segundos." -ForegroundColor Green
