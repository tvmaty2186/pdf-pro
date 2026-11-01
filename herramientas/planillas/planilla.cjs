#!/usr/bin/env node
// pdf.pro — planillas mensuales de asistencia (transporte, terapias, escuela).
// Toma la planilla de un mes y arma la del mes que se pida: cambia el período del encabezado, pone los días hábiles
// (sin sábados, domingos, feriados ni los días que no hubo), los horarios según el día de la semana, los kilómetros y la
// firma de cada fila, y deja vacías las filas que sobran. También revisa una planilla y avisa lo que no cierra.
// Usa el mismo motor que el programa (motor-trabajos.js: MuPDF) y pdf-lib. No guarda datos de nadie: todo lo aprende
// de la planilla que recibe.
//
//   node herramientas/planillas/planilla.cjs revisar ENTRADA.pdf
//   node herramientas/planillas/planilla.cjs armar ENTRADA.pdf --mes 2026-11 --feriados 9,11,23 [--sin 10,17]
//        [--horario "1-2:vie=8:30-9:50;lun-jue=8:30-10:50"] [--km "1-2=19.2KM;3-4=12km"] [--sin-firma] --salida SALIDA.pdf
//
// --horario y --km se aplican por grupo de hojas (1-2 = hojas 1 y 2). Si no se dan, se aprenden de la planilla:
// para cada día de la semana, el horario que más se repite; y el kilómetro que más se repite.
// Una hoja de planilla tiene filas "Nro 1", "Nro 2"…, y columnas Fecha / Hora de Inicio / Hora de Finalización /
// Kilómetros / Firma. Hojas seguidas con el mismo "Transporte a" son una sola planilla (las filas siguen de una a la otra).
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..', '..');
// los trabajos del motor se registran recién al usarlos (así este archivo también lo puede cargar el propio motor)
let H = null;
const trabajos = () => { if (!H) { H = new Map(); require(path.join(raiz, 'motor-trabajos.js'))({ handle: (n, f) => H.set(n, f) }); } return H; };
// lo que devuelve MuPDF apunta a su memoria interna: se copia enseguida (si no, el próximo trabajo lo pisa)
const motor = (n, ...a) => trabajos().get(n)(null, ...a).then(r => r instanceof Uint8Array ? Buffer.from(r) : r);
const { PDFDocument, PDFName, PDFOperator, PDFNumber, StandardFonts, rgb } = require('pdf-lib');

const MESES = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const DIA_N = { dom: 0, lun: 1, mar: 2, mie: 3, 'mié': 3, jue: 4, vie: 5, sab: 6, 'sáb': 6 };
const sinTilde = t => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const mediana = v => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
const masComun = v => { const c = new Map(); for (const x of v) c.set(x, (c.get(x) || 0) + 1); return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]; };
const dosDig = n => String(n).padStart(2, '0');

