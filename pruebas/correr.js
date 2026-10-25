// Pruebas automáticas: abre cada PDF difícil en el programa de verdad (Electron, sin ventana a la vista), hace lo que
// dice el caso y revisa el resultado. Uso: npm test   (o: node pruebas/correr.js simple tablas  → solo esas)
// En Linux necesita xvfb-run. Cada error arreglado deja acá su caso.
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const casos = require('./casos');

const raiz = path.join(__dirname, '..');
const filtro = process.argv.slice(2);
const elegidos = casos.filter(c => !filtro.length || filtro.some(f => c.nombre.includes(f)));

function correr(caso) {
  return new Promise(resolver => {
    const datos = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfpro-prueba-'));
    const captura = path.join(os.tmpdir(), `pdfpro-${caso.nombre}.png`);
    const js = `(async () => { ${casos.AYUDA}\ntry { ${caso.pdf ? `for (let i = 0; i < 60 && !(window.pdfproPrueba?.estado.pestanas[0]?.visor?.doc); i++) await new Promise(r => setTimeout(r, 250));` : ''} // que el PDF termine de abrir (con la máquina ocupada tarda más)
      const r = await (async () => { ${caso.js} })(); console.warn('RESULTADO ' + JSON.stringify(r)); }
      catch (e) { console.warn('RESULTADO ' + JSON.stringify({ excepcion: String(e && e.stack || e) })); } })()`;
    const env = { ...process.env, PDFPRO_CAPTURA: captura, PDFPRO_JS: js, PDFPRO_ESPERA: '500', PDFPRO_DATOS: datos, ...(caso.antes?.(datos) || {}) };
    const args = ['electron', '.', '--no-sandbox', ...(caso.pdf ? [path.join(__dirname, 'pdfs', caso.pdf)] : [])];
    const cmd = process.platform === 'linux' ? 'xvfb-run' : 'npx', lista = process.platform === 'linux' ? ['-a', 'npx', ...args] : args;
    const hijo = spawn(cmd, lista, { cwd: raiz, env });
    let salida = '';
    hijo.stdout.on('data', d => { salida += d; }); hijo.stderr.on('data', d => { salida += d; });
    const reloj = setTimeout(() => hijo.kill('SIGKILL'), caso.tiempo || 90000);
    hijo.on('close', () => {
      clearTimeout(reloj);
      fs.rmSync(datos, { recursive: true, force: true });
      const linea = salida.split('\n').find(l => l.includes('RESULTADO '));
      if (!linea) return resolver({ error: 'no terminó (tiempo agotado o se cerró)', captura });
      const r = JSON.parse(linea.slice(linea.indexOf('RESULTADO ') + 10));
      if (r.excepcion) return resolver({ error: r.excepcion, captura });
      let error = null;
      try { error = caso.revisar(r); } catch (e) { error = 'revisar: ' + e.message; }
      resolver({ error, captura, r });
    });
  });
}

(async () => {
  let fallas = 0;
  for (const caso of elegidos) {
    const t = Date.now(), { error, captura, r } = await correr(caso);
    const seg = ((Date.now() - t) / 1000).toFixed(0);
    if (error) { fallas++; console.log(`✗ ${caso.nombre} (${seg} s): ${error}\n   captura: ${captura}${r ? '\n   resultado: ' + JSON.stringify(r).slice(0, 600) : ''}`); }
    else console.log(`✓ ${caso.nombre} (${seg} s)`);
  }
  console.log(fallas ? `\n${fallas} de ${elegidos.length} fallaron.` : `\nTodas bien (${elegidos.length}).`);
  process.exit(fallas ? 1 : 0);
})();
