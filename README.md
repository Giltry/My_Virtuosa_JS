# Virtuosa JS — bot de música para Discord

Versión en JavaScript del bot de música [Virtuosa](https://github.com/Giltry/DiscordBot---Virtuosa). Mismos comandos, mismo comportamiento, pero con la capa de audio rediseñada para romperse menos.

**Prefijos:** `!` `+` `/` `-` (cualquiera sirve).

| Comando | Alias | Qué hace |
|---|---|---|
| `!play <búsqueda, enlace o playlist>` | `!p` | Busca en YouTube y reproduce, o añade a la cola. Con un enlace de playlist añade hasta 100 canciones |
| `!queue` | `!q` | Muestra la cola |
| `!loop` | | Repite la canción actual |
| `!skip` | `!s` | Salta a la siguiente |
| `!pause` | | Pausa o reanuda |
| `!stop` | | Detiene todo y desconecta |
| `!help` | `!ayuda` | Lista los comandos |

Si la cola se vacía, el bot se desconecta solo a los 30 segundos. También se va si se queda solo en el canal.

---

## Requisitos

- **Node.js 22.12 o superior** (`@discordjs/voice` lo exige). Probado en Node 24 LTS.
- **yt-dlp** — con `pip install -U yt-dlp` basta. No hace falta que esté en el PATH: el bot también lo encuentra como `python -m yt_dlp`.
- **ffmpeg** (opcional pero recomendado). Casi nunca se usa, sólo si YouTube devuelve un formato raro.

## Instalación

```bash
git clone https://github.com/Giltry/My_Virtuosa_JS.git
cd My_Virtuosa_JS
npm install
```

Copia `.env.example` a `.env` y pon tu token:

```
DISCORD_TOKEN=tu_token_aqui
```

En el portal de Discord, activa el intent **MESSAGE CONTENT** (Bot → Privileged Gateway Intents) o el bot no leerá ningún comando.

```bash
npm start
```

> ⚠️ El bot se niega a arrancar si ya hay otra copia **de esta versión** corriendo en el mismo equipo. Pero no puede ver a la versión de Python: si comparten token, **no ejecutes las dos a la vez** o ambas responderán a cada comando.

## Comprobar que todo funciona

```bash
npm run diagnostico
```

Recorre la cadena completa **sin conectarse a Discord** y te dice exactamente dónde falla:

```
=== 1. Entorno ===
  OK    Node 24.19.0
  OK    yt-dlp 2026.08.19 (via "python -m yt_dlp")
  OK    ffmpeg encontrado

=== 2. YouTube: buscar la pista ===
  OK    "JUANA LA CUBANA"

=== 3. Descargar el audio ===
  OK    yt-dlp esta enviando audio

=== 4. Convertir a lo que Discord entiende ===
  OK    formato detectado: webm/opus
  OK    50 paquetes de opus generados
```

Puedes pasarle otra búsqueda: `npm run diagnostico -- "bad bunny"`.

---

## Siempre encendido (Windows)

Para que el bot arranque solo y no tengas que ejecutar nada:

```bash
npm run inicio:instalar
```

Eso registra una tarea programada de Windows, `VirtuosaJS-Bot`, que arranca el bot **cada vez que inicias sesión**, sin abrir ninguna ventana. No necesita permisos de administrador. También lo arranca en ese momento, sin esperar al próximo reinicio.

El bot no corre directamente: lo lanza un **supervisor** (`supervisor.js`) que se encarga de tres cosas:

- **Lo reinicia si se cae.** Espera 5 s, luego 10, 20… hasta un máximo de 5 min entre intentos, para no insistir en bucle si algo está roto de verdad. Si el bot aguantó 10 minutos, el siguiente fallo vuelve a esperar poco.
- **Actualiza yt-dlp** al arrancar y una vez al día. Es el arreglo del 90 % de las roturas, así que ahora ocurre solo. Para desactivarlo, pon `ACTUALIZAR_YTDLP=0` en el `.env`.
- **Lo apunta todo en `logs/bot.log`**, porque en segundo plano no hay consola. Al pasar de 5 MB se mueve a `bot.log.1`.

### Comandos del día a día

| Comando | Qué hace |
|---|---|
| `npm run logs` | Muestra el log en vivo (Ctrl+C para salir; el bot sigue) |
| `npm run inicio:detener` | Detiene el bot. Sigue instalado: vuelve al iniciar sesión |
| `npm run inicio:arrancar` | Lo arranca de nuevo sin reiniciar la PC |
| `npm run inicio:desinstalar` | Lo detiene y quita el arranque automático |

### Límites a tener en cuenta

- **Sólo funciona con la PC encendida y tu sesión iniciada.** Si la PC entra en suspensión, el bot se va con ella. Si quieres que esté disponible, desactiva la suspensión automática.
- Si cambias la carpeta de sitio o de nombre, vuelve a ejecutar `npm run inicio:instalar`: la tarea guarda la ruta.
- Si quieres usar `npm start` a mano para ver la consola, primero `npm run inicio:detener`. Si no, el bot se negará a arrancar porque ya hay uno corriendo.

### Cuando pases a una Raspberry Pi

La tarea programada es sólo de Windows. En Linux, lo equivalente es un servicio de **systemd** que ejecute `node supervisor.js`; el supervisor funciona igual. Un detalle: Raspberry Pi OS no deja instalar paquetes de pip en el sistema, así que instala yt-dlp dentro de un **entorno virtual** para que la actualización automática pueda funcionar.

---

## Por qué esta versión falla menos

Conviene ser claro: **las roturas históricas del bot no fueron culpa de Python.** Fueron cambios de YouTube y de Discord, y le pegan igual a cualquier lenguaje. Lo que cambia aquí es el *diseño*, no el idioma.

### 1. yt-dlp descarga el audio, no sólo la URL

Este es el cambio de fondo.

| | Python (antes) | JS (aquí) |
|---|---|---|
| yt-dlp | extrae una **URL** | **descarga el audio** y lo manda por stdout |
| ffmpeg | descarga esa URL desde cero | (normalmente ni participa) |

En la versión antigua, yt-dlp sacaba la URL y se la pasaba a ffmpeg, que tenía que volver a negociar la descarga con YouTube por su cuenta — con las cabeceras correctas, la firma correcta, etc. Cuando YouTube cambiaba algo, **ffmpeg era quien comía el HTTP 403**, y había que ir parcheando `-headers` a mano.

Aquí yt-dlp hace la descarga él mismo, con sus propias cabeceras, firmas y reintentos, y nos entrega los bytes ya resueltos. Toda la fragilidad queda dentro del programa que se actualiza con un solo comando. **Es un eslabón frágil menos.**

### 2. El audio va tal cual, sin recodificar

YouTube ya sirve el audio en **opus**, que es justo lo que Discord quiere. `demuxProbe` lo detecta y lo pasa directo, sin ffmpeg de por medio: menos CPU y una pieza menos que pueda fallar. Sólo si el formato es raro se recurre a ffmpeg.

Eso hace que el proyecto no necesite ningún codificador de opus. Lo cual importa más de lo que parece — ver el punto 4.

### 3. Los errores ahora se ven

El fallo más molesto de la versión Python era éste: el bot decía "Ahora reproduciendo", **no sonaba nada**, y se iba a los 30 segundos sin decir por qué. El error estaba en ffmpeg, que moría por dentro sin que Python se enterara.

Aquí, antes de dar una canción por empezada, se espera a que llegue el **primer byte real de audio**. Si yt-dlp muere sin mandar nada, su mensaje de error se publica en el chat. Se acabó el silencio misterioso.

### 4. Dependencias mínimas

```
32 paquetes, 0 vulnerabilidades, cero compilación nativa.
```

Esto **no** salió solo. El camino habitual (`@discordjs/opus`) arrastra `node-pre-gyp` → `tar`, que hoy tiene 1 vulnerabilidad crítica y 4 altas **sin arreglo disponible**, y además exige compilar código nativo en Windows. Como el punto 2 hace innecesario el codificador, se quita el paquete y desaparece el problema entero.

Si alguna vez añades `@discordjs/opus` "porque un tutorial lo dice", vuelves a meter todo eso.

### 5. Una cola por servidor

La versión de Python guardaba la cola en una variable compartida: con el bot en dos servidores a la vez, se pisaban las canciones. Aquí cada servidor tiene su propia instancia de `ColaDeGuild`.

---

## ⚠️ Qué se actualiza y rompe el bot

Igual que la versión Python. El [README del repo original](https://github.com/Giltry/DiscordBot---Virtuosa) tiene el desglose completo; aquí va lo esencial adaptado.

### Antes de investigar nada

Si el bot corre con el arranque automático, **yt-dlp ya se actualiza solo cada día**. Busca las líneas `[yt-dlp]` en `logs/bot.log` para confirmar que la última actualización funcionó.

Si lo ejecutas a mano:

```bash
pip install -U yt-dlp
```

El 90 % de las veces es eso. YouTube rota sus clientes internos y sus firmas cada pocos meses.

### Si eso no lo arregla

| Síntoma | Causa probable | Arreglo |
|---|---|---|
| `npm run diagnostico` falla en el paso 2 o 3 | YouTube cambió algo | `pip install -U yt-dlp`; si ya está al día, espera al parche de yt-dlp |
| El diagnóstico pasa entero, pero en Discord no suena | Protocolo de voz | `npm update @discordjs/voice` |
| `formato detectado: unknown` y luego falla | Formato raro + falta ffmpeg | Instala ffmpeg y ponlo en el PATH |
| El bot ni arranca | Node demasiado viejo | Necesitas Node ≥ 22.12 |
| El log repite `El bot se detuvo` una y otra vez | Lo que diga la línea `[bot:error]` justo antes | Casi siempre: token inválido o sin internet |

### 🔮 La próxima rotura, probablemente

yt-dlp ya marcó como **deprecada** la extracción de YouTube sin un motor de JavaScript. Hoy todavía funciona, pero está anunciado que dejará de hacerlo. Para adelantarte, instala [Deno](https://deno.com/); yt-dlp lo detecta y lo usa solo, sin tocar este repo:

```bash
winget install DenoLand.Deno
```

Cuando el bot se rompa y actualizar yt-dlp **no** lo arregle, éste es el primer sospechoso.

### 🚫 Lo que no hay que hacer

**No fijes `player_client` a mano.** Es tentador cuando un hilo de GitHub dice "usa `android_vr` y se arregla". Funciona… unos meses. Después YouTube retira ese cliente y el bot vuelve a romperse con un error más confuso. Eso fue exactamente lo que tumbó la versión de Python en septiembre de 2026. yt-dlp actualizado elige solo el cliente que funciona.

---

## Estructura

```
index.js                      Cliente de Discord y comandos
supervisor.js                 Mantiene el bot vivo, actualiza yt-dlp y escribe el log
diagnostico.js                Comprueba la cadena completa sin tocar Discord
src/ytdlp.js                  TODO lo que habla con YouTube vive aquí
src/cola.js                   Estado de reproducción de un servidor
src/instancia.js              Impide que corran dos copias a la vez
scripts/instalar-inicio.ps1   Registra el arranque automático en Windows
scripts/desinstalar-inicio.ps1  Lo detiene y/o lo quita
```

La separación es a propósito: cuando YouTube rompa algo, el arreglo va en `src/ytdlp.js` y en ningún otro sitio.
