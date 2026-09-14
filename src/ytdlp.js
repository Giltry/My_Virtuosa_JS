// Capa de YouTube. TODO lo que habla con YouTube vive aqui y en ningun otro sitio,
// porque es la parte que YouTube rompe cada pocos meses (ver README).
//
// Decision de diseno importante: NO usamos una libreria de JavaScript para YouTube
// (ytdl-core, play-dl y companiia). Llamamos al binario de yt-dlp, que es el proyecto
// con mas gente parcheandolo cuando YouTube cambia algo. Actualizarlo es
// "pip install -U yt-dlp", sin tocar este repo.

import { spawn } from 'node:child_process';

// Candidatos en orden de preferencia. yt-dlp puede estar como binario suelto en el
// PATH, o instalado con pip (y entonces solo se llega a el con "python -m yt_dlp").
const CANDIDATOS = [
  { cmd: 'yt-dlp', base: [] },
  { cmd: 'python', base: ['-m', 'yt_dlp'] },
  { cmd: 'python3', base: ['-m', 'yt_dlp'] },
  { cmd: 'py', base: ['-3', '-m', 'yt_dlp'] },
];

let resuelto = null;

/** Ejecuta un comando y devuelve {ok, salida}. Nunca lanza. */
function ejecutar(cmd, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    let proceso;
    try {
      // windowsHide: al correr en segundo plano, que ningun subproceso abra ventana.
      proceso = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      resolve({ ok: false, salida: '', error: `no se pudo ejecutar ${cmd}` });
      return;
    }

    let salida = '';
    let error = '';
    const temporizador = setTimeout(() => proceso.kill(), timeoutMs);

    proceso.stdout.on('data', (d) => { salida += d; });
    proceso.stderr.on('data', (d) => { error += d; });
    proceso.on('error', () => {
      clearTimeout(temporizador);
      resolve({ ok: false, salida: '', error: `no se encontro el comando ${cmd}` });
    });
    proceso.on('close', (codigo) => {
      clearTimeout(temporizador);
      resolve({ ok: codigo === 0, salida, error });
    });
  });
}

/**
 * Averigua una sola vez como se invoca yt-dlp en esta maquina y lo cachea.
 * Lanza si no lo encuentra por ningun lado: sin yt-dlp el bot no tiene nada que hacer.
 */
export async function resolverYtDlp() {
  if (resuelto) return resuelto;

  for (const candidato of CANDIDATOS) {
    const r = await ejecutar(candidato.cmd, [...candidato.base, '--version'], { timeoutMs: 30_000 });
    if (r.ok) {
      resuelto = { ...candidato, version: r.salida.trim() };
      return resuelto;
    }
  }

  throw new Error(
    'No encontre yt-dlp. Instalalo con "pip install -U yt-dlp" y asegurate de que ' +
    'el comando "yt-dlp" o "python -m yt_dlp" responda desde la terminal.',
  );
}

/**
 * Actualiza yt-dlp a su ultima version y devuelve {antes, despues}. Lanza con el
 * motivo si no puede. La usa el supervisor al arrancar y una vez al dia: actualizar
 * yt-dlp es el arreglo del 90% de las roturas, asi que mejor que ocurra solo.
 */
export async function actualizarYtDlp() {
  const { cmd, base, version: antes } = await resolverYtDlp();

  let args;
  if (base.includes('yt_dlp')) {
    // Instalado con pip: se actualiza con el mismo Python que lo ejecuta. Sin --user
    // a proposito: pip pasa solo a la instalacion de usuario cuando hace falta, y asi
    // tambien funciona dentro de un entorno virtual, donde --user da error.
    const prefijo = base.slice(0, base.indexOf('-m'));
    args = [...prefijo, '-m', 'pip', 'install', '--upgrade', '--disable-pip-version-check', '--quiet', 'yt-dlp'];
  } else {
    // Binario suelto: trae su propio actualizador.
    args = ['-U'];
  }

  const r = await ejecutar(cmd, args, { timeoutMs: 5 * 60_000 });
  if (!r.ok) {
    const motivo = `${r.error}\n${r.salida}`.split('\n').filter((l) => l.trim()).pop();
    throw new Error(limpiar(motivo || 'fallo desconocido'));
  }

  resuelto = null; // que la proxima consulta lea la version nueva
  const { version: despues } = await resolverYtDlp();
  return { antes, despues };
}

/** Si es un enlace lo deja tal cual; si no, lo convierte en busqueda de YouTube. */
export function construirConsulta(entrada) {
  const texto = entrada.trim();
  if (/^(https?:\/\/|www\.)/i.test(texto)) return texto;
  return `ytsearch1:${texto}`;
}

/**
 * Busca una pista y devuelve sus datos. Guardamos el ENLACE DE LA PAGINA, nunca la
 * URL del stream: las URLs de audio de YouTube caducan en unas horas y una cancion
 * que lleve rato en la cola fallaria con 403.
 */
export async function buscarPista(entrada) {
  const { cmd, base } = await resolverYtDlp();
  const consulta = construirConsulta(entrada);

  const r = await ejecutar(cmd, [
    ...base,
    '--dump-single-json',
    '--no-playlist',
    '--no-warnings',
    '--skip-download',
    consulta,
  ]);

  if (!r.ok) {
    const motivo = (r.error || '').split('\n').filter(Boolean).pop() || 'yt-dlp fallo';
    throw new Error(limpiar(motivo));
  }

  let info;
  try {
    info = JSON.parse(r.salida);
  } catch {
    throw new Error('yt-dlp devolvio una respuesta que no pude interpretar.');
  }

  // Una busqueda devuelve un objeto de tipo playlist con las coincidencias dentro.
  if (Array.isArray(info.entries)) {
    const entradas = info.entries.filter(Boolean);
    if (entradas.length === 0) throw new Error('No encontre ningun resultado.');
    info = entradas[0];
  }

  return {
    titulo: info.title ?? 'Desconocido',
    url: info.webpage_url ?? info.original_url ?? consulta,
    duracion: info.duration ?? null,
  };
}

/**
 * Abre el audio de una pista como un stream.
 *
 * Aqui esta la diferencia clave con la version de Python: alli yt-dlp extraia una URL
 * y se la pasaba a ffmpeg, que era quien la descargaba... y quien comia los HTTP 403
 * cuando YouTube cambiaba algo. Aqui yt-dlp DESCARGA el audio el mismo y nos lo manda
 * por stdout, con sus propias cabeceras y reintentos. Un eslabon fragil menos.
 */
export async function abrirAudio(url) {
  const { cmd, base } = await resolverYtDlp();

  const proceso = spawn(cmd, [
    ...base,
    // 'protocol^=http' pide una URL directa en vez de un manifiesto HLS.
    '-f', 'bestaudio[protocol^=http]/bestaudio',
    '--no-playlist',
    '--no-warnings',
    '--quiet',
    // Si la descarga se corta un instante, que reintente en vez de morir.
    '--retries', '10',
    '--fragment-retries', '10',
    '-o', '-', // volcar el audio a stdout
    url,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  let errores = '';
  proceso.stderr.on('data', (d) => {
    errores += d;
    if (errores.length > 4000) errores = errores.slice(-4000); // no crecer sin limite
  });

  // Sin esto, un fallo al lanzar el proceso tumba el bot entero.
  proceso.on('error', () => {});

  return {
    proceso,
    stream: proceso.stdout,
    verErrores: () => limpiar(errores.trim()),
  };
}

function limpiar(texto) {
  return String(texto).replace(/^ERROR:\s*/i, '').slice(0, 400);
}
