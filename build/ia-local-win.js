// Prepara lo que la IA sin internet necesita en Windows (no va al repositorio):
// - build/node-win/node.exe: Node común, porque el modelo no carga adentro de Electron (ver ia-local.js);
// - node_modules/@node-llama-cpp/win-x64: el motor compilado para Windows (npm solo baja el de la PC donde se arma).
// También escribe en package.json la lista de paquetes de node-llama-cpp que van al instalador (fuera del asar).
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const raiz = path.join(__dirname, '..');
const NODE = 'v22.22.0', LLAMA = require(path.join(raiz, 'node_modules/node-llama-cpp/package.json')).version;

const exe = path.join(__dirname, 'node-win', 'node.exe');
if (!fs.existsSync(exe)) {
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  execSync(`curl -fsSL -o "${exe}" https://nodejs.org/dist/${NODE}/win-x64/node.exe`, { stdio: 'inherit' });
}
const win = path.join(raiz, 'node_modules/@node-llama-cpp/win-x64');
if (!fs.existsSync(path.join(win, 'package.json')) || require(path.join(win, 'package.json')).version !== LLAMA) {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'nlc-'));
  execSync(`npm pack @node-llama-cpp/win-x64@${LLAMA} --silent`, { cwd: tmp, stdio: ['ignore', 'pipe', 'inherit'] });
  fs.rmSync(win, { recursive: true, force: true }); fs.mkdirSync(win, { recursive: true });
  execSync(`tar -xzf "${fs.readdirSync(tmp).find(f => f.endsWith('.tgz'))}" -C "${win}" --strip-components=1`, { cwd: tmp });
  fs.rmSync(tmp, { recursive: true, force: true });
}

// node-llama-cpp y todo lo que usa: van fuera del asar porque los lee Node común
const vistos = new Set();
function ubicar(desde, nombre) {
  for (let d = desde; ; d = path.dirname(d)) {
    const p = path.join(d, 'node_modules', nombre);
    if (fs.existsSync(path.join(p, 'package.json'))) return p;
    if (path.dirname(d) === d) throw new Error('Falta el paquete ' + nombre);
  }
}
(function ir(p) {
  if (vistos.has(p)) return; vistos.add(p);
  for (const n of Object.keys(require(path.join(p, 'package.json')).dependencies || {})) ir(ubicar(p, n));
})(path.join(raiz, 'node_modules/node-llama-cpp'));
const paquetes = [...vistos].map(p => path.relative(raiz, p).split(path.sep).join('/')).filter(p => !/node_modules\/.+\/node_modules\//.test(p)).sort();
const pj = path.join(raiz, 'package.json'), cfg = JSON.parse(fs.readFileSync(pj, 'utf8'));
// solo el motor de Windows con CPU: los de otras PCs (Linux, Mac, placas de video) pesan cientos de MB
const otros = ['linux-*', 'mac-*', 'win-arm64', 'win-x64-*'].map(n => `!node_modules/@node-llama-cpp/${n}/**`);
const lista = ['ia-local.js', ...paquetes.map(p => p + '/**'), 'node_modules/@node-llama-cpp/win-x64/**', '!node_modules/node-llama-cpp/llama/gitRelease.bundle', ...otros];
const unpack = ['ia-local.js', ...paquetes.map(p => p + '/**'), 'node_modules/@node-llama-cpp/win-x64/**'];
const marca = 'ia-local.js';
cfg.build.files = [...cfg.build.files.filter(f => f !== marca && !lista.includes(f)), ...lista];
cfg.build.asarUnpack = [...cfg.build.asarUnpack.filter(f => !unpack.includes(f)), ...unpack];
const nuevo = JSON.stringify(cfg, null, 2) + '\n';
if (nuevo !== fs.readFileSync(pj, 'utf8')) { fs.writeFileSync(pj, nuevo); console.log('package.json: lista de la IA local actualizada.'); }
console.log(`IA local lista para Windows: Node ${NODE}, motor ${LLAMA}, ${paquetes.length} paquetes.`);
