import argparse
import csv
import sys
from pathlib import Path

import numpy as np

EXTENSOES = {".jpg", ".jpeg", ".jfif", ".png", ".webp", ".bmp", ".tif", ".tiff"}
TAMANHO = (128, 128)


def _tempo(seg):
    seg = int(round(seg))
    return f"{seg // 60}m{seg % 60:02d}s" if seg >= 60 else f"{seg}s"


class Progresso:

    def __init__(self, total, titulo, largura=28):
        import time

        self.time = time
        self.total, self.titulo, self.largura = total, titulo.strip().ljust(22), largura
        self.feito, self.inicio, self._ultimo, self._t = 0, time.time(), -1, 0.0
        try:
            "\u2588\u2591".encode(getattr(sys.stdout, "encoding", None) or "ascii")
            self.cheio, self.vazio = "\u2588", "\u2591"
        except (UnicodeEncodeError, LookupError):
            self.cheio, self.vazio = "#", "-"
        if total > 0:
            self._desenhar(forcar=True)

    def passo(self, n=1):
        if self.total <= 0:
            return
        self.feito = min(self.total, self.feito + n)
        self._desenhar()
        if self.feito >= self.total:
            sys.stdout.write("\n")
            sys.stdout.flush()

    def _desenhar(self, forcar=False):
        agora = self.time.time()
        pct = int(self.feito * 100 / self.total)
        fim = self.feito >= self.total
        if not (forcar or fim or pct != self._ultimo or agora - self._t >= 0.5):
            return
        if not fim and not getattr(sys.stdout, "isatty", lambda: False)():
            return
        self._ultimo, self._t = pct, agora
        cheios = int(self.largura * self.feito / self.total)
        barra = self.cheio * cheios + self.vazio * (self.largura - cheios)
        decorrido = agora - self.inicio
        if fim:
            extra = f" | {_tempo(decorrido)}"
        elif self.feito:
            extra = f" | falta ~{_tempo(decorrido / self.feito * (self.total - self.feito))}"
        else:
            extra = ""
        sys.stdout.write(f"\r{self.titulo} [{barra}] {pct:3d}% ({self.feito}/{self.total}){extra}    ")
        sys.stdout.flush()


LADO = 256


def ler_imagem(caminho):
    import cv2

    dados = np.fromfile(str(caminho), dtype=np.uint8)
    img = cv2.imdecode(dados, cv2.IMREAD_COLOR) if dados.size else None
    if img is None:
        raise ValueError(f"nao consegui abrir {caminho}")
    return cv2.resize(img, (LADO, LADO), interpolation=cv2.INTER_AREA)


