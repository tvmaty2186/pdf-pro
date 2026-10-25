// PDF.Pro — del lado del programa: manda los trabajos de MuPDF al proceso aparte (motor.js) y espera la respuesta.
// Si el motor se cae (memoria, un PDF roto) o tarda demasiado, se cierra, se avisa con un error claro y el próximo
// trabajo lo vuelve a arrancar. El programa y el archivo original no se tocan.
const { utilityProcess } = require('electron');
const path = require('path');

module.exports = function (errores) {
  const nombres = [];
  require('./motor-trabajos.js')({ handle: nombre => nombres.push(nombre) }); // solo los nombres (MuPDF no se carga acá)
  let hijo = null, sig = 1, motivo = null;
  const pendientes = new Map();
  function arrancar() {
    hijo = utilityProcess.fork(path.join(__dirname, 'motor.js'), [], { serviceName: 'pdf.pro motor', stdio: 'inherit' });
    hijo.on('message', m => {
      const p = pendientes.get(m.id);
      if (!p) return;
      pendientes.delete(m.id); clearTimeout(p.reloj);
      if (m.error != null) p.rechazar(Object.assign(new Error(m.error), m.control ? { control: true } : {}));
      else p.resolver(m.r);
    });
    hijo.on('exit', codigo => {
      hijo = null;
      const lista = [...pendientes.values()];
      pendientes.clear();
      const texto = motivo || 'El motor de PDF se cerró por un problema (puede ser un documento muy pesado o dañado). Probá de nuevo; el archivo no se tocó.';
      if (!motivo && codigo) errores.anotar('motor caído', 'MuPDF se cerró con código ' + codigo);
      motivo = null;
      for (const p of lista) { clearTimeout(p.reloj); p.rechazar(new Error(texto)); }
    });
  }
  function llamar(nombre, args, { tiempo = 120000 } = {}) {
    if (!hijo) arrancar();
    return new Promise((resolver, rechazar) => {
      const id = sig++;
      const reloj = setTimeout(() => {
        errores.anotar('lento', `Motor de PDF: "${nombre}" tardó más de ${tiempo / 1000} s y se cortó`);
        motivo = 'Esa operación tardó demasiado y se cortó (el archivo no se tocó). Probá de nuevo o con menos páginas.';
        hijo?.kill();
      }, tiempo);
      pendientes.set(id, { resolver, rechazar, reloj });
      hijo.postMessage({ id, nombre, args });
    });
  }
  return { nombres, llamar };
};
