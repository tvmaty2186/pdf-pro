// Prepara el OCR con PaddleOCR para el instalador (no va al repositorio): baja los modelos ONNX a build/ocr-modelos
// (van a resources/ocr) y controla su huella. Detección PP-OCRv4 (RapidOCR) y reconocimiento latino PP-OCRv5.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { execSync } = require('child_process');
const dir = path.join(__dirname, 'ocr-modelos');
const MODELOS = {
  'det.onnx': ['https://huggingface.co/SWHL/RapidOCR/resolve/1cfba2e90fc938db55889873735088de210cc173/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx', 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9'],
  'rec.onnx': ['https://huggingface.co/monkt/paddleocr-onnx/resolve/7b02d0a30a07ba2b92ad1ff5a8941ae2c633de65/languages/latin/rec.onnx', '614ffc2d6d3902d360fad7f1b0dd455ee45e877069d14c4e51a99dc4ef144409'],
  'dict.txt': ['https://huggingface.co/monkt/paddleocr-onnx/resolve/7b02d0a30a07ba2b92ad1ff5a8941ae2c633de65/languages/latin/dict.txt', '3c0a8a79b612653c25f765271714f71281e4e955962c153e272b7b8c1d2b13ff']
};
fs.mkdirSync(dir, { recursive: true });
const huella = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
for (const [nombre, [url, sha]] of Object.entries(MODELOS)) {
  const f = path.join(dir, nombre);
  if (fs.existsSync(f) && huella(f) === sha) continue;
  execSync(`curl -fsSL -o "${f}" ${url}`, { stdio: 'inherit' });
  if (huella(f) !== sha) { fs.rmSync(f); throw new Error('El modelo de OCR bajó distinto: ' + nombre); }
}
console.log('OCR listo: modelos PaddleOCR en build/ocr-modelos.');