// ---------- Leer una hoja ----------
async function leerHoja(datos, n, mu) {
  const r = await motor('pagina-parrafos', datos, n);
  if (r.lugar && r.lugar.m.some((v, i) => Math.abs(v - [1, 0, 0, 1, 0, 0][i]) > 1e-6)) throw new Error(`La hoja ${n} está girada o recortada: esta herramienta todavía no la maneja.`);
  const W = r.parrafos.flatMap(p => p.lineas.flatMap(l => l.palabras)).map(w => ({ ...w, t: w.t.trim() })).filter(w => w.t);
  const hoja = { n, W };
  // encabezado de columnas
  const busca = re => W.find(w => re.test(sinTilde(w.t)));
  const col = { fecha: busca(/^fecha$/), inicio: busca(/^inicio$/) || busca(/^inici/), fin: busca(/^finalizacion$/), km: busca(/^kilometros$/) || busca(/^km$/), firma: busca(/^firma$/) };
  if (!col.fecha || !col.inicio || !col.fin) return null; // no es una hoja de planilla
  hoja.cx = Object.fromEntries(Object.entries(col).filter(([, w]) => w).map(([k, w]) => [k, (w.x0 + w.x1) / 2]));
  if (hoja.cx.km == null) hoja.cx.km = hoja.cx.fin + (hoja.cx.fin - hoja.cx.inicio);
  hoja.y0tabla = Math.min(col.fecha.y, col.inicio.y);
  // filas: "Nro" + número
  const filas = [];
  for (const w of W) if (/^Nro\s*\d*$/i.test(w.t)) filas.push({ y: w.y, x1: w.x1 });
  filas.sort((a, b) => b.y - a.y);
  const paso = mediana(filas.slice(1).map((f, i) => filas[i].y - f.y)) || 24;
  hoja.paso = paso;
  // a qué columna va una palabra (la del encabezado más cercano)
  const columnas = Object.entries(hoja.cx).sort((a, b) => a[1] - b[1]);
  const columnaDe = x => columnas.reduce((m, c) => Math.abs(c[1] - x) < Math.abs(m[1] - x) ? c : m)[0];
  for (const f of filas) {
    const en = W.filter(w => w.y < f.y + paso * 0.55 && w.y > f.y - paso * 0.45 && (w.x0 + w.x1) / 2 > hoja.cx.fecha - 30 && (/\d/.test(w.t) || /^[:.,]+$/.test(w.t) || /^km$/i.test(w.t))); // (el número de la fila queda afuera)
    f.tok = { fecha: [], inicio: [], fin: [], km: [] };
    for (const w of en) { const c = columnaDe((w.x0 + w.x1) / 2); if (f.tok[c]) f.tok[c].push(w); }
    for (const k in f.tok) f.tok[k].sort((a, b) => a.x0 - b.x0);
    const nums = f.tok.fecha.map(w => w.t).join(' ').match(/\d+/g) || [];
    f.fecha = nums.length >= 3 ? { d: +nums[0], m: +nums[1], a: +nums[2] } : null;
    const junta = k => f.tok[k].map(w => w.t).join('');
    f.inicio = junta('inicio') || null; f.fin = junta('fin') || null; f.km = junta('km') || null;
  }
  hoja.filas = filas;
  // cada letra de la hoja con su caja (puntos del PDF): para borrar un dato sin tocar lo impreso que tiene al lado
  hoja.letras = [];
  { const pg = mu.doc.loadPage(n - 1), inv = invertir(pg.getTransform());
    pg.toStructuredText('preserve-whitespace').walk({ onChar(c, o, _f, s, q) {
      if (!c.trim()) return;
      const p = [[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]].map(([x, y]) => aplicar(inv, x, y)), b = aplicar(inv, o[0], o[1]);
      hoja.letras.push({ c, s, x0: Math.min(...p.map(v => v[0])), x1: Math.max(...p.map(v => v[0])), y0: Math.min(...p.map(v => v[1])), y1: Math.max(...p.map(v => v[1])), bx: b[0], by: b[1] });
    } }); }
  // período del encabezado: "MES AAAA" encima de la tabla
  const lineas = r.parrafos.flatMap(p => p.lineas);
  const per = lineas.find(l => new RegExp(`^(${MESES.join('|')})\\s+\\d{4}$`, 'i').test(l.texto.trim()) && l.base[1] > hoja.y0tabla);
  if (per) hoja.periodo = { texto: per.texto.trim(), palabras: per.palabras, base: per.base };
  // "Transporte a …": para juntar las hojas de una misma planilla
  const ta = lineas.find(l => /^transporte a\b/i.test(l.texto.trim()));
  hoja.grupo = ta ? sinTilde(lineas.filter(l => Math.abs(l.base[1] - ta.base[1]) < 6 && l !== ta).map(l => l.texto).join(' ')).replace(/[^a-z0-9]/g, '') : 'hoja' + n; // sin espacios ni comas: "T.O, FONO" = "T.O , FONO"
  // firmas: imágenes en la columna Firma, a la altura de las filas
  hoja.firmas = [];
  if (hoja.cx.firma != null && filas.length) {
    const pg = mu.doc.loadPage(n - 1), inv = invertir(pg.getTransform()), arriba = filas[0].y + paso, abajo = filas.at(-1).y - paso;
    const dev = new mu.m.Device({ fillImage(img, ctm) {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => aplicar(inv, ...aplicar(ctm, x, y)));
      const b = [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
      const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
      if (Math.abs(cx - hoja.cx.firma) < 70 && cy < arriba && cy > abajo) hoja.firmas.push({ b, cx, cy, w: img.getWidth(), h: img.getHeight() });
    } });
    pg.run(dev, mu.m.Matrix.identity); dev.close();
    for (const f of filas) f.firma = hoja.firmas.some(s => Math.abs(s.cy - f.y) < paso * 0.6);
  }
  return hoja;
}
const aplicar = ([a, b, c, d, e, f], x, y) => [a * x + c * y + e, b * x + d * y + f];
const invertir = ([a, b, c, d, e, f]) => { const k = a * d - b * c; return [d / k, -b / k, -c / k, a / k, (c * f - d * e) / k, (b * e - a * f) / k]; };

