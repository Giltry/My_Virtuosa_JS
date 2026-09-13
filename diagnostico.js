// Comprueba la cadena completa sin necesidad de conectarse a Discord.
// Uso: npm run diagnostico
//
// Sirve para responder la pregunta de siempre cuando el bot "no suena":
// ¿falla YouTube, falla el audio, o falla Discord?

import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createAudioResource, demuxProbe } from '@discordjs/voice';

import { abrirAudio, buscarPista, resolverYtDlp } from './src/ytdlp.js';

const CONSULTA = process.argv[2] ?? 'Juana la Cubana';
let fallos = 0;

function ok(texto) { console.log(`  OK    ${texto}`); }
function mal(texto) { console.log(`  FALLA ${texto}`); fallos += 1; }

function hayComando(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (codigo) => resolve(codigo === 0));
  });
}

console.log('\n=== 1. Entorno ===');

const [mayor] = process.versions.node.split('.').map(Number);
if (mayor >= 22) ok(`Node ${process.versions.node}`);
else mal(`Node ${process.versions.node} — @discordjs/voice necesita 22.12 o superior.`);

try {
  const { cmd, base, version } = await resolverYtDlp();
  ok(`yt-dlp ${version} (via "${[cmd, ...base].join(' ')}")`);
} catch (error) {
  mal(error.message);
}

if (await hayComando('ffmpeg', ['-version'])) {
  ok('ffmpeg encontrado');
} else {
  console.log('  AVISO ffmpeg no esta en el PATH. Solo hace falta si YouTube sirve un');
  console.log('        formato que no sea opus, pero conviene tenerlo.');
}

console.log('\n=== 2. YouTube: buscar la pista ===');

let pista;
try {
  pista = await buscarPista(CONSULTA);
  ok(`"${pista.titulo}"`);
  console.log(`        ${pista.url}`);
} catch (error) {
  mal(error.message);
  console.log('\n  -> Prueba "pip install -U yt-dlp". Es el arreglo del 90% de los casos.');
  process.exit(1);
}

console.log('\n=== 3. Descargar el audio ===');

const { proceso, stream, verErrores } = await abrirAudio(pista.url);
let audio;
try {
  audio = await new Promise((resolve, reject) => {
    const medido = new PassThrough();
    let recibio = false;
    const limite = setTimeout(() => reject(new Error('yt-dlp no envio audio en 60 s.')), 60_000);

    stream.once('data', () => {
      recibio = true;
      clearTimeout(limite);
      resolve(medido);
    });
    proceso.once('close', (codigo) => {
      if (recibio) return;
      clearTimeout(limite);
      reject(new Error(verErrores() || `yt-dlp termino con codigo ${codigo} sin enviar audio.`));
    });
    stream.pipe(medido);
  });
  ok('yt-dlp esta enviando audio');
} catch (error) {
  mal(error.message);
  try { proceso.kill(); } catch { /* ya murio */ }
  console.log('\n  -> Aqui es donde golpean los cambios de YouTube. Actualiza yt-dlp.');
  process.exit(1);
}

console.log('\n=== 4. Convertir a lo que Discord entiende ===');

try {
  const sonda = await demuxProbe(audio);
  ok(`formato detectado: ${sonda.type}`);

  const recurso = createAudioResource(sonda.stream, { inputType: sonda.type });

  const paquetes = await new Promise((resolve, reject) => {
    let n = 0;
    const limite = setTimeout(() => reject(new Error('no llegaron paquetes de audio en 30 s.')), 30_000);
    recurso.playStream.on('data', () => {
      n += 1;
      if (n >= 50) {
        clearTimeout(limite);
        resolve(n);
      }
    });
    recurso.playStream.on('end', () => { clearTimeout(limite); resolve(n); });
    recurso.playStream.on('error', (e) => { clearTimeout(limite); reject(e); });
  });

  if (paquetes >= 50) ok(`${paquetes} paquetes de opus generados`);
  else mal(`solo ${paquetes} paquetes; el audio se corta enseguida.`);
} catch (error) {
  mal(error.message);
}

try { proceso.kill(); } catch { /* ya murio */ }

console.log(
  fallos === 0
    ? '\nTodo en orden. Si aun asi no suena en Discord, el problema esta en la conexion\nde voz: mira el README, seccion "Discord: el protocolo de voz".\n'
    : `\n${fallos} comprobacion(es) fallaron. Revisa los mensajes de arriba.\n`,
);

process.exit(fallos === 0 ? 0 : 1);
