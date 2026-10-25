// PDF.Pro — Repetir hacia abajo: completás la primera fila de una tabla con Rellenar y se copia en las filas de abajo
// (mismo lugar, tamaño y letra). Las filas se detectan con los renglones impresos de la hoja (su distancia se repite).
// Las fechas pueden quedar iguales, avanzar un día o ir solo a los días elegidos (los de sesión, por ejemplo mar y jue).
const FECHA = /(\d{1,2})([\/.-])(\d{1,2})\2(\d{2,4})/;
const DIAS = [['1', 'Lu'], ['2', 'Ma'], ['3', 'Mi'], ['4', 'Ju'], ['5', 'Vi'], ['6', 'Sá'], ['0', 'Do']];

const centroY = r => (r[1] + r[3]) / 2;
// La fila de la tabla: los textos de Rellenar de la misma página a la misma altura
export const filaDe = (p, c) => p.comentarios.filter(x => x.tipo === 'texto' && x.n === c.n && !x.giro && Math.abs(centroY(x.rect) - centroY(c.rect)) < Math.max(4, (c.tam || 11) * 0.5));

// Las filas impresas de abajo: los renglones de la hoja agrupados por altura, desde la fila elegida, mientras la distancia se repita
export function filasDeAbajo(lineas, fila) {
  const x0 = Math.min(...fila.map(c => c.rect[0])) - 300, x1 = Math.max(...fila.map(c => c.rect[2])) + 300, y = centroY(fila[0].rect);
  const alturas = [];
  for (const l of lineas.filter(l => (l.rect[0] + l.rect[2]) / 2 > x0 && (l.rect[0] + l.rect[2]) / 2 < x1).map(l => centroY(l.rect)).sort((a, b) => b - a))
    if (!alturas.length || Math.abs(alturas.at(-1) - l) > 2) alturas.push(l);
  const inicio = alturas.findIndex(a => Math.abs(a - y) < 9); // el renglón impreso de la fila elegida
  const desde = inicio >= 0 ? alturas[inicio] : y, abajo = alturas.filter(a => a < desde - 2);
  if (abajo.length < 1) return { paso: 0, filas: 0 };
  const paso = desde - abajo[0];
  let filas = 0, ant = desde;
  for (const a of abajo) { if (Math.abs(ant - a - paso) > paso * 0.2) break; filas++; ant = a; }
  return { paso, filas };
}

// La fecha que sigue: igual, el día siguiente o el próximo de los días elegidos (0 = domingo)
export function siguienteFecha(texto, modo, dias, k) {
  const m = texto.match(FECHA);
  if (!m || modo === 'igual') return texto;
  const anio = m[4].length === 2 ? 2000 + +m[4] : +m[4];
  const f = new Date(anio, +m[3] - 1, +m[1]);
  for (let i = 0; i < k; i++) {
    f.setDate(f.getDate() + 1);
    if (modo === 'dias' && dias.size) while (!dias.has(String(f.getDay()))) f.setDate(f.getDate() + 1);
  }
  const dd = String(f.getDate()).padStart(m[1].length, '0'), mm = String(f.getMonth() + 1).padStart(m[3].length, '0');
  const aa = m[4].length === 2 ? String(f.getFullYear()).slice(2) : String(f.getFullYear());
  return texto.replace(FECHA, `${dd}${m[2]}${mm}${m[2]}${aa}`);
}

export async function repetirHaciaAbajo(ctx, p, c) {
  const { el, dialogo, api, aviso, cambiarComentarios } = ctx;
  if (c.giro) return aviso('En hojas giradas todavía no se puede repetir hacia abajo.', true);
  const fila = filaDe(p, c);
  const { lineas = [] } = await api.paginaContenido(p.datos, c.n).catch(() => ({}));
  let { paso, filas } = filasDeAbajo(lineas, fila);
  const conFecha = fila.some(x => FECHA.test(x.nota || ''));
  const cuantas = el('input', { class: 'campo', type: 'number', min: 1, max: 60, value: filas || 5, style: 'width:70px' });
  const mm = el('input', { class: 'campo', type: 'number', min: 2, max: 60, step: 0.5, value: ((paso || 14) / 72 * 25.4).toFixed(1), style: 'width:70px' });
  const fechaDia = conFecha ? new Date(...(m => [m[4].length === 2 ? 2000 + +m[4] : +m[4], +m[3] - 1, +m[1]])(fila.find(x => FECHA.test(x.nota)).nota.match(FECHA))).getDay() : 2;
  const modo = el('select', { class: 'campo' }, el('option', { value: 'dias' }, 'Solo los días marcados'), el('option', { value: 'siguiente' }, 'Un día más cada fila'), el('option', { value: 'igual' }, 'Todas iguales'));
  const dias = DIAS.map(([v, t]) => el('label', { class: 'dia-casilla' }, el('input', { type: 'checkbox', value: v, checked: +v === fechaDia }), t));
  const filaDlg = (t, x) => el('div', { class: 'pref-fila' }, el('span', {}, t), x);
  const r = await dialogo({ titulo: 'Repetir hacia abajo', texto: filas ? `Copio esta fila (${fila.length} ${fila.length === 1 ? 'dato' : 'datos'}) en las filas de abajo. Encontré ${filas} filas.` : 'Copio esta fila en las de abajo. No pude medir las filas: revisá la distancia.',
    contenido: el('div', { class: 'pref-seccion' }, filaDlg('Cuántas filas', cuantas), filaDlg('Distancia entre filas (mm)', mm),
      conFecha ? filaDlg('Fechas', modo) : null, conFecha ? el('div', { class: 'dias-semana' }, ...dias) : null),
    botones: [{ t: 'Cancelar', v: null }, { t: 'Repetir', v: 'si', primario: true }] });
  if (!r) return;
  const n = Math.min(60, Math.max(1, +cuantas.value || 1)), d = (+mm.value || 5) / 25.4 * 72;
  const elegidos = new Set(dias.map(x => x.querySelector('input')).filter(i => i.checked).map(i => i.value));
  const nuevos = [];
  for (let k = 1; k <= n; k++) for (const x of fila) {
    const [x0, y0, x1, y1] = x.rect;
    nuevos.push({ ...x, id: crypto.randomUUID(), rect: [x0, y0 - d * k, x1, y1 - d * k], nota: conFecha ? siguienteFecha(x.nota || '', modo.value, elegidos, k) : x.nota });
  }
  cambiarComentarios(p, [...p.comentarios, ...nuevos], `Fila repetida ${n} ${n === 1 ? 'vez' : 'veces'} hacia abajo (Ctrl+Z para deshacer)`);
}