async function leerPlanilla(datos) {
  const m = await import('mupdf');
  const doc = m.Document.openDocument(datos, 'application/pdf'), mu = { m, doc };
  const hojas = [];
  for (let n = 1; n <= doc.countPages(); n++) { const h = await leerHoja(datos, n, mu); if (h) hojas.push(h); }
  doc.destroy?.();
  // grupos: hojas seguidas con el mismo "Transporte a"
  const grupos = [];
  for (const h of hojas) { const g = grupos.at(-1); if (g && g.clave === h.grupo && g.hojas.at(-1).n === h.n - 1) g.hojas.push(h); else grupos.push({ clave: h.grupo, hojas: [h] }); }
  for (const g of grupos) {
    g.filas = g.hojas.flatMap(h => h.filas.map(f => ({ ...f, hoja: h }))).map((f, i) => ({ ...f, nro: i + 1 }));
    const llenas = g.filas.filter(f => f.fecha);
    // horario por día de la semana y km, aprendidos de lo que ya está
    g.horario = {};
    for (let d = 1; d <= 5; d++) {
      const delDia = llenas.filter(f => new Date(f.fecha.a, f.fecha.m - 1, f.fecha.d).getDay() === d && f.inicio && f.fin);
      const h = masComun(delDia.map(f => f.inicio + '-' + f.fin));
      if (h) g.horario[d] = h;
    }
    g.km = masComun(llenas.map(f => f.km).filter(Boolean).map(k => k.replace(/\s/g, '')));
    g.hojasTxt = g.hojas.map(h => h.n).join('-');
  }
  return { hojas, grupos };
}

// ---------- Revisar ----------
function revisar(pl, feriados = []) {
  const avisos = [];
  for (const g of pl.grupos) {
    const general = masComun(Object.values(g.horario));
    for (const f of g.filas) {
      const donde = `hoja ${f.hoja.n}, Nro ${f.nro}`;
      if (!f.fecha) { if (f.inicio || f.fin || f.km || f.firma) avisos.push(`${donde}: sin fecha pero con datos`); continue; }
      const dt = new Date(f.fecha.a, f.fecha.m - 1, f.fecha.d), dia = dt.getDay(), txt = `${dosDig(f.fecha.d)}/${dosDig(f.fecha.m)} (${DIAS[dia]})`;
      if (dia === 0 || dia === 6) avisos.push(`${donde} ${txt}: cae fin de semana`);
      if (feriados.includes(f.fecha.d)) avisos.push(`${donde} ${txt}: es feriado`);
      if (!f.inicio || !f.fin) avisos.push(`${donde} ${txt}: falta el horario`);
      if (!f.km) avisos.push(`${donde} ${txt}: faltan los kilómetros`);
      if (f.hoja.firmas.length && !f.firma) avisos.push(`${donde} ${txt}: falta la firma`);
      const esperado = g.horario[dia] || general;
      if (f.inicio && f.fin && esperado && f.inicio + '-' + f.fin !== esperado) avisos.push(`${donde} ${txt}: horario ${f.inicio} a ${f.fin}, los ${DIAS[dia]} suele ser ${esperado.replace('-', ' a ')}`);
      if (f.km && g.km && f.km.replace(/\s/g, '').toLowerCase() !== g.km.toLowerCase()) avisos.push(`${donde} ${txt}: km "${f.km}" (los demás dicen "${g.km}")`);
    }
    const fechas = g.filas.filter(f => f.fecha).map(f => f.fecha.d), rep = fechas.filter((d, i) => fechas.indexOf(d) !== i);
    if (rep.length) avisos.push(`hojas ${g.hojasTxt}: fechas repetidas: ${[...new Set(rep)].join(', ')}`);
  }
  return avisos;
}

