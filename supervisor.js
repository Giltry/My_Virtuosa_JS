// Supervisor: mantiene el bot encendido sin que tengas que tocar nada.
//
// - Si index.js se cae (corte de red, un error raro, lo que sea), lo vuelve a
//   levantar, esperando cada vez un poco mas para no insistir en bucle.
// - Actualiza yt-dlp al arrancar y una vez al dia. Es el arreglo del 90% de las
//   roturas (ver README), asi que mejor que ocurra solo.
// - Guarda todo en logs/bot.log: en segundo plano no hay consola donde mirar.
//
// Normalmente no lo ejecutas tu: lo lanza la tarea programada de Windows al iniciar
// sesion (npm run inicio:instalar). Para probarlo a mano: npm run supervisor

import 'dotenv/config';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CODIGO_YA_CORRIENDO, PUERTO_SUPERVISOR, reclamarInstancia } from './src/instancia.js';
import { actualizarYtDlp } from './src/ytdlp.js';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const CARPETA_LOGS = path.join(RAIZ, 'logs');
const LOG = path.join(CARPETA_LOGS, 'bot.log');

const MAX_LOG_BYTES = 5 * 1024 * 1024; // al pasar de 5 MB se mueve a bot.log.1
const ESPERA_INICIAL_MS = 5_000;
const ESPERA_MAXIMA_MS = 5 * 60_000;
const ESTABLE_MS = 10 * 60_000; // si aguanto 10 min, el siguiente fallo vuelve a esperar poco
const ACTUALIZAR_CADA_MS = 24 * 60 * 60_000;

// ACTUALIZAR_YTDLP=0 en el .env desactiva la actualizacion automatica.
const ACTUALIZAR_YTDLP = process.env.ACTUALIZAR_YTDLP !== '0';

// --- Log --------------------------------------------------------------------

fs.mkdirSync(CARPETA_LOGS, { recursive: true });

function marcaDeTiempo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function registrar(origen, texto) {
  const lineas = String(texto).split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lineas.length === 0) return;

  const bloque = `${lineas.map((l) => `${marcaDeTiempo()} [${origen}] ${l}`).join('\n')}\n`;
  process.stdout.write(bloque);
  try {
    fs.appendFileSync(LOG, bloque);
  } catch { /* disco lleno o archivo bloqueado: no tumbar al supervisor por eso */ }
}

function rotarLogSiHaceFalta() {
  try {
    if (fs.statSync(LOG).size > MAX_LOG_BYTES) fs.renameSync(LOG, `${LOG}.1`);
  } catch { /* todavia no existe */ }
}

/** Los datos de un proceso llegan en trozos que pueden cortar una linea a la mitad. */
function lectorDeLineas(origen) {
  let resto = '';
  return {
    empujar(trozo) {
      resto += trozo;
      const lineas = resto.split(/\r?\n/);
      resto = lineas.pop();
      if (lineas.length > 0) registrar(origen, lineas.join('\n'));
    },
    vaciar() {
      if (resto) registrar(origen, resto);
      resto = '';
    },
  };
}

// --- Bot --------------------------------------------------------------------

let hijo = null;
let espera = ESPERA_INICIAL_MS;
let cerrando = false;
let temporizadorReinicio = null;

function lanzarBot() {
  temporizadorReinicio = null;
  rotarLogSiHaceFalta();
  registrar('supervisor', 'Arrancando el bot...');

  const inicio = Date.now();
  const salida = lectorDeLineas('bot');
  const errores = lectorDeLineas('bot:error');
  let terminado = false;

  hijo = spawn(process.execPath, [path.join(RAIZ, 'index.js')], {
    cwd: RAIZ,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  hijo.stdout.on('data', (d) => salida.empujar(d));
  hijo.stderr.on('data', (d) => errores.empujar(d));

  const alTerminar = (descripcion) => {
    if (terminado) return;
    terminado = true;
    salida.vaciar();
    errores.vaciar();
    hijo = null;
    if (cerrando) return;

    // Si llevaba rato funcionando, el fallo es puntual: reintentar pronto.
    if (Date.now() - inicio >= ESTABLE_MS) espera = ESPERA_INICIAL_MS;

    registrar('supervisor', `El bot se detuvo: ${descripcion}. Reinicio en ${Math.round(espera / 1000)} s.`);
    temporizadorReinicio = setTimeout(lanzarBot, espera);
    espera = Math.min(espera * 2, ESPERA_MAXIMA_MS);
  };

  hijo.on('error', (error) => alTerminar(`no se pudo lanzar (${error.message})`));
  hijo.on('close', (codigo, senal) => {
    let descripcion = `codigo ${codigo ?? senal}`;
    if (codigo === CODIGO_YA_CORRIENDO) {
      descripcion = 'ya habia otro bot corriendo en este equipo (lo abriste a mano con npm start?)';
    } else if ((codigo | 0) === -1) {
      // En Windows, un proceso cerrado a la fuerza sale con -1 (4294967295 sin signo).
      descripcion = 'lo cerraron a la fuerza';
    }
    alTerminar(descripcion);
  });
}

// --- yt-dlp -----------------------------------------------------------------

async function actualizar() {
  if (!ACTUALIZAR_YTDLP || cerrando) return;
  try {
    const { antes, despues } = await actualizarYtDlp();
    registrar('yt-dlp', antes === despues
      ? `Ya estaba al dia (${despues}).`
      : `Actualizado: ${antes} -> ${despues}.`);
  } catch (error) {
    registrar('yt-dlp', `No se pudo actualizar: ${error.message}`);
  }
}

// --- Arranque y cierre ------------------------------------------------------

if (!(await reclamarInstancia(PUERTO_SUPERVISOR))) {
  registrar('supervisor', 'Ya hay un supervisor corriendo en este equipo. No arranco otro.');
  // Codigo 0 a proposito: no es un fallo, y asi la tarea programada no reintenta.
  process.exit(0);
}

registrar('supervisor', `Supervisor iniciado (PID ${process.pid}, Node ${process.versions.node}).`);
if (!ACTUALIZAR_YTDLP) registrar('supervisor', 'Actualizacion automatica de yt-dlp desactivada.');

lanzarBot();
actualizar();
const intervaloActualizacion = setInterval(actualizar, ACTUALIZAR_CADA_MS);

function cerrar(senal) {
  if (cerrando) return;
  cerrando = true;
  registrar('supervisor', `Cerrando (${senal}).`);
  clearInterval(intervaloActualizacion);
  if (temporizadorReinicio) clearTimeout(temporizadorReinicio);
  if (hijo) hijo.kill();
  setTimeout(() => process.exit(0), 2_000);
}

// SIGHUP es lo que llega en Windows cuando se cierra la consola que lo aloja.
for (const senal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(senal, () => cerrar(senal));
}
