// Virtuosa JS - bot de musica para Discord.
// Arranque: node index.js   (o npm start)

import 'dotenv/config';
import fs from 'node:fs';
import { Client, Events, GatewayIntentBits } from 'discord.js';

import { ColaDeGuild } from './src/cola.js';
import { CODIGO_YA_CORRIENDO, PUERTO_BOT, reclamarInstancia } from './src/instancia.js';
import {
  MAX_PISTAS_PLAYLIST, buscarPista, buscarPlaylist, esPlaylist, resolverYtDlp,
} from './src/ytdlp.js';

// Antes que nada: si ya hay un bot corriendo en este equipo, no arrancar otro.
if (!(await reclamarInstancia(PUERTO_BOT))) {
  // writeSync y no console.error: process.exit podria cortar el mensaje a medias.
  fs.writeSync(2, 'Ya hay un bot corriendo en este equipo. Si arranco solo en segundo plano, '
    + 'detenlo con: npm run inicio:detener\n');
  process.exit(CODIGO_YA_CORRIENDO);
}

const PREFIJOS = ['!', '+', '/', '-'];

const cliente = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    // Sin MessageContent el bot no lee los comandos. Hay que activarlo TAMBIEN en
    // el portal de Discord (Bot -> Privileged Gateway Intents).
    GatewayIntentBits.MessageContent,
  ],
});

/** Una cola por servidor. */
const colas = new Map();

function obtenerCola(guildId) {
  let cola = colas.get(guildId);
  if (!cola) {
    cola = new ColaDeGuild(guildId, (id) => colas.delete(id));
    colas.set(guildId, cola);
  }
  return cola;
}

function formatearDuracion(segundos) {
  if (!segundos) return '';
  const m = Math.floor(segundos / 60);
  const s = String(Math.floor(segundos % 60)).padStart(2, '0');
  return ` \`${m}:${s}\``;
}

// --- Comandos ---------------------------------------------------------------

const comandos = {
  async play(mensaje, argumento) {
    if (!argumento) {
      return mensaje.reply('Dime que quieres escuchar: `!play <busqueda, enlace o playlist>` (・・?)');
    }

    const canalVoz = mensaje.member?.voice?.channel;
    if (!canalVoz) {
      return mensaje.reply('Debes estar en un canal de voz para usar este comando. (｡•́︿•̀｡)');
    }

    const cola = obtenerCola(mensaje.guild.id);
    cola.canalTexto = mensaje.channel;

    await mensaje.channel.sendTyping();

    const playlist = esPlaylist(argumento);
    let pistas;
    let lista;
    try {
      if (playlist) {
        lista = await buscarPlaylist(argumento);
        pistas = lista.pistas;
      } else {
        pistas = [await buscarPista(argumento)];
      }
    } catch (error) {
      return mensaje.reply(`Hubo un error al procesar la busqueda (╥﹏╥) ${error.message}`);
    }

    try {
      await cola.conectar(canalVoz);
    } catch (error) {
      cola.destruir();
      return mensaje.reply(`No pude conectarme al canal de voz (ᗒᗣᗕ)՞ ${error.message}`);
    }

    const estabaParado = !cola.reproduciendo && !cola.pausado;
    for (const pista of pistas) cola.agregar(pista);

    if (playlist) {
      const recorte = lista.total > pistas.length
        ? ` (solo las primeras ${MAX_PISTAS_PLAYLIST})`
        : '';
      await mensaje.channel.send(
        `Playlist anadida: **${lista.titulo}** — ${pistas.length} canciones${recorte} ٩(ˊᗜˋ)و`,
      );
    } else if (!estabaParado) {
      await mensaje.channel.send(
        `Anadido a la cola: **${pistas[0].titulo}**${formatearDuracion(pistas[0].duracion)} (ﾉ◕ヮ◕)ﾉ`,
      );
    }

    if (estabaParado) await cola.siguiente();
  },

  async queue(mensaje) {
    const cola = colas.get(mensaje.guild.id);
    const lineas = [];

    if (cola?.actual) {
      lineas.push(`**Sonando:** ${cola.actual.titulo}${cola.loop ? ' (en loop)' : ''}`);
    }
    if (cola?.pistas.length) {
      // Con una playlist la cola puede tener 100 canciones: Discord corta a 2000
      // caracteres, asi que se muestran las primeras y un resumen del resto.
      const MOSTRAR = 15;
      lineas.push('', `**En cola (${cola.pistas.length}):**`);
      cola.pistas.slice(0, MOSTRAR).forEach((p, i) => {
        lineas.push(`${i + 1}. ${p.titulo}${formatearDuracion(p.duracion)}`);
      });
      const resto = cola.pistas.length - MOSTRAR;
      if (resto > 0) lineas.push(`... y ${resto} mas`);
    }

    if (lineas.length === 0) return mensaje.reply('La cola esta vacia. ( ˘･з･)');
    return mensaje.channel.send(lineas.join('\n').slice(0, 1900));
  },

  async loop(mensaje) {
    const cola = colas.get(mensaje.guild.id);
    if (!cola?.actual) return mensaje.reply('No hay ninguna cancion sonando. (・ω・)?');

    cola.loop = !cola.loop;
    return mensaje.channel.send(
      cola.loop
        ? `Modo loop activado: **${cola.actual.titulo}** ↻ (๑˃ᴗ˂)ﻭ`
        : `Modo loop desactivado: **${cola.actual.titulo}** (￣▽￣)ノ`,
    );
  },

  async skip(mensaje) {
    const cola = colas.get(mensaje.guild.id);
    if (!cola?.saltar()) return mensaje.reply('No hay nada que saltar. ( ´･ω･)?');
    return mensaje.channel.send('Skipped ⊂(◉‿◉)つ');
  },

  async pause(mensaje) {
    const cola = colas.get(mensaje.guild.id);
    const resultado = cola?.alternarPausa();
    if (!resultado) return mensaje.reply('No hay nada que pausar. ( ´･ω･)?');
    return mensaje.channel.send(
      resultado === 'pausa' ? 'Cancion pausada. (－ω－) zzZ' : 'Cancion reanudada. ♪(´▽｀)',
    );
  },

  async stop(mensaje) {
    const cola = colas.get(mensaje.guild.id);
    if (!cola) return mensaje.reply('No estoy reproduciendo nada. (・・;)');

    cola.canalTexto = mensaje.channel;
    cola.detener();
    return mensaje.channel.send('Reproduccion detenida y bot desconectado. ( ˙▿˙ )ノ');
  },

  async help(mensaje) {
    return mensaje.channel.send([
      '**Comandos** (funcionan con `!`, `+`, `/` o `-`) ♪(´ε｀ )',
      '`play <busqueda, enlace o playlist>` — reproduce o anade a la cola (alias: `p`)',
      '`queue` — muestra la cola',
      '`loop` — repite la cancion actual',
      '`skip` — salta a la siguiente',
      '`pause` — pausa o reanuda',
      '`stop` — detiene todo y me desconecta',
    ].join('\n'));
  },
};