// ---------- Armar el mes ----------
function diasHabiles(a, m, sacar) {
  const out = [];
  for (let d = 1; d <= new Date(a, m, 0).getDate(); d++) { const w = new Date(a, m - 1, d).getDay(); if (w > 0 && w < 6 && !sacar.includes(d)) out.push(d); }
  return out;
}
// "1-2:vie=8:30-9:50;lun-jue=8:30-10:50" → { '1-2': { 5: '8:30-9:50', 1: …, 4: … } }
function leerHorario(txt) {
  const out = {};
  for (const parte of String(txt || '').split('|').filter(Boolean)) {
    const [hojas, reglas] = parte.split(':').length > 2 ? [parte.slice(0, parte.indexOf(':')), parte.slice(parte.indexOf(':') + 1)] : ['*', parte];
    const r = out[hojas] ||= {};
    for (const regla of reglas.split(';').filter(Boolean)) {
      const [dias, h] = regla.split('=');
      const [d0, d1] = dias.split('-').map(x => DIA_N[sinTilde(x)]);
      for (let d = d0; d <= (d1 ?? d0); d++) r[d] = h.trim();
    }
  }
  return out;
}
const leerKm = txt => Object.fromEntries(String(txt || '').split(';').filter(Boolean).map(p => p.split('=').map(x => x.trim())));

