# Registra el bot para que arranque solo al iniciar sesion en Windows, sin ventana,
# y lo arranca ya mismo.
#
#   Instalar:     npm run inicio:instalar
#   Desinstalar:  npm run inicio:desinstalar
#
# No necesita permisos de administrador: la tarea es solo para tu usuario.

$ErrorActionPreference = 'Stop'

$NombreTarea = 'VirtuosaJS-Bot'
$Raiz = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Usuario = "$env:USERDOMAIN\$env:USERNAME"

# --- Comprobaciones previas: mejor fallar aqui que en segundo plano sin avisar ---

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) {
    throw 'No encuentro node en el PATH. Instala Node 22.12 o superior.'
}
if (-not (Test-Path (Join-Path $Raiz '.env'))) {
    throw "Falta el archivo .env en $Raiz. Copia .env.example a .env y pon tu token."
}
if (-not (Test-Path (Join-Path $Raiz 'node_modules'))) {
    throw 'Faltan las dependencias. Ejecuta primero: npm install'
}

# --- Tarea programada ---

# conhost --headless crea la consola que node necesita, pero sin dibujar ventana.
$Conhost = Join-Path $env:WINDIR 'System32\conhost.exe'
$Supervisor = Join-Path $Raiz 'supervisor.js'
$Accion = New-ScheduledTaskAction -Execute $Conhost `
    -Argument "--headless `"$Node`" `"$Supervisor`"" `
    -WorkingDirectory $Raiz

$Disparador = New-ScheduledTaskTrigger -AtLogOn -User $Usuario
# Margen para que la red este lista al iniciar sesion.
$Disparador.Delay = 'PT30S'

$Ajustes = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

$Principal = New-ScheduledTaskPrincipal -UserId $Usuario -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $NombreTarea `
    -Action $Accion -Trigger $Disparador -Settings $Ajustes -Principal $Principal `
    -Description 'Bot de musica Virtuosa JS. Arranca al iniciar sesion y se reinicia solo si se cae.' `
    -Force | Out-Null

Write-Host "Tarea '$NombreTarea' registrada: el bot arrancara solo cada vez que inicies sesion."

Start-ScheduledTask -TaskName $NombreTarea
Write-Host 'Bot arrancado en segundo plano.'
Write-Host 'Ver lo que hace:  npm run logs'