const ALIAS = { p: 'play', q: 'queue', s: 'skip', ayuda: 'help' };

// --- Eventos ----------------------------------------------------------------

cliente.once(Events.ClientReady, async (c) => {
  console.log(`Bot conectado como ${c.user.tag}`);
  try {
    const { cmd, base, version } = await resolverYtDlp();
    console.log(`yt-dlp ${version} (via "${[cmd, ...base].join(' ')}")`);
  } catch (error) {
    console.error(`AVISO: ${error.message}`);
  }
});

cliente.on(Events.MessageCreate, async (mensaje) => {
  if (mensaje.author.bot || !mensaje.guild) return;

  const prefijo = PREFIJOS.find((p) => mensaje.content.startsWith(p));
  if (!prefijo) return;

  const partes = mensaje.content.slice(prefijo.length).trim().split(/\s+/);
  const nombre = partes.shift()?.toLowerCase();
  if (!nombre) return;

  const comando = comandos[ALIAS[nombre] ?? nombre];
  if (!comando) return;

  try {
    await comando(mensaje, partes.join(' '));
  } catch (error) {
    console.error(`Error en el comando "${nombre}":`, error);
    mensaje.reply(`Algo salio mal (×﹏×) ${error.message}`).catch(() => {});
  }
});

// Si nos echan del canal de voz o se queda vacio, soltamos la conexion.
cliente.on(Events.VoiceStateUpdate, (antes) => {
  const cola = colas.get(antes.guild?.id);
  if (!cola || !cola.conexion) return;

  const canal = antes.guild.members.me?.voice?.channel;
  if (!canal) {
    cola.destruir();
    return;
  }
  const humanos = canal.members.filter((m) => !m.user.bot).size;
  if (humanos === 0) cola.destruir();
});

// Un fallo suelto no deberia tumbar el bot entero.
process.on('unhandledRejection', (error) => console.error('Promesa sin capturar:', error));

for (const senal of ['SIGINT', 'SIGTERM']) {
  process.on(senal, () => {
    console.log('\nCerrando...');
    for (const cola of colas.values()) cola.destruir();
    cliente.destroy();
    process.exit(0);
  });
}

// --- Arranque ---------------------------------------------------------------

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('ERROR: falta DISCORD_TOKEN. Copia .env.example a .env y pon tu token.');
  process.exit(1);
}

cliente.login(token).catch((error) => {
  console.error('Error al iniciar el bot:', error.message);
  process.exit(1);
});