async function armar(datos, pl, op) {
  const [a, m] = op.mes.split('-').map(Number);
  const sacar = [...op.feriados, ...op.sin];
  const dias = diasHabiles(a, m, sacar);
  const reglas = leerHorario(op.horario), kms = leerKm(op.km), informe = [];
  // por hoja: qué borrar y qué escribir
  const porHoja = new Map(), hoja = n => { if (!porHoja.has(n)) porHoja.set(n, { borrar: [], tapar: [], escribir: [], firmas: [] }); return porHoja.get(n); };
  // zona para borrar un dato: MuPDF borra toda letra cuya caja TOCA la zona. Lo impreso de la planilla ("Desde……hs",
  // "--/--/----") está un poco más abajo que el dato escrito encima: se borra solo la franja de arriba del dato, por
  // encima de lo más alto de lo impreso que tiene al lado
  // las letras que son datos (todas las de fechas, horarios, km y período de la hoja): lo demás es lo impreso
  const esDato = new Map();
  const deDato = (w, h) => h.letras.filter(l => Math.abs(l.by - w.y) < 0.8 && l.bx >= w.x0 - 0.5 && l.bx <= w.x1 + 0.5);
  for (const h of pl.hojas) { const set = new Set(); for (const f of h.filas) for (const k of ['fecha', 'inicio', 'fin', 'km']) for (const w of f.tok[k]) deDato(w, h).forEach(l => set.add(l)); if (h.periodo) for (const w of h.periodo.palabras) deDato(w, h).forEach(l => set.add(l)); esDato.set(h, set); }
  const cajaDe = (w, h) => {
    const mias = deDato(w, h), datos = esDato.get(h);
    // MuPDF borra toda letra cuya CAJA toca la zona, y esa caja va de la base hasta ~0,86 del tamaño, con todo el ancho de
    // la letra (aunque sea un punto). Lo impreso de la planilla ("Desde……hs", "--/--/----") está más abajo que el dato
    // escrito encima: se borra la franja del dato que queda por encima de lo más alto de lo impreso que tiene debajo.
    const techo = mias.length ? Math.max(...mias.map(l => l.by + l.s * 0.8)) : w.y + w.tam * 0.8;
    const x0 = w.x0 + 0.2, x1 = w.x1 - 0.2;
    let piso = w.y + 0.3;
    for (const l of h.letras) if (!datos.has(l) && l.x1 > x0 && l.x0 < x1 && l.by < techo) piso = Math.max(piso, l.by + l.s * 0.92 + 0.2);
    return piso < techo - 0.2 ? [x0, piso, x1, techo] : null; // sin lugar: no se borra (y el control de abajo avisa)
  };


  for (const g of pl.grupos) {
    if (g.filas.length < dias.length) throw new Error(`Las hojas ${g.hojasTxt} tienen ${g.filas.length} filas y el mes tiene ${dias.length} días hábiles.`);
    const regla = reglas[g.hojasTxt] || reglas['*'] || {}, km = kms[g.hojasTxt] || kms['*'] || g.km;
    // fila modelo: la primera completa (de ahí salen letra, tamaño y lugar de cada dato)
    const modelo = g.filas.find(f => f.fecha && f.inicio && f.fin && f.km && f.tok.fecha.length);
    if (!modelo) throw new Error(`Las hojas ${g.hojasTxt} no tienen ninguna fila completa para copiar el formato.`);
    const general = masComun(Object.values(g.horario));
    const lineas = [];
    g.filas.forEach((f, i) => {
      const H0 = hoja(f.hoja.n);
      for (const k of ['fecha', 'inicio', 'fin', 'km']) for (const w of f.tok[k]) { const z = cajaDe(w, f.hoja); if (z) H0.borrar.push(z); else H0.tapar.push([w.x0 - 0.2, w.y - 0.4, w.x1 + 0.2, w.y + w.tam * 0.74]); }
      const d = dias[i];
      if (d == null) { lineas.push(`  Nro ${f.nro}: vacía`); return; }
      const dia = new Date(a, m - 1, d).getDay(), horario = regla[dia] || g.horario[dia] || general;
      if (!horario) throw new Error(`No sé el horario de los ${DIAS[dia]} en las hojas ${g.hojasTxt}: pasalo con --horario.`);
      const [ini, fin] = horario.split('-');
      const dy = f.y - modelo.y;
      // fecha: con el mismo corte que el modelo (dd · mm · aaaa en tres pedazos, o junta)
      const partes = modelo.tok.fecha.length >= 3 ? [dosDig(d), dosDig(m), String(a)] : [`${dosDig(d)}/${dosDig(m)}/${a}`];
      partes.forEach((t, j) => { const w = modelo.tok.fecha[j]; H0.escribir.push({ t, x: w.x0, y: w.y + dy, tam: w.tam, f: w.f }); });
      for (const [k, t] of [['inicio', ini], ['fin', fin], ['km', km]]) { const w = modelo.tok[k][0]; H0.escribir.push({ t, x: w.x0, y: w.y + dy, tam: w.tam, f: w.f }); }
      if (!op.sinFirma) H0.firmas.push(f.y);
      lineas.push(`  Nro ${f.nro}: ${dosDig(d)}/${dosDig(m)} ${DIAS[dia]}  ${ini} a ${fin}  ${km}${op.sinFirma ? '' : '  firma'}`);
    });
    informe.push(`Hojas ${g.hojasTxt} (${dias.length} días hábiles):`, ...lineas);
  }
  // encabezado
  const nuevoPer = t => (t === t.toUpperCase() ? MESES[m - 1] : MESES[m - 1][0] + MESES[m - 1].slice(1).toLowerCase()) + ' ' + a;
  for (const h of pl.hojas) if (h.periodo) {
    const H0 = hoja(h.n), w0 = h.periodo.palabras[0];
    for (const w of h.periodo.palabras) { const z = cajaDe(w, h); if (z) H0.borrar.push(z); }
    H0.escribir.push({ t: nuevoPer(h.periodo.texto), x: w0.x0, y: w0.y, tam: w0.tam, f: w0.f });
  }
  // firma: la imagen que más se repite en la columna Firma; se sacan todas y se pone una por fila con fecha
  for (const h of pl.hojas) {
    const H0 = hoja(h.n);
    if (op.sinFirma || !h.firmas.length) { if (H0.firmas.length && !op.sinFirma) informe.push(`Ojo: la hoja ${h.n} no tiene firmas para copiar.`); H0.firmas = []; continue; }
    const tipo = masComun(h.firmas.map(s => s.w + 'x' + s.h)), modelo = h.firmas.filter(s => s.w + 'x' + s.h === tipo);
    H0.firmaTipo = { w: +tipo.split('x')[0], h: +tipo.split('x')[1] };
    const filaDe = s => h.filas.reduce((x, f) => Math.abs(f.y - s.cy) < Math.abs(x.y - s.cy) ? f : x);
    H0.firmaRel = { dx: mediana(modelo.map(s => s.b[0])), dy: mediana(modelo.map(s => s.b[1] - filaDe(s).y)), w: mediana(modelo.map(s => s.b[2] - s.b[0])), h: mediana(modelo.map(s => s.b[3] - s.b[1])) };
    H0.sacarFirmas = h.firmas.map(s => [s.cx - 0.5, s.cy - 0.5, s.cx + 0.5, s.cy + 0.5]);
  }
  // 1) sacar firmas viejas, 2) borrar datos viejos, 3) escribir, 4) poner firmas
  const firmaRef = new Map();
  { // la firma se busca antes de sacarla (después puede no quedar referenciada en la hoja)
    const doc = await PDFDocument.load(datos, { updateMetadata: false });
    for (const [n, H0] of porHoja) if (H0.firmaTipo) firmaRef.set(n, buscarImagen(doc, doc.getPage(n - 1), H0.firmaTipo));
  }
  for (const [n, H0] of porHoja) {
    if (H0.sacarFirmas?.length) datos = await motor('borrar-zona', datos, n, H0.sacarFirmas, { texto: false, imagenes: 'quitar' });
    if (H0.borrar.length) datos = await motor('borrar-zona', datos, n, H0.borrar, { texto: true });
    // un dato viejo escrito justo encima de lo impreso (sin franja libre para borrarlo): se tapa solo su tinta con
    // blanco, antes de escribir el nuevo
    if (H0.tapar.length) {
      const d0 = await PDFDocument.load(datos, { updateMetadata: false }), pg = d0.getPage(n - 1);
      for (const [a, b, c, d] of H0.tapar) pg.drawRectangle({ x: a, y: b, width: c - a, height: d - b, color: rgb(1, 1, 1) });
      datos = Buffer.from(await d0.save({ useObjectStreams: true }));
      informe.push(`(hoja ${n}: ${H0.tapar.length} dato(s) viejo(s) estaban encima de lo impreso; se taparon con blanco)`);
    }
  }
  // escribir con la letra original de cada dato; si no trae alguna letra, con Helvetica
  const faltan = [];
  for (const [n, H0] of porHoja) {
    const porFuente = new Map();
    for (const e of H0.escribir) { if (!porFuente.has(e.f)) porFuente.set(e.f, []); porFuente.get(e.f).push(e); }
    for (const [f, lista] of porFuente) {
      const fu = await motor('fuente-original', datos, n, f).catch(() => null);
      const sirve = e => fu && Object.keys(fu.mapa).length && [...e.t].every(c => c in fu.mapa);
      const con = lista.filter(sirve), sin = lista.filter(e => !sirve(e));
      if (con.length) datos = await motor('escribir-original', datos, n, { recurso: fu.recurso, num: fu.num }, con.map(e => ({ x: e.x, y: e.y, tam: e.tam, color: [0, 0, 0], hex: [...e.t].map(c => fu.mapa[c]).join('') })));
      faltan.push(...sin.map(e => ({ ...e, n })));
    }
  }
  const doc = await PDFDocument.load(datos, { updateMetadata: false });
  if (faltan.length) {
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    for (const e of faltan) doc.getPage(e.n - 1).drawText(e.t, { x: e.x, y: e.y, size: e.tam, font: helv });
    informe.push(`(${faltan.length} dato(s) con Helvetica porque la letra del PDF no traía esas letras: ${[...new Set(faltan.map(e => e.t))].join(', ')})`);
  }
  for (const [n, H0] of porHoja) {
    if (!H0.firmas.length || !H0.firmaRel) continue;
    const page = doc.getPage(n - 1), ref = firmaRef.get(n);
    if (!ref || !doc.context.lookup(ref)) throw new Error('No pude volver a usar la firma de la hoja ' + n);
    const xo = page.node.Resources().lookup(PDFName.of('XObject')) || (() => { const d = doc.context.obj({}); page.node.Resources().set(PDFName.of('XObject'), d); return d; })();
    xo.set(PDFName.of('FirmaPro'), ref);
    const { dx, dy, w, h } = H0.firmaRel;
    for (const y of H0.firmas) page.pushOperators(PDFOperator.of('q'), PDFOperator.of('cm', [w, 0, 0, h, dx, y + dy].map(v => PDFNumber.of(Math.round(v * 100) / 100))), PDFOperator.of('Do', [PDFName.of('FirmaPro')]), PDFOperator.of('Q'));
  }
  return { datos: Buffer.from(await doc.save({ useObjectStreams: true })), informe };
}
// la imagen (por su tamaño en píxeles) en la hoja o adentro de un dibujo (Form) de la hoja
function buscarImagen(doc, page, { w, h }) {
  let ref = null;
  const ver = (dic, prof) => {
    if (!dic || prof > 3 || ref) return;
    for (const k of dic.keys()) {
      const r = dic.get(k), o = doc.context.lookup(r), dd = o?.dict;
      if (dd?.get(PDFName.of('Width'))?.asNumber?.() === w && dd.get(PDFName.of('Height'))?.asNumber?.() === h) { ref = r; return; }
      const sub = dd?.lookup?.(PDFName.of('Resources'))?.lookup?.(PDFName.of('XObject'));
      if (sub) ver(sub, prof + 1);
    }
  };
  ver(page.node.Resources()?.lookup(PDFName.of('XObject')), 0);
  return ref;
}

