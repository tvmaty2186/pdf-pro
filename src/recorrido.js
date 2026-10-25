// PDF.Pro — recorrido de bienvenida: la primera vez que se abre un PDF, unos pocos pasos muestran dónde está cada cosa
// (se ilumina el lugar y al lado va la explicación). Se puede saltar; se vuelve a ver desde Ayuda.
const PASOS = [
  { donde: () => document.querySelector('#barra-comandos [data-cmd="rellenar"]'), titulo: 'Rellenar formularios',
    texto: 'Hacé clic acá y después en el renglón del formulario: escribís derecho, alineado con lo impreso. También pone ✓, ✗ y la fecha de hoy.' },
  { donde: () => document.querySelector('#barra-comandos [data-cmd="firmar"]'), titulo: 'Firmar',
    texto: 'Tu firma o sello guardados, con un clic. La primera vez la agregás desde una foto: el fondo se quita solo.' },
  { donde: () => document.querySelector('#barra-comandos [data-cmd="editar"]'), titulo: 'Editar el texto',
    texto: 'Cambiás lo que dice el PDF como en Word, con la misma letra. Si algo no entra, sigue en la hoja de abajo.' },
  { donde: () => [...document.querySelectorAll('#rapidas button')].find(b => /Más/.test(b.textContent)), titulo: 'Todas las herramientas',
    texto: 'Acá está todo: comprimir, unir, numerar, censurar, pasar a Word o Excel, contraseñas y más. También con Ctrl+K, escribiendo lo que querés hacer.' },
  { donde: () => document.querySelector('.mascota'), titulo: 'Tu asistente', lado: 'izquierda',
    texto: 'Completa formularios con tus datos, aprende de tus ejemplos y responde lo que le preguntes. Elegís Claude o Gemini en Asistente → Ajustes de la IA.' },
  { donde: () => document.querySelector('#menus'), titulo: 'Los menús', abajo: true,
    texto: 'Todo lo demás está en los menús de arriba. Si algo falla, Ayuda → Enviar informe de errores. Este recorrido se vuelve a ver desde Ayuda.' }
];

export function recorrido({ el, nombreMascota = 'el asistente', alTerminar }) {
  if (document.querySelector('.recorrido')) return;
  const pasos = PASOS.map(p => ({ ...p, titulo: p.titulo === 'Tu asistente' ? `Tu asistente: ${nombreMascota}` : p.titulo }));
  const luz = el('div', { class: 'recorrido-luz' }), globo = el('div', { class: 'recorrido-globo', role: 'dialog', 'aria-live': 'polite' });
  const capa = el('div', { class: 'recorrido' }, luz, globo);
  let i = -1;
  const terminar = () => { capa.remove(); removeEventListener('keydown', tecla, true); removeEventListener('resize', mostrar); alTerminar?.(); };
  const tecla = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); terminar(); } else if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); siguiente(); } };
  function siguiente() {
    do i++; while (i < pasos.length && !visible(pasos[i].donde()));
    if (i >= pasos.length) return terminar();
    mostrar();
  }
  function mostrar() {
    const p = pasos[i], r = p.donde().getBoundingClientRect(), m = 6;
    Object.assign(luz.style, { left: r.left - m + 'px', top: r.top - m + 'px', width: r.width + m * 2 + 'px', height: r.height + m * 2 + 'px' });
    const ultimo = !pasos.slice(i + 1).some(q => visible(q.donde()));
    globo.replaceChildren(el('small', { class: 'sutil' }, `${pasos.slice(0, i + 1).filter(q => visible(q.donde())).length} de ${pasos.filter(q => visible(q.donde())).length}`),
      el('h4', {}, p.titulo), el('p', {}, p.texto),
      el('div', { class: 'recorrido-botones' }, ultimo ? null : el('button', { class: 'btn-texto', onclick: terminar }, 'Saltar'),
        el('button', { class: 'btn-primario', onclick: siguiente }, ultimo ? '¡Listo!' : 'Siguiente')));
    // el globo va al lado del lugar: abajo si entra, si no arriba; a la izquierda para la mascota (abajo a la derecha)
    const W = Math.min(320, innerWidth - 24), H = globo.offsetHeight || 170;
    let x = r.left + r.width / 2 - W / 2, y = r.bottom + 14;
    if (p.lado === 'izquierda') { x = r.left - W - 16; y = r.bottom - H; }
    else if (y + H > innerHeight - 8) y = r.top - H - 14;
    Object.assign(globo.style, { width: W + 'px', left: Math.max(12, Math.min(x, innerWidth - W - 12)) + 'px', top: Math.max(12, Math.min(y, innerHeight - H - 12)) + 'px' });
    globo.querySelector('.btn-primario')?.focus();
  }
  document.body.append(capa);
  addEventListener('keydown', tecla, true); addEventListener('resize', mostrar);
  siguiente();
}
const visible = e => !!e && e.getClientRects().length > 0 && !e.closest('[hidden]');