def feat_v1(img):
    import cv2

    img = cv2.resize(img, TAMANHO, interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    cinza = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    partes = []
    for canal in cv2.split(hsv):
        partes += [canal.mean(), canal.std()]
    hist_h = cv2.calcHist([hsv], [0], None, [18], [0, 180]).flatten()
    partes += list(hist_h / hist_h.sum())
    partes.append(float((cinza < 60).mean()))
    gx = cv2.Sobel(cinza, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(cinza, cv2.CV_32F, 0, 1, ksize=3)
    magnitude = np.sqrt(gx ** 2 + gy ** 2)
    partes += [float(magnitude.mean()), float(magnitude.std())]
    bordas = cv2.Canny(cinza, 80, 160)
    partes.append(float((bordas > 0).mean()))
    h, w = cinza.shape
    for i in range(2):
        for j in range(2):
            bloco = cinza[i * h // 2:(i + 1) * h // 2, j * w // 2:(j + 1) * w // 2]
            partes += [float(bloco.mean()), float(bloco.std())]
    return np.array(partes, dtype=np.float32)


def lbp_riu2(cinza):
    g = cinza.astype(np.int16)
    c = g[1:-1, 1:-1]
    vizinhos = [g[0:-2, 0:-2], g[0:-2, 1:-1], g[0:-2, 2:], g[1:-1, 2:],
                g[2:, 2:], g[2:, 1:-1], g[2:, 0:-2], g[1:-1, 0:-2]]
    bits = np.stack([(v >= c) for v in vizinhos]).astype(np.int8)
    transicoes = np.abs(np.diff(np.concatenate([bits, bits[:1]]), axis=0)).sum(0)
    codigo = np.where(transicoes <= 2, bits.sum(0), 9)
    hist = np.bincount(codigo.ravel(), minlength=10).astype(np.float32)
    return list(hist / hist.sum())


def feat_v2(img):
    import cv2

    partes = list(feat_v1(img))
    cinza = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    for canal in (1, 2):
        h = cv2.calcHist([lab], [canal], None, [8], [0, 256]).flatten()
        partes += list(h / h.sum())
    h = cv2.calcHist([hsv], [1], None, [8], [0, 256]).flatten()
    partes += list(h / h.sum())

    partes += lbp_riu2(cinza)
    partes += lbp_riu2(cv2.resize(cinza, (128, 128), interpolation=cv2.INTER_AREA))

    gx = cv2.Sobel(cinza, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(cinza, cv2.CV_32F, 0, 1, ksize=3)
    mag, ang = cv2.cartToPolar(gx, gy, angleInDegrees=True)
    hist, _ = np.histogram(ang % 180, bins=12, range=(0, 180), weights=mag)
    hist = hist / (hist.sum() + 1e-9)
    partes += list(hist)
    partes.append(float(-(hist * np.log(hist + 1e-9)).sum()))

    s_canal = hsv[:, :, 1]
    for i in range(3):
        for j in range(3):
            fatia = (slice(i * LADO // 3, (i + 1) * LADO // 3),
                     slice(j * LADO // 3, (j + 1) * LADO // 3))
            partes += [float(cinza[fatia].mean()), float(cinza[fatia].std()),
                       float(s_canal[fatia].mean())]

    limiar = min(70.0, float(np.percentile(cinza, 20)))
    escuro = (cinza <= limiar).astype(np.uint8)
    escuro = cv2.morphologyEx(escuro, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    n, rotulos, stats, centros = cv2.connectedComponentsWithStats(escuro)
    if n > 1:
        k = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        area = stats[k, cv2.CC_STAT_AREA]
        larg, alt = stats[k, cv2.CC_STAT_WIDTH], stats[k, cv2.CC_STAT_HEIGHT]
        cx, cy = centros[k]
        dentro = cinza[rotulos == k].mean()
        fora = cinza[rotulos != k].mean()
        partes += [area / LADO ** 2, area / max(1, larg * alt),
                   float(np.hypot(cx - LADO / 2, cy - LADO / 2) / (LADO * 0.71)),
                   float((fora - dentro) / 255)]
    else:
        partes += [0.0, 0.0, 1.0, 0.0]

    q = LADO // 4
    centro = cinza[q:LADO - q, q:LADO - q]
    mascara = np.ones_like(cinza, dtype=bool)
    mascara[q:LADO - q, q:LADO - q] = False
    partes += [float(centro.mean() - cinza[mascara].mean()) / 255, float(centro.std()) / 255]
    return np.array(partes, dtype=np.float32)


FEATS = {"v1": feat_v1, "v2": feat_v2}


def caracteristicas(caminho, versao="v2"):
    return FEATS[versao](ler_imagem(caminho))


def carregar_pasta(pasta, rotulo):
    X, y, nomes = [], [], []
    ignoradas = {}
    arquivos = [a for a in sorted(Path(pasta).iterdir()) if a.is_file()]
    barra = Progresso(len(arquivos), f"Lendo {Path(pasta).name:14s}")
    for arq in arquivos:
        barra.passo()
        if arq.suffix.lower() not in EXTENSOES:
            ext = arq.suffix.lower() or "(sem extensao)"
            ignoradas[ext] = ignoradas.get(ext, 0) + 1
            continue
        try:
            X.append(ler_imagem(arq))
            y.append(rotulo)
            nomes.append(arq)
        except Exception as erro:
            print(f"\n  ! pulando {arq.name}: {erro}")
    print(f"  {Path(pasta).name}: {len(arquivos)} arquivos, {len(X)} fotos lidas")
    if ignoradas:
        print(f"    ignorados por extensao: {ignoradas}")
    return X, y, nomes


def montar_dados(pasta_dados):
    base = Path(pasta_dados)
    if base.name in ("com_escavacao", "sem_escavacao") and base.parent.is_dir():
        base = base.parent
    X, y, nomes = [], [], []
    for sub, rotulo in (("com_escavacao", 1), ("sem_escavacao", 0)):
        d = base / sub
        if not d.is_dir():
            sys.exit(
                f"Pasta nao encontrada: {d.resolve()}\n"
                f"Informe a pasta que CONTEM 'com_escavacao' e 'sem_escavacao', "
                f"nao a propria subpasta."
            )
        a, b, c = carregar_pasta(d, rotulo)
        X += a
        y += b
        nomes += c
    if len(set(y)) < 2 or len(y) < 10:
        sys.exit("Preciso de pelo menos 10 fotos e de fotos nas duas pastas.")
    return X, np.array(y), nomes, base


def criar_modelo():
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    return make_pipeline(
        StandardScaler(),
        RandomForestClassifier(n_estimators=300, min_samples_leaf=2,
                             random_state=0, n_jobs=-1),
    )


def decidir(prob_sim, limiar, folga):
    if prob_sim >= limiar + folga:
        return "sim"
    if prob_sim <= limiar - folga:
        return "nao"
    return "incerto"


def salvar_revisao(base, caminhos, y, probs, previsoes, revisada=None):
    import html
    from urllib.parse import quote

    linhas = []
    revisada = revisada or [False] * len(caminhos)
    for cam, t, p, prev, rev in zip(caminhos, y, probs, previsoes, revisada):
        esperado = "sim" if t == 1 else "nao"
        if prev == "incerto":
            resultado = "incerto"
        else:
            resultado = "acerto" if prev == esperado else "ERRO"
        linhas.append({
            "arquivo": cam.name,
            "pasta": cam.parent.name,
            "esperado": esperado,
            "prob_escavacao": round(float(p), 3),
            "previsao": prev,
            "resultado": resultado,
            "revisada": "sim" if rev else "nao",
            "_rel": f"{quote(cam.parent.name)}/{quote(cam.name)}",
        })

    csv_path = base / "validacao_treino.csv"
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        campos = ["arquivo", "pasta", "esperado", "prob_escavacao", "previsao", "resultado", "revisada"]
        w = csv.DictWriter(f, fieldnames=campos, delimiter=";", extrasaction="ignore")
        w.writeheader()
        w.writerows(linhas)

    grupos = [
        ("Erros", lambda l: l["resultado"] == "ERRO"),
        ("Incertas (conferir)", lambda l: l["resultado"] == "incerto"),
        ("Acertos: com escavacao vista como SIM", lambda l: l["resultado"] == "acerto" and l["esperado"] == "sim"),
        ("Acertos: sem escavacao vista como NAO", lambda l: l["resultado"] == "acerto" and l["esperado"] == "nao"),
    ]
    partes = []
    for titulo, filtro in grupos:
        itens = sorted([l for l in linhas if filtro(l)], key=lambda l: l["prob_escavacao"])
        partes.append(f"<h2>{html.escape(titulo)} ({len(itens)})</h2>")
        if not itens:
            partes.append("<p class='vazio'>Nenhuma.</p>")
            continue
        partes.append("<div class='grade'>")
        for l in itens:
            partes.append(
                f"<figure class='{l['resultado'].lower()}'>"
                f"<a href='{l['_rel']}' target='_blank'><img src='{l['_rel']}' loading='lazy'></a>"
                f"<figcaption><b>{html.escape(l['arquivo'])}</b>"
                f"{' &#10004; revisada por voce' if l['revisada'] == 'sim' else ''}<br>"
                f"pasta: {html.escape(l['pasta'])}<br>"
                f"prob. escavacao: {l['prob_escavacao']:.2f} &rarr; {l['previsao']}</figcaption></figure>"
            )
        partes.append("</div>")

    pagina = f"""<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Validacao do classificador de escavacao</title>
<style>
:root{{--fundo:#f6f7f9;--cartao:#fff;--texto:#1d2329;--sub:#5b6570;--erro:#c62828;--incerto:#b26a00;--ok:#2e7d32}}
@media (prefers-color-scheme: dark){{:root{{--fundo:#15191d;--cartao:#20262c;--texto:#e7ebef;--sub:#9aa5b1;--erro:#ef5350;--incerto:#ffb74d;--ok:#66bb6a}}}}
body{{font-family:Segoe UI,Arial,sans-serif;background:var(--fundo);color:var(--texto);margin:24px}}
h1{{font-size:20px}} h2{{font-size:16px;margin-top:28px}} .vazio{{color:var(--sub)}}
.grade{{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}}
figure{{margin:0;background:var(--cartao);border-radius:8px;overflow:hidden;border:3px solid transparent}}
figure.erro{{border-color:var(--erro)}} figure.incerto{{border-color:var(--incerto)}} figure.acerto{{border-color:var(--ok)}}
img{{width:100%;height:160px;object-fit:cover;display:block}}
figcaption{{font-size:12px;padding:6px 8px;color:var(--sub)}} figcaption b{{color:var(--texto)}}
</style></head><body>
<h1>Validacao do classificador de escavacao</h1>
<p>Cada foto foi classificada por um modelo treinado SEM ela (validacao cruzada).
Clique na foto para ampliar. Fotos ordenadas da menor para a maior probabilidade de escavacao.</p>
{''.join(partes)}
</body></html>"""
    html_path = base / "validacao_treino.html"
    html_path.write_text(pagina, encoding="utf-8")
    print(f"\nRevisao foto a foto salva em:\n  {html_path}\n  {csv_path}")


PESO_REVISADA = 3

LIMIAR_OS_SIM = 0.75


def decidir_os(p_os, sim_os, limiar, folga):
    if p_os >= sim_os:
        return "sim"
    if p_os <= limiar - folga:
        return "nao"
    return "incerto"


def pesos_revisadas(caminhos, dados):
    reg = Path(dados) / "revisoes.csv"
    ultima = {}
    if reg.is_file():
        for l in ler_csv(reg):
            if l.get("decisao") in ("com escavacao", "sem escavacao"):
                ultima[l["hash"]] = "com_escavacao" if l["decisao"] == "com escavacao" else "sem_escavacao"
    if not ultima:
        return np.ones(len(caminhos)), [False] * len(caminhos)
    pesos, revisada = [], []
    barra = Progresso(len(caminhos), "Conferindo revisadas  ")
    for cam in caminhos:
        barra.passo()
        ok = ultima.get(hash_arquivo(cam)) == cam.parent.name
        pesos.append(PESO_REVISADA if ok else 1.0)
        revisada.append(ok)
    return np.array(pesos, dtype=float), revisada


def validar(F, F_esp, y, limiar, folga, pesos=None, titulo="Validando"):
    from sklearn.model_selection import StratifiedKFold

    k = min(5, int(np.bincount(y).min()))
    cv = StratifiedKFold(n_splits=k, shuffle=True, random_state=0)
    probs = np.zeros(len(y))
    barra = Progresso(k, titulo)
    for tr, te in cv.split(F, y):
        m = criar_modelo()
        w = np.ones(len(y)) if pesos is None else pesos
        m.fit(np.vstack([F[tr], F_esp[tr]]), np.concatenate([y[tr], y[tr]]),
              randomforestclassifier__sample_weight=np.concatenate([w[tr], w[tr]]))
        probs[te] = m.predict_proba(F[te])[:, 1]
        barra.passo()
    previsoes = [decidir(p, limiar, folga) for p in probs]
    return probs, previsoes


def medir(previsoes, y):
    decididas = [(p, t) for p, t in zip(previsoes, y) if p != "incerto"]
    acertos = sum(1 for p, t in decididas if (p == "sim") == bool(t))
    falso_sim = sum(1 for p, t in zip(previsoes, y) if p == "sim" and t == 0)
    falso_nao = sum(1 for p, t in zip(previsoes, y) if p == "nao" and t == 1)
    return {"decididas": len(decididas), "incertas": len(y) - len(decididas),
            "acertos": acertos, "falso_sim": falso_sim, "falso_nao": falso_nao,
            "taxa": (acertos / len(decididas)) if decididas else 0.0}


def treinar(args):
    import cv2
    import joblib

    imagens, y, caminhos, base = montar_dados(args.dados)
    print(f"{len(y)} fotos: {int(y.sum())} com escavacao, {int((1 - y).sum())} sem.")
    espelhadas = [cv2.flip(img, 1) for img in imagens]
    pesos, revisada = pesos_revisadas(caminhos, base)
    if any(revisada):
        print(f"{sum(revisada)} fotos confirmadas por voce na revisao (peso {PESO_REVISADA} no treino).")

    resultados = {}
    for versao, func in FEATS.items():
        barra = Progresso(2 * len(imagens), f"Medindo fotos ({versao})  ")
        F_lista, F_esp_lista = [], []
        for img, esp in zip(imagens, espelhadas):
            F_lista.append(func(img))
            barra.passo()
            F_esp_lista.append(func(esp))
            barra.passo()
        F, F_esp = np.vstack(F_lista), np.vstack(F_esp_lista)
        probs, previsoes = validar(F, F_esp, y, args.limiar, args.folga, pesos,
                                   titulo=f"Validando ({versao})     ")
        resultados[versao] = (F, F_esp, probs, previsoes, medir(previsoes, y))

    print("\n=== COMPARATIVO (fotos que o modelo nunca viu no treino) ===")
    print(f"{'':28s}{'v1 (atual)':>12s}{'v2 (nova)':>12s}")
    linhas = [("Decididas (sim/nao)", "decididas"), ("Incertas (p/ conferir)", "incertas"),
              ("Sem escav. vista como SIM", "falso_sim"), ("Com escav. vista como NAO", "falso_nao")]
    for rotulo, chave in linhas:
        print(f"{rotulo:28s}{resultados['v1'][4][chave]:>12d}{resultados['v2'][4][chave]:>12d}")
    print(f"{'Acerto nas decididas':28s}{resultados['v1'][4]['taxa']:>12.0%}{resultados['v2'][4]['taxa']:>12.0%}")

    def custo(v):
        m = resultados[v][4]
        return (m["falso_sim"] + m["falso_nao"], m["incertas"])
    vencedora = "v2" if custo("v2") < custo("v1") else "v1"
    print(f"\nVersao escolhida: {vencedora}")

    F, F_esp, probs, previsoes, m = resultados[vencedora]
    salvar_revisao(base, caminhos, y, probs, previsoes, revisada)
    inc_rev = sum(1 for p, r in zip(previsoes, revisada) if p == "incerto" and r)
    if inc_rev:
        print(f"Obs.: {inc_rev} das incertas ja foram confirmadas por voce. O rotulo delas esta certo;")
        print("a duvida e do modelo, que ainda nao reconhece esse tipo de foto sozinho.")

    print("Treinando o modelo final com todas as fotos...")
    modelo = criar_modelo()
    modelo.fit(np.vstack([F, F_esp]), np.concatenate([y, y]),
               randomforestclassifier__sample_weight=np.concatenate([pesos, pesos]))
    joblib.dump({"versao": vencedora, "modelo": modelo}, args.modelo)
    print(f"\nModelo salvo em: {args.modelo}")
    print("Para melhorar: mova fotos mal rotuladas, acrescente casos dificeis e treine de novo.")
    oferecer_revisao(args, base / "validacao_treino.csv", base)


def carregar_modelo(caminho):
    import joblib

    if not Path(caminho).is_file():
        sys.exit(f"Modelo nao encontrado: {caminho}. Treine primeiro (opcao 1).")
    salvo = joblib.load(caminho)
    if isinstance(salvo, dict):
        return salvo["modelo"], salvo["versao"]
    return salvo, "v1"


def hash_arquivo(caminho):
    import hashlib
    return hashlib.md5(Path(caminho).read_bytes()).hexdigest()


def testar(args):
    import html
    from urllib.parse import quote

    modelo, versao = carregar_modelo(args.modelo)
    base = Path(args.pasta)
    if not base.is_dir():
        sys.exit(f"Pasta nao encontrada: {base.resolve()}")

    hashes_no_treino = hashes_treino(args.dados)

    grupos = []
    for sub, esperado in (("com_escavacao", "sim"), ("sem_escavacao", "nao")):
        d = base / sub
        if not d.is_dir():
            sys.exit(f"Pasta nao encontrada: {d.resolve()}")
        for item in sorted(d.iterdir()):
            fotos = ([a for a in sorted(item.iterdir()) if a.suffix.lower() in EXTENSOES]
                     if item.is_dir() else
                     [item] if item.suffix.lower() in EXTENSOES else [])
            if fotos:
                grupos.append((sub, esperado, item, fotos))

    barra = Progresso(sum(len(g[3]) for g in grupos), "Analisando o teste    ")
    oss, repetidas = [], []
    for sub, esperado, item, fotos in grupos:
            resultado_fotos = []
            for f in fotos:
                barra.passo()
                if hash_arquivo(f) in hashes_no_treino:
                    repetidas.append(f"{sub}/{item.name}/{f.name}" if item.is_dir() else f"{sub}/{f.name}")
                try:
                    prob = float(modelo.predict_proba(caracteristicas(f, versao).reshape(1, -1))[0, 1])
                except Exception as erro:
                    print(f"\n  ! pulando {f.name}: {erro}")
                    continue
                rel = "/".join(quote(x) for x in f.relative_to(base).parts)
                resultado_fotos.append({"arquivo": f.name, "prob": prob, "rel": rel, "caminho": f.resolve(),
                                        "previsao": decidir(prob, args.limiar, args.folga)})
            if not resultado_fotos:
                continue
            p_os = max(r["prob"] for r in resultado_fotos)
            prev = decidir_os(p_os, args.sim_os, args.limiar, args.folga)
            res = "incerto" if prev == "incerto" else ("acerto" if prev == esperado else "ERRO")
            oss.append({"os": item.name if item.is_dir() else item.stem, "pasta": sub,
                        "esperado": esperado, "prob_os": p_os, "previsao": prev,
                        "resultado": res, "fotos": resultado_fotos})

    if not oss:
        sys.exit("Nenhuma OS com fotos encontrada no teste.")

    def resumo(itens, chave_prev):
        dec = [i for i in itens if i[chave_prev] != "incerto"]
        ac = sum(1 for i in dec if i[chave_prev] == i["esperado"])
        fs = sum(1 for i in itens if i[chave_prev] == "sim" and i["esperado"] == "nao")
        fn = sum(1 for i in itens if i[chave_prev] == "nao" and i["esperado"] == "sim")
        return len(itens), len(dec), len(itens) - len(dec), (ac / len(dec)) if dec else 0, fs, fn

    fotos_todas = [dict(f, esperado=o["esperado"]) for o in oss for f in o["fotos"]]
    print(f"\n=== TESTE REAL (OS fora do treino) - modelo {versao} ===")
    print(f"Regra da OS: SIM se a melhor foto >= {args.sim_os:.2f} | "
          f"NAO se todas <= {args.limiar - args.folga:.2f} | entre os dois = incerta")
    print(f"{'':30s}{'por OS':>10s}{'por foto':>10s}")
    r_os, r_ft = resumo(oss, "previsao"), resumo(fotos_todas, "previsao")
    for i, rot in enumerate(["Avaliadas", "Decididas (sim/nao)", "Incertas (p/ conferir)"]):
        print(f"{rot:30s}{r_os[i]:>10d}{r_ft[i]:>10d}")
    print(f"{'Acerto nas decididas':30s}{r_os[3]:>10.0%}{r_ft[3]:>10.0%}")
    print(f"{'Sem escav. vista como SIM':30s}{r_os[4]:>10d}{r_ft[4]:>10d}   (deixaria passar um erro)")
    print(f"{'Com escav. vista como NAO':30s}{r_os[5]:>10d}{r_ft[5]:>10d}   (apontaria erro indevido)")
    print("Obs.: a coluna 'por foto' julga cada foto sozinha; numa OS com escavacao,")
    print("fotos de fachada e rua vao dar 'nao', e isso e normal. O que vale e 'por OS'.")
    if repetidas:
        print(f"\nATENCAO: {len(repetidas)} foto(s) do teste tambem estao no treino; o resultado fica otimista:")
        for r in repetidas[:10]:
            print(f"  - {r}")

    csv_os = base / "teste_por_os.csv"
    with open(csv_os, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["os", "pasta", "esperado", "prob_os", "previsao", "resultado", "n_fotos", "probs_fotos"])
        for o in oss:
            w.writerow([o["os"], o["pasta"], o["esperado"], round(o["prob_os"], 3), o["previsao"],
                        o["resultado"], len(o["fotos"]),
                        " | ".join(f"{x['arquivo']}={x['prob']:.2f}" for x in o["fotos"])])

    grupos = [("Erros", "ERRO"), ("Incertas (conferir)", "incerto"), ("Acertos", "acerto")]
    partes = []
    for titulo, chave in grupos:
        itens = [o for o in oss if o["resultado"] == chave]
        partes.append(f"<h2>{titulo} ({len(itens)})</h2>")
        if not itens:
            partes.append("<p class='vazio'>Nenhuma.</p>")
        for o in sorted(itens, key=lambda o: o["prob_os"]):
            partes.append(
                f"<section class='{chave.lower()}'><h3>OS {html.escape(o['os'])} "
                f"<small>esperado: {o['esperado']} | prob. da OS: {o['prob_os']:.2f} &rarr; {o['previsao']}</small></h3>"
                "<div class='grade'>")
            for x in o["fotos"]:
                partes.append(
                    f"<figure><a href='{x['rel']}' target='_blank'><img src='{x['rel']}' loading='lazy'></a>"
                    f"<figcaption>{html.escape(x['arquivo'])}<br>{x['prob']:.2f} &rarr; {x['previsao']}</figcaption></figure>")
            partes.append("</div></section>")
    pagina = f"""<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Teste real por OS</title><style>
:root{{--fundo:#f6f7f9;--cartao:#fff;--texto:#1d2329;--sub:#5b6570;--erro:#c62828;--incerto:#b26a00;--ok:#2e7d32}}
@media (prefers-color-scheme: dark){{:root{{--fundo:#15191d;--cartao:#20262c;--texto:#e7ebef;--sub:#9aa5b1;--erro:#ef5350;--incerto:#ffb74d;--ok:#66bb6a}}}}
body{{font-family:Segoe UI,Arial,sans-serif;background:var(--fundo);color:var(--texto);margin:24px}}
section{{background:var(--cartao);border-left:6px solid var(--ok);border-radius:8px;padding:8px 12px;margin:10px 0}}
section.erro{{border-left-color:var(--erro)}} section.incerto{{border-left-color:var(--incerto)}}
h3{{font-size:15px;margin:4px 0 8px}} h3 small{{color:var(--sub);font-weight:normal}} .vazio{{color:var(--sub)}}
.grade{{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}}
figure{{margin:0}} img{{width:100%;height:120px;object-fit:cover;border-radius:4px;display:block}}
figcaption{{font-size:11px;color:var(--sub);padding:2px 0}}
</style></head><body><h1>Teste real por OS</h1>
<p>Regra da OS: "sim" se a melhor foto tiver probabilidade de pelo menos {args.sim_os:.2f};
"nao" se todas as fotos ficarem em {args.limiar - args.folga:.2f} ou menos; no meio, incerta.
A probabilidade da OS e a maior entre as fotos.</p>
{''.join(partes)}</body></html>"""
    (base / "teste_por_os.html").write_text(pagina, encoding="utf-8")
    print(f"\nDetalhe salvo em:\n  {base / 'teste_por_os.html'}\n  {csv_os}")
    oferecer_revisao(args, csv_os, args.dados)
    oferecer_incorporacao(args, base.resolve(), oss)


REGISTRO_CAMPOS = ["data_hora", "arquivo", "origem", "prob", "decisao", "acao", "de", "para", "hash"]
DESTINOS = {"C": "com_escavacao", "S": "sem_escavacao", "D": "descartadas"}
NOMES_DECISAO = {"C": "com escavacao", "S": "sem escavacao", "D": "descartada"}


def ler_csv(caminho):
    with open(caminho, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f, delimiter=";"))


def hashes_revisados(dados):
    reg = Path(dados) / "revisoes.csv"
    if not reg.is_file():
        return set()
    return {l["hash"] for l in ler_csv(reg) if l.get("decisao") in NOMES_DECISAO.values()}


def contar_pendentes(caminho_csv, dados):
    try:
        return len(montar_fila(caminho_csv, dados, silencioso=True))
    except (SystemExit, Exception):
        return None


def oferecer_revisao(args, caminho_csv, dados):
    if not getattr(args, "oferecer_revisao", False):
        return
    n = contar_pendentes(caminho_csv, dados)
    if not n:
        print("\nNenhuma foto incerta ou com erro pendente de revisao.")
        return
    resp = input(f"\nHa {n} fotos incertas ou com erro para revisar. Revisar agora (opcao 4)? [s/n]: ").strip().lower()
    if resp.startswith("s"):
        revisar(argparse.Namespace(csv=str(caminho_csv), dados=str(dados), fotos=None))
    else:
        print("Ok. Voce pode revisar depois pela opcao 4.")


LIMIAR_AUTO_COM = 0.65


def hashes_treino(dados):
    arquivos = []
    for sub in ("com_escavacao", "sem_escavacao"):
        d = Path(dados) / sub
        if d.is_dir():
            arquivos += [a for a in d.iterdir() if a.is_file() and a.suffix.lower() in EXTENSOES]
    barra = Progresso(len(arquivos), "Conferindo o treino   ")
    hs = set()
    for a in arquivos:
        hs.add(hash_arquivo(a))
        barra.passo()
    return hs


def ultimas_decisoes(dados):
    reg = Path(dados) / "revisoes.csv"
    ult = {}
    if reg.is_file():
        for l in ler_csv(reg):
            if l.get("decisao") in NOMES_DECISAO.values():
                ult[l["hash"]] = l["decisao"]
    return ult


def registrar_auto(dados, caminho, prob, rotulo, para, h):
    from datetime import datetime

    reg = Path(dados) / "revisoes.csv"
    novo = not reg.is_file()
    with open(reg, "a", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=REGISTRO_CAMPOS, delimiter=";")
        if novo:
            w.writeheader()
        w.writerow({"data_hora": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    "arquivo": caminho.name, "origem": "teste (incorporado)",
                    "prob": round(prob, 3), "decisao": f"auto: {rotulo}",
                    "acao": "incorporada automaticamente", "de": str(caminho),
                    "para": str(para), "hash": h})


def oferecer_incorporacao(args, base, oss):
    if not getattr(args, "oferecer_revisao", False):
        return
    resp = input(f"\nIncorporar as {len(oss)} OS deste teste ao treino? "
                 "(elas deixam de servir como teste) [s/n]: ").strip().lower()
    if not resp.startswith("s"):
        print("Ok. As OS continuam na pasta teste.")
        return

    import shutil
    from collections import Counter
    from datetime import datetime

    dados = Path(args.dados).resolve()
    no_treino = hashes_treino(dados)
    decisoes = ultimas_decisoes(dados)
    cont = Counter()
    pendentes = []
    barra = Progresso(sum(len(o["fotos"]) for o in oss), "Incorporando          ")
    for o in oss:
        for f in o["fotos"]:
            barra.passo()
            cam = f["caminho"]
            h = hash_arquivo(cam)
            if h in no_treino:
                cont["ja estavam no treino"] += 1
                continue
            dec = decisoes.get(h)
            if dec == "descartada":
                cont["descartadas na revisao"] += 1
                continue
            if dec in ("com escavacao", "sem escavacao"):
                rotulo = dec
            elif o["esperado"] == "nao":
                rotulo = "sem escavacao"
            elif f["prob"] >= LIMIAR_AUTO_COM:
                rotulo = "com escavacao"
            else:
                pendentes.append((o, f))
                continue
            destino = dados / ("com_escavacao" if rotulo == "com escavacao" else "sem_escavacao")
            alvo = nome_livre(destino, cam.name, prefixo=f"teste_{o['os']}_")
            shutil.copy2(str(cam), str(alvo))
            no_treino.add(h)
            registrar_auto(dados, cam, f["prob"], rotulo, alvo, h)
            cont[f"copiadas para {destino.name}"] += 1

    arquivo = base.parent / "teste_antigo" / datetime.now().strftime("%Y-%m-%d_%H%M%S")
    arquivo.mkdir(parents=True, exist_ok=True)
    for nome in ("com_escavacao", "sem_escavacao", "teste_por_os.csv", "teste_por_os.html"):
        origem = base / nome
        if origem.exists():
            shutil.move(str(origem), str(arquivo / nome))
    (base / "com_escavacao").mkdir(exist_ok=True)
    (base / "sem_escavacao").mkdir(exist_ok=True)

    print("\n=== INCORPORACAO AO TREINO ===")
    for chave, n in sorted(cont.items()):
        print(f"  {chave}: {n}")
    print(f"  aguardando sua classificacao (C/S): {len(pendentes)}")
    print(f"Teste arquivado em: {arquivo}")
    print("A pasta teste esta vazia e pronta para OS novas.")

    if not pendentes:
        print("Proximo passo: opcao 1 (treinar de novo).")
        return
    csv_pend = arquivo / "incorporar_pendentes.csv"
    with open(csv_pend, "w", newline="", encoding="utf-8-sig") as fcsv:
        w = csv.DictWriter(fcsv, delimiter=";",
                           fieldnames=["arquivo", "prob_escavacao", "previsao", "caminho", "origem", "info"])
        w.writeheader()
        for o, f in pendentes:
            novo_cam = arquivo / f["caminho"].relative_to(base)
            w.writerow({"arquivo": f["arquivo"], "prob_escavacao": round(f["prob"], 3),
                        "previsao": "incerto", "caminho": str(novo_cam), "origem": "incorporar",
                        "info": f"OS {o['os']} TEM escavacao. Esta foto mostra a escavacao? "
                                "(fachada/rua = S)"})
    resp = input(f"\nClassificar agora as {len(pendentes)} fotos restantes das OS com escavacao (C/S)? [s/n]: ")
    if resp.strip().lower().startswith("s"):
        revisar(argparse.Namespace(csv=str(csv_pend), dados=str(dados), fotos=None))
    else:
        print("Ok. Elas ficam na opcao 4, em 'Fotos restantes do ultimo teste incorporado'.")


def oferecer_arquivar_garimpo(pasta, pendentes, dados):
    import shutil
    from datetime import datetime

    pasta = Path(pasta).resolve()
    dados = Path(dados).resolve()
    if not pasta.is_dir() or not any(pasta.iterdir()):
        return
    protegidas = [dados, dados / "com_escavacao", dados / "sem_escavacao", dados / "teste"]
    if any(pasta == p or p.is_relative_to(pasta) or pasta.is_relative_to(dados / "com_escavacao")
           or pasta.is_relative_to(dados / "sem_escavacao") for p in protegidas):
        print(f"\nA pasta do garimpo ({pasta}) faz parte do treino; ela nao sera arquivada automaticamente.")
        return
    if pendentes:
        print(f"\nAinda ha {pendentes} suspeitas pendentes neste garimpo. "
              "Revise todas (opcao 4) para poder arquivar as fotos.")
        return
    resp = input(f"\nTodas as suspeitas foram revisadas. Arquivar as fotos de '{pasta.name}' "
                 "e deixar a pasta livre para um lote novo? [s/n]: ").strip().lower()
    if not resp.startswith("s"):
        print("Ok. As fotos continuam na pasta. No proximo garimpo, use fotos novas.")
        return
    destino = pasta.parent / f"{pasta.name}_usadas_{datetime.now().strftime('%Y-%m-%d_%H%M%S')}"
    destino.mkdir(parents=True)
    itens = list(pasta.iterdir())
    for item in itens:
        shutil.move(str(item), str(destino / item.name))
    print(f"{len(itens)} itens movidos para: {destino}")
    print(f"A pasta {pasta} esta vazia e pronta para o proximo lote.")


def garimpar(args):
    from datetime import datetime

    pasta = Path(args.pasta)
    if not pasta.is_dir():
        sys.exit(f"Pasta nao encontrada: {pasta.resolve()}")
    modelo, versao = carregar_modelo(args.modelo)
    dados = Path(args.dados).resolve()

    fotos = sorted(a for a in pasta.rglob("*") if a.is_file() and a.suffix.lower() in EXTENSOES)
    if not fotos:
        sys.exit("Nenhuma foto encontrada na pasta (nem nas subpastas).")
    ja = hashes_treino(dados) | hashes_revisados(dados)

    limite_nao = args.limiar - args.folga
    analisadas, suspeitas, ja_usadas = 0, [], 0
    barra = Progresso(len(fotos), "Garimpando confusores ")
    for f in fotos:
        barra.passo()
        if hash_arquivo(f) in ja:
            ja_usadas += 1
            continue
        try:
            prob = float(modelo.predict_proba(caracteristicas(f, versao).reshape(1, -1))[0, 1])
        except Exception as erro:
            print(f"\n  ! pulando {f.name}: {erro}")
            continue
        analisadas += 1
        if prob > limite_nao:
            suspeitas.append((f, prob))

    if not analisadas:
        print(f"Nenhuma foto nova: as {ja_usadas} fotos ja estao no treino ou ja foram revisadas.")
        return
    vistas_sim = sum(1 for _, p in suspeitas if p >= args.limiar + args.folga)
    incertas = len(suspeitas) - vistas_sim
    print(f"\n=== GARIMPO DE CONFUSORES (fotos de OS sem escavacao) - modelo {versao} ===")
    print(f"Fotos analisadas ............ {analisadas}" + (f"  ({ja_usadas} ja usadas, ignoradas)" if ja_usadas else ""))
    print(f"Vistas como escavacao (SIM) . {vistas_sim}  ({vistas_sim / analisadas:.1%})   <- taxa de confusao por foto")
    print(f"Incertas .................... {incertas}  ({incertas / analisadas:.1%})")
    print(f"Corretas (NAO) .............. {analisadas - len(suspeitas)}  ({(analisadas - len(suspeitas)) / analisadas:.1%})")
    print("Meta: chegar perto de 1% vistas como SIM, para que OS com 4 ou 5 fotos quase nunca virem 'sim' por engano.")

    if not suspeitas:
        print("Nenhuma foto confundiu o modelo. Otimo sinal!")
        oferecer_arquivar_garimpo(pasta, 0, dados)
        return
    pasta_g = dados / "garimpo"
    pasta_g.mkdir(exist_ok=True)
    csv_g = pasta_g / f"garimpo_{datetime.now().strftime('%Y-%m-%d_%H%M%S')}.csv"
    with open(csv_g, "w", newline="", encoding="utf-8-sig") as fcsv:
        w = csv.DictWriter(fcsv, delimiter=";",
                           fieldnames=["arquivo", "prob_escavacao", "previsao", "caminho", "origem", "info",
                                       "pasta_origem"])
        w.writeheader()
        for f, prob in sorted(suspeitas, key=lambda t: -t[1]):
            w.writerow({"arquivo": f.name, "prob_escavacao": round(prob, 3), "previsao": "incerto",
                        "caminho": str(f.resolve()), "origem": "garimpo",
                        "info": f"Foto de OS SEM escavacao que confundiu o modelo ({prob:.2f}). "
                                "Confirme: S = sem escavacao, C = tem escavacao sim, D = descartar",
                        "pasta_origem": str(pasta.resolve())})
    print(f"\nSuspeitas salvas em: {csv_g}")
    resp = input(f"Revisar agora as {len(suspeitas)} fotos suspeitas (das mais para as menos confusas)? [s/n]: ")
    if resp.strip().lower().startswith("s"):
        revisar(argparse.Namespace(csv=str(csv_g), dados=str(dados), fotos=None))
    else:
        print("Ok. Elas ficam na opcao 4, em 'Ultimo garimpo de confusores'.")
        print("Depois de revisar todas, o programa oferece arquivar as fotos do garimpo.")


def escolher_csv_revisao(dados):
    from datetime import datetime

    dados = Path(dados)
    candidatos = [("Ultimo treino (opcao 1)", dados / "validacao_treino.csv"),
                  ("Ultimo teste real (opcao 3)", dados / "teste" / "teste_por_os.csv"),
                  ("Ultima classificacao de fotos novas (opcao 2)", dados / "previsoes.csv"),
                  ("Ultima classificacao de fotos novas (opcao 2)", Path("previsoes.csv").resolve())]
    antigos = sorted((dados / "teste_antigo").glob("*/incorporar_pendentes.csv"))
    if antigos:
        candidatos.insert(2, ("Fotos restantes do ultimo teste incorporado", antigos[-1]))
    diarios = sorted((dados / "revisao_diaria").glob("pendentes_*.csv"))
    if diarios:
        candidatos.insert(2, ("Pendencias da rotina diaria (assistente)", diarios[-1]))
    garimpos = sorted((dados / "garimpo").glob("garimpo_*.csv"))
    if garimpos:
        candidatos.insert(2, ("Ultimo garimpo de confusores (opcao 5)", garimpos[-1]))
    vistos, opcoes = set(), []
    for rotulo, cam in candidatos:
        if cam.is_file() and cam.resolve() not in vistos:
            vistos.add(cam.resolve())
            opcoes.append((rotulo, cam))
    print("\nO que voce quer revisar?")
    for i, (rotulo, cam) in enumerate(opcoes, 1):
        quando = datetime.fromtimestamp(cam.stat().st_mtime).strftime("%d/%m %H:%M")
        n = contar_pendentes(cam, dados)
        pend = "?" if n is None else str(n)
        print(f"  {i} - {rotulo}: {pend} fotos pendentes  (gerado em {quando})")
    print("  0 - Outro arquivo (digitar o caminho)")
    validas = {str(i) for i in range(len(opcoes) + 1)}
    escolha = ""
    while escolha not in validas:
        escolha = input("Escolha: ").strip()
    if escolha == "0":
        return perguntar("Caminho do CSV", str(dados / "validacao_treino.csv"))
    return str(opcoes[int(escolha) - 1][1])


def montar_fila(caminho_csv, dados, fotos=None, silencioso=False):
    caminho_csv = Path(caminho_csv)
    if not caminho_csv.is_file():
        sys.exit(f"CSV nao encontrado: {caminho_csv.resolve()}")
    linhas = ler_csv(caminho_csv)
    if not linhas:
        sys.exit("CSV vazio.")
    cab = set(linhas[0].keys())
    base_csv = caminho_csv.resolve().parent
    fila = []
    if {"pasta", "esperado", "resultado", "arquivo"} <= cab:
        for l in linhas:
            if l["resultado"] in ("incerto", "ERRO"):
                fila.append({"caminho": base_csv / l["pasta"] / l["arquivo"], "origem": "treino",
                             "prob": float(l["prob_escavacao"]),
                             "info": f"Treino | pasta atual: {l['pasta']} | modelo: {l['previsao']} ({l['resultado']})"})
    elif {"os", "probs_fotos"} <= cab:
        for l in linhas:
            if l["resultado"] not in ("incerto", "ERRO"):
                continue
            for par in l["probs_fotos"].split(" | "):
                nome, _, p = par.rpartition("=")
                cam = base_csv / l["pasta"] / l["os"] / nome
                if not cam.exists():
                    cam = base_csv / l["pasta"] / nome
                fila.append({"caminho": cam, "origem": "teste", "prob": float(p),
                             "info": f"Teste | OS {l['os']} (pasta: {l['pasta']}) | resultado da OS: {l['resultado']}"})
    elif {"arquivo", "prob_escavacao", "previsao"} <= cab:
        for l in linhas:
            if l["previsao"] != "incerto":
                continue
            if l.get("caminho"):
                cam = Path(l["caminho"])
            else:
                if not fotos:
                    if silencioso:
                        raise ValueError("pasta das fotos desconhecida")
                    fotos = perguntar("Este CSV nao guarda a pasta das fotos. Qual e a pasta?", "fotos_novas")
                cam = Path(fotos) / l["arquivo"]
            fila.append({"caminho": cam, "origem": l.get("origem") or "novas",
                         "prob": float(l["prob_escavacao"]),
                         "info": l.get("info") or "Foto nova | modelo: incerto"})
    else:
        sys.exit("Nao reconheci o CSV. Use validacao_treino.csv, previsoes.csv ou teste_por_os.csv.")

    ja = hashes_revisados(dados)
    final, faltando, repetidas = [], 0, 0
    for it in fila:
        if not it["caminho"].is_file():
            faltando += 1
            continue
        it["hash"] = hash_arquivo(it["caminho"])
        if it["hash"] in ja:
            repetidas += 1
            continue
        it.update(atual=it["caminho"], copia=None, decisao=None)
        final.append(it)
    if silencioso:
        return final
    msg = f"{len(final)} fotos para revisar"
    if repetidas:
        msg += f" | {repetidas} ja revisadas antes (puladas)"
    if faltando:
        msg += f" | {faltando} nao encontradas (movidas ou apagadas)"
    print(msg)
    return final


def nome_livre(pasta, nome, prefixo=""):
    pasta.mkdir(parents=True, exist_ok=True)
    alvo = pasta / f"{prefixo}{nome}"
    n = 1
    while alvo.exists():
        p = Path(nome)
        alvo = pasta / f"{prefixo}{p.stem}_{n}{p.suffix}"
        n += 1
    return alvo


def registrar(dados, it, dec, acao, de, para):
    from datetime import datetime

    reg = Path(dados) / "revisoes.csv"
    novo = not reg.is_file()
    with open(reg, "a", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=REGISTRO_CAMPOS, delimiter=";")
        if novo:
            w.writeheader()
        w.writerow({"data_hora": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    "arquivo": it["caminho"].name, "origem": it["origem"],
                    "prob": round(it["prob"], 3), "decisao": NOMES_DECISAO[dec],
                    "acao": acao, "de": de, "para": para, "hash": it["hash"]})


def aplicar_decisao(it, dec, dados, permitir_teste=True):
    import shutil

    destino = Path(dados) / DESTINOS[dec]
    if it["origem"] == "treino":
        de = str(it["atual"])
        if it["atual"].parent.resolve() == destino.resolve():
            acao, para = "mantida (pasta confirmada)", str(it["atual"])
        else:
            alvo = nome_livre(destino, it["atual"].name)
            shutil.move(str(it["atual"]), str(alvo))
            it["atual"] = alvo
            acao = "descartada (movida para descartadas)" if dec == "D" else "movida de pasta"
            para = str(alvo)
    else:
        de = str(it["caminho"])
        if it["copia"] is not None and Path(it["copia"]).exists():
            Path(it["copia"]).unlink()
            it["copia"] = None
        if dec == "D":
            acao, para = "descartada (nao copiada)", ""
        elif it["origem"] == "teste" and not permitir_teste:
            acao, para = "registrada (nao copiada: foto do teste)", ""
        else:
            alvo = nome_livre(destino, it["caminho"].name, prefixo=f"rev_{it['origem']}_")
            shutil.copy2(str(it["caminho"]), str(alvo))
            it["copia"] = alvo
            acao, para = "copiada para o treino", str(alvo)
    it["decisao"] = dec
    registrar(dados, it, dec, acao, de, para)
    return acao


def revisar(args):
    fila = montar_fila(args.csv, args.dados, args.fotos)
    if not fila:
        print("Nada para revisar.")
        if Path(args.csv).name.startswith("garimpo_"):
            linhas = ler_csv(args.csv)
            origem = linhas[0].get("pasta_origem") if linhas else None
            if origem:
                oferecer_arquivar_garimpo(origem, 0, args.dados)
        return

    import base64
    import tkinter as tk
    from tkinter import messagebox

    import cv2

    estado = {"i": 0, "permitir_teste": None, "feitas": 0}
    raiz = tk.Tk()
    raiz.title("Revisao de fotos incertas")
    raiz.geometry("1100x860")
    topo = tk.Label(raiz, font=("Segoe UI", 12), anchor="w", justify="left")
    topo.pack(fill="x", padx=12, pady=(10, 4))
    quadro = tk.Label(raiz)
    quadro.pack(expand=True)
    rodape = tk.Label(raiz, font=("Segoe UI", 11), fg="#555555",
                      text="C = com escavacao    S = sem escavacao    D = descartar    "
                           "P = pular    \u2190 = voltar    Esc = sair")
    rodape.pack(pady=4)
    botoes = tk.Frame(raiz)
    botoes.pack(pady=(0, 12))

    def mostrar():
        it = fila[estado["i"]]
        caminho = it["atual"] if it["origem"] == "treino" else it["caminho"]
        img = cv2.imdecode(np.fromfile(str(caminho), dtype=np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            quadro.configure(image="", text=f"Nao consegui abrir {caminho.name}")
        else:
            h, w = img.shape[:2]
            esc = min(1050 / w, 680 / h, 1.0)
            img = cv2.resize(img, (max(1, int(w * esc)), max(1, int(h * esc))), interpolation=cv2.INTER_AREA)
            ok, png = cv2.imencode(".png", img)
            foto = tk.PhotoImage(data=base64.b64encode(png.tobytes()))
            quadro.configure(image=foto, text="")
            quadro.image = foto
        ja = f"   |   ja decidida: {NOMES_DECISAO[it['decisao']]}" if it["decisao"] else ""
        topo.configure(text=f"Foto {estado['i'] + 1} de {len(fila)}   |   {it['caminho'].name}\n"
                            f"{it['info']}   |   prob. de escavacao: {it['prob']:.2f}{ja}")

    def fechar():
        quadro.configure(image="")
        quadro.image = None
        raiz.destroy()

    def avancar():
        if estado["i"] < len(fila) - 1:
            estado["i"] += 1
            mostrar()
        else:
            messagebox.showinfo("Revisao concluida",
                                f"Fim da lista. {estado['feitas']} decisoes registradas.\n"
                                "Rode a opcao 1 para treinar de novo com as fotos revisadas.")
            fechar()

    def decidir_foto(dec):
        it = fila[estado["i"]]
        if it["origem"] == "teste" and dec != "D" and estado["permitir_teste"] is None:
            estado["permitir_teste"] = messagebox.askyesno(
                "Fotos do teste",
                "Copiar fotos do TESTE para o treino?\n\n"
                "Sim: elas passam a ensinar o modelo, e essas OS deixam de valer como teste.\n"
                "Nao: a decisao fica so registrada.")
        try:
            aplicar_decisao(it, dec, args.dados, bool(estado["permitir_teste"]))
            estado["feitas"] += 1
        except Exception as erro:
            messagebox.showerror("Erro", str(erro))
            return
        avancar()

    def voltar():
        if estado["i"] > 0:
            estado["i"] -= 1
            mostrar()

    for texto, cmd in (("C - Com escavacao", lambda: decidir_foto("C")),
                       ("S - Sem escavacao", lambda: decidir_foto("S")),
                       ("D - Descartar", lambda: decidir_foto("D")),
                       ("P - Pular", avancar),
                       ("\u2190 Voltar", voltar)):
        tk.Button(botoes, text=texto, width=18, command=cmd).pack(side="left", padx=4)
    for tecla, cmd in (("c", lambda e: decidir_foto("C")), ("s", lambda e: decidir_foto("S")),
                       ("d", lambda e: decidir_foto("D")), ("p", lambda e: avancar())):
        raiz.bind(f"<{tecla}>", cmd)
        raiz.bind(f"<{tecla.upper()}>", cmd)
    raiz.bind("<Left>", lambda e: voltar())
    raiz.bind("<Escape>", lambda e: fechar())
    raiz.protocol("WM_DELETE_WINDOW", fechar)

    mostrar()
    raiz.mainloop()
    import gc
    gc.collect()
    print(f"{estado['feitas']} decisoes registradas em {Path(args.dados) / 'revisoes.csv'}")
    if estado["feitas"]:
        print("Proximo passo: opcao 1 (treinar de novo).")
    if Path(args.csv).name.startswith("garimpo_"):
        linhas = ler_csv(args.csv)
        origem = linhas[0].get("pasta_origem") if linhas else None
        if origem:
            oferecer_arquivar_garimpo(origem, contar_pendentes(args.csv, args.dados) or 0, args.dados)


def prever(args):
    import joblib

    if not Path(args.modelo).is_file():
        sys.exit(f"Modelo nao encontrado: {args.modelo}. Treine primeiro (opcao 1).")
    pasta = Path(args.pasta)
    if not pasta.is_dir():
        sys.exit(f"Pasta nao encontrada: {pasta.resolve()}")
    modelo, versao = carregar_modelo(args.modelo)
    linhas = []
    arquivos = [a for a in sorted(pasta.iterdir()) if a.suffix.lower() in EXTENSOES]
    barra = Progresso(len(arquivos), "Classificando fotos   ")
    for arq in arquivos:
        barra.passo()
        try:
            prob = float(modelo.predict_proba(caracteristicas(arq, versao).reshape(1, -1))[0, 1])
        except Exception as erro:
            print(f"\n  ! pulando {arq.name}: {erro}")
            continue
        linhas.append({
            "arquivo": arq.name,
            "prob_escavacao": round(prob, 3),
            "previsao": decidir(prob, args.limiar, args.folga),
            "caminho": str(arq.resolve()),
        })
    with open(args.saida, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=["arquivo", "prob_escavacao", "previsao", "caminho"], delimiter=";")
        w.writeheader()
        w.writerows(linhas)
    print(f"{len(linhas)} fotos classificadas. Resultado em: {args.saida}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = ap.add_subparsers(dest="comando", required=True)

    t = sub.add_parser("treinar")
    t.add_argument("--dados", default="dados")
    t.add_argument("--modelo", default="modelo_escavacao.joblib")
    t.add_argument("--limiar", type=float, default=0.5)
    t.add_argument("--folga", type=float, default=0.15)
    t.set_defaults(func=treinar)

    p = sub.add_parser("prever")
    p.add_argument("--modelo", default="modelo_escavacao.joblib")
    p.add_argument("--pasta", required=True)
    p.add_argument("--saida", default="previsoes.csv")
    p.add_argument("--limiar", type=float, default=0.5)
    p.add_argument("--folga", type=float, default=0.15)
    p.set_defaults(func=prever)

    te = sub.add_parser("testar")
    te.add_argument("--modelo", default="modelo_escavacao.joblib")
    te.add_argument("--pasta", default="teste")
    te.add_argument("--dados", default="dados", help="pasta de treino, para avisar fotos repetidas")
    te.add_argument("--limiar", type=float, default=0.5)
    te.add_argument("--folga", type=float, default=0.15)
    te.add_argument("--sim-os", dest="sim_os", type=float, default=LIMIAR_OS_SIM,
                    help="probabilidade minima da melhor foto para a OS ser 'sim' (padrao 0,75)")
    te.set_defaults(func=testar)

    rv = sub.add_parser("revisar")
    rv.add_argument("--csv", required=True, help="validacao_treino.csv, previsoes.csv ou teste_por_os.csv")
    rv.add_argument("--dados", default="dados", help="pasta de treino")
    rv.add_argument("--fotos", default=None, help="pasta das fotos (so para previsoes.csv antigo)")
    rv.set_defaults(func=revisar)

    ga = sub.add_parser("garimpar")
    ga.add_argument("--pasta", required=True, help="fotos de OS SEM escavacao (aceita subpastas)")
    ga.add_argument("--modelo", default="modelo_escavacao.joblib")
    ga.add_argument("--dados", default="dados", help="pasta de treino")
    ga.add_argument("--limiar", type=float, default=0.5)
    ga.add_argument("--folga", type=float, default=0.15)
    ga.set_defaults(func=garimpar)

    if len(sys.argv) == 1:
        args = menu_interativo(ap)
    else:
        args = ap.parse_args()
    args.func(args)


def pasta_dados_padrao():
    pasta_script = Path(__file__).resolve().parent
    if (pasta_script / "com_escavacao").is_dir():
        return str(pasta_script)
    return "dados"


def perguntar(texto, padrao):
    resposta = input(f"{texto} [{padrao}]: ").strip().strip('"')
    return resposta or padrao


def menu_interativo(ap):
    print("O que voce quer fazer?")
    print("  1 - Treinar o classificador com as fotos da pasta de dados")
    print("  2 - Classificar fotos novas com um modelo ja treinado")
    print("  3 - Teste real: OS fora do treino, com resultado por OS")
    print("  4 - Revisar incertas (voce decide e o treino aprende)")
    print("  5 - Garimpar confusores (fotos SEM escavacao que enganam o modelo)")
    escolha = ""
    while escolha not in ("1", "2", "3", "4", "5"):
        escolha = input("Escolha 1, 2, 3, 4 ou 5: ").strip()

    if escolha == "1":
        dados = perguntar(
            "Pasta que CONTEM as subpastas com_escavacao e sem_escavacao",
            pasta_dados_padrao())
        modelo = perguntar("Nome do arquivo para salvar o modelo", "modelo_escavacao.joblib")
        args = ap.parse_args(["treinar", "--dados", dados, "--modelo", modelo])
        args.oferecer_revisao = True
    elif escolha == "5":
        modelo = perguntar("Arquivo do modelo treinado", "modelo_escavacao.joblib")
        pasta = perguntar("Pasta com fotos de OS SEM escavacao (pode ter subpastas)",
                          str(Path(pasta_dados_padrao()) / "garimpo" / "fotos"))
        dados = pasta_dados_padrao()
        args = ap.parse_args(["garimpar", "--modelo", modelo, "--pasta", pasta, "--dados", dados])
    elif escolha == "4":
        dados = pasta_dados_padrao()
        csv_rev = escolher_csv_revisao(dados)
        args = ap.parse_args(["revisar", "--csv", csv_rev, "--dados", dados])
    elif escolha == "3":
        modelo = perguntar("Arquivo do modelo treinado", "modelo_escavacao.joblib")
        pasta = perguntar("Pasta do teste (com as subpastas com_escavacao e sem_escavacao)",
                          str(Path(pasta_dados_padrao()) / "teste"))
        dados = perguntar("Pasta de treino (para checar fotos repetidas)", pasta_dados_padrao())
        args = ap.parse_args(["testar", "--modelo", modelo, "--pasta", pasta, "--dados", dados])
        args.oferecer_revisao = True
    else:
        modelo = perguntar("Arquivo do modelo treinado", "modelo_escavacao.joblib")
        pasta = perguntar("Pasta com as fotos novas", "fotos_novas")
        saida = perguntar("Nome do CSV com o resultado", "previsoes.csv")
        args = ap.parse_args(["prever", "--modelo", modelo, "--pasta", pasta, "--saida", saida])
    return args


if __name__ == "__main__":
    main()
