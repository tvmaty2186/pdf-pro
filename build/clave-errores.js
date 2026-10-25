// Arma clave-errores.json (no va al repositorio) con la clave fina de GitHub para mandar informes de errores.
// La clave sale de la variable PDFPRO_CLAVE_ERRORES; sin ella, el programa guarda los informes y los manda más adelante.
const fs = require('fs'), path = require('path');
const destino = path.join(__dirname, '..', 'clave-errores.json'), k = process.env.PDFPRO_CLAVE_ERRORES;
if (!k) { fs.rmSync(destino, { force: true }); console.log('Sin PDFPRO_CLAVE_ERRORES: los informes quedan guardados.'); process.exit(0); }
const c = Buffer.from(k).map((b, i) => b ^ (0x5a + i) & 0xff).toString('base64'); // no queda a la vista en el instalador
fs.writeFileSync(destino, JSON.stringify({ c }));
console.log('Clave de informes lista.');