// Resumen corto de una planilla (para el asistente y la línea de comandos)
function resumen(pl) {
  return [...pl.grupos.map(g => `Hojas ${g.hojasTxt}: ${g.filas.length} filas, ${g.filas.filter(f => f.fecha).length} con fecha · horario aprendido: ${Object.entries(g.horario).map(([d, h]) => DIAS[d] + ' ' + h).join(', ') || '—'} · km: ${g.km || '—'}`),
    'Período en el encabezado: ' + (pl.hojas.filter(h => h.periodo).map(h => `${h.n}: ${h.periodo.texto}`).join(' · ') || 'no lo encontré')];
}
// Para usarla desde el programa (el motor la llama): revisar y armar con los bytes del PDF
async function revisarPdf(datos, feriados = []) {
  const pl = await leerPlanilla(Buffer.from(datos));
  if (!pl.grupos.length) throw new Error('No es una planilla de asistencia (no encontré las columnas Fecha, Hora de Inicio y Hora de Finalización).');
  return { resumen: resumen(pl), avisos: revisar(pl, feriados) };
}
async function armarPdf(datos, op) {
  const pl = await leerPlanilla(Buffer.from(datos));
  if (!pl.grupos.length) throw new Error('No es una planilla de asistencia (no encontré las columnas Fecha, Hora de Inicio y Hora de Finalización).');
  const o = { feriados: [], sin: [], ...op };
  if (!/^\d{4}-\d{1,2}$/.test(o.mes || '')) throw new Error('Falta el mes (AAAA-MM).');
  const { datos: nuevo, informe } = await armar(Buffer.from(datos), pl, o);
  const control = revisar(await leerPlanilla(nuevo), o.feriados);
  return { datos: new Uint8Array(nuevo), resumen: resumen(pl), informe, control };
}
module.exports = { revisarPdf, armarPdf, MESES };

