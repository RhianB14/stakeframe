"""STK-F2-18 — Fase 2: escala de tipo.

A versão anterior tinha 51 das 150 declarações de `font-size` abaixo de
12px (30 em 11px, 19 em 10px, 2 em 8px). A interface tinha virado
listagem de terminal: para caber mais linha, a fonte encolheu, e a
densidade virou ilegibilidade em vez de informação.

O piso passa a ser 11,5px (`--text-xs`), e 12px (`--text-sm`) para
legenda. Nenhuma regra de layout muda — só o valor da fonte. Onde a
densidade apertar, a solução é coluna, não fonte.
"""
import re
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else "apps/web/src/product/product.css"

# 8px e 10px nao tem funcao: eram versoes "bem pequena" do mesmo texto.
# 11px era a稠度 padrao das legendas; sobe para o piso da escala.
MAP = {
    "8px": "var(--text-xs)",
    "10px": "var(--text-xs)",
    "11px": "var(--text-xs)",
    "12px": "var(--text-sm)",
    "13px": "var(--text-md)",
    "14px": "var(--text-md)",
    "15px": "var(--text-body)",
    "16px": "var(--text-h3)",
    "17px": "var(--text-h3)",
    "20px": "var(--text-h2)",
    "21px": "var(--text-h2)",
    "30px": "var(--text-h1)",
}

# Escalas fluidas (clamp) e tamanhos de display nao entram no mapeamento:
# dependem da largura da viewport, nao de um degrau da escala.
SKIP = re.compile(r"clamp\(|min\(|max\(|vw")


def main() -> None:
    src = open(PATH, encoding="utf-8").read()
    replaced = 0
    sizes: dict[str, int] = {}

    out: list[str] = []
    pos = 0
    for m in re.finditer(r"font-size:\s*([\d.]+)px", src):
        value = m.group(1)
        start = src.rfind(";", 0, m.start())
        end = src.find(";", m.end())
        declaration = src[start + 1 : m.end()]
        if SKIP.search(declaration):
            continue
        # Só troca se o valor estiver no mapeamento e ainda não for token.
        following = src[m.end() : end]
        if "var(" in following:
            continue
        token = MAP.get(f"{value}px")
        if token is None:
            sizes.setdefault(value, 0)
            sizes[value] = sizes.get(value, 0) + 1
            continue
        out.append(src[pos : m.start()])
        out.append(f"font-size: {token}")
        pos = m.end()
        replaced += 1
        sizes[value] = sizes.get(value, 0) + 1
    out.append(src[pos:])
    src = "".join(out)

    open(PATH, "w", encoding="utf-8", newline="").write(src)
    print(f"font-size migradas: {replaced}")
    print(f"tamanhos remanescentes: {dict(sorted(sizes.items(), key=lambda kv: float(kv[0])))}")


if __name__ == "__main__":
    main()
