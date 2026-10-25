// PDF.Pro — proceso aparte para MuPDF (lo arranca motor-cliente.js con utilityProcess). Recibe { id, nombre, args },
// corre el trabajo de motor-trabajos.js y contesta { id, r } o { id, error }.
const trabajos = new Map();
require('./motor-trabajos.js')({ handle: (nombre, fn) => trabajos.set(nombre, fn) });
process.parentPort.on('message', async ({ data }) => {
  const { id, nombre, args } = data;
  try {
    const fn = trabajos.get(nombre);
    if (!fn) throw new Error('Trabajo desconocido: ' + nombre);
    process.parentPort.postMessage({ id, r: await fn(null, ...args) });
  } catch (e) {
    process.parentPort.postMessage({ id, error: String(e?.message || e), control: !!e?.control });
  }
});
