// Virtuosa JS - bot de musica para Discord.
// Arranque: node index.js   (o npm start)

import 'dotenv/config';
import fs from 'node:fs';
import { Client, Events, GatewayIntentBits } from 'discord.js';

import { ColaDeGuild } from './src/cola.js';
import { CODIGO_YA_CORRIENDO, PUERTO_BOT, reclamarInstancia } from './src/instancia.js';
import { buscarPista, resolverYtDlp } from './src/ytdlp.js';

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
      return mensaje.reply('Dime que quieres escuchar: `!play <busqueda o enlace>`');
    }

    const canalVoz = mensaje.member?.voice?.channel;
    if (!canalVoz) {
      return mensaje.reply('Debes estar en un canal de voz para usar este comando.');
    }

    const cola = obtenerCola(mensaje.guild.id);
    cola.canalTexto = mensaje.channel;

    await mensaje.channel.sendTyping();

    let pista;
    try {
      pista = await buscarPista(argumento);
    } catch (error) {
      return mensaje.reply(`Hubo un error al procesar la busqueda: ${error.message}`);
    }

    try {
      await cola.conectar(canalVoz);
    } catch (error) {
      cola.destruir();
      return mensaje.reply(`No pude conectarme al canal de voz: ${error.message}`);
    }

    cola.agregar(pista);

    if (!cola.reproduciendo && !cola.pausado) {
      await cola.siguiente();
    } else {
      await mensaje.channel.send(
        `Anadido a la cola: **${pista.titulo}**${formatearDuracion(pista.duracion)}`,
      );
    }
  },

  async queue(mensaje) {
    const cola = colas.get(mensaje.guild.id);
    const lineas = [];

    if (cola?.actual) {
      lineas.push(`**Sonando:** ${cola.actual.titulo}${cola.loop ? ' (en loop)' : ''}`);
    }
    if (cola?.pistas.length) {
      lineas.push('', '**En cola:**');
      cola.pistas.forEach((p, i) => {
        lineas.push(`${i + 1}. ${p.titulo}${formatearDuracion(p.duracion)}`);
      });
    }

    if (lineas.length === 0) return mensaje.reply('La cola esta vacia.');
    return mensaje.channel.send(lineas.join('\n').slice(0, 1900));
  },

  async loop(mensaje) {
    const cola = colas.get(mensaje.guild.id);
    if (!cola?.actual) return mensaje.reply('No hay ninguna cancion sonando.');

    cola.loop = !cola.loop;
    return mensaje.channel.send(
      `El modo loop ha sido ${cola.loop ? 'activado' : 'desactivado'}: **${cola.actual.titulo}**`,
    );
  },

  async skip(mensaje) {
    const cola = colas.get(mensaje.guild.id);
    if (!cola?.saltar()) return mensaje.reply('No hay nada que saltar.');
    return mensaje.channel.send('Skipped');
  },

  async pause(mensaje) {
    const cola = colas.get(mensaje.guild.id);
    const resultado = cola?.alternarPausa();
    if (!resultado) return mensaje.reply('No hay nada que pausar.');
    return mensaje.channel.send(
      resultado === 'pausa' ? 'Cancion pausada.' : 'Cancion reanudada.',
    );
  },

  async stop(mensaje) {
    const cola = colas.get(mensaje.guild.id);
    if (!cola) return mensaje.reply('No estoy reproduciendo nada.');

    cola.canalTexto = mensaje.channel;
    cola.detener();
    return mensaje.channel.send('Reproduccion detenida y bot desconectado.');
  },

  async help(mensaje) {
    return mensaje.channel.send([
      '**Comandos** (funcionan con `!`, `+`, `/` o `-`)',
      '`play <busqueda o enlace>` — reproduce o anade a la cola (alias: `p`)',
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
    mensaje.reply(`Algo salio mal: ${error.message}`).catch(() => {});
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