// ---------- Línea de comandos ----------
if (require.main === module) (async () => {
  const [cmd, entrada, ...resto] = process.argv.slice(2);
  const op = { feriados: [], sin: [] };
  for (let i = 0; i < resto.length; i++) {
    const k = resto[i];
    if (k === '--sin-firma') op.sinFirma = true;
    else if (k.startsWith('--')) { const v = resto[++i]; const clave = k.slice(2); op[clave] = /^(feriados|sin)$/.test(clave) ? v.split(',').filter(Boolean).map(Number) : v; }
  }
  if (!cmd || !entrada || !fs.existsSync(entrada)) { console.log('Uso: planilla.cjs revisar ENTRADA.pdf | armar ENTRADA.pdf --mes AAAA-MM --feriados d,d --salida SALIDA.pdf'); process.exit(1); }
  const datos = fs.readFileSync(entrada), pl = await leerPlanilla(datos);
  if (!pl.grupos.length) throw new Error('No encontré ninguna hoja con forma de planilla (columnas Fecha, Hora de Inicio, Hora de Finalización).');
  console.log(resumen(pl).join('\n'));
  if (cmd === 'revisar') {
    const avisos = revisar(pl, op.feriados);
    console.log(avisos.length ? '\nPara revisar:\n- ' + avisos.join('\n- ') : '\nTodo en orden.');
  } else if (cmd === 'armar') {
    if (!/^\d{4}-\d{1,2}$/.test(op.mes || '') || !op.salida) throw new Error('Faltan --mes AAAA-MM y --salida.');
    const { datos: nuevo, informe } = await armar(datos, pl, op);
    fs.writeFileSync(op.salida, nuevo);
    console.log('\n' + informe.join('\n'));
    const control = revisar(await leerPlanilla(nuevo), op.feriados);
    console.log(control.length ? '\nControl de la planilla nueva:\n- ' + control.join('\n- ') : '\nControl de la planilla nueva: todo en orden.');
    console.log('Guardada en ' + op.salida);
  } else throw new Error('Comando desconocido: ' + cmd);
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
