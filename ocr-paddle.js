// PDF.Pro — OCR con PaddleOCR en Node (onnxruntime-node, sin Python). Dos modelos ONNX:
// - detección PP-OCRv4 (encuentra los renglones de texto, sirve para cualquier idioma);
// - reconocimiento latino PP-OCRv5 (lee cada renglón; castellano con tildes y ñ. PP-OCRv4 no tiene modelo latino).
// Entra una imagen ya decodificada { ancho, alto, bgra } y sale { texto, bloques: [{ texto, confianza, caja: [x0, y0, x1, y1] }] }
// con las cajas en píxeles de esa imagen. Los modelos van en resources/ocr (armando: build/ocr-modelos).
const path = require('path');
const fs = require('fs');

let sesiones = null;
function carpeta() {
  if (process.env.PDFPRO_OCR_MODELOS) return process.env.PDFPRO_OCR_MODELOS;
  const enRecursos = process.resourcesPath && path.join(process.resourcesPath, 'ocr');
  return enRecursos && fs.existsSync(path.join(enRecursos, 'det.onnx')) ? enRecursos : path.join(__dirname, 'build', 'ocr-modelos');
}
async function cargar() {
  if (sesiones) return sesiones;
  const ort = require('onnxruntime-node'), dir = carpeta();
  const op = { executionProviders: ['cpu'], intraOpNumThreads: Math.max(1, Math.min(4, require('os').availableParallelism() - 1)) };
  // el diccionario: un carácter por renglón; el índice 0 de la salida es "en blanco" y el último es el espacio
  const dic = fs.readFileSync(path.join(dir, 'dict.txt'), 'utf8').replace(/\r?\n$/, '').split(/\r?\n/);
  sesiones = { ort, det: await ort.InferenceSession.create(path.join(dir, 'det.onnx'), op), rec: await ort.InferenceSession.create(path.join(dir, 'rec.onnx'), op), dic: [...dic, ' '] };
  return sesiones;
}

// Achica o agranda (bilineal) un recorte de la imagen BGRA y lo pasa a un tensor 1×3×alto×ancho (RGB) con la normalización dada
function aTensor(img, [x0, y0, w0, h0], ancho, alto, media, desvio, anchoTotal = ancho) {
  const datos = new Float32Array(3 * alto * anchoTotal), plano = alto * anchoTotal;
  const sx = w0 / ancho, sy = h0 / alto;
  for (let y = 0; y < alto; y++) {
    const fy = Math.min(h0 - 1, Math.max(0, (y + 0.5) * sy - 0.5)), y1 = Math.floor(fy), y2 = Math.min(h0 - 1, y1 + 1), dy = fy - y1;
    for (let x = 0; x < ancho; x++) {
      const fx = Math.min(w0 - 1, Math.max(0, (x + 0.5) * sx - 0.5)), x1 = Math.floor(fx), x2 = Math.min(w0 - 1, x1 + 1), dx = fx - x1;
      const a = ((y0 + y1) * img.ancho + x0 + x1) * 4, b = ((y0 + y1) * img.ancho + x0 + x2) * 4, c = ((y0 + y2) * img.ancho + x0 + x1) * 4, d = ((y0 + y2) * img.ancho + x0 + x2) * 4;
      for (let k = 0; k < 3; k++) { // BGRA → R, G, B
        const ch = 2 - k;
        const v = (img.bgra[a + ch] * (1 - dx) + img.bgra[b + ch] * dx) * (1 - dy) + (img.bgra[c + ch] * (1 - dx) + img.bgra[d + ch] * dx) * dy;
        datos[k * plano + y * anchoTotal + x] = (v / 255 - media[k]) / desvio[k];
      }
    }
    for (let x = ancho; x < anchoTotal; x++) for (let k = 0; k < 3; k++) datos[k * plano + y * anchoTotal + x] = (0.5 - media[k]) / desvio[k]; // relleno gris
  }
  return datos;
}

