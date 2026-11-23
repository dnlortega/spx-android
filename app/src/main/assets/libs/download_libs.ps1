$dest = "C:\Users\Jacqueline\.gemini\antigravity\scratch\spx-android\app\src\main\assets\libs"

$files = @(
    @{ url = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";      out = "leaflet.css" },
    @{ url = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";       out = "leaflet.js" },
    @{ url = "https://cdn.sheetjs.com/xlsx-0.20.2/package/dist/xlsx.full.min.js"; out = "xlsx.full.min.js" },
    @{ url = "https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js"; out = "lucide.min.js" }
)

foreach ($f in $files) {
    $outPath = Join-Path $dest $f.out
    Write-Host "Baixando $($f.out)..."
    try {
        Invoke-WebRequest -Uri $f.url -OutFile $outPath -UseBasicParsing
        $size = [math]::Round((Get-Item $outPath).Length / 1024, 1)
        Write-Host "  OK: $($f.out) ($size KB)"
    } catch {
        Write-Host "  ERRO: $($f.out) - $_"
    }
}
Write-Host "Download concluido!"
