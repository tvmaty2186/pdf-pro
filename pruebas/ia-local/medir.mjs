// Medición de modelos de IA local para pdf.pro (paso 1 de la sección 11 del documento de ingeniería).
// No es parte del programa: se corre aparte, desde una carpeta con node-llama-cpp, mupdf y pdf-lib instalados:
//   cd <carpeta>; npm i node-llama-cpp mupdf@1.28.1 pdf-lib
//   node /ruta/pdf-pro/pruebas/ia-local/medir.mjs <modelo.gguf> [salida.json]
// Hace los 10 PDF de documentos.json (sin datos personales), les saca el texto con MuPDF (como el programa) y para cada
// uno pide un resumen y una respuesta. Mide: datos clave que nombra el resumen, respuestas correctas, castellano,
// velocidad (palabras por segundo y espera hasta la primera palabra), memoria máxima y tiempo de carga. Solo CPU.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const req = createRequire(path.join(process.cwd(), 'x.js'));
const { getLlama, LlamaChatSession } = await import(req.resolve('node-llama-cpp'));
const mupdf = await import(req.resolve('mupdf'));
const { PDFDocument, StandardFonts } = req('pdf-lib');

const [modeloRuta, salida = 'resultado.json'] = process.argv.slice(2);
const docs = JSON.parse(fs.readFileSync(new URL('./documentos.json', import.meta.url), 'utf8'));

// memoria: el máximo de todo el proceso (se mira cada 200 ms)
let pico = 0;
const reloj = setInterval(() => { pico = Math.max(pico, process.memoryUsage().rss); }, 200);

// PDF de cada documento y su texto sacado con MuPDF
async function hacerPdf(texto) {
  const d = await PDFDocument.create(), f = await d.embedFont(StandardFonts.Helvetica);
  let pg = d.addPage([595, 842]), y = 790;
  for (const parrafo of texto.split('\n')) {
    let linea = '';
    for (const p of parrafo.split(' ')) {
      const t = linea ? linea + ' ' + p : p;
      if (f.widthOfTextAtSize(t, 11) > 480) { pg.drawText(linea, { x: 55, y, size: 11, font: f }); y -= 15; linea = p; } else linea = t;
      if (y < 60) { pg = d.addPage([595, 842]); y = 790; }
    }
    pg.drawText(linea, { x: 55, y, size: 11, font: f }); y -= 21;
  }
  return d.save();
}
const textoDe = bytes => { const doc = mupdf.Document.openDocument(Buffer.from(bytes), 'application/pdf'); let t = ''; for (let i = 0; i < doc.countPages(); i++) t += doc.loadPage(i).toStructuredText().asText(); return t; };

const sinTildes = t => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tiene = (texto, opciones) => opciones.some(o => sinTildes(texto).includes(sinTildes(o)));
const INGLES = /\b(the|and|of|is|are|with|this|summary|document|will|for)\b/gi, CASTELLANO = /\b(el|la|los|las|de|que|y|en|se|por|con|para)\b/gi;
const castellano = t => (t.match(CASTELLANO) || []).length > 3 * (t.match(INGLES) || []).length;
const palabras = t => (t.trim().match(/\S+/g) || []).length;

const SISTEMA = 'Sos el asistente de un programa para leer PDF. Respondés siempre en español rioplatense, claro y corto, sin inventar nada que no esté en el documento.';
const t0 = Date.now();
const llama = await getLlama({ gpu: false });
const model = await llama.loadModel({ modelPath: modeloRuta });
const context = await model.createContext({ contextSize: 6144, threads: 4 });
const carga = (Date.now() - t0) / 1000;
const secuencia = context.getSequence();

// un pedido: devuelve el texto, la espera hasta la primera palabra y las palabras por segundo después
async function pedir(texto, maxTokens) {
  await secuencia.clearHistory();
  const s = new LlamaChatSession({ contextSequence: secuencia, systemPrompt: SISTEMA });
  const inicio = Date.now(); let primero = 0;
  const r = await s.prompt(texto, { maxTokens, temperature: 0.2, budgets: { thoughtTokens: 0 }, onTextChunk: () => { primero ||= Date.now(); } });
  const fin = Date.now();
  s.dispose({ disposeSequence: false });
  return { texto: r.trim(), espera: ((primero || fin) - inicio) / 1000, pps: palabras(r) / Math.max(0.1, (fin - (primero || inicio)) / 1000) };
}

const filas = [];
for (const d of docs) {
  const texto = textoDe(await hacerPdf(d.texto));
  const res = await pedir(`Resumí este documento en 3 a 5 viñetas cortas, con los datos importantes (montos, fechas, plazos).\n\n<documento>\n${texto}\n</documento>`, 400);
  const resp = await pedir(`Documento:\n<documento>\n${texto}\n</documento>\n\nPregunta: ${d.pregunta}\nRespondé en una sola frase.`, 120);
  const cubre = d.claves.filter(c => tiene(res.texto, c)).length / d.claves.length;
  filas.push({ id: d.id, cubre, correcta: d.respuesta.every(o => tiene(resp.texto, o)), castellano: castellano(res.texto) && castellano(resp.texto),
    pps: res.pps, espera: res.espera, resumen: res.texto, respuesta: resp.texto });
  console.error(`${d.id}: datos ${Math.round(cubre * 100)} % · respuesta ${filas.at(-1).correcta ? 'bien' : 'MAL'} · ${res.pps.toFixed(1)} pal/s · espera ${res.espera.toFixed(1)} s`);
}
// documento largo: los 10 juntos (unas 1.600 palabras) para medir cuánto tarda en leer antes de responder
const largo = textoDe(await hacerPdf(docs.map(d => d.texto).join('\n')));
const resLargo = await pedir(`Resumí este documento en 5 viñetas cortas.\n\n<documento>\n${largo}\n</documento>`, 300);

clearInterval(reloj); pico = Math.max(pico, process.memoryUsage().rss);
const prom = k => filas.reduce((a, f) => a + Number(f[k]), 0) / filas.length;
const resultado = { modelo: path.basename(modeloRuta), archivoGB: +(fs.statSync(modeloRuta).size / 1e9).toFixed(2), cargaS: +carga.toFixed(1),
  memoriaGB: +(pico / 1e9).toFixed(2), datosClave: Math.round(prom('cubre') * 100), respuestasBien: filas.filter(f => f.correcta).length,
  castellano: filas.filter(f => f.castellano).length, palabrasPorSegundo: +prom('pps').toFixed(1), esperaCortoS: +prom('espera').toFixed(1),
  esperaLargoS: +resLargo.espera.toFixed(1), palabrasLargo: palabras(largo), resumenLargo: resLargo.texto, filas };
fs.writeFileSync(salida, JSON.stringify(resultado, null, 1));
console.error(JSON.stringify({ ...resultado, filas: undefined, resumenLargo: undefined }));
await context.dispose(); await model.dispose(); await llama.dispose();
