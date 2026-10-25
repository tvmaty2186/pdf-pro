#!/bin/sh
# Sube el instalador recién armado (npm run dist) a github.com/tvmaty2186/pdf-pro-versiones.
# Allá una GitHub Action lo junta y publica la versión; el programa la encuentra en Ayuda → Buscar actualizaciones.
# Uso: ./publicar-version.sh "Qué cambió en esta versión"
set -e
v=$(node -p "require('./package.json').version")
dest=../pdf-pro-versiones
[ -f "dist/PDF.Pro Setup $v.exe" ] || { echo "Falta dist/PDF.Pro Setup $v.exe (npm run dist)"; exit 1; }
rm -rf "$dest/subir" && mkdir -p "$dest/subir"
split -b 45m -d "dist/PDF.Pro Setup $v.exe" "$dest/subir/instalador.part"
cp "dist/PDF.Pro Setup $v.exe.blockmap" "$dest/subir/PDF.Pro-Setup-$v.exe.blockmap"
cp dist/latest.yml "$dest/subir/latest.yml"
printf '%s\n' "${1:-Versión $v}" > "$dest/subir/notas.md"
echo "$v" > "$dest/subir/version.txt"
cd "$dest"
# cada versión va en un historial nuevo (sin las anteriores): así el repositorio no crece 120 MB por versión
git checkout -q --orphan nueva
git rm -rq --cached . 2>/dev/null || true
git add .github README.md subir
git commit -qm "pdf.pro $v" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git branch -q -D main 2>/dev/null || true
git branch -q -m main
git push -q -f origin main
git reflog expire --expire=now --all && git gc -q --prune=now
# un historial nuevo no siempre dispara la Action sola: se le avisa
[ -n "$GH_TOKEN" ] && curl -sS -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" -H "Content-Type: application/json" \
  https://api.github.com/repos/tvmaty2186/pdf-pro-versiones/actions/workflows/publicar.yml/dispatches -d '{"ref":"main"}' >/dev/null
echo "Subida la versión $v"
