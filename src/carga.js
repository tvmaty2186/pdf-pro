// pdf.pro — pantalla de carga. main.js llama a avance(porcentaje, texto) en cada paso real del arranque.
document.getElementById('version').textContent = 'versión ' + (new URLSearchParams(location.search).get('version') || '');
window.avance = (pct, texto) => {
  document.getElementById('relleno').style.width = Math.max(0, Math.min(100, pct)) + '%';
  if (texto) document.getElementById('estado').textContent = texto;
};
