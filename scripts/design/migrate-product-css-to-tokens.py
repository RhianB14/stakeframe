"""STK-F2-18 — migração de product.css para a camada de tokens.

Executado uma vez sobre `origin/main`. É mecânico e auditável: cada hex é
classificado por FUNÇÃO (a propriedade onde aparece) e por BANDA
(luminância + matiz + croma), e o resultado é conferido depois.

Não é parte do build. Fica no repositório como registro de por que cada
valor foi trocado — a próxima pessoa que achar uma cor estranha precisa
saber se ela é resíduo ou escolha.
"""
import math
import re
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else "apps/web/src/product/product.css"


def oklch(hx: str) -> tuple[float, float, float]:
    h = hx.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = [int(h[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    f = lambda u: u / 12.92 if u <= 0.04045 else ((u + 0.055) / 1.055) ** 2.4
    R, G, B = f(r), f(g), f(b)
    l = (0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B) ** (1 / 3)
    m = (0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B) ** (1 / 3)
    s = (0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B) ** (1 / 3)
    L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
    A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
    Bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    return L, math.hypot(A, Bb), math.degrees(math.atan2(Bb, A)) % 360


def band(C: float, H: float) -> str:
    # O limiar de croma é o ponto inteiro desta função. Os 172 hex do CSS
    # original eram quase todos cinza COM VIÉS AZUL: croma 0,02–0,05, que
    # é indistinguível de cinza. Classificar isso como "azul" gerou 88 usos
    # de --accent-ink e transformou texto neutro em cor de marca.
    if C < 0.06:
        return "neutral"
    if 230 <= H <= 275:
        return "blue"
    if 140 <= H <= 185:
        return "green"
    if H < 30 or H > 345:
        return "red"
    if 60 <= H <= 115:
        return "amber"
    return "neutral"


# Overrides conferidos um a um no contexto original. Chave: hex; None =
# manter literal (marca externa, que não é nossa para tokenizar).
MANUAL = {
    # Google impõe a própria cor no botão de acesso.
    "#4285f4": None, "#dadce0": None, "#202124": None, "#eef1f8": None, "#fff": None,
    # Resultado positivo.
    "#0d2b23": "--pos-soft", "#12392d": "--pos-soft", "#21392f": "--pos-soft",
    "#176a4b": "--pos", "#43d58c": "--pos", "#53db98": "--pos", "#65e39f": "--pos",
    "#62e5a2": "--pos",
    # Resultado negativo.
    "#30151d": "--neg-soft", "#3e282e": "--neg-soft", "#7f3340": "--neg",
    "#76444e": "--neg", "#ff8793": "--neg", "#eea8af": "--neg", "#f5b6bd": "--neg",
    "#ffc0c8": "--neg", "#ffc2c9": "--neg",
    # Pendência e atenção.
    "#342e24": "--warn-soft", "#393022": "--warn-soft", "#605134": "--warn",
    "#786444": "--warn", "#b98a3d": "--warn", "#d9b870": "--warn", "#d5bc8e": "--warn",
    "#e0c38b": "--warn", "#dec395": "--warn", "#f1c36c": "--warn", "#e4c992": "--warn",
    "#ffcf78": "--warn",
    # Azul: cada um tem um papel distinto.
    "#2878ff": "--accent",      # --mini-blue do Mini App
    "#3478db": "--accent-ink",   # borda tracejada de "adicionar seleção"
    "#506dac": "--accent",       # dia pressionado do calendário
    "#5a9bff": "--accent-ink",   # topo do spinner
    "#7c98d5": "--focus",        # anel de foco
    "#94afff": "--focus",        # anel de foco do textarea / accent-color
    # Trilho de rolagem e cinza de apoio.
    "#151b26": "--surface-sunken", "#52617a": "--border-strong",
}

# (hex, propriedade) -> token, quando o MESMO hex tem outro papel.
TEXT_ONLY = {
    ("#f6f8fc", "color"): "--text-primary",
    ("#fff", "color"): "--text-primary",
}

BORDER = re.compile(r"^border(-top|-bottom|-left|-right|-color)?$")
BG = {"background", "background-color"}
COLOR = {"color"}

HEX = re.compile(r"#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b")


def to_token(hx: str, prop: str) -> str | None:
    L, C, H = oklch(hx)
    b = band(C, H)
    if (hx, prop) in TEXT_ONLY:
        return TEXT_ONLY[(hx, prop)]
    if hx in MANUAL:
        return MANUAL[hx]
    if b == "green":
        return "--pos"
    if b == "red":
        return "--neg"
    if b == "amber":
        return "--warn"
    if b == "blue":
        if BORDER.match(prop):
            return "--border-strong"
        if prop in BG:
            return "--accent" if L > 0.5 else "--surface-3"
        return "--accent-ink"
    if prop in BG:
        return "--surface-1" if L < 0.20 else ("--surface-2" if L < 0.30 else "--surface-3")
    if BORDER.match(prop):
        return "--border" if L < 0.34 else "--border-strong"
    if prop in COLOR:
        if L > 0.86:
            return "--text-primary"
        return "--text-secondary" if L > 0.745 else "--text-tertiary"
    return "--text-tertiary"


def substitute(src: str) -> str:
    out: list[str] = []
    pos = 0
    for m in HEX.finditer(src):
        hx = m.group(0).lower()
        start = src.rfind(";", 0, m.start())
        decl = src[start + 1 : m.end()]
        prop = decl.split(":")[0].strip() if ":" in decl else "?"
        out.append(src[pos : m.start()])
        pos = m.end()
        token = to_token(hx, prop)
        out.append(m.group(0) if token is None else f"var({token})")
    out.append(src[pos:])
    return "".join(out)


def replace_once(src: str, old: str, new: str, label: str) -> str:
    if old not in src:
        raise SystemExit(f"bloco nao encontrado: {label}")
    return src.replace(old, new, 1)


def main() -> None:
    src = open(PATH, encoding="utf-8").read()
    src = substitute(src)

    # --token herdado da tela publica, nomeado por aparencia (#a7b1c2)
    src = src.replace("var(--text-faint, #7e899b)", "var(--text-tertiary)")
    src = src.replace("var(--text-faint)", "var(--text-tertiary)")

    # rgba de cor -> color-mix sobre o token. Sombra neutra (preto) fica:
    # sombra nao e cor de marca.
    for a, b in {
        "rgba(40, 120, 255, 0.2)": "color-mix(in oklab, var(--accent) 20%, transparent)",
        "rgba(67, 213, 140, 0.13)": "color-mix(in oklab, var(--pos) 13%, transparent)",
        "rgba(7, 16, 31, 0.92)": "color-mix(in oklab, var(--bg) 92%, transparent)",
        "rgba(16, 19, 24, 0.96)": "color-mix(in oklab, var(--surface-1) 96%, transparent)",
        "rgba(0, 5, 15, 0.72)": "color-mix(in oklab, var(--bg) 72%, transparent)",
        "rgba(1, 6, 16, 0.72)": "color-mix(in oklab, var(--bg) 72%, transparent)",
    }.items():
        src = src.replace(a, b)

    # Gradiente de mesma cor nas duas pontas: nao separa hierarquia nenhuma.
    src = re.sub(
        r"linear-gradient\(\s*\d+deg,\s*var\(--surface-2\),\s*var\(--surface-2\)\s*\)",
        "var(--surface-2)",
        src,
    )
    src = re.sub(
        r"linear-gradient\(\s*\d+deg,\s*var\(--surface-3\),\s*var\(--surface-3\)\s*\)",
        "var(--surface-3)",
        src,
    )
    src = src.replace(
        "linear-gradient(145deg, rgba(17, 29, 48, 0.98), rgba(13, 23, 40, 0.98))",
        "var(--mini-card)",
    )

    open(PATH, "w", encoding="utf-8", newline="").write(src)
    left = sorted(set(x.lower() for x in HEX.findall(src)))
    print(f"hex restantes: {left}")


if __name__ == "__main__":
    main()
