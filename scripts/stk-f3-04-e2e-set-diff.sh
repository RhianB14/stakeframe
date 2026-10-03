#!/usr/bin/env bash
# STK-F3-04 — compara o CONJUNTO de falhas do E2E entre a branch e o baseline.
#
# O número agregado varia com flake de contenção; o conjunto é que prova. Este
# script roda o MESMO arquivo nos DOIS estados e imprime a diferença de
# conjuntos, para que "não regredi" seja uma afirmação verificada e não uma
# esperança.
#
# Uso: bash scripts/stk-f3-04-e2e-set-diff.sh
set -uo pipefail

cd "$(dirname "$0")/.."
PORT="${E2E_PORT:-8111}"
OUT="${TMPDIR:-/tmp}/stk-f3-04-set-diff"
mkdir -p "$OUT"

run_suite() {
  local label="$1"
  pnpm --filter @stakeframe/web build > "$OUT/build-$label.log" 2>&1 || {
    echo "BUILD FAILED ($label)"; return 1;
  }
  E2E_BASE_URL="http://127.0.0.1:$PORT" npx playwright test tests/e2e/product.test.ts \
    --retries=0 --reporter=line > "$OUT/e2e-$label.log" 2>&1
  # O conjunto é a lista de "N) [projeto] › arquivo:linha › título".
  grep -oE "^[[:space:]]+[0-9]+\) \[[a-z-]+\] .*" "$OUT/e2e-$label.log" \
    | sed -E 's/^[[:space:]]+[0-9]+\) //' | sort -u > "$OUT/set-$label.txt"
  echo "$label: $(wc -l < "$OUT/set-$label.txt") falhas | $(grep -oE '[0-9]+ passed' "$OUT/e2e-$label.log" | head -1)"
}

echo "== BASELINE (15c4a86, sem o STK-F3-04) =="
git stash push -u -q -m stk-f3-04-setdiff || exit 1
run_suite baseline
git stash pop -q || { echo "STASH POP FALHOU — recuperar com git stash pop"; exit 1; }

echo "== BRANCH (stk/f3-04-poly-cards) =="
run_suite branch

echo
echo "== CONJUNTO QUE SOBREVIVE NOS DOIS (flake de contenção) =="
comm -12 "$OUT/set-baseline.txt" "$OUT/set-branch.txt" | sed 's/^/  /'

echo
echo "== SÓ NA BRANCH =="
comm -13 "$OUT/set-baseline.txt" "$OUT/set-branch.txt" | sed 's/^/  /' || true
[ -s "$OUT/set-branch.txt" ] && comm -13 "$OUT/set-baseline.txt" "$OUT/set-branch.txt" | grep -q . || echo "  (nenhum)"

echo
echo "== SÓ NO BASELINE =="
comm -23 "$OUT/set-baseline.txt" "$OUT/set-branch.txt" | sed 's/^/  /' || true
comm -23 "$OUT/set-baseline.txt" "$OUT/set-branch.txt" | grep -q . || echo "  (nenhum)"
