import argparse
import base64
import csv
import gzip
import json
import re
import sys
import threading
import unicodedata
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

PASTA = Path(__file__).resolve().parent


def carregar_classificador():
    import importlib.util

    marcas = ("def feat_v2(", "def carregar_modelo(", "LIMIAR_OS_SIM")
    candidatos = []
    for pasta in (PASTA, PASTA.parent):
        for arq in pasta.glob("*.py"):
            if arq.resolve() == Path(__file__).resolve():
                continue
            try:
                texto = arq.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            if all(m in texto for m in marcas):
                candidatos.append(arq)
    if not candidatos:
        sys.exit("Nao encontrei o arquivo do classificador (o .py das opcoes 1 a 5) nesta pasta "
                 f"nem na pasta acima:\n  {PASTA}\n  {PASTA.parent}\n"
                 "Coloque a versao mais recente dele junto com este assistente.")
    arq = max(candidatos, key=lambda a: a.stat().st_mtime)
    spec = importlib.util.spec_from_file_location("classificador_escavacao", arq)
    modulo = importlib.util.module_from_spec(spec)
    sys.modules["classificador_escavacao"] = modulo
    spec.loader.exec_module(modulo)
    print(f"Classificador: {arq.name}")
    return modulo


ce = carregar_classificador()

VERSAO = "1.2"
CONFIG_ARQ = PASTA / "assistente_config.json"
CONFIG_PADRAO = {
    "porta": 8765,
    "mapa": "",
    "modelo": "modelo_escavacao.joblib",
    "rede_max_m": 20,
    "matricula_max_m": 8,
    "matricula_ignorar_m": 1,
    "salvar_fotos": True,
}
PASTA_REG = PASTA / "assistente"
TRAVA = threading.Lock()


def carregar_config():
    cfg = dict(CONFIG_PADRAO)
    if CONFIG_ARQ.is_file():
        cfg.update(json.loads(CONFIG_ARQ.read_text(encoding="utf-8")))
    if not cfg["mapa"] or not Path(cfg["mapa"]).is_file():
        candidatos = sorted(list(PASTA.glob("Mapa*.html")) + list(PASTA.parent.glob("Mapa*.html")),
                            key=lambda p: p.stat().st_mtime, reverse=True)
        cfg["mapa"] = str(candidatos[0]) if candidatos else ""
    CONFIG_ARQ.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return cfg