// Detección: mapa de "acá hay texto" → cajas (componentes conectados, agrandadas como en DBNet)
async function detectar(s, img) {
  const LADO = 960, escala = Math.min(1, LADO / Math.max(img.ancho, img.alto));
  const ancho = Math.max(32, Math.round(img.ancho * escala / 32) * 32), alto = Math.max(32, Math.round(img.alto * escala / 32) * 32);
  const t = new s.ort.Tensor('float32', aTensor(img, [0, 0, img.ancho, img.alto], ancho, alto, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]), [1, 3, alto, ancho]);
  const mapa = (await s.det.run({ x: t }))[s.det.outputNames[0]].data;
  const visto = new Uint8Array(ancho * alto), cajas = [], pila = [];
  for (let i = 0; i < mapa.length; i++) {
    if (visto[i] || mapa[i] < 0.3) continue;
    let x0 = ancho, y0 = alto, x1 = 0, y1 = 0, n = 0, suma = 0;
    pila.push(i); visto[i] = 1;
    while (pila.length) {
      const j = pila.pop(), x = j % ancho, y = (j - x) / ancho;
      n++; suma += mapa[j];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const k of [j - 1, j + 1, j - ancho, j + ancho]) {
        if (k < 0 || k >= mapa.length || visto[k] || mapa[k] < 0.3) continue;
        if ((k === j - 1 && x === 0) || (k === j + 1 && x === ancho - 1)) continue;
        visto[k] = 1; pila.push(k);
      }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (Math.min(w, h) < 3 || suma / n < 0.6) continue;
    const d = (w * h * 1.5) / (2 * (w + h)); // "unclip" 1,5: el mapa marca solo el centro de las letras
    const fx = img.ancho / ancho, fy = img.alto / alto;
    cajas.push([Math.max(0, (x0 - d) * fx), Math.max(0, (y0 - d) * fy), Math.min(img.ancho, (x1 + 1 + d) * fx), Math.min(img.alto, (y1 + 1 + d) * fy)].map(Math.round));
  }
  return cajas;
}

// Reconocimiento de un renglón: alto 48, ancho proporcional; CTC (lo más probable en cada paso, sin repetidos ni "en blanco")
async function leer(s, img, [x0, y0, x1, y1]) {
  const w = x1 - x0, h = y1 - y0, ALTO = 48;
  const ancho = Math.max(8, Math.min(3200, Math.ceil(w * ALTO / h))), total = Math.max(320, Math.ceil(ancho / 8) * 8);
  const t = new s.ort.Tensor('float32', aTensor(img, [x0, y0, w, h], ancho, ALTO, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], total), [1, 3, ALTO, total]);
  const sal = (await s.rec.run({ x: t }))[s.rec.outputNames[0]], [, pasos, clases] = sal.dims, p = sal.data;
  let texto = '', ant = 0, conf = 0, n = 0;
  for (let i = 0; i < pasos; i++) {
    let mejor = 0, max = -Infinity;
    for (let c = 0; c < clases; c++) if (p[i * clases + c] > max) { max = p[i * clases + c]; mejor = c; }
    if (mejor !== 0 && mejor !== ant) { texto += s.dic[mejor - 1] ?? ''; conf += max; n++; }
    ant = mejor;
  }
  return { texto: texto.trim(), confianza: n ? conf / n : 0 };
}

async function reconocer(img) {
  const s = await cargar();
  const bloques = [];
  for (const caja of await detectar(s, img)) {
    const r = await leer(s, img, caja);
    if (r.texto && r.confianza >= 0.5) bloques.push({ ...r, caja });
  }
  // orden de lectura: por renglones (cajas que se pisan en altura) y dentro de cada uno de izquierda a derecha
  bloques.sort((a, b) => a.caja[1] - b.caja[1]);
  const renglones = [];
  for (const b of bloques) {
    const r = renglones.find(r => { const m = (b.caja[1] + b.caja[3]) / 2; return m > r.y0 && m < r.y1; });
    if (r) { r.items.push(b); r.y0 = Math.min(r.y0, b.caja[1]); r.y1 = Math.max(r.y1, b.caja[3]); }
    else renglones.push({ y0: b.caja[1], y1: b.caja[3], items: [b] });
  }
  const orden = renglones.flatMap(r => r.items.sort((a, b) => a.caja[0] - b.caja[0]));
  return { texto: renglones.map(r => r.items.map(b => b.texto).join(' ')).join('\n'), bloques: orden, ancho: img.ancho, alto: img.alto };
}

module.exports = { reconocer };
