# Detiene el bot que corre en segundo plano y quita el arranque automatico.
#
#   Detener y desinstalar:          npm run inicio:desinstalar
#   Solo detener (sigue instalado): npm run inicio:detener

param(
    [switch]$SoloDetener
)

$NombreTarea = 'VirtuosaJS-Bot'
$Raiz = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

$Tarea = Get-ScheduledTask -TaskName $NombreTarea -ErrorAction SilentlyContinue
if ($Tarea) {
    Stop-ScheduledTask -TaskName $NombreTarea -ErrorAction SilentlyContinue
}

# Detener la tarea no siempre se lleva a los procesos hijos, asi que se cierran a mano.
# Solo los de ESTA carpeta, para no tocar otros proyectos de Node.
$Procesos = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='conhost.exe'" |
    Where-Object {
        $_.CommandLine -and
        $_.CommandLine.IndexOf($Raiz, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $_.CommandLine -match 'supervisor\.js|index\.js'
    })

foreach ($Proceso in $Procesos) {
    Stop-Process -Id $Proceso.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Host "Procesos del bot detenidos: $($Procesos.Count)"

if ($SoloDetener) {
    if ($Tarea) {
        Write-Host 'El arranque automatico sigue instalado: volvera a arrancar al iniciar sesion.'
        Write-Host 'Para arrancarlo ahora sin reiniciar:  npm run inicio:arrancar'
    }
    return
}

if ($Tarea) {
    Unregister-ScheduledTask -TaskName $NombreTarea -Confirm:$false
    Write-Host "Tarea '$NombreTarea' eliminada. El bot ya no arrancara solo."
} else {
    Write-Host 'El arranque automatico no estaba instalado.'
}
