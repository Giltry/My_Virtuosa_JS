// Evita que corran dos copias a la vez en el mismo equipo.
//
// Con el mismo token, dos bots responderian dos veces a cada comando. Pasaria, por
// ejemplo, si el supervisor ya lo tiene corriendo en segundo plano y ademas lo lanzas
// a mano con "npm start".

import net from 'node:net';

export const PUERTO_BOT = 47831;
export const PUERTO_SUPERVISOR = 47832;

/** Codigo de salida del bot cuando ya habia otro corriendo. El supervisor lo reconoce. */
export const CODIGO_YA_CORRIENDO = 3;

// Referencias vivas a los cerrojos, para que nada los recoja la basura.
const cerrojos = [];

/**
 * Reclama un puerto local como cerrojo. Devuelve false si otro proceso ya lo tiene.
 *
 * Se usa un puerto y no un archivo .pid a proposito: el sistema operativo suelta el
 * puerto solo en cuanto el proceso muere, asi que nunca queda un cerrojo huerfano
 * despues de un apagon o de cerrar el proceso a la fuerza.
 */
export function reclamarInstancia(puerto) {
  return new Promise((resolve, reject) => {
    const servidor = net.createServer();

    servidor.once('error', (error) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });

    servidor.listen(puerto, '127.0.0.1', () => {
      servidor.unref(); // no mantener vivo el proceso solo por el cerrojo
      cerrojos.push(servidor);
      resolve(true);
    });
  });
}
