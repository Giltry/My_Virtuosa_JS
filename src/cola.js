// Estado de reproduccion de UN servidor.
//
// Nota: la version de Python guardaba la cola en una sola variable compartida, asi que
// si el bot estaba en dos servidores a la vez se pisaban las canciones entre ellos.
// Aqui cada servidor tiene su propia instancia de esta clase.

import { PassThrough } from 'node:stream';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
} from '@discordjs/voice';

import { abrirAudio } from './ytdlp.js';

const INACTIVIDAD_MS = 30_000;

export class ColaDeGuild {
  constructor(guildId, alDestruirse) {
    this.guildId = guildId;
    this.alDestruirse = alDestruirse;

    this.canalTexto = null;
    this.conexion = null;
    this.pistas = [];
    this.actual = null;
    this.loop = false;

    this.procesoActual = null;
    this.temporizador = null;
    this.deteniendo = false;

    this.reproductor = createAudioPlayer({
      // Si no queda nadie escuchando, pausa en vez de seguir gastando ancho de banda.
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    this.reproductor.on(AudioPlayerStatus.Idle, () => {
      this.#matarProceso();
      if (this.deteniendo) return;
      this.siguiente().catch((e) => this.#avisar(`Error al pasar a la siguiente: ${e.message}`));
    });

    this.reproductor.on('error', (error) => {
      this.#avisar(`Error de reproduccion: ${error.message}`);
    });
  }

  // --- Conexion -------------------------------------------------------------

  async conectar(canalVoz) {
    if (this.conexion && this.conexion.state.status !== VoiceConnectionStatus.Destroyed) {
      return this.conexion;
    }

    this.conexion = joinVoiceChannel({
      channelId: canalVoz.id,
      guildId: canalVoz.guild.id,
      adapterCreator: canalVoz.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    this.conexion.on(VoiceConnectionStatus.Disconnected, async () => {
      // Puede ser un corte real o solo que Discord nos movio de servidor de voz.
      // Damos 5 segundos a que se reconecte solo antes de rendirnos.
      try {
        await Promise.race([
          entersState(this.conexion, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.conexion, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.destruir();
      }
    });

    this.conexion.subscribe(this.reproductor);

    // Si esto revienta, casi siempre es el protocolo de voz (ver README).
    await entersState(this.conexion, VoiceConnectionStatus.Ready, 20_000);
    return this.conexion;
  }

  // --- Cola -----------------------------------------------------------------

  agregar(pista) {
    this.pistas.push(pista);
    this.#cancelarTemporizador();
  }

  get reproduciendo() {
    return this.reproductor.state.status === AudioPlayerStatus.Playing
      || this.reproductor.state.status === AudioPlayerStatus.Buffering;
  }

  get pausado() {
    return this.reproductor.state.status === AudioPlayerStatus.Paused
      || this.reproductor.state.status === AudioPlayerStatus.AutoPaused;
  }

  async siguiente() {
    this.#cancelarTemporizador();

    let pista;
    if (this.loop && this.actual) {
      pista = this.actual;
    } else {
      pista = this.pistas.shift();
    }

    if (!pista) {
      this.actual = null;
      this.#avisar('La cola esta vacia. Agrega mas canciones con **play**.');
      this.#programarDesconexion();
      return;
    }

    this.actual = pista;

    try {
      const recurso = await this.#crearRecurso(pista);
      this.reproductor.play(recurso);
      if (!this.loop) this.#avisar(`Ahora reproduciendo: **${pista.titulo}** (≧ᗜˬᗜ≦)`);
    } catch (error) {
      this.#avisar(`No pude reproducir **${pista.titulo}**: ${error.message}`);
      // Que un fallo puntual no deje el bot colgado: pasamos a la siguiente.
      if (this.loop) this.loop = false;
      if (this.pistas.length > 0) {
        await this.siguiente();
      } else {
        this.#programarDesconexion();
      }
    }
  }

  /**
   * Vuelve a pedirle a yt-dlp el audio JUSTO ANTES de sonar, nunca antes: las URLs
   * de YouTube caducan y una pista que lleve rato en la cola fallaria con 403.
   */
  async #crearRecurso(pista) {
    const { proceso, stream, verErrores } = await abrirAudio(pista.url);
    this.procesoActual = proceso;

    // Esperamos al primer byte real. Si yt-dlp muere sin mandar nada, queremos el
    // motivo en pantalla y no un silencio de 30 segundos como pasaba en Python.
    const audio = await new Promise((resolve, reject) => {
      const medido = new PassThrough();
      let recibioAlgo = false;

      stream.once('data', () => {
        recibioAlgo = true;
        resolve(medido);
      });

      proceso.once('close', (codigo) => {
        if (recibioAlgo) return;
        reject(new Error(verErrores() || `yt-dlp termino con codigo ${codigo} sin enviar audio.`));
      });

      stream.pipe(medido);
    });

    // demuxProbe detecta si el audio ya viene en opus (lo normal en YouTube). Si es
    // asi se envia tal cual, sin pasar por ffmpeg: menos CPU y un eslabon menos que
    // se pueda romper. Solo si el formato es raro se recodifica.
    const sonda = await demuxProbe(audio);
    return createAudioResource(sonda.stream, { inputType: sonda.type, metadata: pista });
  }

  // --- Controles ------------------------------------------------------------

  saltar() {
    if (!this.reproduciendo && !this.pausado) return false;
    this.loop = false; // saltar con el loop puesto reproduciria lo mismo otra vez
    this.reproductor.stop(true);
    return true;
  }

  alternarPausa() {
    if (this.reproduciendo) {
      this.reproductor.pause();
      return 'pausa';
    }
    if (this.pausado) {
      this.reproductor.unpause();
      return 'reanudado';
    }
    return null;
  }

  detener() {
    this.deteniendo = true;
    this.pistas = [];
    this.loop = false;
    this.actual = null;
    this.reproductor.stop(true);
    this.destruir();
  }

  destruir() {
    this.#cancelarTemporizador();
    this.#matarProceso();
    try {
      if (this.conexion && this.conexion.state.status !== VoiceConnectionStatus.Destroyed) {
        this.conexion.destroy();
      }
    } catch { /* ya estaba destruida */ }
    this.conexion = null;
    this.alDestruirse?.(this.guildId);
  }

  // --- Internos -------------------------------------------------------------

  #matarProceso() {
    if (!this.procesoActual) return;
    try { this.procesoActual.kill(); } catch { /* ya habia terminado */ }
    this.procesoActual = null;
  }

  #programarDesconexion() {
    this.#cancelarTemporizador();
    this.temporizador = setTimeout(() => {
      if (this.reproduciendo || this.pistas.length > 0) return;
      this.#avisar('Me desconecte por inactividad.');
      this.destruir();
    }, INACTIVIDAD_MS);
  }

  #cancelarTemporizador() {
    if (this.temporizador) {
      clearTimeout(this.temporizador);
      this.temporizador = null;
    }
  }

  #avisar(mensaje) {
    this.canalTexto?.send(mensaje).catch(() => { /* sin permisos o canal borrado */ });
  }
}