def norm(texto):
    t = unicodedata.normalize("NFKD", str(texto or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"\s+", " ", t).strip()


class Mapa:

    def __init__(self, caminho, cfg):
        from scipy.spatial import cKDTree

        self.cfg = cfg
        self.caminho = Path(caminho)
        texto = self.caminho.read_text(encoding="utf-8")
        m = re.search(r'<script id="__blobs" type="application/json">(.*?)</script>', texto, re.S)
        if not m:
            raise ValueError("Nao encontrei os dados do mapa (__blobs) nesse HTML.")
        blobs = json.loads(m.group(1))
        del texto

        def dec(nome):
            return json.loads(gzip.decompress(base64.b64decode(blobs[nome])).decode("utf-8"))

        meta = dec("META")
        self.gerado_em = meta.get("gerado_em", "?")

        D = dec("DADOS")
        cols, dic, cod, soltas = D["colunas"], D["dic"], D["cod"], D["soltas"]
        linhas = D["linhas"]

        def coluna(nome):
            ci = cols.index(nome)
            if ci in soltas:
                j = soltas.index(ci)
                return [l[j] for l in linhas]
            valores, codigos = dic[str(ci)], cod[str(ci)]
            return [valores[c] for c in codigos]

        os_ = coluna("Numero OS")
        self._carregar_rede(dec("REDE"))
        lon = coluna("NR_COORDENADA_X")
        lat = coluna("NR_COORDENADA_Y")
        dist = coluna("DIST_REDE_AGUA_M")
        faixa = coluna("Bucket Distancia")
        precisa = coluna("Coordenada precisa")
        pav = coluna("PAVIMENTACAO")
        self.exato, self.digitos = {}, {}
        for i, numero in enumerate(os_):
            reg = (lat[i], lon[i], dist[i], faixa[i], precisa[i] == "Sim", pav[i])
            self.exato[str(numero).strip().upper()] = reg
            self.digitos[re.sub(r"\D", "", str(numero)).lstrip("0")] = reg
        self.n_os = len(os_)

        pontos = []
        for nome in ("CLIENTES_PERTO", "CLIENTES_LONGE"):
            C = dec(nome)
            d = np.array(C["deltas"], dtype=np.int64)
            pontos.append(np.c_[np.cumsum(d[0::2]) / C["escala"], np.cumsum(d[1::2]) / C["escala"]])
        pontos = np.vstack(pontos)
        self.arvore = cKDTree(self._xy(pontos[:, 0], pontos[:, 1]))
        self.n_clientes = len(pontos)

    def _carregar_rede(self, rede):
        from scipy.spatial import cKDTree

        inicios, fins = [], []
        for trecho in rede["trechos"]:
            c = np.array(trecho[0], dtype=float)
            if len(c) < 2:
                continue
            p = self._xy(c[:, 1], c[:, 0])
            for a, b in zip(p[:-1], p[1:]):
                n = max(1, int(np.ceil(np.linalg.norm(b - a) / 50.0)))
                pts = a + (b - a) * np.linspace(0, 1, n + 1)[:, None]
                inicios.append(pts[:-1])
                fins.append(pts[1:])
        self.seg_a = np.vstack(inicios)
        self.seg_b = np.vstack(fins)
        self.seg_raio = float(np.linalg.norm(self.seg_b - self.seg_a, axis=1).max() / 2)
        self.arvore_rede = cKDTree((self.seg_a + self.seg_b) / 2)

    def dist_rede(self, lat, lon, raio=200.0):
        p = self._xy([lat], [lon])[0]
        idx = self.arvore_rede.query_ball_point(p, raio + self.seg_raio)
        if not idx:
            return 999.0
        a, d = self.seg_a[idx], self.seg_b[idx] - self.seg_a[idx]
        t = np.clip(((p - a) * d).sum(1) / np.maximum((d * d).sum(1), 1e-9), 0, 1)
        return round(float(np.linalg.norm(a + d * t[:, None] - p, axis=1).min()), 1)

    def matriculas(self, lat, lon):
        p = self._xy([lat], [lon])[0]
        perto = len(self.arvore.query_ball_point(p, self.cfg["matricula_max_m"]))
        mesmo_ponto = len(self.arvore.query_ball_point(p, self.cfg["matricula_ignorar_m"]))
        return perto - mesmo_ponto

    def ponto(self, lat, lon):
        return {"dist_rede_m": self.dist_rede(lat, lon), "matriculas_vizinhas": self.matriculas(lat, lon)}

    @staticmethod
    def distancia_m(lat1, lon1, lat2, lon2):
        a, b = Mapa._xy([lat1, lat2], [lon1, lon2])
        return round(float(np.linalg.norm(a - b)), 1)

    @staticmethod
    def _xy(lat, lon):
        lat, lon = np.asarray(lat, float), np.asarray(lon, float)
        return np.c_[lon * 111320 * np.cos(np.radians(-10.95)), lat * 110540]

    def consultar(self, numero_os):
        reg = self.exato.get(str(numero_os).strip().upper())
        if reg is None:
            reg = self.digitos.get(re.sub(r"\D", "", str(numero_os)).lstrip("0"))
        if reg is None:
            return None
        lat, lon, dist, faixa, precisa, pav = reg
        return {"dist_rede_m": round(float(dist), 1), "faixa": faixa, "coordenada_precisa": precisa,
                "pavimento": pav, "matriculas_vizinhas": self.matriculas(lat, lon),
                "lat": lat, "lon": lon,
                "dist_rede_calc": self.dist_rede(lat, lon)}


RX_RECUSA = re.compile(r"(cliente|morador|proprietari|dono|responsavel)\w*\s+(nao|n)\s+(permit|autoriz|aceit|quis|quer|deix)|\brecus")
RX_OUTROS = {
    "Falta de Material": r"falta de material|sem (o )?material",
    "Endereço não localizado": r"endereco (nao|n) (localizad|encontrad|exist)|(nao|n) (localizamos|encontramos) o (endereco|imovel|numero)",
    "Responsável não estava no local": r"ninguem (em casa|no local)|responsavel (nao|n) (estava|se encontrava)|casa fechada|imovel fechado",
    "Já executado por outra equipe": r"ja (executad|possui (a )?ligacao|tem (a )?ligacao|tem hidrometro)",
}
RX_GEORADAR = re.compile(r"geo ?ra[dt]|georad|gel ?rad")
RX_AUTORIZ = re.compile(r"programa\w*.{0,60}(autoriz|permit|permiss|liber)|(autoriz|permit|permiss|liber)\w*.{0,60}programa"
                        r"|posterg\w*.{0,40}(permiss|autoriza)|(permiss|autoriza)\w*.{0,40}posterg")
RX_ALEGA = re.compile(r"sondag|sondamos|escavamos|escavei|escavacao de|cavamos|cavei|cavado|abrimos|buraco|1[.,]\s?\d{1,2} ?m")
RX_ESGOTO = re.compile(r"esgot")
RX_PAV = re.compile(r"asfalt|paralelep|pedra|concreto|calcad|cimento|bloquete|solo (duro|rigido|seco)|solo de dif|terreno (duro|dif)|dificil escava|rocha")
RX_TUBO = re.compile(r"(tubula\w*|cano)\s+(estourad|rompid|quebrad)|vazamento|estouro")
RX_FUNDO = re.compile(r"1[.,]\s?[2-9]\d? ?m|1[.,]\s?[2-9]\d?\b|1 metro e|mais de 1 ?m|profundidade")


def sinais_do_parecer(parecer):
    t = norm(parecer)
    outros = [m for m, rx in RX_OUTROS.items() if re.search(rx, t)]
    return {"recusa": bool(RX_RECUSA.search(t)), "outro_motivo": outros, "alega_escavacao": bool(RX_ALEGA.search(t)),
            "georadar": bool(RX_GEORADAR.search(t)), "autorizacao_programacao": bool(RX_AUTORIZ.search(t)),
            "esgoto": bool(RX_ESGOTO.search(t)), "pavimento_duro": bool(RX_PAV.search(t)),
            "tubulacao": bool(RX_TUBO.search(t)), "escavou_fundo": bool(RX_FUNDO.search(t))}


def gps_da_foto(conteudo):
    try:
        import io
        from PIL import Image

        g = Image.open(io.BytesIO(conteudo)).getexif().get_ifd(0x8825)
        if not g or 2 not in g or 4 not in g:
            return None

        def graus(v):
            d, mi, se = (float(x) for x in v)
            return d + mi / 60 + se / 3600

        lat = graus(g[2]) * (-1 if str(g.get(1, "N")).strip().upper().startswith("S") else 1)
        lon = graus(g[4]) * (-1 if str(g.get(3, "E")).strip().upper().startswith("W") else 1)
        if not (-13 < lat < -8 and -40 < lon < -35):
            return None
        return lat, lon
    except Exception:
        return None


def local_das_fotos(fotos):
    pontos = [g for g in (gps_da_foto(c) for _, c in fotos) if g]
    if not pontos:
        return None
    lat = float(np.median([p[0] for p in pontos]))
    lon = float(np.median([p[1] for p in pontos]))
    dispersao = max(Mapa.distancia_m(lat, lon, a, b) for a, b in pontos)
    return {"lat": round(lat, 6), "lon": round(lon, 6), "n_fotos_gps": len(pontos), "dispersao_m": dispersao}


def achar_modelo(cfg):
    modelo = Path(cfg["modelo"])
    if modelo.is_absolute():
        return modelo
    candidatos = [PASTA / modelo, PASTA.parent / modelo, Path.cwd() / modelo]
    achados = [c for c in candidatos if c.is_file()]
    if not achados:
        sys.exit("Modelo nao encontrado. Procurei em:\n  " + "\n  ".join(str(c) for c in candidatos)
                 + "\nTreine pela opcao 1 do classificador ou informe o caminho em assistente_config.json.")
    return max(achados, key=lambda c: c.stat().st_mtime)


class Fotos:
    def __init__(self, caminho_modelo):
        self.caminho = Path(caminho_modelo)
        self.modelo, self.versao = ce.carregar_modelo(self.caminho)
        self.carimbo = self.caminho.stat().st_mtime

    def recarregar_se_mudou(self):
        try:
            carimbo = self.caminho.stat().st_mtime
        except OSError:
            return
        if carimbo != self.carimbo:
            with TRAVA:
                self.modelo, self.versao = ce.carregar_modelo(self.caminho)
                self.carimbo = carimbo
            print(f"  (modelo atualizado carregado: {self.caminho.name})")

    def prob(self, conteudo):
        import cv2

        img = cv2.imdecode(np.frombuffer(conteudo, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("imagem ilegivel")
        img = cv2.resize(img, (ce.LADO, ce.LADO), interpolation=cv2.INTER_AREA)
        vetor = ce.FEATS[self.versao](img).reshape(1, -1)
        return float(self.modelo.predict_proba(vetor)[0, 1])


def m(valor):
    return "menos de 1 m" if valor < 1 else f"{valor:.0f} m"


def analisar(numero_os, motivo, parecer, fotos, mapa, classificador, cfg):
    mot = norm(motivo)
    if "inexistencia" in mot:
        tipo = "INEX"
    elif "necessita escavacao" in mot:
        tipo = "ESC"
    else:
        return {"os": numero_os, "escopo": False, "decisao": None, "observacao": "",
                "detalhe": "Motivo fora do escopo da analise."}

    sinais = sinais_do_parecer(parecer)
    probs = []
    for nome, conteudo in fotos:
        try:
            probs.append({"foto": nome, "prob": round(classificador.prob(conteudo), 3)})
        except Exception as erro:
            probs.append({"foto": nome, "prob": None, "erro": str(erro)})
    validas = [p["prob"] for p in probs if p["prob"] is not None]
    melhor = max(validas) if validas else 0.0
    limite_nao = 0.5 - 0.15
    if not validas:
        foto = "nao"
    elif melhor >= ce.LIMIAR_OS_SIM:
        foto = "sim"
    elif melhor <= limite_nao:
        foto = "nao"
    else:
        foto = "incerto"
    txt_fotos = "sem fotos anexadas" if not validas else f"melhor foto {melhor:.2f}"

    info_mapa = mapa.consultar(numero_os) if mapa else None
    local = local_das_fotos(fotos)
    decisao, obs = None, ""

    if sinais["recusa"]:
        decisao = "erro"
        obs = ("Motivo de postergação indevido. Parecer indica recusa do cliente; "
               "motivo provável: Cliente não permitiu.")
    elif sinais["outro_motivo"]:
        decisao = "conferir"
        obs = (f"Conferir: parecer sugere outro motivo ({', '.join(sinais['outro_motivo'])}). "
               "Verificar se o motivo registrado está correto.")

    elif tipo == "INEX":
        fonte, base, nota = None, None, ""
        if mapa and local:
            confiavel = True
            if info_mapa and abs(info_mapa["dist_rede_calc"] - info_mapa["dist_rede_m"]) > 3:
                confiavel = False
            if local["dispersao_m"] > 150:
                confiavel = False
            if confiavel:
                fonte, base = "fotos", mapa.ponto(local["lat"], local["lon"])
                if info_mapa:
                    local["dist_ate_os_m"] = Mapa.distancia_m(local["lat"], local["lon"], info_mapa["lat"], info_mapa["lon"])
        if fonte is None and info_mapa:
            fonte, base = "mapa", info_mapa
        onde = "do local das fotos" if fonte == "fotos" else "no mapa"

        if fonte is None:
            if foto == "sim":
                decisao, obs = "ok", "Realizar extensão de rede. Fotos mostram escavação sem rede encontrada. (OS fora do mapa)"
            else:
                decisao = "conferir"
                obs = f"Conferir: OS fora do mapa e fotos sem GPS; não foi possível verificar rede e matrículas ({txt_fotos})."
        else:
            rede_perto = base["dist_rede_m"] <= cfg["rede_max_m"]
            mats = base["matriculas_vizinhas"]
            motivos = []
            if rede_perto:
                motivos.append(f"rede a {m(base['dist_rede_m'])} {onde}")
            if mats > 0:
                motivos.append(f"{mats} matrícula(s) ativa(s) a até {cfg['matricula_max_m']} m {onde}")
            txt_mot = "; ".join(motivos)
            if not motivos:
                decisao = "ok"
                rede_txt = "sem rede a 200 m" if base["dist_rede_m"] >= 999 else f"rede a {m(base['dist_rede_m'])}"
                obs = (f"Realizar extensão de rede. Sem rede a até {cfg['rede_max_m']} m nem matrícula ativa "
                       f"a até {cfg['matricula_max_m']} m {onde} ({rede_txt}).")
            elif foto == "sim":
                decisao, obs = "ok", f"Realizar extensão de rede. Fotos mostram escavação sem rede encontrada ({txt_mot})."
            elif sinais["georadar"]:
                decisao = "conferir"
                obs = f"Conferir: equipe informa uso de georadar sem encontrar rede ({txt_mot}); fotos sem escavação."
            elif sinais["autorizacao_programacao"]:
                decisao = "conferir"
                obs = f"Conferir: parecer informa autorização da programação para postergar ({txt_mot})."
            elif foto == "incerto":
                decisao = "conferir"
                obs = f"Conferir: escavação obrigatória ({txt_mot}); fotos inconclusivas ({txt_fotos})."
            elif sinais["alega_escavacao"]:
                decisao = "erro"
                obs = f"Evidencias insuficientes. Equipe alega sondagem/escavação, mas as fotos não mostram ({txt_mot})."
            else:
                decisao = "erro"
                obs = f"Sem evidências. {txt_mot[0].upper() + txt_mot[1:]}, sem foto de escavação."

            if fonte == "mapa" and info_mapa and not info_mapa["coordenada_precisa"]:
                nota = " Coordenada imprecisa no mapa (fotos sem GPS)."
            elif (fonte == "fotos" and info_mapa and info_mapa["coordenada_precisa"]
                  and local.get("dist_ate_os_m", 0) > 100):
                nota = f" Fotos tiradas a {m(local['dist_ate_os_m'])} do ponto da OS no mapa."
            if nota:
                obs += nota
                if decisao in ("erro", "ok"):
                    decisao, obs = "conferir", "Conferir: " + obs

    else:
        if foto == "sim":
            razoes = []
            if sinais["escavou_fundo"]:
                razoes.append("equipe escavou 1,20 m ou mais sem encontrar rede")
            if sinais["tubulacao"]:
                razoes.append("tubulação estourada encontrada na escavação")
            if sinais["esgoto"]:
                razoes.append("presença de esgoto (local insalubre)")
            decisao = "ok"
            obs = "Necessário apoio da retro. Fotos mostram escavação realizada" + (f"; {'; '.join(razoes)}." if razoes else ".")
        elif foto == "incerto":
            decisao = "conferir"
            extra = []
            if sinais["pavimento_duro"]:
                extra.append("solo/pavimento duro")
            if sinais["esgoto"]:
                extra.append("esgoto")
            obs = f"Conferir: fotos inconclusivas ({txt_fotos})" + (f"; parecer cita {', '.join(extra)}." if extra else ".")
        elif sinais["pavimento_duro"]:
            pav = f" (mapa: {info_mapa['pavimento']})" if info_mapa else ""
            decisao, obs = "conferir", f"Conferir: parecer cita solo/pavimento duro{pav}; fotos sem escavação."
        elif sinais["esgoto"]:
            decisao, obs = "conferir", "Conferir: parecer cita esgoto, mas as fotos não mostram escavação."
        else:
            decisao = "erro"
            obs = "Evidencias insuficientes. Fotos sem escavação e parecer sem condição que justifique escavação mecânica."

    return {"os": numero_os, "escopo": True, "tipo": tipo, "decisao": decisao, "observacao": obs,
            "foto_os": foto, "melhor_foto": round(melhor, 3), "fotos": probs, "mapa": info_mapa, "local": local,
            "sinais_parecer": sinais, "versao_modelo": classificador.versao}


def registrar_analise(res, motivo, parecer, fotos, cfg):
    hoje = datetime.now().strftime("%Y-%m-%d")
    with TRAVA:
        PASTA_REG.mkdir(exist_ok=True)
        if cfg.get("salvar_fotos") and fotos:
            destino = PASTA_REG / "fotos" / hoje / re.sub(r"[^\w.-]", "_", str(res["os"]))
            destino.mkdir(parents=True, exist_ok=True)
            for i, (nome, conteudo) in enumerate(fotos, 1):
                nome_ok = re.sub(r"[^\w.-]", "_", nome or f"foto_{i}.jpg")
                (destino / nome_ok).write_bytes(conteudo)
        arq = PASTA_REG / "registro_analises.csv"
        if arq.is_file():
            with open(arq, encoding="utf-8-sig") as f:
                cabecalho = f.readline()
            if "gps_fotos" not in cabecalho:
                arq.rename(PASTA_REG / f"registro_analises_ate_{hoje}.csv")
        novo = not arq.is_file()
        with open(arq, "a", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f, delimiter=";")
            if novo:
                w.writerow(["data_hora", "os", "motivo", "decisao", "observacao_sugerida", "foto_os",
                            "melhor_foto", "probs_fotos", "dist_rede_m", "matriculas_vizinhas",
                            "coordenada_precisa", "gps_fotos", "parecer"])
            mp = res.get("mapa") or {}
            w.writerow([datetime.now().strftime("%Y-%m-%d %H:%M:%S"), res["os"], motivo, res.get("decisao"),
                        res.get("observacao"), res.get("foto_os"), res.get("melhor_foto"),
                        " | ".join(f"{p['foto']}={p['prob']}" for p in res.get("fotos", [])),
                        mp.get("dist_rede_m", ""), mp.get("matriculas_vizinhas", ""),
                        mp.get("coordenada_precisa", ""),
                        (f"{res['local']['lat']},{res['local']['lon']}" if res.get("local") else ""), parecer])


def registrar_decisao_final(dados):
    with TRAVA:
        PASTA_REG.mkdir(exist_ok=True)
        arq = PASTA_REG / "decisoes_finais.csv"
        novo = not arq.is_file()
        with open(arq, "a", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f, delimiter=";")
            if novo:
                w.writerow(["data_hora", "os", "motivo", "decisao_sugerida", "observacao_sugerida",
                            "observacao_final", "auditor"])
            w.writerow([datetime.now().strftime("%Y-%m-%d %H:%M:%S"), dados.get("os", ""), dados.get("motivo", ""),
                        dados.get("decisao_sugerida", ""), dados.get("observacao_sugerida", ""),
                        dados.get("observacao_final", ""), dados.get("auditor", "")])


PISO_SEM = 0.15
MARGEM_ERRO = 0.01
MARGEM_INCERTAS = 0.03


def pasta_de_treino():
    for p in (PASTA, PASTA / "dados", PASTA.parent):
        if (p / "com_escavacao").is_dir() and (p / "sem_escavacao").is_dir():
            return p
    sys.exit("Nao achei a pasta de treino (com_escavacao e sem_escavacao) perto do assistente.")


def categoria_final(obs):
    t = norm(obs)
    if not t or t.startswith("conferir"):
        return None
    if re.search(r"indevid|incorret", t):
        return "indevido"
    if re.search(r"sem evid|insuficient|nao realizou|reprogram|sondagem para comprov|"
                 r"necessario (realizar )?sondagem|confirmar (a )?rede", t):
        return "sem_escavacao"
    if re.search(r"apoio da retro|extensao de rede|realizar extensao|maquit", t):
        return "aceita"
    return None


def ler_csv_assistente(nome):
    arq = PASTA_REG / nome
    if not arq.is_file():
        return []
    with open(arq, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f, delimiter=";"))


def fotos_da_os(numero_os):
    nome = re.sub(r"[^\w.-]", "_", str(numero_os))
    pastas = sorted((PASTA_REG / "fotos").glob(f"*/{nome}"))
    return pastas[-1] if pastas else None


def _medida(previsoes, y, sel):
    prev = [previsoes[i] for i in sel]
    yy = y[sel]
    m_ = ce.medir(prev, yy)
    m_["taxa_incertas"] = m_["incertas"] / max(1, len(sel))
    m_["taxa_erro"] = (m_["falso_sim"] + m_["falso_nao"]) / max(1, m_["decididas"])
    return m_


def treino_validado(dados, versao, novos=(), limiar=0.5, folga=0.15):
    import cv2

    imagens, y, caminhos, base = ce.montar_dados(dados)
    espelhadas = [cv2.flip(img, 1) for img in imagens]
    pesos, revisada = ce.pesos_revisadas(caminhos, base)
    func = ce.FEATS[versao]
    barra = ce.Progresso(2 * len(imagens), f"Medindo fotos ({versao})")
    F, F_esp = [], []
    for img, esp in zip(imagens, espelhadas):
        F.append(func(img)); barra.passo()
        F_esp.append(func(esp)); barra.passo()
    F, F_esp = np.vstack(F), np.vstack(F_esp)
    probs, previsoes = ce.validar(F, F_esp, y, limiar, folga, pesos, titulo=f"Validando ({versao})")
    novos = {str(Path(c).resolve()) for c in novos}
    antigos = [i for i, c in enumerate(caminhos) if str(Path(c).resolve()) not in novos]
    medida = _medida(previsoes, y, list(range(len(y))))
    medida.update(total=len(y), com=int(y.sum()), sem=int((1 - y).sum()))
    medida["antigas"] = _medida(previsoes, y, antigos)
    print("Treinando o modelo final com todas as fotos...")
    modelo = ce.criar_modelo()
    modelo.fit(np.vstack([F, F_esp]), np.concatenate([y, y]),
               randomforestclassifier__sample_weight=np.concatenate([pesos, pesos]))
    ce.salvar_revisao(base, caminhos, y, probs, previsoes, revisada)
    return modelo, medida


def treino_diario(cfg):
    import joblib
    import shutil

    agora = datetime.now()
    carimbo = agora.strftime("%Y-%m-%d_%H%M%S")
    dados = pasta_de_treino()
    caminho_modelo = achar_modelo(cfg)
    _, versao = ce.carregar_modelo(caminho_modelo)
    print(f"Pasta de treino: {dados}\nModelo em uso: {caminho_modelo} ({versao})")

    estado_arq = PASTA_REG / "treino_processados.json"
    processados = set(json.loads(estado_arq.read_text(encoding="utf-8"))) if estado_arq.is_file() else set()
    decisoes = {}
    for d in ler_csv_assistente("decisoes_finais.csv"):
        chave = f"{d['os']}|{d['data_hora']}"
        if chave not in processados:
            decisoes[d["os"]] = (chave, d)
    if not decisoes:
        print("Nenhuma auditoria nova desde o ultimo treino. Nada a fazer.")
        return
    analises = {}
    for r in ler_csv_assistente_antigos() + ler_csv_assistente("registro_analises.csv"):
        analises[r["os"]] = r

    no_treino = ce.hashes_treino(dados)
    copiar, revisar, contagem = [], [], {"com": 0, "sem": 0, "revisao": 0, "fora": 0, "sem_fotos": 0, "ja_no_treino": 0}
    for os_, (chave, d) in decisoes.items():
        cat = categoria_final(d.get("observacao_final", ""))
        reg = analises.get(os_)
        pasta = fotos_da_os(os_)
        processados.add(chave)
        if cat in (None, "indevido") or reg is None:
            contagem["fora"] += 1
            continue
        if pasta is None:
            contagem["sem_fotos"] += 1
            continue
        probs = {}
        for par in (reg.get("probs_fotos") or "").split(" | "):
            nome, _, p = par.rpartition("=")
            try:
                probs[nome] = float(p)
            except ValueError:
                pass
        sug = norm(d.get("observacao_sugerida", "")) + " " + norm(reg.get("observacao_sugerida", ""))
        fin = norm(d.get("observacao_final", ""))
        veredito = fin.split(".")[0].strip()
        escavacao_confirmada = cat == "aceita" and (
            ("fotos mostram escavacao" in sug and veredito and veredito in sug)
            or re.search(r"(?<!sem )escava", fin) is not None)
        for foto in sorted(pasta.iterdir()):
            p = probs.get(foto.name)
            if p is None or foto.suffix.lower() not in ce.EXTENSOES:
                continue
            if ce.hash_arquivo(foto) in no_treino:
                contagem["ja_no_treino"] += 1
                continue
            if cat == "sem_escavacao":
                if p >= 0.65:
                    revisar.append((os_, foto, p, "Auditor: sem evidência de escavação, mas o modelo viu escavação nesta foto."))
                elif p > PISO_SEM:
                    copiar.append((os_, foto, p, "sem_escavacao"))
            else:
                if p >= 0.65 and escavacao_confirmada:
                    copiar.append((os_, foto, p, "com_escavacao"))
                elif p >= 0.65 or 0.35 < p < 0.65:
                    revisar.append((os_, foto, p, "OS aceita pelo auditor. Esta foto mostra escavação?"))
                elif p > PISO_SEM:
                    copiar.append((os_, foto, p, "sem_escavacao"))

    copiadas = []
    for os_, foto, p, destino in copiar:
        alvo = ce.nome_livre(dados / destino, foto.name, prefixo=f"auto_{agora:%Y%m%d}_{os_}_")
        shutil.copy2(str(foto), str(alvo))
        registrar_auto_diario(dados, foto, p, destino.replace("_", " "), alvo, ce.hash_arquivo(foto))
        copiadas.append(alvo)
        contagem["com" if destino == "com_escavacao" else "sem"] += 1

    if revisar:
        pasta_rev = dados / "revisao_diaria"
        pasta_rev.mkdir(exist_ok=True)
        arq_rev = pasta_rev / f"pendentes_{carimbo}.csv"
        with open(arq_rev, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, delimiter=";", fieldnames=["arquivo", "prob_escavacao", "previsao", "caminho", "origem", "info"])
            w.writeheader()
            for os_, foto, p, info in revisar:
                w.writerow({"arquivo": foto.name, "prob_escavacao": round(p, 3), "previsao": "incerto",
                            "caminho": str(foto.resolve()), "origem": "diario", "info": f"OS {os_}. {info}"})
        contagem["revisao"] = len(revisar)

    print("\n=== ROTULOS DO DIA ===")
    print(f"OS com decisao nova ....... {len(decisoes)}")
    print(f"Fotos para COM escavacao .. {contagem['com']}")
    print(f"Fotos para SEM escavacao .. {contagem['sem']}")
    print(f"Fotos para revisao (C/S) .. {contagem['revisao']}  (opcional, opcao 4 do classificador)")
    print(f"OS de fora (sem decisao clara, motivo indevido ou sem analise) .. {contagem['fora']}")
    if contagem["sem_fotos"]:
        print(f"OS sem fotos guardadas .... {contagem['sem_fotos']}")

    if not copiadas:
        estado_arq.write_text(json.dumps(sorted(processados)), encoding="utf-8")
        print("Nenhuma foto nova entrou no treino; o modelo continua o mesmo.")
        return

    hist_arq = PASTA_REG / "historico_treinos.csv"
    historico = ler_csv_assistente("historico_treinos.csv")
    adotados = [h for h in historico if h.get("adotado") == "sim"]
    if adotados:
        base_erro, base_inc = float(adotados[-1]["taxa_erro"]), float(adotados[-1]["taxa_incertas"])
    else:
        print("\nPrimeira rotina: medindo o modelo atual (sem as fotos de hoje) para comparar...")
        temp = PASTA_REG / "_temp_base"
        if temp.exists():
            shutil.rmtree(temp)
        temp.mkdir()
        for c in copiadas:
            shutil.move(str(c), str(temp / f"{c.parent.name}__{c.name}"))
        try:
            _, medida_base = treino_validado(dados, versao)
        finally:
            for c in copiadas:
                shutil.move(str(temp / f"{c.parent.name}__{c.name}"), str(c))
            shutil.rmtree(temp, ignore_errors=True)
        base_erro, base_inc = medida_base["taxa_erro"], medida_base["taxa_incertas"]

    print("\nTreinando com as fotos novas...")
    modelo_novo, medida = treino_validado(dados, versao, novos=copiadas)
    ant = medida["antigas"]
    tol_erro = max(MARGEM_ERRO, 2 / max(1, ant["decididas"]))
    tol_inc = max(MARGEM_INCERTAS, 2 / max(1, medida["total"]))
    piorou = (ant["taxa_erro"] > base_erro + tol_erro) or (ant["taxa_incertas"] > base_inc + tol_inc)
    print("\n=== COMPARACAO (validacao cruzada, nas fotos que ja estavam no treino) ===")
    print(f"{'':24s}{'atual':>10s}{'novo':>10s}")
    print(f"{'Erro nas decididas':24s}{base_erro:>10.1%}{ant['taxa_erro']:>10.1%}")
    print(f"{'Incertas':24s}{base_inc:>10.1%}{ant['taxa_incertas']:>10.1%}")
    print(f"Com as fotos de hoje incluidas: erro {medida['taxa_erro']:.1%} | incertas {medida['taxa_incertas']:.1%}")
    print(f"Fotos no treino: {medida['total']} (com {medida['com']}, sem {medida['sem']})")

    if piorou:
        quarentena = PASTA_REG / "quarentena" / carimbo
        quarentena.mkdir(parents=True)
        for c in copiadas:
            shutil.move(str(c), str(quarentena / f"{c.parent.name}__{c.name}"))
        print(f"\nO modelo novo PIOROU: o atual foi mantido.")
        print(f"As fotos de hoje foram separadas em: {quarentena}")
        print("Vale olhar se algum rotulo do dia ficou errado antes de devolver as fotos ao treino.")
        adotado = "nao"
    else:
        anteriores = caminho_modelo.parent / "modelos_anteriores"
        anteriores.mkdir(exist_ok=True)
        shutil.copy2(str(caminho_modelo), str(anteriores / f"modelo_escavacao_{carimbo}.joblib"))
        joblib.dump({"versao": versao, "modelo": modelo_novo}, caminho_modelo)
        print(f"\nModelo atualizado: {caminho_modelo}")
        print(f"Copia do modelo anterior: {anteriores}")
        print("O assistente carrega o modelo novo sozinho na proxima analise.")
        adotado = "sim"

    novo = not hist_arq.is_file()
    with open(hist_arq, "a", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f, delimiter=";")
        if novo:
            w.writerow(["data_hora", "os_novas", "fotos_com", "fotos_sem", "fotos_revisao", "total_fotos",
                        "taxa_erro", "taxa_incertas", "base_erro", "base_incertas", "versao", "adotado"])
        w.writerow([agora.strftime("%Y-%m-%d %H:%M:%S"), len(decisoes), contagem["com"], contagem["sem"],
                    contagem["revisao"], medida["total"], round(medida["taxa_erro"], 4),
                    round(medida["taxa_incertas"], 4), round(base_erro, 4), round(base_inc, 4), versao, adotado])
    estado_arq.write_text(json.dumps(sorted(processados)), encoding="utf-8")


def registrar_auto_diario(dados, foto, prob, rotulo, para, h):
    reg = Path(dados) / "revisoes.csv"
    novo = not reg.is_file()
    with open(reg, "a", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=ce.REGISTRO_CAMPOS, delimiter=";")
        if novo:
            w.writeheader()
        w.writerow({"data_hora": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "arquivo": foto.name,
                    "origem": "treino diario", "prob": round(prob, 3), "decisao": f"auto: {rotulo}",
                    "acao": "incluida pela rotina diaria", "de": str(foto), "para": str(para), "hash": h})


def ler_csv_assistente_antigos():
    linhas = []
    for arq in sorted(PASTA_REG.glob("registro_analises_ate_*.csv")):
        with open(arq, encoding="utf-8-sig", newline="") as f:
            linhas += list(csv.DictReader(f, delimiter=";"))
    return linhas


class Assistente:
    def __init__(self, cfg):
        self.cfg = cfg
        try:
            import PIL
        except ImportError:
            print("ATENCAO: sem a biblioteca Pillow nao da para ler o GPS das fotos. Instale: pip install pillow")
        modelo = achar_modelo(cfg)
        print(f"Carregando o modelo de escavacao: {modelo}")
        self.fotos = Fotos(modelo)
        self.mapa = None
        if cfg["mapa"]:
            print(f"Carregando o mapa: {Path(cfg['mapa']).name} (pode levar alguns segundos)...")
            self.mapa = Mapa(cfg["mapa"], cfg)
            print(f"  mapa gerado em {self.mapa.gerado_em} | {self.mapa.n_os} OS | {self.mapa.n_clientes} clientes ativos")
        else:
            print("ATENCAO: nenhum mapa encontrado. Coloque o HTML do mapa nesta pasta ou informe em assistente_config.json.")

    def status(self):
        return {"ok": True, "versao": VERSAO, "modelo": self.fotos.versao,
                "mapa": self.mapa.gerado_em if self.mapa else None,
                "n_os_mapa": self.mapa.n_os if self.mapa else 0}

    def analisar_json(self, dados):
        self.fotos.recarregar_se_mudou()
        fotos = []
        for i, f in enumerate(dados.get("fotos", []), 1):
            b64 = f.get("base64", "")
            if "," in b64[:100]:
                b64 = b64.split(",", 1)[1]
            fotos.append((f.get("nome") or f"foto_{i}.jpg", base64.b64decode(b64)))
        res = analisar(dados.get("os", ""), dados.get("motivo", ""), dados.get("parecer", ""),
                       fotos, self.mapa, self.fotos, self.cfg)
        if res.get("escopo"):
            registrar_analise(res, dados.get("motivo", ""), dados.get("parecer", ""), fotos, self.cfg)
        return res


def criar_handler(assistente):
    class Handler(BaseHTTPRequestHandler):
        def _responder(self, codigo, corpo):
            dados = json.dumps(corpo, ensure_ascii=False).encode("utf-8")
            self.send_response(codigo)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Content-Length", str(len(dados)))
            self.end_headers()
            self.wfile.write(dados)

        def do_OPTIONS(self):
            self._responder(204, {})

        def do_GET(self):
            if self.path.startswith("/status"):
                self._responder(200, assistente.status())
            else:
                self._responder(404, {"erro": "rota desconhecida"})

        def do_POST(self):
            try:
                tamanho = int(self.headers.get("Content-Length", 0))
                dados = json.loads(self.rfile.read(tamanho).decode("utf-8") or "{}")
                if self.path.startswith("/analisar"):
                    res = assistente.analisar_json(dados)
                    if res.get("escopo"):
                        print(f"  OS {res['os']}: {res['decisao']} | {res['observacao'][:90]}")
                    self._responder(200, res)
                elif self.path.startswith("/decisao_final"):
                    registrar_decisao_final(dados)
                    self._responder(200, {"ok": True})
                else:
                    self._responder(404, {"erro": "rota desconhecida"})
            except Exception as erro:
                print(f"  ! erro: {erro}")
                self._responder(500, {"erro": str(erro)})

        def log_message(self, *args):
            pass

    return Handler


def iniciar(cfg):
    assistente = Assistente(cfg)
    servidor = ThreadingHTTPServer(("127.0.0.1", cfg["porta"]), criar_handler(assistente))
    print(f"\nAssistente pronto em http://127.0.0.1:{cfg['porta']}  (versao {VERSAO})")
    print("Deixe esta janela aberta enquanto audita. Para encerrar: feche a janela ou Ctrl+C.\n")
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print("\nAssistente encerrado.")


def testar_os(args, cfg):
    assistente = Assistente(cfg)
    pasta = Path(args.pasta)
    fotos = [(a.name, a.read_bytes()) for a in sorted(pasta.iterdir())
             if a.is_file() and a.suffix.lower() in ce.EXTENSOES]
    res = analisar(args.os, args.motivo, args.parecer, fotos, assistente.mapa, assistente.fotos, cfg)
    print(f"\n=== OS {res['os']} ===")
    if not res.get("escopo"):
        print(res["detalhe"])
        return
    print(f"Decisao ......... {res['decisao']}")
    print(f"Observacao ...... {res['observacao']}")
    print(f"Fotos (OS) ...... {res['foto_os']} (melhor {res['melhor_foto']:.2f})")
    for p in res["fotos"]:
        print(f"   {p['foto']}: {p['prob']}")
    mp = dict(res["mapa"]) if res.get("mapa") else None
    if mp:
        mp.pop("lat", None); mp.pop("lon", None)
    print(f"Mapa (ponto OS) . {mp or 'OS fora do mapa'}")
    print(f"GPS das fotos ... {res.get('local') or 'fotos sem GPS'}")
    print(f"Parecer ......... {', '.join(k for k, v in res['sinais_parecer'].items() if v) or 'nenhum sinal'}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = ap.add_subparsers(dest="comando")
    t = sub.add_parser("testar-os")
    t.add_argument("--pasta", required=True)
    t.add_argument("--os", required=True)
    t.add_argument("--motivo", required=True)
    t.add_argument("--parecer", default="")
    sub.add_parser("treino-diario")
    args = ap.parse_args()
    cfg = carregar_config()
    if args.comando == "testar-os":
        testar_os(args, cfg)
    elif args.comando == "treino-diario":
        PASTA_REG.mkdir(exist_ok=True)
        treino_diario(cfg)
    else:
        iniciar(cfg)


if __name__ == "__main__":
    main()
