// ==UserScript==
// @name         Auditoria de OS - 1
// @namespace    http://tampermonkey.net/
// @version      7.8.1
// @description  Galeria de imagens com analise automatica de desdobramento e Projeto Se Liga
// @match        https://*.fs.ocs.oraclecloud.com/*
// @match        file:///*
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @require      https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js
// @require      https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';

  const MAPA_AUTO = (function () {
    const CHAVE_PING = 'faMapaPing';
    const CHAVE_PONG = 'faMapaPong';
    const CHAVE_PEDIDO = 'faMapaPedido';
    const CHAVE_RESPOSTA = 'faMapaResposta';
    const CANAL = 'fa-mapa-camera';

    const CONFIG = {
      zoom: 19,
      largura: 1000,
      altura: 720,
      qualidade: 0.72,
      camadaClientes: 'Clientes ativos até 100 m da rede',
      camadaOS: 'Ordens de serviço',
      ocultarOutrasOS: true,
      fundo: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
      fundoZoomMax: 19
    };

    function paginaCamera(CANAL, CONFIG) {
      if (window.__faCameraMapa) return;
      window.__faCameraMapa = true;

      let indiceOS = null;
      let caixasMalha = null;
      let vistaOriginal = null;
      let camadasAlteradas = null;
      let temClientes = false;
      let prazoRestauracao = null;
      const cacheTiles = new Map();

      function caixaDaCamada(nome) {
        const linha = Array.from(document.querySelectorAll('#camadas label'))
          .find(rotulo => rotulo.textContent.trim().startsWith(nome));
        return linha ? linha.querySelector('input[type="checkbox"]') : null;
      }

      function prepararCamadas() {
        if (camadasAlteradas) return;
        camadasAlteradas = [];
        const ajustar = (nome, ligar) => {
          const caixa = caixaDaCamada(nome);
          if (!caixa) return false;
          if (caixa.checked !== ligar) {
            caixa.click();
            camadasAlteradas.push({ nome, original: !ligar });
          }
          return caixa.checked === ligar;
        };

        temClientes = ajustar(CONFIG.camadaClientes, true);

        if (CONFIG.ocultarOutrasOS) ajustar(CONFIG.camadaOS, false);
      }

      function restaurarCamadas() {
        (camadasAlteradas || []).slice().reverse().forEach(({ nome, original }) => {
          const caixa = caixaDaCamada(nome);
          if (caixa && caixa.checked !== original) caixa.click();
        });
        camadasAlteradas = null;
      }

      function agendarRestauracao() {
        clearTimeout(prazoRestauracao);
        prazoRestauracao = setTimeout(restaurarTudo, 90000);
      }

      const mapaPronto = () => window.__MAPA_PRONTO__ === true &&
        !!(window.L && window.__sond && window.__sond.mapa && window.__D && window.__D.DADOS);
      const chaveOS = valor => String(valor == null ? '' : valor).replace(/\D/g, '').replace(/^0+/, '');
      const vazio = valor => valor === null || valor === undefined || String(valor).trim() === '';

      function estado() {
        const meta = (window.__D && window.__D.META) || {};
        return {
          pronto: mapaPronto(),
          geradoEm: meta.gerado_em || '',
          totalOS: mapaPronto() ? window.__D.DADOS.linhas.length : 0
        };
      }

      function localizar(os) {
        const dados = window.__D.DADOS;
        if (!indiceOS) {
          const coluna = dados.colunas.indexOf('Numero OS');
          indiceOS = new Map();
          dados.linhas.forEach((linha, i) => {
            const chave = chaveOS(linha[coluna]);
            if (chave && !indiceOS.has(chave)) indiceOS.set(chave, i);
          });
        }
        const i = indiceOS.get(chaveOS(os));
        if (i === undefined) return null;
        const linha = dados.linhas[i];
        const campo = nome => { const j = dados.colunas.indexOf(nome); return j < 0 ? '' : linha[j]; };
        const lat = Number(linha[dados.idx.lat]);
        const lon = Number(linha[dados.idx.lon]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return {
          lat, lon,
          os: String(campo('Numero OS')),
          endereco: campo('Endereço'),
          bairro: campo('BAIRRO_GEO'),
          municipio: campo('MUNICIPIO_GEO'),
          situacao: campo('Situação'),
          distRede: campo('DIST_REDE_AGUA_M')
        };
      }

      async function carregarTile(url) {
        if (cacheTiles.has(url)) return cacheTiles.get(url);
        const promessa = (async () => {
          const controle = new AbortController();
          const prazo = setTimeout(() => controle.abort(), 12000);
          try {
            const resposta = await fetch(url, { mode: 'cors', credentials: 'omit', signal: controle.signal });
            if (!resposta.ok) throw new Error('HTTP ' + resposta.status);
            return await createImageBitmap(await resposta.blob());
          } finally {
            clearTimeout(prazo);
          }
        })().catch(() => null);
        cacheTiles.set(url, promessa);
        promessa.then(imagem => { if (!imagem) cacheTiles.delete(url); });
        if (cacheTiles.size > 400) cacheTiles.delete(cacheTiles.keys().next().value);
        return promessa;
      }

      function fundosCandidatos(mapa) {
        const lista = [];
        mapa.eachLayer(camada => {
          if (camada instanceof window.L.TileLayer && camada._url) {
            lista.push({
              url: camada._url,
              sub: camada.options.subdomains || 'abc',
              zmax: camada.options.maxNativeZoom || camada.options.maxZoom || 19
            });
          }
        });
        if (!lista.some(f => f.url === CONFIG.fundo)) {
          lista.push({ url: CONFIG.fundo, sub: 'abc', zmax: CONFIG.fundoZoomMax });
        }
        return lista;
      }

      async function baixarFundo(fundo, zt, origem, largura, altura, zoom) {
        const lado = 256 * Math.pow(2, zoom - zt);
        const n = Math.pow(2, zt);
        const tarefas = [];
        for (let ty = Math.floor(origem.y / lado); ty <= Math.floor((origem.y + altura) / lado); ty++) {
          if (ty < 0 || ty >= n) continue;
          for (let tx = Math.floor(origem.x / lado); tx <= Math.floor((origem.x + largura) / lado); tx++) {
            const x = ((tx % n) + n) % n;
            const sub = fundo.sub[(x + ty) % fundo.sub.length];
            const url = fundo.url.replace('{z}', zt).replace('{x}', x).replace('{y}', ty)
              .replace('{s}', sub).replace('{r}', '');
            tarefas.push(carregarTile(url).then(imagem => ({ imagem, dx: tx * lado - origem.x, dy: ty * lado - origem.y, lado })));
          }
        }
        const tiles = await Promise.all(tarefas);
        return { tiles, ok: tiles.filter(t => t.imagem).length, total: tiles.length };
      }

      function desenharMalha(ctx, mapa, origem, largura, altura, zoom) {
        const malha = window.__D.MALHA;
        if (!malha || !Array.isArray(malha.trechos)) return false;
        if (!caixasMalha) {
          caixasMalha = new Float32Array(malha.trechos.length * 4);
          malha.trechos.forEach((trecho, i) => {
            let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
            for (const c of trecho[0]) {
              if (c[0] < x1) x1 = c[0];
              if (c[0] > x2) x2 = c[0];
              if (c[1] < y1) y1 = c[1];
              if (c[1] > y2) y2 = c[1];
            }
            caixasMalha.set([x1, y1, x2, y2], i * 4);
          });
        }
        const a = mapa.unproject([origem.x, origem.y + altura], zoom);
        const b = mapa.unproject([origem.x + largura, origem.y], zoom);
        const folga = 0.0005;
        const oeste = a.lng - folga, sul = a.lat - folga, leste = b.lng + folga, norte = b.lat + folga;
        ctx.beginPath();
        for (let i = 0; i < malha.trechos.length; i++) {
          const k = i * 4;
          if (caixasMalha[k] > leste || caixasMalha[k + 2] < oeste || caixasMalha[k + 1] > norte || caixasMalha[k + 3] < sul) continue;
          const coords = malha.trechos[i][0];
          for (let j = 0; j < coords.length; j++) {
            const p = mapa.project([coords[j][1], coords[j][0]], zoom);
            if (j === 0) ctx.moveTo(p.x - origem.x, p.y - origem.y);
            else ctx.lineTo(p.x - origem.x, p.y - origem.y);
          }
        }

        const metrosPorPixel = 156543.03 * Math.cos(a.lat * Math.PI / 180) / Math.pow(2, zoom);
        const espessura = Math.max(7, 6 / metrosPorPixel);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#c3ccd1';
        ctx.lineWidth = espessura;
        ctx.stroke();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = espessura * 0.72;
        ctx.stroke();
        return true;
      }

      function redesenharAgora(mapa) {
        Object.keys(mapa._layers || {}).forEach(id => {
          const camada = mapa._layers[id];
          if (camada && camada._ctx && typeof camada._redraw === 'function' &&
              camada._container && camada._container.tagName === 'CANVAS') {
            try { camada._redrawBounds = null; camada._redraw(); } catch (erro) {  }
          }
        });
      }

      function desenharCamadas(ctx, mapa, x0, y0) {
        const caixa = mapa.getContainer();
        const base = caixa.getBoundingClientRect();
        const ordem = canvas => {
          const painel = canvas.closest('.leaflet-pane:not(.leaflet-map-pane)');
          return painel ? (parseInt(getComputedStyle(painel).zIndex, 10) || 0) : 0;
        };
        Array.from(caixa.querySelectorAll('canvas'))
          .filter(canvas => canvas.width && canvas.height && !canvas.classList.contains('maplibregl-canvas'))
          .map((canvas, i) => ({ canvas, i, z: ordem(canvas) }))
          .sort((p, q) => p.z - q.z || p.i - q.i)
          .forEach(({ canvas }) => {
            const r = canvas.getBoundingClientRect();
            if (!r.width || !r.height) return;
            try { ctx.drawImage(canvas, r.left - base.left - x0, r.top - base.top - y0, r.width, r.height); }
            catch (erro) {  }
          });
      }

      function desenharDestaque(ctx, x, y, alvo) {
        ctx.save();

        const cores = { 'Postergada': '#d32f2f', 'Concluída': '#1a9850', 'Cancelada': '#9e9e9e' };
        ctx.beginPath(); ctx.arc(x, y, 6.5, 0, Math.PI * 2);
        ctx.fillStyle = cores[alvo.situacao] || '#111111';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        ctx.lineWidth = 7;
        ctx.strokeStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(x, y, 17, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = '#e6007e';
        ctx.beginPath(); ctx.arc(x, y, 17, 0, Math.PI * 2); ctx.stroke();

        const texto = 'OS ' + alvo.os;
        ctx.font = 'bold 15px Arial, Helvetica, sans-serif';
        const largura = ctx.measureText(texto).width + 16;
        const cx = x - largura / 2, cy = y - 17 - 12 - 24;
        ctx.fillStyle = '#e6007e';
        ctx.beginPath();
        ctx.rect(cx, cy, largura, 24);
        ctx.moveTo(x - 7, cy + 24); ctx.lineTo(x, cy + 33); ctx.lineTo(x + 7, cy + 24);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.textBaseline = 'middle';
        ctx.fillText(texto, cx + 8, cy + 12.5);
        ctx.restore();
      }

      function desenharRodape(ctx, largura, altura, alvo, geradoEm) {
        const partes = ['OS ' + alvo.os];
        if (!vazio(alvo.endereco)) partes.push(String(alvo.endereco).trim());
        const local = [alvo.bairro, alvo.municipio].filter(v => !vazio(v)).join(' / ');
        if (local) partes.push(local);
        const dist = Number(alvo.distRede);
        if (!vazio(alvo.distRede) && Number.isFinite(dist)) {
          partes.push('rede de água a ' + dist.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' m');
        }
        if (geradoEm) {
          const m = String(geradoEm).match(/^(\d{4})-(\d{2})-(\d{2})(.*)$/);
          partes.push('mapa gerado em ' + (m ? m[3] + '/' + m[2] + '/' + m[1] + m[4] : geradoEm));
        }
        ctx.save();
        ctx.font = '13px Arial, Helvetica, sans-serif';
        let texto = partes.join('  ·  ');
        while (texto.length > 20 && ctx.measureText(texto).width > largura - 20) texto = texto.slice(0, -2);
        if (texto !== partes.join('  ·  ')) texto += '…';
        ctx.fillStyle = 'rgba(255,255,255,.93)';
        ctx.fillRect(0, altura - 26, largura, 26);
        ctx.fillStyle = '#1d2a30';
        ctx.textBaseline = 'middle';
        ctx.fillText(texto, 10, altura - 12.5);
        ctx.restore();
      }

      async function capturar(os) {
        if (!mapaPronto()) return { ok: false, codigo: 'carregando', motivo: 'O mapa ainda está carregando' };
        const alvo = localizar(os);
        if (!alvo) return { ok: false, codigo: 'nao-encontrada', motivo: 'O.S. não encontrada no mapa' };

        const mapa = window.__sond.mapa;
        if (!vistaOriginal) vistaOriginal = { centro: mapa.getCenter(), zoom: mapa.getZoom() };
        prepararCamadas();
        agendarRestauracao();
        const zoom = Math.min(CONFIG.zoom, mapa.getMaxZoom() || CONFIG.zoom);
        mapa.setView([alvo.lat, alvo.lon], zoom, { animate: false });
        redesenharAgora(mapa);

        const tamanho = mapa.getSize();
        const largura = Math.max(320, Math.min(CONFIG.largura, tamanho.x));
        const altura = Math.max(240, Math.min(CONFIG.altura, tamanho.y));
        const ponto = mapa.latLngToContainerPoint([alvo.lat, alvo.lon]);
        const x0 = Math.round(ponto.x - largura / 2);
        const y0 = Math.round(ponto.y - altura / 2);
        const global = mapa.project([alvo.lat, alvo.lon], zoom);
        const origem = { x: Math.round(global.x - largura / 2), y: Math.round(global.y - altura / 2) };

        const escala = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
        const tela = document.createElement('canvas');
        tela.width = Math.round(largura * escala);
        tela.height = Math.round(altura * escala);
        const ctx = tela.getContext('2d');
        ctx.scale(escala, escala);
        ctx.fillStyle = '#eef1f2';
        ctx.fillRect(0, 0, largura, altura);

        let fundoUsado = 'nenhum';
        for (const fundo of fundosCandidatos(mapa)) {

          const niveis = [Math.min(zoom, fundo.zmax)];
          if (niveis[0] > 17) niveis.push(17);
          for (const zt of niveis) {
            const baixado = await baixarFundo(fundo, zt, origem, largura, altura, zoom);
            if (baixado.total && baixado.ok >= baixado.total * 0.6) {
              baixado.tiles.forEach(t => { if (t.imagem) ctx.drawImage(t.imagem, t.dx, t.dy, t.lado, t.lado); });
              fundoUsado = 'imagem';
              break;
            }
          }
          if (fundoUsado === 'imagem') break;
        }
        if (fundoUsado === 'nenhum' && desenharMalha(ctx, mapa, origem, largura, altura, zoom)) fundoUsado = 'malha';

        mapa.setView([alvo.lat, alvo.lon], zoom, { animate: false });
        redesenharAgora(mapa);
        desenharCamadas(ctx, mapa, x0, y0);
        desenharDestaque(ctx, largura / 2, altura / 2, alvo);
        desenharRodape(ctx, largura, altura, alvo, estado().geradoEm);

        let dataUrl = '';
        try { dataUrl = tela.toDataURL('image/jpeg', CONFIG.qualidade); }
        catch (erro) { return { ok: false, motivo: 'O navegador bloqueou a leitura da imagem do mapa' }; }
        return { ok: true, dataUrl, fundo: fundoUsado, clientes: temClientes, largura: tela.width, altura: tela.height };
      }

      function restaurarTudo() {
        clearTimeout(prazoRestauracao);
        if (!mapaPronto()) return;
        const mapa = window.__sond.mapa;
        restaurarCamadas();
        if (vistaOriginal) mapa.setView(vistaOriginal.centro, vistaOriginal.zoom, { animate: false });
        vistaOriginal = null;
        redesenharAgora(mapa);
      }

      let fila = Promise.resolve();
      window.addEventListener('message', evento => {
        const msg = evento.data;
        if (evento.source !== window || !msg || msg.canal !== CANAL || msg.de !== 'script') return;
        const responder = corpo => window.postMessage(Object.assign({ canal: CANAL, de: 'pagina', ref: msg.ref }, corpo), '*');
        if (msg.tipo === 'estado') { responder({ tipo: 'estado', estado: estado() }); return; }
        if (msg.tipo === 'fim') { fila = fila.then(restaurarTudo).catch(() => {}); return; }
        if (msg.tipo === 'capturar') {
          fila = fila.then(() => capturar(msg.os))
            .catch(erro => ({ ok: false, motivo: 'Falha na captura: ' + (erro && erro.message ? erro.message : erro) }))
            .then(resultado => responder({ tipo: 'captura', resultado }));
        }
      });
      window.postMessage({ canal: CANAL, de: 'pagina', tipo: 'camera-pronta' }, '*');
    }

    function iniciarCamera() {
      const ehMapa = () => document.getElementById('mapa') &&
        (document.getElementById('__blobs') || document.getElementById('__app'));
      if (!ehMapa()) return false;

      const camId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      let selo = null;
      let capturas = 0;
      const rotular = texto => {
        if (!selo) {
          selo = document.createElement('div');
          Object.assign(selo.style, {
            position: 'fixed', left: '12px', bottom: '56px', zIndex: '99999', padding: '6px 10px',
            background: '#14323a', color: '#e8f6f8', font: '12px Arial, sans-serif', borderRadius: '6px',
            boxShadow: '0 2px 8px rgba(0,0,0,.3)', pointerEvents: 'none'
          });
          document.body.appendChild(selo);
        }
        selo.textContent = '📷 Câmera da auditoria: ' + texto;
      };

      const codigo = document.createElement('script');
      codigo.textContent = '(' + paginaCamera.toString() + ')(' + JSON.stringify(CANAL) + ',' + JSON.stringify(CONFIG) + ');';
      (document.head || document.documentElement).appendChild(codigo);
      codigo.remove();

      const pendentes = new Map();
      let contador = 0;
      const perguntar = corpo => new Promise(resolve => {
        const ref = 'r' + (++contador);
        pendentes.set(ref, resolve);
        window.postMessage(Object.assign({ canal: CANAL, de: 'script', ref }, corpo), '*');
      });
      window.addEventListener('message', evento => {
        const msg = evento.data;
        if (!msg || msg.canal !== CANAL || msg.de !== 'pagina' || !pendentes.has(msg.ref)) return;
        const resolver = pendentes.get(msg.ref);
        pendentes.delete(msg.ref);
        resolver(msg);
      });

      let tentativas = 0;
      const conferirPronto = async () => {
        const resposta = await perguntar({ tipo: 'estado' });
        if (resposta.estado && resposta.estado.pronto) { if (!selo) rotular('conectada'); return; }
        if (++tentativas < 300) setTimeout(conferirPronto, 2000);
      };
      conferirPronto();

      GM_addValueChangeListener(CHAVE_PING, async (nome, antigo, novo) => {
        if (!novo || !novo.id) return;
        const resposta = await perguntar({ tipo: 'estado' });
        const estado = resposta.estado || { pronto: false };
        const responder = () => GM_setValue(CHAVE_PONG, Object.assign({ id: novo.id, cam: camId, t: Date.now() }, estado));

        if (estado.pronto) responder(); else setTimeout(responder, 600);
      });
      GM_addValueChangeListener(CHAVE_PEDIDO, async (nome, antigo, novo) => {
        if (!novo || !novo.id || novo.para !== camId) return;
        if (novo.tipo === 'fim') {
          window.postMessage({ canal: CANAL, de: 'script', tipo: 'fim' }, '*');
          rotular(capturas + ' imagem(ns) enviada(s)');
          return;
        }
        rotular('capturando O.S. ' + novo.os);
        const resposta = await perguntar({ tipo: 'capturar', os: novo.os });
        const resultado = resposta.resultado || { ok: false, motivo: 'Sem resposta do mapa' };
        if (resultado.ok) capturas++;
        GM_setValue(CHAVE_RESPOSTA, Object.assign({ id: novo.id, cam: camId, seq: novo.seq, os: novo.os, t: Date.now() }, resultado));
        rotular(capturas + ' imagem(ns) enviada(s)');
      });
      return true;
    }

    const cliente = (function () {
      const sessao = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const espera = new Map();
      let seq = 0;
      let ouvindo = false;
      let camAlvo = null;
      let aoReceberPong = null;

      function ouvir() {
        if (ouvindo) return;
        ouvindo = true;
        GM_addValueChangeListener(CHAVE_PONG, (nome, antigo, novo) => {
          if (novo && novo.id === sessao && aoReceberPong) aoReceberPong(novo);
        });
        GM_addValueChangeListener(CHAVE_RESPOSTA, (nome, antigo, novo) => {

          if (!novo || novo.id !== sessao || novo.cam !== camAlvo) return;
          const resolver = espera.get('seq' + novo.seq);
          if (!resolver) return;
          espera.delete('seq' + novo.seq);
          resolver(novo);
        });
      }

      function verificar(prazoMs = 3000) {
        ouvir();
        camAlvo = null;
        return new Promise(resolve => {
          let naoPronta = null;
          const concluir = valor => { clearTimeout(prazo); aoReceberPong = null; resolve(valor); };
          const prazo = setTimeout(() => concluir(naoPronta), prazoMs);
          aoReceberPong = pong => {
            if (pong.pronto) { camAlvo = pong.cam; concluir(pong); }
            else if (!naoPronta) naoPronta = pong;
          };
          GM_setValue(CHAVE_PING, { id: sessao, t: Date.now() });
        });
      }

      async function capturar(os, prazoMs = 25000) {
        ouvir();
        const numero = ++seq;
        const promessa = new Promise(resolve => {
          const prazo = setTimeout(() => { espera.delete('seq' + numero); resolve(null); }, prazoMs);
          espera.set('seq' + numero, valor => { clearTimeout(prazo); resolve(valor); });
        });
        GM_setValue(CHAVE_PEDIDO, { id: sessao, para: camAlvo, seq: numero, os: String(os), t: Date.now() });
        const resposta = await promessa;
        return resposta || { ok: false, codigo: 'sem-resposta', motivo: 'o mapa não respondeu a tempo' };
      }

      function encerrar() {
        GM_setValue(CHAVE_PEDIDO, { id: sessao, para: camAlvo, tipo: 'fim', t: Date.now() });

        setTimeout(() => GM_setValue(CHAVE_RESPOSTA, { id: '', t: Date.now() }), 500);
      }

      return { verificar, capturar, encerrar };
    })();

    return { iniciarCamera, cliente, CONFIG, paginaCamera, CANAL };
  })();

  if (location.protocol === 'file:') {
    MAPA_AUTO.iniciarCamera();
    return;
  }

  const LOGO_DATA_URL = '';

  const AUDITORIA_INSTANCE_KEY = '__AUDITORIA_OS_CCO_ACTIVE__';
  const AUDITORIA_VERSION = '7.1.1';

  if (window[AUDITORIA_INSTANCE_KEY]) {
    console.warn(
      `[AUDITORIA OPERACIONAL] Execucao duplicada bloqueada. ` +
      `Versao ativa: ${window[AUDITORIA_INSTANCE_KEY]}.`
    );
    return;
  }

  window[AUDITORIA_INSTANCE_KEY] = AUDITORIA_VERSION;

  console.log('[AUDITORIA OPERACIONAL] Auditoria de OS carregada. Use Ctrl+Enter.');

  const baseUrls = [
    location.origin + "/index.php?m=attribute&a=thumbnail&sentity=1&eid=0&attr_id=320",
    location.origin + "/index.php?m=attribute&a=thumbnail&sentity=1&eid=0&attr_id=321",
    location.origin + "/index.php?m=attribute&a=thumbnail&sentity=1&eid=0&attr_id=322",
    location.origin + "/index.php?m=attribute&a=thumbnail&sentity=1&eid=0&attr_id=323",
    location.origin + "/index.php?m=attribute&a=thumbnail&sentity=1&eid=0&attr_id=324",
    location.origin + "/index.php?m=attribute&a=thumbnail&sentity=1&eid=0&attr_id=1380",
    location.origin + "/index.php?m=attribute&a=thumbnail&sentity=1&eid=0&attr_id=1381",
    location.origin + "/index.php?m=attribute&a=thumbnail&sentity=1&eid=0&attr_id=1382",
    location.origin + "/index.php?m=attribute&a=thumbnail&sentity=1&eid=0&attr_id=1383",
    location.origin + "/index.php?m=attribute&a=thumbnail&sentity=1&eid=0&attr_id=1384",
    location.origin + "/index.php?m=attribute&a=thumbnail&sentity=1&eid=0&attr_id=1385"
  ];

  const FIELD_INCLUIR_ADICIONAIS = "1058";
  const FIELD_LIGACAO_NOVA       = "1060";
  const FIELD_NUMERO_OS_FIELD    = "1766";
  const FIELD_TIPO_PAVIMENTO     = "1683";
  const FIELD_EXTENSAO_VALA      = "1530";
  const FIELD_MATERIAL_RAMAL     = "1531";
  const FIELD_DIAMETRO_RAMAL     = "1532";
  const FIELD_MATERIAL_REDE      = "1534";
  const FIELD_PROFUNDIDADE_VALA  = "1537";
  const FIELD_TIPO_LIGACAO       = "1721";
  const FIELD_QUANTIDADE_RAMAIS  = "1764";
  const FIELD_DC_ASFALTO_VIA_LOCAL = "1109";
  const FIELD_DC_LAJOTA_VIA_LOCAL = "1110";
  const FIELD_DC_CALCADA_VIA_LOCAL = "1111";
  const FIELD_DC_CALCADA_VIA_ARTERIAL = "1112";
  const FIELD_DC_ASFALTO_VIA_ARTERIAL = "1113";
  const FIELD_DC_LAJOTA_VIA_ARTERIAL = "1317";
  const FIELD_HIDROMETRO = "992";
  const FIELD_QUANTIDADE_POSTERIORES = "1062";
  const FIELD_SERVICO_POSTERIOR    = "1066";

  const EQUIPE_SETOR_MAP = {
    "SER468T": "Manutencao",
    "SER077T": "Multidisciplinar",
    "SER795T": "Reaterro",
    "SER318T": "Manutencao",
    "SER393T": "Multidisciplinar",
    "SER068T": "Manutencao",
    "SER593T": "Fiscal de Obras",
    "SER739T": "Volante Diurno",
    "SER724T": "Volante Diurno",
    "SER053T": "Manutencao",
    "SER380T": "Multidisciplinar",
    "SER461T": "Manutencao",
    "SER201T": "Manutencao",
    "SER179T": "Manutencao",
    "SER794T": "Reaterro",
    "SER102T": "Manutencao",
    "SER051T": "Manutencao",
    "SER729T": "Manutencao",
    "SER294T": "Volante Diurno",
    "SER727T": "Reaterro",
    "SER058T": "Volante Diurno",
    "SER050T": "Manutencao",
    "SER577T": "Volante Diurno",
    "SER594T": "Manutencao",
    "SER535T": "Manutencao",
    "SER178T": "Volante Diurno",
    "SER574T": "Volante Diurno",
    "SER797T": "Reaterro",
    "SER539T": "Manutencao",
    "SER559T": "Reaterro",
    "SER406T": "Manutencao",
    "SER419T": "Manutencao",
    "SER740T": "Manutencao",
    "SER387T": "Pesquisa de vazamento",
    "SER303T": "Reaterro",
    "SER581T": "Pesquisa de vazamento",
    "SER250T": "Volante Diurno",
    "SER391T": "Manutencao",
    "SER407T": "Manutencao",
    "SER527T": "Volante Diurno",
    "SER415T": "Manutencao",
    "SER778T": "Manutencao",
    "SER254T": "Pesquisa de vazamento",
    "SER104T": "Fiscal de Obras",
    "SER796T": "Manutencao",
    "SER083T": "Pesquisa de vazamento",
    "SER152T": "Manutencao",
    "SER182T": "Manutencao",
    "SER092T": "Pesquisa de vazamento",
    "SER381T": "Pesquisa de vazamento",
    "SER304T": "Pesquisa de vazamento",
    "SER721T": "Volante Diurno",
    "SER705T": "Pitometria",
    "SER595T": "Volante Diurno",
    "SER187T": "Pitometria",
    "SER725T": "Solda",
    "SER423T": "Volante Noturno",
    "SER087T": "Volante Noturno",
    "SER069T": "Volante Noturno",
    "SER573T": "Pesquisa de vazamento",
    "SER462T": "Manutencao",
    "SER385T": "Pesquisa de vazamento",
    "SER049T": "Manutencao",
    "SER498T": "Repavimentacao",
    "SER238T": "Pitometria",
    "SER098T": "Multidisciplinar",
    "SER464T": "Reaterro",
    "SER388T": "Pesquisa de vazamento",
    "SER044T": "Pesquisa de vazamento",
    "SER110T": "Volante Diurno",
    "SER097T": "Volante Diurno",
    "SER467T": "Reaterro",
    "SER392T": "Manutencao",
    "SER580T": "Pesquisa de vazamento",
    "SER066T": "Manutencao",
    "SER459T": "Manutencao",
    "SER074T": "Pesquisa de vazamento",
    "SER389T": "Manutencao",
    "SER057T": "Volante Diurno",
    "SER730T": "Pitometria",
    "SER850T": "Manutencao",
    "SER851T": "Manutencao",
    "SER819T": "Volante Diurno"
};

  const CODIGOS_MANUTENCAO_PARAMETRIZADOS = new Set([
    "613711",
    "613706",
    "612514",
    "612510",
    "612503",
    "612502",
    "612501",
    "612423",
    "612419",
    "612417",
    "612416",
    "612407",
    "612406",
    "612404",
    "612402",
    "612401",
    "811314",
    "811313",
    "811308",
    "811307",
    "811305",
    "811304",
    "811303",
    "811302",
    "811301",
    "611403",
    "611402",
    "611401",
    "712647",
    "712646",
    "712633",
    "712632",
    "712614",
    "712613",
    "712612",
    "712608",
    "712607",
    "712606",
    "712605",
    "712602"
  ]);

  const CODIGOS_SE_LIGA = new Set([
    "310815",
    "410212",
    "410213",
    "511735",
    "511971",
    "511972",
    "511973",
    "511974",
    "512203",
    "610811",
    "612473",
    "612474",
    "612475",
    "612519",
    "612520",
    "612713",
    "612715",
    "613815",
    "622299",
    "632221",
    "910803",
    "910804"
  ]);

  const POSTERIORES_MANUTENCAO_AUTORIZADOS = [
    "613288",
    "613287",
    "613286",
    "613285",
    "613266",
    "613265",
    "613284",
    "613279",
    "613278",
    "613275",
    "613274",
    "613271"
  ];

  const POSTERIORES_SE_LIGA_AUTORIZADOS = [
    "613290",
    "613291",
    "613292",
    "613293"
  ];

  const DESCRICOES_SERVICOS = {
    "310401": "CADASTRO DE ATIVAÇÃO DE LIGAÇÃO DE ÁGUA",
    "310801": "SENSIBILIZAÇÃO SOCIAL LIGAÇÃO DE ÁGUA",
    "310803": "RECLAMAÇÃO DE RECOMPOSIÇÃO DE PAV. - CAPEX ÁGUA",
    "310804": "RECLAMAÇÃO DE RECOMPOSIÇÃO DE PAV. - CAPEX ÁGUA - LOG",
    "310805": "VERIFICAÇÃO DE QUALIDADE DO SERVIÇO - CAPEX ÁGUA",
    "310806": "INSTALAÇÃO DE RAMAL DE ESPERA DE ÁGUA",
    "310815": "SE LIGA - FISCALIZAÃÃO DE OBRA",
    "310902": "SENSIBILIZAÇÃO SOCIAL LIGAÇÃO DE ESGOTO",
    "310903": "VISTORIA TÉCNICA - LIGAÇÃO DE ESGOTO",
    "310905": "RECLAMAÇÃO DE RECOMPOSIÇÃO DE PAV. - CAPEX ESGOTO",
    "310906": "RECLAMAÇÃO DE RECOMPOSIÇÃO DE PAV. - CAPEX ESGOTO - LOG",
    "310909": "SENSIBILIZAÇÃO SOCIAL ESGOTO - PRÉ OBRA",
    "310910": "SENSIBILIZAÇÃO SOCIAL ESGOTO - PÓS OBRA",
    "310911": "INSTALAÇÃO DE LIGAÇÃO DE ESGOTO - CAPEX",
    "310912": "RESSERVIÇO LIGAÇÃO DE ESGOTO - CAPEX",
    "311215": "VISTORIA TÉCNICA - REDE DE ÁGUA",
    "311216": "VISTORIA TÉCNICA - REDE DE ESGOTO",
    "410201": "VISITA DE CAPTAÇÃO DE CLIENTES",
    "410203": "VISITA DE CAPTAÇÃO DE CLIENTES - LOG",
    "410204": "VISITA DE CAPTAÇÃO DE CLIENTES - AUSENTE (LOG)",
    "410205": "VISITA DE CAPTAÇÃO DE CLIENTES - AUSENTE (U.C)",
    "410212": "SE LIGA - VISITA DE CAPTAÇÃO DE CLIENTES - LOG",
    "410213": "SE LIGA - VISITA DE CAPTAÇÃO DE CLIENTES - U.C",
    "410501": "RECADASTRAMENTO",
    "410502": "VERIFICAÇÃO DE CATEGORIA/ECONOMIA",
    "410503": "VERIFICAÇÃO DE DADOS DA LIGAÇÃO",
    "410504": "VERIFICAÇÃO DE ENDEREÇO",
    "410505": "VISTORIA DE SUSPENSÃO/SUPRESSÃO A PEDIDO DO CLIENTE",
    "410514": "VERIFICAÇÃO DE CATEGORIA/ECONOMIA - INTERESSE DA EMPRESA",
    "411601": "VERIFICAÇÃO DE EXCESSO DE CONSUMO - A PEDIDO DO CLIENTE",
    "411602": "VERIFICAÇÃO DE EXCESSO DE CONSUMO - INTERESSE DA EMPRESA",
    "411603": "VERIFICAÇÃO DE EXCESSO DE CONSUMO - PROCON/JURÍDICO",
    "411702": "NOTIFICAÇÃO PARA REGULARIZAÇÃO",
    "411706": "VERIFICAÇÃO DE LEITURA",
    "412101": "CONFIRMAÇÃO DE LEITURA",
    "412102": "REPASSE DA CRÍTICA DE LEITURA",
    "412103": "CONFIRMAÇÃO DE LEITURA A PEDIDO DO CLIENTE",
    "412104": "ENTREGA DE FATURA NO IMÓVEL",
    "413301": "VERIFICAÇÃO PARA TARIFA SOCIAL",
    "413303": "VISITA DE ISENÇÃO",
    "413515": "RETORNO AO CLIENTE - ISENÇÃO DE TARIFA",
    "421530": "RATEIO ÁGUA CONDOMÍNIO",
    "510601": "VIABILIDADE TÉCNICA DE LIGAÇÃO DE ÁGUA",
    "510604": "VIABILIDADE TÉCNICA PARA AMPLIAÇÃO DE REDE DE ÁGUA",
    "510605": "VIABILIDADE TÉCNICA DE LIGAÇÃO DE ESGOTO",
    "510608": "VIABILIDADE TÉCNICA PARA AMPLIAÇÃO DE REDE DE ESGOTO",
    "510609": "VIABILIDADE TÉCNICA - REMANEJAMENTO DE LIGAÇÃO DE ÁGUA",
    "510610": "VISTORIA DE PADRONIZAÇÃO DE LIGAÇÃO DE ÁGUA",
    "510614": "VERIFICAÇÃO DE INTERLIGAÇÃO DE LIGAÇÃO - ESGOTO",
    "510618": "VISTORIA TÉCNICA - MEDIÇÃO INDIVIDUALIZADA",
    "510619": "VIABILIDADE TÉCNICA DE LIGAÇÃO PROVISÓRIA DE ÁGUA C.C",
    "510620": "LEVANTAMENTO TOPOGRÁFICO",
    "510621": "VISTORIA DO ABRIGO PADRÃO",
    "510624": "VIABILIDADE TÉCNICA PARA AMPLIAÇÃO DE REDE DE ÁGUA C.C",
    "511601": "VERIFICAÇÃO DE VAZAMENTO INTERNO CONSERTADO",
    "511602": "VERIFICAÇÃO DE CONSUMO ZERO",
    "511603": "VERIFICAÇÃO DE CONSUMO BAIXO",
    "511701": "INSTALAÇÃO DE LACRES NO CAVALETE",
    "511702": "FISCALIZAÇÃO COM PERÍCIA",
    "511703": "FISCALIZAÇÃO DE LIGAÇÃO DE ÁGUA - INATIVA",
    "511704": "FISCALIZAÇÃO DE LIGAÇÃO DE ÁGUA - ATIVA",
    "511705": "FISCALIZAÇÃO DE LIGAÇÃO DE ÁGUA - DENÚNCIA",
    "511706": "FISCALIZAÇÃO DE LIGAÇÃO DE ÁGUA - DENÚNCIA LOG",
    "511707": "VISTORIA DE LIGAÇÃO",
    "511708": "FISCALIZAÇÃO DE LIGAÇÃO DE ÁGUA - PROCON/JURÍDICO",
    "511711": "RETIRADA DE BY PASS",
    "511712": "FISC - REGISTRO DE BOLETIM DE OCORRÊNCIA",
    "511714": "FISCALIZAÇÃO DE LIGAÇÃO DE ÁGUA - SUSPENSA CAVALETE",
    "511715": "FISCALIZAÇÃO DE LIGAÇÃO DE ÁGUA - SUSPENSA RAMAL",
    "511719": "FISCALIZAÇÃO DE LIGAÇÃO DE ÁGUA - AUTODENÚNCIA",
    "511720": "FISCALIZAÇÃO DE LIGAÇÃO DE ÁGUA - CAPTAÇÃO",
    "511721": "DENÚNCIA COLABORADOR",
    "511722": "FISCALIZAÇÃO EXPLORATÓRIA MODELO DE FRAUDES",
    "511723": "DENÚNCIA COLABORADOR - LOG",
    "511727": "ACOMPANHAMENTO DE PERÍCIA JUDICIAL",
    "511728": "FISCALIZAÇÃO RONDA FONTE ALTERNATIVA - LOG",
    "511735": "SE LIGA - FISCALIZAÇÃO E LIGAÇÃO DE ÁGUA - DENÚNCIA",
    "511801": "FISCALIZAÇÃO DE LIGAÇÃO DE ESGOTO",
    "511804": "FISCALIZAÇÃO DE LIGAÇÃO DE ESGOTO - PROCON/JURÍDICO",
    "511901": "AFERIÇÃO DE HIDRÔMETRO",
    "511902": "SUBSTITUIÇAO DE HIDRÔMETRO - FURTO",
    "511903": "SUBSTITUIÇÃO DE HIDRÔMETRO - VIOLADO",
    "511904": "SUBSTITUIÇÃO DE HIDRÔMETRO - DANIFICADO",
    "511905": "SUBSTITUIÇÃO DE HIDRÔMETRO - A PEDIDO DO CLIENTE",
    "511906": "SUBSTITUIÇÃO DE HIDRÔMETRO - CORRETIVA",
    "511907": "SUBSTITUIÇÃO DE HIDRÔMETRO - PREVENTIVA",
    "511908": "CORREÇÃO DE HIDRÔMETRO INVERTIDO",
    "511909": "INSTALAÇAO DE HIDRÔMETRO",
    "511910": "SUBSTITUIÇÃO DE HIDRÔMETRO - REDIMENSIONAMENTO",
    "511911": "VERIFICAÇÃO DE HIDRÔMETRO",
    "511912": "VERIFICAÇÃO DE HIDRÔMETRO A PEDIDO DO CLIENTE",
    "511913": "INSTALAÇÃO DE HIDRÔMETRO 1\"",
    "511914": "INSTALAÇÃO DE HIDRÔMETRO 1.1/2\"",
    "511915": "INSTALAÇÃO DE HIDRÔMETRO 2\"",
    "511916": "INSTALAÇÃO DE HIDRÔMETRO EM SÉRIE",
    "511917": "RETIRADA DE HIDRÔMETRO EM SÉRIE",
    "511949": "SUBSTITUIÇÃO DE HIDRÔMETRO - PROMO CAPT. CLIENTES",
    "511950": "INSTALAÇÃO DE HIDRÔMETRO - PROMO CAPT. CLIENTES",
    "511953": "VERIFICAÇÃO DE VÁLVULA DE MEDIDOR INTELIGENTE",
    "511955": "AFERIÇÃO DE HIDRÔMETRO - INDIVIDUALIZADA",
    "511959": "AFERIÇÃO DE HIDRÔMETRO MACRO MEDIDOR",
    "511960": "SUBSTITUIÇÃO DE HIDRÔMETRO - FURTO - COM QUEIXA",
    "511961": "SUBSTITUIÇAO DE HIDRÔMETRO - FURTO - SEM QUEIXA",
    "511970": "INSTALAÇÃO DE HIDRÔMETRO - 3/4",
    "511971": "SE LIGA - SUBSTITUIÇÃO DE HIDRÔMETRO - DANIFICADO",
    "511972": "SE LIGA - SUBSTITUIÇÃO DE HIDRÔMETRO - CORRETIVA",
    "511973": "SE LIGA - SUBSTITUIÇÃO DE HIDRÔMETRO - PREVENTIVA",
    "511974": "SE LIGA - SUBSTITUIÇÃO DE HIDRÔMETRO - VIOLADO",
    "512201": "VERIFICAÇÃO DE QUALIDADE DO SERVIÇO - LIGAÇÃO ÁGUA",
    "512203": "SE LIGA - VERIFICAÇÃO DE QUALIDADE DE LIGAÇÃO DE ÁGUA",
    "512301": "VERIFICAÇÃO DE QUALIDADE DO SERVIÇO - LIGAÇÃO ESGOTO",
    "512501": "VERIFICAÇÃO DE QUALIDADE DO SERVIÇO - MANUTENÇÃO CAVALETE",
    "512701": "VISTORIA DE PADRONIZAÇÃO DE LIGAÇÃO DE ÁGUA",
    "512801": "VERIFICAÇÃO DE QUALIDADE DO SERVIÇO - PADRONIZAÇÃO ESGOTO",
    "513001": "VERIFICAÇÃO DE QUALIDADE DO SERVIÇO - U.C.",
    "513201": "RECLAMAÇÃO DE RECOMPOSIÇÃO DE PAVIMENTO",
    "513202": "RECLAMAÇÃO DE RECOMPOSIÇÃO DE PAVIMENTO - LOG",
    "513206": "VERIFICAÇÃO DE RECOMPOSIÇÃO DE PAVIMENTO - OPEX ÁGUA",
    "513207": "VERIFICAÇÃO DE RECOMPOSIÇÃO DE PAVIMENTO - OPEX ESGOTO",
    "513208": "VERIFICAÇÃO DE RECOMPOSIÇÃO DE PAVIMENTO - CAPEX ÁGUA",
    "513209": "VERIFICAÇÃO DE RECOMPOSIÇÃO DE PAVIMENTO - CAPEX ESGOTO",
    "513210": "VERIFICAÇÃO DE RECOMPOSIÇÃO DE PAVIMENTO - OPEX ÁGUA - LOG",
    "513211": "VERIFICAÇÃO DE RECOMPOSIÇÃO DE PAVIMENTO - OPEX ESGOTO - LOG",
    "513212": "VERIFICAÇÃO DE RECOMPOSIÇÃO DE PAVIMENTO - CAPEX ÁGUA - LOG",
    "513213": "VERIFICAÇÃO DE RECOMPOSIÇÃO DE PAVIMENTO - CAPEX ESGOTO - LO",
    "513401": "RELIGAÇÃO CAVALETE - SUSPENSÃO A PEDIDO DO CLIENTE",
    "513402": "RELIGAÇÃO CAVALETE - SUSPENSÃO FALTA DE PAGAMENTO",
    "513403": "RELIGAÇÃO CAVALETE - SEM COBRANÇA",
    "513404": "RELIGAÇÃO CAVALETE - SUSPENSÃO POR INFRAÇÃO",
    "513405": "RELIGAÇÃO FITA",
    "513406": "VERIFICAÇÃO DE QUALIDADE DO SERVIÇO - RELIGAÇÃO",
    "513407": "RELIGAÇÃO CAVALETE - SOLICITAÇÃO PROCON/JURÍDICO",
    "513408": "RELIGAÇÃO CAVALETE - TARIFA MÍNIMA",
    "513409": "RELIGAÇÃO CAVALETE - ORDEM PODER CONCEDENTE",
    "513419": "RELIGAÇÃO CAVALETE INDIVIDUALIZADO - A PEDIDO DO CLIENTE",
    "513421": "RELIGAÇÃO CAVALETE SUSPENSÃO FALTA DE PAGAMENTO COMERCIAL",
    "513422": "RELIGAÇÃO CAVALETE - A PEDIDO DO CLIENTE - COMERCIAL",
    "513423": "RELIGAÇÃO CAVALETE SUSPENSÃO FALTA DE PAGAMENTO INDUSTRIAL",
    "513424": "RELIGAÇÃO CAVALETE - A PEDIDO DO CLIENTE - INDUSTRIAL",
    "513901": "SUSPENSÃO ABASTECIMENTO FITA",
    "513902": "SUSPENSÃO ABASTECIMENTO CAVALETE - POR FALTA DE PAGAMENTO",
    "513903": "SUSPENSÃO ABASTECIMENTO CAVALETE - A PEDIDO DO CLIENTE",
    "513904": "SUSPENSÃO ABASTECIMENTO CAVALETE - POR INFRAÇÃO",
    "513915": "SUSPENSÃO DO ABASTECIMENTO - RELIGAÇÃO COMPULSÓRIA",
    "513916": "SUSPENSÃO CAVALETE INDIVIDUALIZADO - A PEDIDO DO CLIENTE",
    "513917": "SUSPENSÃO ABASTECIMENTO CONDOMÍNIO - A PEDIDO DO CLIENTE",
    "514001": "VISTORIA DE LIGAÇÃO DE ESGOTO",
    "514002": "VISTORIA INTERNA DE LIGAÇÃO DE ESGOTO",
    "514003": "VISTORIA QUALITATIVA DE ESGOTO",
    "514004": "REVISTORIA QUALITATIVA DE ESGOTO",
    "610801": "AMPLIAÇÃO DE REDE DE ÁGUA - INTERESSE DA EMPRESA",
    "610802": "AMPLIAÇÃO DE REDE DE ÁGUA - SOLICITAÇÃO EXTERNA",
    "610803": "EXTENSÃO DE REDE DE ÁGUA - PROMO CAPT. CLIENTES",
    "610811": "SE LIGA - EXTENSÃO DE REDE DE ÁGUA",
    "611001": "SUBSTITUIÇÃO RAMAL DE ÁGUA",
    "611002": "INTERLIGAÇÃO REDE DE ÁGUA",
    "611003": "INSTALAÇÃO/RETIRADA DE REGISTRO DE MANOBRA",
    "611004": "INSTALAÇÃO/RETIRADA DE VÁLVULA REDUTORA DE PRESSÃO",
    "611005": "INSTALAÇÃO/RETIRADA DE MACROMEDIDOR",
    "611006": "REMANEJAMENTO REDE DE ÁGUA",
    "611007": "SUBSTITUIÇÃO REDE DE ÁGUA",
    "611008": "AMPLIAÇÃO DE REDE DE ÁGUA - INTERESSE DA EMPRESA",
    "611009": "AMPLIAÇÃO DE REDE DE ÁGUA - SOLICITAÇÃO EXTERNA",
    "611010": "AMPLIAÇÃO DE REDE DE ÁGUA - SOL. EXTERNA - COM RECOMPOSIÇÃO",
    "611011": "INSTALAÇÃO DE DESCARGA DE REDE",
    "611012": "SUBSTITUIÇÃO DE RAMAL DE ÁGUA - INTERESSE DA EMPRESA",
    "611013": "INSTALAÇÃO DE PONTO PITOMÉTRICO",
    "611014": "INSTALAÇÃO/RETIRADA DE VENTOSA",
    "611401": "VERIFICAÇÃO DE FALTA D ÁGUA - IMPREVISTA",
    "611402": "VERIFICAÇÃO DE PRESSÃO NO CAVALETE",
    "611403": "VERIFICAÃÃO DE FALTA DE ÃGUA - COMUNIDADE",
    "611701": "RETIRADA DE BY PASS",
    "611702": "SONDAGEM NO RAMAL DE ÁGUA - SUSPEITA DE IRREGULARIDADE",
    "611705": "SONDAGEM NO RAMAL DE ÁGUA - LOG - SUSPEITA DE IRREGULARIDADE",
    "611901": "INSTALAÇÃO DE HIDRÔMETRO EM POÇO",
    "611902": "INSTALAÇÃO DE MODULO DE TELEMETRIA ACOPLADO - U.C",
    "611903": "INSTALAÇÃO DE MODULO DE TELEMETRIA ACOPLADO - C.C",
    "611904": "INSTALAÇÃO DE MODULO DE TELEMETRIA CABEADO - U.C.",
    "611905": "INSTALAÇÃO DE MODULO DE TELEMETRIA CABEADO - C.C.",
    "611906": "INSTALAÇÃO DE SENSORES DE PRESSÃO IOT - LOG",
    "612101": "LEITURA (C.C)",
    "612201": "REDIMENSIONAMENTO DE LIGAÇÃO DE ÁGUA",
    "612202": "RELIGAÇÃO SUPRESSÃO",
    "612203": "RENOVAÇÃO DE LIGAÇÃO ATIVA",
    "612204": "REMANEJAMENTO DE RAMAL DE ÁGUA",
    "612205": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - PROVISÓRIA",
    "612206": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - PROVISÓRIA",
    "612207": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - TARIFA SOCIAL",
    "612208": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA",
    "612209": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - C/ ASFALTO OU PARAL.",
    "612210": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - 3/4\" OU 1\"",
    "612211": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - 1.1/2\" OU 2\"",
    "612212": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - PARCIAL",
    "612213": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - 1\"",
    "612214": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - 1.1/2\"",
    "612215": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - 2\"",
    "612216": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - 1\" C/ ASFALTO",
    "612217": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - 1.1/2\" C/ ASFALTO",
    "612218": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - 2\" C/ ASFALTO",
    "612219": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - RES. 3/4 OU 1/2",
    "612220": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - NÃO RES. 3/4 OU 1/2",
    "612221": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - IND - MURO 3/4",
    "612222": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - IND - PASSEIO 3/4",
    "612223": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - IND - CONVENCIONAL 3/4",
    "612224": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - RES/PUB - MURO 3/4",
    "612225": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - RES/PUB - PASSEIO 3/4",
    "612226": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - RES/PUB - CONVENCIONAL 3/4",
    "612227": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - COM - MURO 3/4",
    "612228": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - COM - PASSEIO 3/4",
    "612229": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - COM - CONVENCIONAL 3/4",
    "612230": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - PROMO CAPT. CLIENTES - MURO",
    "612231": "INSTALAÇÃO LIG ÁGUA-PROMO CAPT.CLIENTES PASSEIO SEM COBRANÇA",
    "612232": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - PROMO CAPT. CLIENTES - CONV.",
    "612233": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - PROMO CRESC VEG - MURO",
    "612234": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - PROMO CRESC VEG - PASSEIO",
    "612235": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - PROMO CRESC VEG - CONV.",
    "612236": "RELIGAÇÃO SUPRESSÃO - PROMO CRESC VEG",
    "612237": "RELIGAÇÃO SUPRESSÃO - PROMO CAPT CLIENTES - SEM COBRANÇA",
    "612238": "RELIGAÇÃO SUPRESSÃO - COM - 3/4\"",
    "612239": "RELIGAÇÃO SUPRESSÃO - 1\"",
    "612240": "RELIGAÇÃO SUPRESSÃO - 1.1/2\"",
    "612241": "RELIGAÇÃO SUPRESSÃO - PARCIAL",
    "612242": "RELIGAÇÃO SUPRESSÃO - C/ ASFALTO",
    "612251": "REDIMENSIONAMENTO DE RAMAL - 1/2\" PARA 3/4\"",
    "612252": "REDIMENSIONAMENTO DE RAMAL - 3/4\" PARA 1\"",
    "612253": "REDIMENSIONAMENTO DE RAMAL - 3/4\" PARA 1.1/2\"",
    "612254": "REDIMENSIONAMENTO DE RAMAL - 3/4\" PARA 2\"",
    "612255": "REMANEJAMENTO DE RAMAL DE ÁGUA - C/ PAV.",
    "612256": "REMANEJAMENTO DE RAMAL DE ÁGUA - INTERESSE DA EMPRESA",
    "612257": "INSTALAÇÃO DE CAVALETE",
    "612258": "INSTALAÇÃO DE CAVALETE MÚLTIPLO",
    "612261": "RELIGAÇÃO SUPRESSÃO - 2\"",
    "612401": "CONSERTO DE RAMAL DE ÁGUA",
    "612402": "CONSERTO DE RAMAL - PESQUISA DE VAZAMENTO",
    "612403": "DESOBSTRUÇÃO DE RAMAL DE ÁGUA",
    "612404": "CONSERTO DE REDE DE ÁGUA",
    "612405": "CAPEAMENTO DE REDE ÁGUA",
    "612406": "CONSERTO DE REDE DE ÁGUA - TERCEIROS",
    "612407": "CONSERTO DE REDE - PESQUISA DE VAZAMENTO",
    "612408": "DESOBSTRUÇÃO DE REDE DE ÁGUA",
    "612409": "MANUNTEÇÃO PREVENTIVA - ADUTORA",
    "612410": "MANUTENÇÃO PREVENTIVA - HIDRANTE",
    "612411": "MANUTENÇÃO PREVENTIVA - REGISTRO DE MANOBRA",
    "612412": "SONDAGEM TÉCNICA ÁGUA",
    "612413": "SONDAGEM TÉCNICA ÁGUA",
    "612414": "MANUTENÇÃO EM REGISTRO DE MANOBRA",
    "612415": "RETIRADA DE REDE DE ÁGUA",
    "612416": "CONSERTO DE RAMAL DE ÁGUA - TERCEIROS",
    "612417": "CONSERTO DE RAMAL DE ÁGUA - UNIDADE NÃO IDENTIFICADA",
    "612419": "MANUTENÇÃO PREDITIVA - REDE DE ÁGUA",
    "612420": "ENCAMISAMENTO DE RAMAL DE ÁGUA",
    "612421": "ENCAMISAMENTO DE REDE DE ÁGUA",
    "612422": "INSTALAÇÃO DE VÁLVULA DE RETENÇÃO ÁGUA",
    "612423": "VERIFICAÇÃO PRÉVIA DE VAZAMENTO DE ÁGUA - U.C.",
    "612425": "SONDAGEM - PROMO CAPT. CLIENTES (LOG)",
    "612462": "APOIO PARA MANUTENÇÃO - ÁGUA",
    "612473": "SE LIGA - CONSERTO DE REDE",
    "612474": "SE LIGA - CONSERTO DE RAMAL",
    "612475": "SE LIGA - CORREÇÃO DE VAZAMENTO",
    "612501": "CONSERTO DE CAVALETE",
    "612502": "CONSERTO DE CAVALETE - PESQUISA DE VAZAMENTOS",
    "612503": "CONSERTO DE CAVALETE - PEQUENOS AJUSTES",
    "612504": "SUBSTITUIÇÃO DE CAVALETE",
    "612505": "SUBSTITUIÇÃO REGISTRO DE CAVALETE",
    "612506": "REGULARIZAÇÃO DE CAVALETE",
    "612507": "REMANEJAMENTO DE CAVALETE",
    "612509": "REMANEJAMENTO DE CAVALETE - INTERESSE DA EMPRESA",
    "612510": "CONSERTO DE CAVALETE - SEM COBRANÇA",
    "612511": "INSTALAÇÃO/RETIRADA DE ELIMINADOR DE AR",
    "612512": "REMANEJAMENTO DE CAVALETE ACIMA DE 3/4",
    "612513": "SUBSTITUIÇÃO REGISTRO DE CAVALETE ACIMA DE 1\"",
    "612514": "CONSERTO DE CAVALETE - ACIMA DE 3/4\"",
    "612516": "REMANEJAMENTO DE RAMAL/ CAVALETE - PROMO CAPT. CLIENTES",
    "612519": "SE LIGA - CONSERTO DE CAVALETE",
    "612520": "SE LIGA - REMANEJAMENTO DE CAVALETE ACIMA DE 3/4",
    "612701": "INSTALAÇÃO DE ABRIGO PADRÃO",
    "612702": "INSTALAÇÃO DE ABRIGO PADRÃO - PASSEIO",
    "612703": "INSTALAÇÃO DE ABRIGO PADRÃO - INTERESSE DA EMPRESA",
    "612704": "PADRONIZAÇÃO DE CAVALETE",
    "612705": "SUBSTITUIÇÃO DE ABRIGO PADRÃO - PASSEIO",
    "612707": "SUBSTITUIÇÃO DE ABRIGO PADRÃO",
    "612708": "MANUTENÇÃO DE ABRIGO PADRÃO - PASSEIO",
    "612709": "INSTALAÇÃO DE ABRIGO PADRÃO - PASSEIO - INTERESSE DA EMPRESA",
    "612710": "PADRONIZAÇÃO LIG. ÁGUA - PROMO CAPT. CLIENTES - SEM COBRANÇA",
    "612713": "SE LIGA - PADRONIZAÇÃO DE LIGAÇÃO DE ÁGUA",
    "612715": "SE LIGA - PADRONIZAÃÃO DE LIGAÃÃO DE ÃGUA - COM COBRANÃA",
    "612901": "ANÁLISE TÉCNICA OPERACIONAL",
    "612902": "COLETA DE AMOSTRA - QUALIDADE DA ÁGUA",
    "612903": "DESCARGA DE CAVALETE - CORRETIVA",
    "612904": "DESCARGA DE CAVALETE - PREVENTIVA",
    "612905": "DESCARGA DE REDE - PREVENTIVA",
    "612907": "ANÁLISE DE QUALIDADE DA ÁGUA - INTERESSE DA EMPRESA",
    "613101": "ANÁLISE FISCALIZAÇÃO DE EFLUENTE",
    "613102": "FISCALIZAÇÃO DE DESCARACTERIZAÇÃO DE EFLUENTES",
    "613201": "RECOMPOSIÇÃO DE CALÇADA - LOG",
    "613202": "RECOMPOSIÇÃO DE CALÇADA - U.C.",
    "613203": "RECOMPOSIÇÃO DE ASFALTO - LOG",
    "613204": "RECOMPOSIÇÃO DE ASFALTO - U.C.",
    "613205": "RECOMPOSIÇÃO DE LAJOTA/PARALELEPÍPEDO - LOG",
    "613206": "RECOMPOSIÇÃO DE LAJOTA/PARALELEPÍPEDO - U.C.",
    "613207": "RECOMPOSIÇÃO DE CALÇADA - U.C. - TERCEIRO",
    "613208": "RECOMPOSIÇÃO DE ASFALTO - U.C. - TERCEIRO",
    "613209": "RECOMPOSIÇÃO DE LAJOTA/PARALELEPÍPEDO - U.C. - TERCEIRO",
    "613210": "RECOMPOSIÇÃO DE CALÇADA - LOG - TERCEIRO",
    "613211": "RECOMPOSIÇÃO DE ASFALTO - LOG - TERCEIRO",
    "613212": "RECOMPOSIÇÃO DE LAJOTA/PARALELEPÍPEDO - LOG - TERCEIRO",
    "613213": "RECOMPOSIÇÃO DE PAVIMENTO ASFALTO U.C - CAPEX",
    "613214": "RECOMPOSIÇÃO DE PAVIMENTO CALCADA U.C - CAPEX",
    "613215": "RECOMPOSIÇÃO DE LAJOTA/PARALELEPÍPEDO - U.C. - CAPEX",
    "613216": "RECOMPOSIÇÃO DE PAVIMENTO ASFALTO LOG - CAPEX",
    "613217": "RECOMPOSIÇÃO DE PAVIMENTO CALCADA LOG - CAPEX",
    "613218": "RECOMPOSIÇÃO DE LAJOTA/PARALELEPÍPEDO - LOG. - CAPEX",
    "613227": "RECOMPOSIÇÃO DE CALÇADA - SAA - TERCEIRO (U.C)",
    "613228": "RECOMPOSIÇÃO DE ASFALTO - SAA - TERCEIRO (U.C)",
    "613229": "RECOMPOSIÇÃO DE LAJOTA/PARALELEPÍPEDO - SAA - TERCEIRO (U.C)",
    "613230": "RECOMPOSIÇÃO DE CALÇADA - SAA - TERCEIRO (LOG)",
    "613231": "RECOMPOSIÇÃO DE ASFALTO - SAA - TERCEIRO (LOG)",
    "613232": "RECOMPOSIÇÃO DE LAJOTA/PARALELEPÍPEDO - SAA - TERCEIRO (LOG)",
    "613265": "RECOMPOSIÇÃO DE LAJOTA/PARALELEPÍPEDO - LOG (VIA LOCAL)",
    "613266": "RECOMPOSIÇÃO DE LAJOTA/PARALELEPÍPEDO - U.C. (VIA LOCAL)",
    "613267": "RECOMPOSIÇÃO DE CALÇADA - U.C. (VIA LOCAL) - TERCEIRO",
    "613268": "RECOMPOSIÇÃO DE ASFALTO - U.C. (VIA LOCAL) - TERCEIRO",
    "613269": "RECOMP. DE LAJOTA/PARALELEPÍPEDO - U.C(VIA LOCAL) - TERCEIRO",
    "613270": "RECOMPOSIÇÃO DE CALÇADA - LOG (VIA LOCAL) - TERCEIRO",
    "613271": "RECOMPOSIÇÃO DE CALÇADA - LOG (VIA ARTERIAL)",
    "613272": "RECOMPOSIÇÃO DE CALÇADA - U.C. (VIA ARTERIAL) - TERCEIRO",
    "613273": "RECOMPOSIÇÃO DE CALÇADA - LOG (VIA ARTERIAL) - TERCEIRO",
    "613274": "RECOMPOSIÇÃO DE LAJOTA/PARALELEPÍPEDO - LOG (VIA ARTERIAL)",
    "613275": "RECOMPOSIÇÃO DE LAJOTA/PARALELEPÍPEDO - U.C. (VIA ARTERIAL)",
    "613276": "RECOMP. DE LAJOTA/PARALELEPÍPEDO U.C (VIA ARTERIAL) TERCEIRO",
    "613277": "RECOMP. DE LAJOTA/PARALELEPÍPEDO LOG (VIA ARTERIAL) TERCEIRO",
    "613278": "RECOMPOSIÇÃO DE ASFALTO - LOG (VIA ARTERIAL)",
    "613279": "RECOMPOSIÇÃO DE ASFALTO - U.C. (VIA ARTERIAL)",
    "613280": "RECOMPOSIÇÃO DE ASFALTO - U.C. (VIA ARTERIAL) - TERCEIRO",
    "613281": "RECOMPOSIÇÃO DE ASFALTO - LOG (VIA ARTERIAL) - TERCEIRO",
    "613282": "RECOMPOSIÇÃO DE ASFALTO - LOG (VIA LOCAL) - TERCEIRO",
    "613283": "RECOMP. DE LAJOTA/PARALELEPÍPEDO LOG (VIA LOCAL) - TERCEIRO",
    "613284": "RECOMPOSIÇÃO DE CALÇADA - U.C. (VIA ARTERIAL)",
    "613285": "RECOMPOSIÇÃO DE CALÇADA - LOG (VIA LOCAL)",
    "613286": "RECOMPOSIÇÃO DE CALÇADA - U.C. (VIA LOCAL)",
    "613287": "RECOMPOSIÇÃO DE ASFALTO - LOG (VIA LOCAL)",
    "613288": "RECOMPOSIÇÃO DE ASFALTO - U.C. (VIA LOCAL)",
    "613290": "SE LIGA - RECOMPOSIÇÃO DE CALÇADA - LOG",
    "613291": "SE LIGA - RECOMPOSIÇÃO DE CALÇADA - U.C.",
    "613292": "SE LIGA - RECOMPOSIÇÃO DE ASFALTO - LOG",
    "613293": "SE LIGA - RECOMPOSIÇÃO DE ASFALTO - U.C.",
    "613294": "RECADASTRO - RECOMPOSIÇÃO DE CALÇADA - U.C.",
    "613295": "RECADASTRO - RECOMPOSIÇÃO DE ASFALTO - U.C.",
    "613296": "RECADASTRO - RECOMPOSIÇÃO DE CALÇADA - LOG",
    "613297": "RECADASTRO - RECOMPOSIÇÃO DE ASFALTO - LOG",
    "613401": "RELIGAÇÃO RAMAL - SEM COBRANÇA",
    "613402": "RELIGAÇÃO RAMAL - SUSPENSÃO FALTA DE PAGAMENTO",
    "613403": "RELIGAÇÃO RAMAL - SUSPENSÃO A PEDIDO DO CLIENTE",
    "613404": "RELIGAÇÃO RAMAL - SUSPENSÃO POR INFRAÇÃO",
    "613405": "RELIGAÇÃO RAMAL - SUSPENSÃO FALTA PAGTO. - C/ PAV.",
    "613406": "RELIGAÇÃO CAVALETE/RAMAL COM PADRONIZAÇÃO",
    "613407": "RELIGAÇÃO RAMAL - SOLICITAÇÃO PROCON/JURÍDICO",
    "613408": "REGULARIZAÇÃO - SUSPENSÃO/RELIGAÇÃO INDEVIDA",
    "613409": "RELIGAÇÃO RAMAL - ORDEM PODER CONCEDENTE",
    "613413": "RELIGAÇÃO DE ÁGUA - RAMAL - A PEDIDO - A PADRONIZAR",
    "613414": "RELIGAÇÃO RAMAL - SUPRESSÃO (PADRONIZADA)",
    "613417": "RELIGAÇÃO RAMAL - SUSPENSÃO FALTA DE PAGAMENTO - COMERCIAL",
    "613418": "RELIGAÇÃO RAMAL - SUSPENSÃO FALTA DE PAGAMENTO - INDUSTRIAL",
    "613419": "RELIGAÇÃO ABASTECIMENTO CONDOMÍNIO - A PEDIDO DO CLIENTE",
    "613601": "TRAVESSIA NÃO DESTRUTIVA",
    "613602": "TRAVESSIA NÃO DESTRUTIVA",
    "613603": "CORTE NO ASFALTO COM DISCO",
    "613604": "LIMPEZA NO LOCAL DO SERVIÇO - LOG",
    "613605": "LIMPEZA NO LOCAL DO SERVIÇO - U.C",
    "613606": "RETIRADA DE ENTULHOS",
    "613607": "RETIRADA DE ENTULHOS",
    "613608": "REATERRO",
    "613609": "REATERRO",
    "613610": "SERVIÇOS GERAIS",
    "613612": "RECORTE NO MURO",
    "613701": "ABERTURA DE REGISTRO DE MANOBRA",
    "613702": "DESCARGA DE REDE - CORRETIVA",
    "613703": "FECHAMENTO DE REGISTRO DE MANOBRA",
    "613704": "GEOFONAMENTO",
    "613705": "GEOFONAMENTO",
    "613706": "VERIFICAÇÃO PRÉVIA DE VAZAMENTO ÁGUA",
    "613707": "INSTALAÇÃO DE DATA LOGGER",
    "613708": "RETIRADA DE DATA LOGGER",
    "613711": "VERIFICAÃÃO DE VAZAMENTO DE ÃGUA - COMUNIDADE",
    "613714": "APOIO PARA MANUTENÇÃO - MANOBRA",
    "613721": "ABERTURA DE REGISTRO DE MANOBRA - C.C.",
    "613722": "FECHAMENTO DE REGISTRO DE MANOBRA - C.C.",
    "613801": "SUPRESSÃO DE LIGAÇÃO DE ÁGUA - POR FALTA DE PAGAMENTO",
    "613802": "SUPRESSÃO DE LIGAÇÃO DE ÁGUA - POR INFRAÇÃO",
    "613803": "SUPRESSÃO DE LIGAÇÃO DE ÁGUA - A PEDIDO DO CLIENTE",
    "613804": "SUPRESSÃO DE LIGAÇÃO CLANDESTINA",
    "613805": "SUPRESSÃO DE LIGAÇÃO DE ÁGUA - POR UNIFICAÇÃO DE LOTE",
    "613806": "SUPRESSÃO DE LIGAÇÃO DE ÁGUA - POR DESOCUPAÇÃO",
    "613807": "SUPRESSÃO DE LIGAÇÃO DE ÁGUA PROVISÓRIA",
    "613808": "SUPRESSÃO DE LIGAÇÃO DE ESGOTO PROVISÓRIA",
    "613809": "SUPRESSÃO DE LIGAÇÃO DE ÁGUA - PROMO CAPT. CLIENTES",
    "613815": "SE LIGA - SUPRESSÃO DE LIGAÇÃO DE ÁGUA - POR INFRAÇÃO",
    "613901": "SUSPENSÃO ABASTECIMENTO RAMAL - POR FALTA DE PAGAMENTO",
    "613902": "SUSPENSÃO ABASTECIMENTO RAMAL - POR INFRAÇÃO",
    "613903": "SUSPENSÃO ABASTECIMENTO RAMAL - POR DESOCUPAÇÃO",
    "613904": "SUSPENSÃO ABASTECIMENTO RAMAL - A PEDIDO DO CLIENTE",
    "613905": "SUSPENSÃO ABASTECIMENTO RAMAL - POR IMPEDIMENTO",
    "613906": "SUSPENSÃO ABASTECIMENTO RAMAL DE LIGAÇÃO CLANDESTINA",
    "622294": "MANUTENÇÃO MODULO DE TELEMETRIA ACOPLADO - U.C",
    "622296": "MANUTENÇÃO MODULO DE TELEMETRIA CABEADO - U.C",
    "622297": "MANUTENÇÃO MODULO DE TELEMETRIA CABEADO - C.C",
    "622298": "MANUTENÇÃO SENSORES DE PRESSÃO IOT - LOG",
    "622299": "SE LIGA - INSTALAÇÃO DE LIGAÇÃO DE ÁGUA",
    "632209": "INSTALAÇÃO LIGAÇÃO DE ÁGUA - INDUSTRIAL 1/2",
    "632210": "INSTALAÇÃO LIGAÇÃO DE ÁGUA - INDUSTRIAL 3/4",
    "632211": "INSTALAÇÃO LIGAÇÃO DE ÁGUA - INDUSTRIAL 1 POL",
    "632212": "INSTALAÇÃO LIGAÇÃO DE ÁGUA - INDUSTRIAL 2 POL",
    "632213": "INSTALAÇÃO LIGAÇÃO DE ÁGUA - RESIDENCIAL 3/4",
    "632214": "INSTALAÇÃO LIGAÇÃO DE ÁGUA - COMERCIAL 1/2",
    "632215": "INSTALAÇÃO LIGAÇÃO DE ÁGUA - COMERCIAL 3/4",
    "632216": "INSTALAÇÃO LIGAÇÃO DE ÁGUA - COMERCIAL 1 POL",
    "632217": "INSTALAÇÃO LIGAÇÃO DE ÁGUA - COMERCIAL 2 POL",
    "632218": "RELIGAÇÃO SUPRESSÃO - COMERCIAL",
    "632219": "RELIGAÇÃO SUPRESSÃO - INDUSTRIAL",
    "632220": "INSTALAÇÃO DE LIGAÇÃO DE ÁGUA - 1/2",
    "632221": "SE LIGA - RELIGAÇÃO SUPRESSÃO",
    "632222": "RECADASTRO - RELIGAÇÃO SUPRESSÃO",
    "632223": "RECADASTRO - INSTALAÇÃO DE LIGAÇÃO DE ÁGUA",
    "710003": "EXTENSÃO DE REDE DE ESGOTO - PROMO CAPT. CLIENTES",
    "710901": "AMPLIAÇÃO DE REDE DE ESGOTO - INTERESSE DA EMPRESA",
    "710902": "AMPLIAÇÃO DE REDE DE ESGOTO - SOLICITAÇÃO EXTERNA",
    "710903": "INSTALAÇÃO DE POÇO DE VISITA",
    "710904": "CONSERTO DE REDE DE ESGOTO - OBRAS CAPEX",
    "711101": "REMANEJAMENTO DE LIGAÇÃO DE ESGOTO",
    "711102": "SUBSTITUIÇÃO LIGAÇÃO DE ESGOTO",
    "711103": "INTERLIGAÇÃO REDE DE ESGOTO",
    "711104": "SUBSTITUIÇÃO DE TAMPA EM POÇO DE VISITA",
    "711105": "INSTALAÇÃO DE TAMPA EM POÇO DE VISITA",
    "711106": "REMANEJAMENTO REDE DE ESGOTO",
    "711107": "SUBSTITUIÇÃO REDE DE ESGOTO",
    "711108": "AMPLIAÇÃO DE REDE DE ESGOTO - INTERESSE DA EMPRESA",
    "711109": "AMPLIAÇÃO DE REDE DE ESGOTO - SOLICITAÇÃO EXTERNA",
    "711110": "INTERVENÇÃO EM REDE DE ESGOTO NAS OBRAS DE GALERIA PLUVIAL",
    "711111": "SUBSTITUIÇÃO DE RAMAL DE ESGOTO",
    "711112": "VIABILIDADE PARA MELHORIA OPERACIONAL - ESGOTO",
    "711113": "INSTALAÇÃO DE POÇO DE VISITA",
    "711114": "INTERFERÊNCIA EM MANUTENÇÃO DE ÁGUA",
    "712301": "INSTALAÇÃO DE LIGAÇÃO DE ESGOTO - PROVISÓRIA",
    "712302": "INSTALAÇÃO DE LIGAÇÃO DE ESGOTO - TARIFA SOCIAL",
    "712303": "INSTALAÇÃO DE LIGAÇÃO DE ESGOTO",
    "712304": "INSTALAÇÃO DE LIGAÇÃO DE ESGOTO - APÓS OBRA",
    "712305": "INSTALAÇÃO DE LIGAÇÃO DE ESGOTO - SIS. MISTO - C/ COBRANÇA",
    "712306": "INSTALAÇÃO DE LIGAÇÃO DE ESGOTO - SIS. MISTO - S/ COBRANÇA",
    "712307": "INSTALAÇÃO DE LIGAÇÃO DE ESGOTO - RES/PUB 4\" DN 100",
    "712308": "INSTALAÇÃO DE LIGAÇÃO DE ESGOTO - RES/PUB 6\" DN 150",
    "712309": "INSTALAÇÃO DE LIGAÇÃO DE ESGOTO - COM 4\" DN 100",
    "712310": "INSTALAÇÃO DE LIGAÇÃO DE ESGOTO - COM 6\" DN 150",
    "712311": "INSTALAÇÃO DE LIGAÇÃO DE ESGOTO - IND 4\" DN 100",
    "712312": "INSTALAÇÃO DE LIGAÇÃO DE ESGOTO - IND 6\" DN 150",
    "712313": "INSTALAÇÃO LIG. ESGOTO - PROMO CAPT. CLIENTES - SEM COBRANÇA",
    "712314": "INSTALAÇÃO DE LIGAÇÃO DE ESGOTO - PROMO CRESC VEG",
    "712315": "REDIMENSIONAMENTO DE RAMAL DE ESGOTO - ATÉ 10M",
    "712316": "INSTALAÇÃO DE LIGAÇÃO DE ESGOTO - PARCIAL",
    "712317": "INSTALAÇÃO DE LIGAÇÃO DE ESGOTO - C/ ASFALTO",
    "712318": "INSTALAÇÃO DE CAIXA COLETORA DE ESGOTO",
    "712601": "SONDAGEM TÉCNICA ESGOTO",
    "712602": "CONSERTO DE RAMAL DE ESGOTO",
    "712603": "SONDAGEM TÉCNICA ESGOTO",
    "712604": "REMANEJAMENTO DE RAMAL DE ESGOTO",
    "712605": "VERIFICAÇÃO PRÉVIA DE VAZAMENTO DE ESGOTO",
    "712606": "DESOBSTRUÇÃO DE RAMAL DE ESGOTO - U.C.",
    "712607": "VERIFICAÇÃO RETORNO DE ESGOTO NO IMÓVEL",
    "712608": "DESOBSTRUÇÃO DE RAMAL DE ESGOTO - LOG",
    "712609": "INSTALAÇÃO TAMPA TIL",
    "712610": "SUBSTITUIÇÃO TAMPA TIL",
    "712611": "INSTALAÇÃO DE VÁLVULA DE RETENÇÃO ESGOTO",
    "712612": "CONSERTO DE REDE DE ESGOTO",
    "712613": "CONSERTO DE REDE DE ESGOTO - TERCEIROS",
    "712614": "DESOBSTRUÇÃO DE REDE DE ESGOTO",
    "712615": "MANUTENÇÃO PREDITIVA - REDE DE ESGOTO",
    "712616": "MANUTENÇÃO PREVENTIVA - REDE DE ESGOTO",
    "712617": "MANUTENÇÃO EM POÇO DE VISITA",
    "712618": "ESGOTAMENTO E LIMPEZA DE POÇO DE VISITA",
    "712619": "RECLAMAÇÃO DE POÇO DE VISITA ABERTO",
    "712620": "MANUTENÇÃO DE CAIXA COLETORA DE ESGOTO",
    "712621": "LIMPEZA DE GRADEAMENTO EM EEE/ETE",
    "712622": "MANUTENÇÃO EM EEE/ETE",
    "712623": "LIMPEZA DE FOSSA SÉPTICA - LOG",
    "712624": "DESCARREGAMENTO DE CAMINHÃO LIMPA FOSSA EM ETE",
    "712625": "VISTORIA DE INSPEÇÃO EM EEE",
    "712626": "VISTORIA DE INSPEÇÃO TTS",
    "712627": "VISTORIA DE INSPEÇÃO FLAP",
    "712628": "LIMPEZA/DESOBSTRUÇÃO PREVENTIVA EM EEE",
    "712629": "LIMPEZA/DESOBSTRUÇÃO CORRETIVA EM EEE",
    "712632": "CONSERTO DE RAMAL DE ESGOTO - TERCEIROS",
    "712633": "VERIFICAÃÃO DE VAZAMENTO DE ESGOTO - COMUNIDADE",
    "712635": "VISTORIA TECNICA OPERACIONAL",
    "712646": "MANUTENÃÃO FLAP'S ESGOTO - REDES",
    "712647": "CONSERTO DE RAMAL DE ESGOTO - LOG",
    "712649": "APOIO PARA MANUTENÇÃO - ESGOTO",
    "712652": "APOIO HIDROJATO - CAPEX",
    "712801": "PADRONIZAÇÃO DE LIGAÇÃO DE ESGOTO",
    "712802": "PADRONIZAÇÃO DE LIGAÇÃO DE ESGOTO - PROMO CAPT. CLIENTES",
    "714001": "LOCALIZAÇÃO DA LIGAÇÃO DE ESGOTO",
    "811301": "ABASTECIMENTO POR CAMINHÃO PIPA - SEM COBRANÇA",
    "811302": "ABASTECIMENTO POR CAMINHÃO PIPA - COM COBRANÇA",
    "811303": "ABASTECIMENTO POR CAMINHÃO PIPA - COM COBRANÇA - C.C.",
    "811304": "ABASTECIMENTO POR CAMINHÃO PIPA - SEM COBRANÇA - C.C.",
    "811305": "ABASTECIMENTO DE CAMINHÃO PIPA",
    "811306": "ABASTECIMENTO DE CAMINHÃO HIDROVÁCUO",
    "811307": "ABASTECIMENTO POR CAMINHÃO PIPA - COMUNIDADE",
    "811308": "ABASTECIMENTO POR CAMINHÃO PIPA - CONTRATO DE DEMANDA",
    "811313": "ABASTECIMENTO POR CAMINHÃO PIPA - VENDA COMERCIAL",
    "811314": "ABASTECIMENTO POR CAMINHÃO PIPA - CONTRATO DE DEMANDA C.C",
    "910801": "RECLAMAÇÃO DE RECOMPOSIÇÃO PAV. - CAPEX ÁGUA - PROCEDENTE",
    "910802": "RECLAMAÇÃO DE RECOMPOSIÇÃO PAV. - CAPEX ÁGUA - IMPROCEDENTE",
    "910803": "SE LIGA - FISCALIZAÃÃO DE OBRA - CONFORME",
    "910804": "SE LIGA - FISCALIZAÃÃO DE OBRA - NÃO CONFORME",
    "910901": "VISTORIA TÉCNICA - LIG ESGOTO - TIL DISPONÍVEL",
    "910902": "VISTORIA TÉCNICA - LIG ESGOTO - SOLEIRA BAIXA",
    "910903": "VISTORIA TÉCNICA - LIG ESGOTO - FACTÍVEL",
    "910904": "SENSIBILIZAÇÃO - LIG ESGOTO - CONCLUÍDA",
    "910905": "SENSIBILIZAÇÃO - LIG ESGOTO - LOTE VAGO/ABANDONADO",
    "910906": "RECLAMAÇÃO DE RECOMPOSIÇÃO PAV. - CAPEX ESGOTO - PROCEDENTE",
    "910907": "RECLAMAÇÃO DE RECOMPOSIÇÃO PAV. - CAPEX ESGOTO - IMPROCEDENT",
    "910909": "RECLAMAÇÃO DE RECOMPOSIÇÃO PAV. - CAPEX ESGOTO - IMPROCEDENT",
    "910911": "SENSIBILIZAÇÃO - LIG ESGOTO - CONCLUÍDA - PÓS OBRA",
    "910914": "VISTORIA TÉCNICA - LIG ESGOTO - ANÁLISE DE REDE COLETORA",
    "910915": "LIGAÇÃO ESGOTO VERIFICADA - INTERLIGADO",
    "910916": "LIGAÇÃO ESGOTO VERIFICADA - INTERLIGADO COM PÊNDENCIAS",
    "910917": "LIGAÇÃO ESGOTO VERIFICADA - NÃO INTERLIGADO",
    "911203": "APROVAÇÃO DE PROJETO DE EMPREENDIMENTO",
    "911204": "VISTORIA TÉCNICA - REDE DE ÁGUA - CONFORME",
    "911205": "VISTORIA TÉCNICA - REDE DE ÁGUA - INCONFORME",
    "911206": "VISTORIA TÉCNICA - REDE DE ÁGUA - NÃO EXECUTADO",
    "911207": "VISTORIA TÉCNICA - REDE DE ESGOTO - CONFORME",
    "911208": "VISTORIA TÉCNICA - REDE DE ESGOTO - INCONFORME",
    "911209": "VISTORIA TÉCNICA - REDE DE ESGOTO - NÃO EXECUTADO",
    "920204": "VISITA DE CAPTAÇÃO DE CLIENTES - DESABITADO",
    "920211": "VISITA DE CAPTAÇÃO DE CLIENTES - DUPLICIDADE",
    "920212": "VISITA DE CAPTAÇÃO DE CLIENTES - FONTE ALTERNATIVA C/ ESGOTO",
    "920213": "VISITA DE CAPTAÇÃO DE CLIENTES - LIGAÇÃO ATIVA",
    "920214": "VISITA DE CAPTAÇÃO DE CLIENTES -DUPLICIDADE (LOG)",
    "920215": "VISITA DE CAPTAÇÃO DE CLIENTES - DESABITADO (LOG)",
    "920216": "VISITA DE CAPTAÇÃO DE CLIENTES - FONTE ALT C/ ESGOTO (LOG)",
    "920217": "VISITA DE CAPTAÇÃO DE CLIENTES -INEXISTENTE/UNIFICADO (LOG)",
    "920218": "VISITA DE CAPTAÇÃO DE CLIENTES - SEM NEGOCIAÇÃO (LOG)",
    "920219": "VISITA DE CAPTAÇÃO DE CLIENTES - COM NEGOCIAÇÃO (LOG)",
    "920503": "VERIFICAÇÃO DE CATEGORIA/ECONOMIA - COM ALTERAÇÃO",
    "920504": "VERIFICAÇÃO DE CATEGORIA/ECONOMIA - SEM ALTERAÇÃO",
    "920525": "VERIF CATEGORIA/ECONOMIA INTERESSE DA EMPRESA COM ALTERAÇÃO",
    "920526": "VERIF CATEGORIA/ECONOMIA INTERESSE DA EMPRESA SEM ALTERAÇÃO",
    "921601": "EXCESSO DE CONSUMO - COM INDÍCIO DE VAZAMENTO",
    "921602": "EXCESSO DE CONSUMO - SEM INDÍCIO DE VAZAMENTO",
    "921603": "VAZAMENTO INTERNO CONSERTADO - PROCEDENTE",
    "921604": "VAZAMENTO INTERNO CONSERTADO - IMPROCEDENTE",
    "921605": "CONSUMO ZERO - S/ IRREG. E DESABITADO",
    "921606": "CONSUMO ZERO - FONTE ALTERNATIVA",
    "921607": "CONSUMO ZERO - BY PASS",
    "921608": "CONSUMO ZERO - LIGAÇÃO CLANDESTINA",
    "921609": "CONSUMO ZERO - ABASTECIDO POR OUTRA LIGAÇÃO",
    "921610": "CONSUMO ZERO - S/ IRREG. E HABITADA",
    "921611": "EXCESSO DE CONSUMO - ERRO DE LEITURA - INTERESSE DA EMPRESA",
    "921612": "EXCESSO DE CONSUMO - ERRO DE LEITURA",
    "921614": "EXCESSO DE CONSUMO - COM INDÍCIO DE VAZAMENTO - INTERESSE DA",
    "921615": "EXCESSO DE CONSUMO - SEM ÍNDÍCIO DE VAZAMENTO - INTERESSE DA",
    "921616": "CONSUMO ZERO - HIDRÔMETRO VIOLADO",
    "921617": "CONSUMO ZERO - HIDRÔMETRO DANIFICADO",
    "921618": "CONSUMO ZERO - CAVALETE VIOLADO",
    "921619": "CONSUMO ZERO - NECESSÁRIO SONDAGEM",
    "921621": "CONSUMO ZERO - LACRE VIOLADO",
    "921622": "CONSUMO ZERO - NECESSÁRIO APOIO PERÍCIA",
    "921623": "CONSUMO BAIXO - ABASTECIDO POR OUTRA LIGAÇÃO",
    "921624": "CONSUMO BAIXO - BY PASS",
    "921625": "CONSUMO BAIXO - CAVALETE VIOLADO",
    "921626": "CONSUMO BAIXO - FONTE ALTERNATIVA",
    "921627": "CONSUMO BAIXO - HIDRÔMETRO DANIFICADO",
    "921628": "CONSUMO BAIXO - HIDRÔMETRO VIOLADO",
    "921629": "CONSUMO BAIXO - LACRE VIOLADO",
    "921630": "CONSUMO BAIXO - LIGAÇÃO CLANDESTINA",
    "921631": "CONSUMO BAIXO - NECESSÁRIO APOIO PERÍCIA",
    "921632": "CONSUMO BAIXO - NECESSÁRIO SONDAGEM",
    "921633": "CONSUMO BAIXO - S/ IRREG. E DESABITADO",
    "921634": "CONSUMO BAIXO - S/ IRREG. E HABITADA",
    "921635": "VERIFICAÇÃO - PROCON/JURÍDICO - COM INDÍCIO DE VAZAMENTO",
    "921636": "VERIFICAÇÃO - PROCON/JURÍDICO - SEM INDÍCIO DE VAZAMENTO",
    "921637": "VERIFICAÇÃO - PROCON/JURÍDICO - VAZAMENTO INTERNO CONSERTADO",
    "921638": "VERIFICAÇÃO - PROCON/JURÍDICO - SUBSTITUIÇÃO DE HIDRÔMETRO",
    "921639": "VERIFICAÇÃO - PROCON/JURÍDICO - IRREGULARIDADE IDENTIFICADA",
    "921640": "VERIFICAÇÃO - PROCON/JURÍDICO - SEM IRREGULARIDADE",
    "930601": "VIABILIDADE - LIG ÁGUA - DEFERIDO",
    "930602": "VIABILIDADE - LIG ÁGUA - AMPLIAÇÃO DE REDE",
    "930603": "VIABILIDADE - LIG ÁGUA - INDEFERIDO - APP",
    "930604": "VIABILIDADE - LIG ÁGUA - INDEFERIDO - ÁREA DE INVASÃO",
    "930606": "VIABILIDADE - LIG ÁGUA - INDEFERIDO - LOT. IRREGULAR",
    "930607": "VIABILIDADE - LIG ESGOTO - DEFERIDO",
    "930608": "VIABILIDADE - LIG ESGOTO - AMPLIAÇÃO DE REDE",
    "930609": "VIABILIDADE - LIG ESGOTO - INDEFERIDO",
    "930610": "VIABILIDADE - REMANEJAMENTO - CAVALETE",
    "930611": "VIABILIDADE - REMANEJAMENTO - RAMAL",
    "930612": "VIABILIDADE - REMANEJAMENTO - INDEFERIDO",
    "930613": "PADRONIZAÇÃO LIG ÁGUA - DEFERIDO",
    "930614": "PADRONIZAÇÃO LIG ÁGUA - PASSEIO - DEFERIDO",
    "930615": "PADRONIZAÇÃO LIG ÁGUA - INDEFERIDO",
    "930616": "VIABILIDADE - LIG ÁGUA - PADRÃO INCORRETO",
    "930617": "VIABILIDADE - LIG ÁGUA - CORTE DE PAV.",
    "930618": "VIABILIDADE - LIG ÁGUA - CADASTRO EXISTENTE",
    "930619": "VIABILIDADE - LIG ÁGUA - PENDÊNCIAS COMERCIAIS",
    "930625": "VIABILIDADE - LIGAÇÃO ESGOTO DISPONÍVEL",
    "930626": "VIABILIDADE LIG ÁGUA - PENDÊNCIAS DOCUMENTAIS",
    "930627": "VIABILIDADE LIG ÁGUA - IMÓVEL NÃO LOCALIZADO",
    "930628": "MEDIÇÃO INDIVIDUALIZADA - DEFERIDA",
    "930629": "MEDIÇÃO INDIVIDUALIZADA - INDEFERIDA",
    "930630": "VIABILIDADE TÉCNICA PARA AMPLIAÇÃO DE REDE DE ÁGUA - INDEFER",
    "930631": "VIABILIDADE TÉCNICA PARA AMPLIAÇÃO DE REDE DE ÁGUA - DEFERID",
    "930632": "VIABILIDADE TÉCNICA PARA AMPLIAÇÃO DE REDE DE ESGOTO - INDEF",
    "930633": "VIABILIDADE TÉCNICA PARA AMPLIAÇÃO DE REDE DE ESGOTO - DEFER",
    "930634": "VIABILIDADE DE LIGAÇÃO PROVISÓRIA DE ÁGUA - DEFERIDA C.C",
    "930635": "VIABILIDADE DE LIGAÇÃO PROVISÓRIA DE ÁGUA - INDEFERIDA C.C",
    "930636": "VIABILIDADE LIGAÇÃO DE ÁGUA - AMPLIAÇÃO REDE C.C",
    "930637": "ABRIGO PADRÃO - DEFERIDO",
    "930638": "ABRIGO PADRÃO - INDEFERIDO",
    "930639": "VIABILIDADE - LIG ÁGUA - DEFERIDO - PADRÃO PASSEIO",
    "930640": "VIABILIDADE - LIG ÁGUA - DEFERIDO - PADRÃO MURO",
    "931701": "FISC - INATIVA - HIDRÔMETRO VIOLADO",
    "931702": "FISC - INATIVA - HIDRÔMETRO DANIFICADO",
    "931703": "FISC - INATIVA - BY PASS",
    "931704": "FISC - INATIVA - CAVALETE VIOLADO",
    "931705": "FISC - INATIVA - LIGAÇÃO CLANDESTINA",
    "931706": "FISC - INATIVA - CORTE VIOLADO",
    "931707": "FISC - INATIVA - NECESSÁRIO SONDAGEM",
    "931708": "FISC - INATIVA - LACRE VIOLADO",
    "931709": "FISC - INATIVA - S/ IRREG. E HABITADA",
    "931710": "FISC - INATIVA - NECESSÁRIO APOIO PERÍCIA",
    "931711": "FISC - INATIVA - FONTE ALTERNATIVA",
    "931712": "FISC - ATIVA - HIDRÔMETRO VIOLADO",
    "931713": "FISC - ATIVA - HIDRÔMETRO DANIFICADO",
    "931714": "FISC - ATIVA - BY PASS",
    "931715": "FISC - ATIVA - CAVALETE VIOLADO",
    "931716": "FISC - ATIVA - LIGAÇÃO CLANDESTINA",
    "931717": "FISC - ATIVA - LACRE VIOLADO",
    "931718": "FISC - ATIVA - S/ IRREG. E HABITADA",
    "931719": "FISC - ATIVA - NECESSÁRIO APOIO PERÍCIA",
    "931720": "FISC - DENÚNCIA - HIDRÔMETRO VIOLADO",
    "931721": "FISC - DENÚNCIA - HIDRÔMETRO DANIFICADO",
    "931722": "FISC - DENÚNCIA - BY PASS",
    "931723": "FISC - DENÚNCIA - CAVALETE VIOLADO",
    "931724": "FISC - DENÚNCIA - LIGAÇÃO CLANDESTINA",
    "931725": "FISC - DENÚNCIA - CORTE VIOLADO",
    "931727": "FISC - DENÚNCIA - LACRE VIOLADO",
    "931728": "FISC - DENÚNCIA - S/ IRREG. E HABITADA",
    "931729": "FISC - DENÚNCIA - NECESSÁRIO APOIO PERÍCIA",
    "931730": "FISC - DENÚNCIA - FONTE ALTERNATIVA",
    "931731": "FISC - DENÚNCIA LOG - LIGAÇÃO CLANDESTINA",
    "931732": "FISC - DENUNCIA LOG - S/ IRREG. E HABITADA",
    "931733": "FISC - DENÚNCIA LOG - MATRÍCULA IDENTIFICADA",
    "931734": "VISTORIA DE LIGAÇÃO - IMÓVEL SEM HIDRÔMETRO",
    "931735": "VISTORIA DE LIGAÇÃO - SEM ACESSO AO HIDRÔMETRO",
    "931736": "VISTORIA DE LIGAÇÃO - CAVALETE IRREGULAR",
    "931737": "VISTORIA DE LIGAÇÃO - IRREGULARIDADE",
    "931738": "VISTORIA DE LIGAÇÃO - SEM IRREGULARIDADE",
    "931739": "AUTO DE INFRAÇÃO - DEFESA DEFERIDA",
    "931740": "AUTO DE INFRAÇÃO - DEFESA INDEFERIDA",
    "931741": "AUTO DE INFRAÇÃO - REVELIA",
    "931744": "FISC - ATIVA - FORNECIMENTO A TERCEIROS",
    "931745": "FISC - DENÚNCIA - FORNECIMENTO A TERCEIROS",
    "931747": "FISC - CAVALETE - HIDRÔMETRO VIOLADO",
    "931748": "FISC - CAVALETE - HIDRÔMETRO DANIFICADO",
    "931749": "FISC - CAVALETE - BY PASS",
    "931750": "FISC - CAVALETE - CAVALETE VIOLADO",
    "931751": "FISC - CAVALETE - SUSPENSÃO VIOLADA",
    "931752": "FISC - CAVALETE - LACRE VIOLADO",
    "931753": "FISC - CAVALETE - S/ IRREG. E HABITADA",
    "931754": "FISC - CAVALETE - S/ IRREG. E DESABITADO",
    "931755": "FISC - CAVALETE - FONTE ALTERNATIVA",
    "931756": "FISC - CAVALETE - NECESSÁRIO APOIO PERÍCIA",
    "931757": "FISC - RAMAL - HIDRÔMETRO VIOLADO",
    "931758": "FISC - RAMAL - HIDRÔMETRO DANIFICADO",
    "931759": "FISC - RAMAL - BY PASS",
    "931760": "FISC - RAMAL - CAVALETE VIOLADO",
    "931761": "FISC - RAMAL - SUSPENSÃO VIOLADA",
    "931762": "FISC - RAMAL - LACRE VIOLADO",
    "931763": "FISC - RAMAL - S/ IRREG. E HABITADA",
    "931764": "FISC - RAMAL - S/ IRREG. E DESABITADO",
    "931765": "FISC - RAMAL - FONTE ALTERNATIVA",
    "931766": "FISC - RAMAL - NECESSÁRIO APOIO PERÍCIA",
    "931795": "FISC - AUTODENUNCIA - RETIRADA DE IRREGULARIDADE",
    "931796": "FISC - DENÚNCIA - ABASTECIDO POR OUTRA LIGAÇÃO",
    "931797": "FISC - DENÚNCIA - NECESSÁRIO SONDAGEM",
    "931798": "FISC - CAVALETE - LIGAÇÃO CLANDESTINA",
    "931799": "FISC - CAVALETE - NECESSÁRIO SONDAGEM",
    "931801": "FISC - ESGOTO - LIGAÇÃO CLANDESTINA",
    "931802": "FISC - ESGOTO - EFLUENTE FORA DO PADRÃO",
    "931803": "FISC - ESGOTO - SEM IRREGULARIDADES",
    "931902": "VERIFICAÇÃO DE HIDRÔMETRO - SUBSTITUIÇÃO",
    "931903": "VERIFICAÇÃO DE HIDRÔMETRO - SEM IRREGULARIDADE",
    "931904": "VERIFICAÇÃO DE HIDRÔMETRO - FISCALIZAÇÃO",
    "931905": "VERIFICAÇÃO DE HIDRÔMETRO - P.C. - SUBSTITUIÇÃO",
    "931906": "VERIFICAÇÃO DE HIDRÔMETRO - P.C. - SEM IRREGULARIDADE",
    "931931": "VERIFICAÇÃO DE VÁLVULA DE MEDIDOR INTELIGENTE - PROCEDENTE",
    "931932": "VERIFICAÇÃO DE VÁLVULA DE MEDIDOR INTELIGENTE - IMPROCEDENTE",
    "932001": "QUALIDADE DO SERVIÇO - RECLAMAÇÃO PROCEDENTE",
    "932002": "QUALIDADE DO SERVIÇO - RECLAMAÇÃO IMPROCEDENTE",
    "932501": "CONSERTO DE CAVALETE - ANTES DO HD - SEM ESCAVAÇÃO",
    "932502": "CONSERTO DE CAVALETE - APÓS O HD - SEM ESCAVAÇÃO",
    "932503": "CONSERTO DE CAVALETE - ANTES DO HD - COM ESCAVAÇÃO",
    "932504": "CONSERTO DE CAVALETE - APÓS O HD - COM ESCAVAÇÃO",
    "932505": "CONSERTO DE CAVALETE - IMPROCEDENTE",
    "934001": "LIG ESGOTO - INTERLIGADO NA DRENAGEM",
    "934002": "LIG ESGOTO - IMÓVEL COM FOSSA",
    "934103": "FISC - INATIVA - NÃO REALIZADA/SEM ACESSO",
    "934104": "FISC - CAVALETE - NÃO REALIZADA/SEM ACESSO",
    "934105": "FISC - RAMAL - NÃO REALIZADA/SEM ACESSO",
    "934106": "FISC - DENÚNCIA - NÃO REALIZADA/SEM ACESSO",
    "934107": "FISC - DENÚNCIA LOG - NÃO REALIZADA/SEM ACESSO",
    "934108": "CONSUMO ZERO - NÃO REALIZADA/SEM ACESSO",
    "934109": "CONSUMO BAIXO - NÃO REALIZADA/SEM ACESSO",
    "934114": "FISC - AUTODENUNCIA - S/ IRREG. E HABITADA",
    "934115": "FISC - EXPLORATÓRIA - NÃO REALIZADA/SEM ACESSO",
    "934116": "FISC - RONDA - SEM FLAGRANTE (LOG)",
    "934117": "FISC - RONDA - FONTE ALTERNATIVA (LOG)",
    "934132": "CONSUMO ZERO - LIGAÇÃO UNIFICADA",
    "934133": "CONSUMO BAIXO - LIGAÇÃO UNIFICADA",
    "934134": "FISC - AUTODENUNCIA - S/ IRREG. E DESABITADO",
    "934135": "FISC - DENUNCIA LOG - S/ IRREG. E DESABITADO",
    "934136": "FISC - DENÚNCIA LOG - NECESSÁRIO SONDAGEM",
    "941401": "FALTA DE ÁGUA IMPREVISTA - VAZAMENTO",
    "941402": "FALTA DE ÁGUA IMPREVISTA - PROBLEMA INTERNO",
    "941403": "FALTA DE ÁGUA IMPREVISTA - OBSTRUÇÃO",
    "941404": "FALTA DE ÁGUA IMPREVISTA - REGISTRO FECHADO",
    "941405": "FALTA DE ÁGUA IMPREVISTA - IMPROCEDENTE",
    "941406": "VERIFICAÇÃO DE PRESSÃO NO CAVALETE - VAZAMENTO",
    "941407": "VERIFICAÇÃO DE PRESSÃO NO CAVALETE - PROBLEMA INTERNO",
    "941408": "VERIFICAÇÃO DE PRESSÃO NO CAVALETE - OBSTRUÇÃO",
    "941409": "VERIFICAÇÃO DE PRESSÃO NO CAVALETE - REGISTRO FECHADO",
    "941410": "VERIFICAÇÃO DE PRESSÃO NO CAVALETE - IMPROCEDENTE",
    "941411": "FALTA DE ÁGUA IMPREVISTA - INTERMITÊNCIA OPERACIONAL",
    "941412": "VERIFICAÇÃO DE PRESSÃO NO CAVALETE - INTERMIT. OPERACIONAL",
    "941414": "FALTA DE ÁGUA IMPREVISTA - OBSTRUÇÃO VÁLVULA",
    "941701": "SONDAGEM NO RAMAL DE ÁGUA - IMPROCEDENTE",
    "941703": "SONDAGEM NO RAMAL DE ÁGUA - RETIRADA DE LIGAÇÃO CLANDESTINA",
    "941704": "SONDAGEM NO RAMAL DE ÁGUA - HIDRÔMETRO VIOLADO",
    "941705": "SONDAGEM NO RAMAL DE ÁGUA - HIDRÔMETRO DANIFICADO",
    "941706": "SONDAGEM NO RAMAL DE ÁGUA - CAVALETE VIOLADO",
    "941707": "SONDAGEM NO RAMAL DE ÁGUA - LACRE VIOLADO",
    "941708": "SONDAGEM NO RAMAL DE ÁGUA - S/ IRREG. E DESABITADO",
    "941709": "SONDAGEM NO RAMAL DE ÁGUA - FONTE ALTERNATIVA",
    "941710": "SONDAGEM NO RAMAL DE ÁGUA - NECESSÁRIO APOIO PERÍCIA",
    "941711": "SONDAGEM NO RAMAL DE ÁGUA - ABASTECIDO POR OUTRA LIGAÇÃO",
    "941712": "SONDAGEM NO RAMAL DE ÁGUA - LIGAÇÃO UNIFICADA",
    "941713": "SONDAGEM NO RAMAL DE ÁGUA - NECESSÁRIO PADRONIZAÇÃO",
    "941717": "SONDAGEM NO RAMAL DE ÁGUA - LOG - ABASTECIDO POR OUTRA LIGAÇ",
    "941718": "SONDAGEM NO RAMAL DE ÁGUA - LOG - CAVALETE VIOLADO",
    "941719": "SONDAGEM NO RAMAL DE ÁGUA - LOG - FONTE ALTERNATIVA",
    "941720": "SONDAGEM NO RAMAL DE ÁGUA - LOG - HIDRÔMETRO DANIFICADO",
    "941721": "SONDAGEM NO RAMAL DE ÁGUA - LOG - HIDRÔMETRO VIOLADO",
    "941722": "SONDAGEM NO RAMAL DE ÁGUA -LOG - IMPROCEDENTE",
    "941723": "SONDAGEM NO RAMAL DE ÁGUA - LOG - LACRE VIOLADO",
    "941724": "SONDAGEM NO RAMAL DE ÁGUA - LOG - LIGAÇÃO UNIFICADA",
    "941725": "SONDAGEM NO RAMAL DE ÁGUA - LOG - NECESSÁRIO APOIO PERÍCIA",
    "941726": "SONDAGEM NO RAMAL DE ÁGUA - LOG - NECESSÁRIO PADRONIZAÇÃO",
    "941727": "SONDAGEM NO RAMAL DE ÁGUA - LOG - RETIRADA DE BY PASS",
    "941728": "SONDAGEM NO RAMAL DE ÁGUA - LOG - RETIRADA DE LIGAÇÃO CLANDE",
    "941729": "SONDAGEM NO RAMAL DE ÁGUA - LOG - S/ IRREG. E DESABITADO",
    "941730": "SONDAGEM NO RAMAL DE ÁGUA - LOG - MATRÍCULA IDENTIFICADA",
    "942401": "CONSERTO DE RAMAL DE ÁGUA - IMPROCEDENTE - U.C",
    "942402": "CONSERTO REDE ÁGUA - IMPROCEDENTE",
    "942403": "PESQUISA DE VAZAMENTO - NÃO LOCALIZADO",
    "942404": "PESQUISA DE VAZAMENTO - NÃO LOCALIZADO",
    "942405": "CONSERTO DE RAMAL DE ÁGUA - IMPROCEDENTE - LOG",
    "942408": "VERIFICAÇÃO PRÉVIA DE VAZAMENTO DE ÁGUA - UC - IMPROCEDENTE",
    "942409": "VERIFICAÇÃO PRÉVIA DE VAZAMENTO DE ÁGUA - UC - PROCEDENTE",
    "942410": "CONSERTO DE RAMAL DE ÁGUA - PROCEDENTE - U.C",
    "942411": "CONSERTO DE RAMAL DE ÁGUA - PROCEDENTE - LOG",
    "942601": "CONSERTO RAMAL ESGOTO - IMPROCEDENTE",
    "942602": "CONSERTO REDE ESGOTO - IMPROCEDENTE",
    "942901": "COLETA DE AMOSTRA - COM DESCARGA NO CAVALETE",
    "942903": "COLETA DE AMOSTRA - COM DESCARGA DE REDE",
    "942904": "COLETA DE AMOSTRA - SEM DESCARGA",
    "943701": "VERIFICAÇÃO PRÉVIA DE VAZAMENTO ÁGUA - IMPROCEDENTE",
    "943702": "VERIFICAÇÃO PRÉVIA DE VAZAMENTO ÁGUA - PROCEDENTE",
    "943801": "SUPRESSÃO DE LIGAÇÃO CLANDESTINA - IMPROCEDENTE",
    "943802": "SUPRESSÃO DE LIGAÇÃO CLANDESTINA - IRREGULARIDADE RETIRADA",
    "952602": "VERIFICAÇÃO PRÉVIA DE VAZAMENTO DE ESGOTO - IMPROCEDENTE",
    "952604": "VERIFICAÇÃO PRÉVIA DE VAZAMENTO DE ESGOTO - PROCEDENTE",
    "952608": "DESOBSTRUÇÃO RAMAL DE ESGOTO - HIDROJATEAMENTO",
    "952609": "DESOBSTRUÇÃO RAMAL DE ESGOTO - VARETA",
    "952610": "DESOBSTRUÇÃO REDE DE ESGOTO - HIDROJATEAMENTO",
    "952611": "DESOBSTRUÇÃO REDE DE ESGOTO - VARETA",
    "952613": "DESOBSTRUÇÃO REDE DE ESGOTO - IMPROCEDENTE",
    "952617": "VERIFICAÇÃO RETORNO DE ESGOTO NO IMÓVEL - PROCEDENTE",
    "952633": "VISTORIA DE INSPEÇÃO FLAP - NÃO CONFORME",
    "952634": "VISTORIA DE INSPEÇÃO EM EEE - CONFORME",
    "952635": "VISTORIA DE INSPEÇÃO EM EEE - NÃO CONFORME",
    "954001": "VISTORIA QUALITATIVA DE ESGOTO - ADEQUADO",
    "954002": "VISTORIA QUALITATIVA DE ESGOTO - NOTIFICADO",
    "954003": "VISTORIA QUALITATIVA DE ESGOTO - ORIENTADO",
    "954004": "VISTORIA QUALITATIVA DE ESGOTO - SEM CONTATO",
    "954005": "VISTORIA QUALITATIVA DE ESGOTO - NÃO AUTORIZADO",
    "954006": "VISTORIA QUALITATIVA DE ESGOTO - SEM DISPONIBILIDADE DE REDE",
    "954007": "REVISTORIA QUALITATIVA DE ESGOTO - ADEQUADO",
    "954008": "REVISTORIA QUALITATIVA DE ESGOTO - INADEQUADO",
    "954009": "REVISTORIA QUALITATIVA DE ESGOTO - NÃO AUTORIZADO",
    "954010": "REVISTORIA QUALITATIVA DE ESGOTO - MORADOR AUSENTE",
    "971701": "FISC - CAVALETE - ABASTECIDO POR OUTRA LIGAÇÃO",
    "971702": "FISC - CAVALETE - LIGAÇÃO UNIFICADA",
    "971703": "FISC - RAMAL - LIGAÇÃO CLANDESTINA",
    "971704": "FISC - RAMAL - NECESSÁRIO SONDAGEM",
    "971705": "FISC - RAMAL - ABASTECIDO POR OUTRA LIGAÇÃO",
    "971706": "FISC - INATIVA - S/ IRREG. E DESABITADO",
    "971707": "FISC - INATIVA - ABASTECIDO POR OUTRA LIGAÇÃO",
    "971708": "FISC - INATIVA - LIGAÇÃO UNIFICADA",
    "971709": "FISC - RAMAL - LIGAÇÃO UNIFICADA",
    "971710": "FISC EXPLORATÓRIA - ABASTECIDO POR OUTRA LIGAÇÃO",
    "971711": "FISC EXPLORATÓRIA - BY PASS",
    "971712": "FISC EXPLORATÓRIA - CAVALETE VIOLADO",
    "971713": "FISC EXPLORATÓRIA - CORTE VIOLADO",
    "971714": "FISC EXPLORATÓRIA S/ IRREG. E DESABITADO",
    "971715": "FISC EXPLORATÓRIA - FONTE ALTERNATIVA",
    "971716": "FISC EXPLORATÓRIA - HIDRÔMETRO DANIFICADO",
    "971717": "FISC EXPLORATÓRIA - HIDRÔMETRO VIOLADO",
    "971718": "FISC EXPLORATÓRIA - LACRE VIOLADO",
    "971719": "FISC EXPLORATÓRIA - LIGAÇÃO CLANDESTINA",
    "971720": "FISC EXPLORATÓRIA - LIGAÇÃO UNIFICADA",
    "971721": "FISC EXPLORATÓRIA - NECESSÁRIO APOIO PERÍCIA",
    "971722": "FISC EXPLORATÓRIA - NECESSÁRIO SONDAGEM",
    "971723": "FISC EXPLORATÓRIA S/ IRREG. E HABITADA",
    "971724": "FISC - DENÚNCIA - S/ IRREG. E DESABITADO",
    "971725": "FISC EXPLORATÓRIA - FORNECIMENTO A TERCEIROS",
    "971734": "FISC - DENÚNCIA LOG - FONTE ALTERNATIVA",
    "971745": "FISC - DENÚNCIA - LIGAÇÃO UNIFICADA",
    "971746": "FISC - ATIVA - LIGAÇÃO UNIFICADA",
    "971747": "FISC - ATIVA - FONTE ALTERNATIVA",
    "971761": "FISC - ATIVA - NÃO REALIZADA/SEM ACESSO",
    "971762": "FISC - ATIVA - ABASTECIDO POR OUTRA LIGAÇÃO",
    "971763": "FISC - ATIVA - NECESSÁRIO SONDAGEM",
    "971765": "FISC - ATIVA - S/ IRREG. E DESABITADO",
    "971768": "RETIRADA DE BY PASS - IMPROCEDENTE",
  };

  const CODIGOS_VERIFICAR_ALTERACAO = new Set(["612423", "613706", "611402", "611401"]);
  const DESDOBROS_PERMITIDOS = {};

  for (const codigo of CODIGOS_MANUTENCAO_PARAMETRIZADOS) {
    DESDOBROS_PERMITIDOS[codigo] = [...POSTERIORES_MANUTENCAO_AUTORIZADOS];
  }

  for (const codigo of CODIGOS_SE_LIGA) {
    DESDOBROS_PERMITIDOS[codigo] = [...POSTERIORES_SE_LIGA_AUTORIZADOS];
  }

  const CODIGOS_DUPLICADOS_ENTRE_GRUPOS = [...CODIGOS_MANUTENCAO_PARAMETRIZADOS]
    .filter(codigo => CODIGOS_SE_LIGA.has(codigo));
  if (CODIGOS_DUPLICADOS_ENTRE_GRUPOS.length) {
    console.error('[AUDITORIA] Codigos duplicados entre Manutencao e Se Liga:', CODIGOS_DUPLICADOS_ENTRE_GRUPOS);
  }

  const CODIGO_DESCRICAO_MAP = Object.fromEntries(
    Object.entries(DESCRICOES_SERVICOS).map(([codigo, descricao]) => [codigo, `${codigo} - ${descricao}`])
  );

  const CAMPOS_DESDOBRAMENTO_CONDICIONAL = [
    { titulo: 'DC Asfalto Via Local', campo: FIELD_DC_ASFALTO_VIA_LOCAL },
    { titulo: 'DC Lajota Via Local', campo: FIELD_DC_LAJOTA_VIA_LOCAL },
    { titulo: 'DC Calcada Via Local', campo: FIELD_DC_CALCADA_VIA_LOCAL },
    { titulo: 'DC Calcada Via Arterial', campo: FIELD_DC_CALCADA_VIA_ARTERIAL },
    { titulo: 'DC Asfalto Via Arterial', campo: FIELD_DC_ASFALTO_VIA_ARTERIAL },
    { titulo: 'DC Lajota Via Arterial', campo: FIELD_DC_LAJOTA_VIA_ARTERIAL }
  ];

  function simNao(val) {
    if (val === "S" || val === "1") return "\u2705 SIM";
    if (val === "N" || val === "0") return "\u274c NAO";
    return val || null;
  }
  function hasValue(value) { return value !== null && value !== undefined && String(value).trim() !== ''; }
  function parsePositiveNumber(value) {
    if (!hasValue(value)) return 0;
    const normalized = String(value).trim().replace(',', '.');
    const match = normalized.match(/-?\d+(?:\.\d+)?/);
    if (!match) return 0;
    const number = Number(match[0]);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function formatHoraTermino(raw) {
    if (!hasValue(raw)) return null;
    const texto = String(raw).trim();

    const horaNoTexto = texto.match(/(?:T|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (horaNoTexto) {
      return `${String(horaNoTexto[1]).padStart(2, '0')}:${horaNoTexto[2]}`;
    }

    const horaSimples = texto.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (horaSimples) {
      return `${String(horaSimples[1]).padStart(2, '0')}:${horaSimples[2]}`;
    }

    if (/^\d{10,13}$/.test(texto)) {
      const numero = Number(texto);
      const data = new Date(texto.length === 10 ? numero * 1000 : numero);
      if (!Number.isNaN(data.getTime())) {
        return data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });
      }
    }
    return texto;
  }

  function formatDataEncerramento(raw) {
    if (!hasValue(raw)) return null;
    const texto = String(raw).trim();
    const matchBr = texto.match(/^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/);
    if (matchBr) {
      const [, dia, mes, anoRaw] = matchBr;
      const ano = anoRaw.length === 2 ? `20${anoRaw}` : anoRaw;
      return `${dia}/${mes}/${ano}`;
    }
    const matchIso = texto.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (matchIso) return `${matchIso[3]}/${matchIso[2]}/${matchIso[1]}`;
    return texto;
  }

  function formatDuracaoAtividade(raw) {
    if (!hasValue(raw)) return null;
    const texto = String(raw).trim();

    if (/hora|minuto/i.test(texto)) return texto;

    const minutosTotais = Number(texto.replace(',', '.'));
    if (!Number.isFinite(minutosTotais) || minutosTotais < 0) return texto;

    const minutosArredondados = Math.round(minutosTotais);
    const horas = Math.floor(minutosArredondados / 60);
    const minutos = minutosArredondados % 60;
    const partes = [];

    if (horas > 0) partes.push(`${horas} ${horas === 1 ? 'hora' : 'horas'}`);
    if (minutos > 0 || horas === 0) partes.push(`${minutos} ${minutos === 1 ? 'minuto' : 'minutos'}`);

    return partes.join(' ');
  }

  function formatServicoPosterior(raw) {
    if (!hasValue(raw)) return null;
    const original = String(raw).trim();
    const codigo = extractCodigo(original);
    if (!codigo) return original;
    if (DESCRICOES_SERVICOS[codigo]) return `${codigo} - ${DESCRICOES_SERVICOS[codigo]}`;
    const detalheOriginal = original.slice(original.indexOf(codigo) + codigo.length)
      .replace(/^\s*[-–—:]?\s*/, '').trim();
    return detalheOriginal
      ? `${codigo} - ${detalheOriginal}`
      : `${codigo} - Descricao nao cadastrada`;
  }

  function temCodigoServicoPreenchido(valor) {
    if (!hasValue(valor)) return false;
    return !/^(?:0|n|nao|não|false|none|null|-)$/i.test(String(valor).trim());
  }

  function montarServicoPosterior(activityData) {
    const rawCodigo = activityData?.[FIELD_SERVICO_POSTERIOR];
    if (!temCodigoServicoPreenchido(rawCodigo)) return [];
    const codigo = extractCodigo(rawCodigo);

    return [{ numero: 1, titulo: 'Servico Posterior (SP)', fieldId: FIELD_SERVICO_POSTERIOR,
      codigo, valorOriginal: String(rawCodigo).trim(),
      descricao: formatServicoPosterior(rawCodigo), origem: 'Servicos Posteriores - campo 1066' }];
  }

  function montarDesdobramentosCondicionais(activityData) {
    const condicionais = [];
    CAMPOS_DESDOBRAMENTO_CONDICIONAL.forEach(config => {
      const rawCodigo = activityData?.[config.campo];
      if (!temCodigoServicoPreenchido(rawCodigo)) return;
      const codigo = extractCodigo(rawCodigo);

      condicionais.push({ numero: condicionais.length + 1, titulo: config.titulo,
        fieldId: config.campo, codigo, valorOriginal: String(rawCodigo).trim(),
        descricao: formatServicoPosterior(rawCodigo),
        origem: 'Desdobramento Condicional Sergipe' });
    });
    return condicionais;
  }

  function extractCodigo(value) {
    const match = String(value || '').match(/(?:^|\D)(\d{6})(?:\D|$)/);
    return match ? match[1] : '';
  }

  function normalizeText(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  }

  function extractEquipeCode(value) {

    const match = String(value || '').match(/\bSER[A-Z0-9]+T\b/i);
    return match ? match[0].toUpperCase() : '';
  }

  function resolverRecursoDaConsulta(resposta, aid, pid) {
    const providerId = String(pid ?? '').trim();
    const provider = resposta?.delta?.Provider?.[providerId];
    const porPname = extractEquipeCode(provider?.pname);
    if (porPname) {
      return { equipe: porPname, origem: 'delta.Provider.pname', providerId, candidatos: [] };
    }

    const formularios = Object.values(resposta?.delta?.FormData || {})
      .filter(form => form &&
        String(form.activity_id ?? '') === String(aid) &&
        String(form.provider_id ?? '') === providerId);
    const candidatos = [...new Set(formularios
      .map(form => extractEquipeCode(form.user_name))
      .filter(Boolean))];
    if (candidatos.length === 1) {
      return { equipe: candidatos[0], origem: 'delta.FormData.user_name', providerId, candidatos };
    }
    return {
      equipe: '',
      origem: candidatos.length > 1 ? 'conflito_formdata' : 'nao_identificado',
      providerId,
      candidatos
    };
  }

  function recurso(atividade, recursoAtual = '', equipeGrade = '', origemRecurso = '') {
    const equipe = extractEquipeCode(recursoAtual);
    if (equipe) return { exibido: equipe, valido: true, codigo: equipe };

    if (origemRecurso === 'conflito_formdata') {
      return { exibido: 'Nao identificado', valido: false, codigo: '' };
    }
    const fallback = extractEquipeCode(equipeGrade);
    return fallback
      ? { exibido: fallback, valido: true, codigo: fallback }
      : { exibido: 'Nao identificado', valido: false, codigo: '' };
  }

  function resolveMatricula(data, activityData) {
    const candidates = [activityData?.['226'],activityData?.matricula,activityData?.matricula_uc,activityData?.account_number,activityData?.customer_number,data?.matricula];
    for (const value of candidates) {
      const textValue = String(value ?? '').trim();
      if (textValue && !/^desconhecida$/i.test(textValue)) return textValue;
    }
    return '';
  }
  function resolveHidrometro(data, activityData) {
    const candidates = [activityData?.[FIELD_HIDROMETRO], data?.hidrometro];
    for (const value of candidates) {
      const textValue = String(value ?? '').trim();
      if (textValue && !/^desconhecid[oa]$/i.test(textValue)) return textValue;
    }
    return 'Nao Encontrado';
  }

  function mapearEquipesVisiveis() {
    return Array.from(document.querySelectorAll('div[data-field="pname"], div[data-field="resource"], div[data-field="resource_name"]'))
      .map(el => {
        const equipe = extractEquipeCode(el.textContent);
        if (!equipe) return null;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        return { equipe, centroY: rect.top + rect.height / 2 };
      })
      .filter(Boolean);
  }

  function getEquipeFromDiv(div, equipesVisiveis = null) {
    const rowIndex = getRowIndex(div);
    const grid = getGridContainer(div);
    const osCell = rowIndex === null
      ? null
      : (grid.querySelector(`div[data-row-index="${rowIndex}"][data-field="appt_number"]`) ||
         document.querySelector(`div[data-row-index="${rowIndex}"][data-field="appt_number"]`));
    const rect = (osCell || div)?.getBoundingClientRect?.();
    if (!rect || rect.width === 0 || rect.height === 0) return '';
    const centroOs = rect.top + rect.height / 2;
    const candidatos = equipesVisiveis || mapearEquipesVisiveis();
    let melhorEquipe = '';
    let menorDistancia = 30;
    for (const item of candidatos) {
      const distancia = Math.abs(item.centroY - centroOs);
      if (distancia < menorDistancia) {
        menorDistancia = distancia;
        melhorEquipe = item.equipe;
      }
    }
    return melhorEquipe;
  }

  function analisarDesdobramento({
    codigoAbertura, quantidadeInformada, posteriores = [], desdobramentosCondicionais = [],
    naoExigePorDescricao = false, ehServicoAdicional = false, teveEscavacao = false
  }) {
    const manutencao = CODIGOS_MANUTENCAO_PARAMETRIZADOS.has(codigoAbertura);
    const seLiga = CODIGOS_SE_LIGA.has(codigoAbertura);
    const situacional = codigoAbertura === '612401' || codigoAbertura === '612501';
    const permitidos = DESDOBROS_PERMITIDOS[codigoAbertura] || null;
    const mensagens = [];
    let nivel = 'ok';
    let corretamente = 'N/A';
    const avisar = (gravidade, mensagem) => {
      if (!mensagens.includes(mensagem)) mensagens.push(mensagem);
      if (gravidade === 'erro') nivel = 'erro';
      else if (gravidade === 'verificar' && nivel !== 'erro') nivel = 'verificar';
    };

    const spPreenchidos = posteriores.length;
    const spCodigos = posteriores.map(p => p.codigo).filter(Boolean);
    const spSemCodigo = posteriores.filter(p => !p.codigo);
    const codigosDC = desdobramentosCondicionais.map(dc => dc.codigo).filter(Boolean);
    const dcDistintos = [...new Set(codigosDC)];
    const dcNaoReconhecidos = desdobramentosCondicionais.filter(dc => !dc.codigo);
    const dcDuplicados = [...new Set(codigosDC.filter((c, i) => codigosDC.indexOf(c) !== i))];
    const dcPermitidos = manutencao
      ? desdobramentosCondicionais.filter(dc => dc.codigo && POSTERIORES_MANUTENCAO_AUTORIZADOS.includes(dc.codigo))
      : [];
    const possuiSPValido = spCodigos.length > 0;
    const possuiDCValido = manutencao && dcPermitidos.length > 0;
    const possuiDesdobramentoValido = possuiSPValido || possuiDCValido;
    const necessidade = ehServicoAdicional ? 'Nao Aplicavel'
      : situacional ? 'Situacional'
      : naoExigePorDescricao ? 'Nao'
      : manutencao || seLiga ? 'Sim' : 'Verificar';

    if (ehServicoAdicional) {
      if (spPreenchidos) {
        avisar('erro', `ALERTA: O.S. adicional (/1) possui Servico Posterior verdadeiro: ${posteriores.map(p => p.codigo || p.valorOriginal).join(', ')}.`);
      } else {
        mensagens.push('OK! Servico Adicional (/1) identificado. Analise de desdobramento nao aplicavel.');
      }

      if (seLiga && desdobramentosCondicionais.length) {
        avisar('erro', `O Projeto Se Liga nao utiliza Desdobramento Condicional (DC). Foram preenchidos ${desdobramentosCondicionais.length} campo(s) DC. Utilize os quatro codigos autorizados apenas em Servico Posterior (SP).`);
      }
      return {
        tipoServicoAdicional: true, adicionalComPosterior: spPreenchidos > 0,
        necessidade, equipeDesdobrou: spPreenchidos ? 'Incorreto' : 'OK!',
        corretamente: nivel === 'erro' ? 'Nao' : 'Nao Aplicavel',
        nivel, mensagens, alteracaoCodigo: 'Nao Aplicavel'
      };
    }

    if (!manutencao && !seLiga) {
      avisar('verificar', `Codigo de abertura ${codigoAbertura || 'nao identificado'} nao parametrizado para analise de desdobramento.`);
    }
    for (const sp of spSemCodigo) {
      avisar('verificar', `Servico Posterior preenchido, mas sem codigo de 6 digitos identificavel: ${sp.valorOriginal || 'valor nao informado'}.`);
    }
    const spDuplicados = [...new Set(spCodigos.filter((c, i) => spCodigos.indexOf(c) !== i))];
    if (spDuplicados.length) avisar('verificar', `Servico Posterior duplicado: ${spDuplicados.join(', ')}.`);

    if (hasValue(quantidadeInformada)) {
      const qtdTexto = String(quantidadeInformada).trim();
      if (/^\d+$/.test(qtdTexto)) {
        const qtd = Number(qtdTexto);
        if (qtd !== spPreenchidos) {
          avisar('verificar', `Quantidade de posteriores informada no campo 1062 (${qtd}) difere dos campos SP encontrados (${spPreenchidos}).`);
        }
      }
    }

    for (const sp of posteriores) {
      if (!sp.codigo) continue;
      if (sp.codigo === '613608') {
        avisar('verificar', 'reaterro aberto em Serviço Posterior, verifique');
      } else if (permitidos && !permitidos.includes(sp.codigo)) {
        avisar('erro', `Codigo posterior nao permitido para esta abertura: ${sp.codigo}.`);
      } else if (!permitidos) {
        avisar('verificar', `Sem lista de permissao para conferir o codigo do Servico Posterior: ${sp.codigo}.`);
      }
    }

    if (seLiga && desdobramentosCondicionais.length > 0) {
      avisar('erro', `O Projeto Se Liga nao utiliza Desdobramento Condicional (DC). Foram preenchidos ${desdobramentosCondicionais.length} campo(s) DC. Utilize os quatro codigos autorizados apenas em Servico Posterior (SP).`);
    }
    if (manutencao && desdobramentosCondicionais.length) {
      const dcsForaDaLista = desdobramentosCondicionais.filter(dc => dc.codigo && !POSTERIORES_MANUTENCAO_AUTORIZADOS.includes(dc.codigo));
      if (dcsForaDaLista.length) {
        avisar('erro', `DC fora da lista permitida de Manutencao: ${[...new Set(dcsForaDaLista.map(dc => dc.codigo))].join(', ')}.`);
      }
      if (dcNaoReconhecidos.length) {
        avisar('verificar', `DC preenchido sem codigo de 6 digitos identificavel nos campos: ${dcNaoReconhecidos.map(dc => dc.titulo).join(', ')}.`);
      }
      if (dcDuplicados.length) {
        avisar('verificar', `DC repetido em campos diferentes: ${dcDuplicados.join(', ')}. Verificar preenchimento.`);
      }
      if (dcDistintos.length > 2) {
        avisar('erro', `Foram identificados ${dcDistintos.length} DC distintos. O limite operacional é 2 DC.`);
      }
    }
    if (!manutencao && !seLiga && desdobramentosCondicionais.length) {
      avisar('verificar', `DC identificado em abertura nao parametrizada. Conferir ${desdobramentosCondicionais.length} campo(s) preenchido(s).`);
    }

    if (situacional && !spPreenchidos && !desdobramentosCondicionais.length) {
      avisar('verificar', 'Confira imagem se necessita.');
    } else if (necessidade === 'Sim' && !possuiDesdobramentoValido) {
      avisar('verificar', seLiga
        ? 'O codigo exige desdobramento, mas nenhum Servico Posterior (SP) valido foi localizado.'
        : 'O codigo exige desdobramento, mas nenhum Servico Posterior ou DC valido foi localizado.');
    } else if (necessidade === 'Nao' && (spPreenchidos || desdobramentosCondicionais.length)) {
      avisar('verificar', 'O codigo nao exige desdobramento, mas possui Servico Posterior ou DC. Verificar necessidade.');
    }

    if (teveEscavacao && !possuiDesdobramentoValido) {
      avisar('erro', seLiga
        ? 'Escavacao identificada sem Servico Posterior (SP) valido.'
        : 'Escavacao identificada sem Servico Posterior ou Desdobramento Condicional valido.');
    }

    const equipeDesdobrou = possuiDesdobramentoValido
      ? (possuiDCValido && !possuiSPValido ? 'Sim - via DC' : 'Sim')
      : necessidade === 'Nao' ? 'N/A' : 'Nao localizado';
    corretamente = nivel === 'erro' ? 'Nao' : nivel === 'verificar' ? 'Verificar' :
      (possuiDesdobramentoValido ? 'Sim' : 'N/A');
    return {
      necessidade, equipeDesdobrou, corretamente, nivel, mensagens,
      alteracaoCodigo: CODIGOS_VERIFICAR_ALTERACAO.has(codigoAbertura) ? 'Verificar' : 'N/A',
      qtdDCDistintos: dcDistintos.length
    };
  }

  const FIELD_PARECER_SOLICITACAO = "210";
  const FIELD_PARECER     = "223";
  const FIELD_DURACAO_ATIVIDADE = "length";

  const FIELD_DATA_ENCERRAMENTO = "date";
  const FIELD_MOTIVO_NAO_EXECUCAO_SER = "1679";

  const MOTIVO_NAO_EXECUCAO_SER_MAP = {
    "33": "Ja executado por outra equipe",
    "215": "Area de Risco",
    "82": "Auxilio Geofone",
    "83": "Auxilio Retro",
    "216": "Cancelado - Sansys Smart Meter",
    "24": "Cavalete de ferro",
    "168": "Cliente apresentou pagamento",
    "8": "Cliente Declinou do Pedido",
    "81": "Cliente nao permitiu a execucao",
    "218": "Conserto parcial",
    "104": "Consumidor declinou do pedido",
    "23": "Corte indevido",
    "71": "Desabitado/Abandonado",
    "210": "Desobstrucao parcial",
    "217": "Desobstrucao parcial",
    "20": "Encerrado tempo limite para execucao",
    "17": "Encerramento ordem servico execucao",
    "15": "Endereco nao localizado",
    "19": "Endereco nao localizado",
    "9": "Equipe Ineficiente",
    "214": "Evolucao do Corte - Morador Ausente",
    "10": "Falta de Material",
    "22": "Hidrometro enterrado",
    "166": "Hidrometro soterrado - Postergar",
    "11": "Inexistencia de Rede - Postergar",
    "69": "Morador Ausente",
    "209": "Necessita Retroescavadeira",
    "21": "Negociacao para pagamento",
    "25": "Outros",
    "16": "Portao fechado",
    "212": "Portao Fechado - Cancelar",
    "77": "Postergar - Necessita Escavacao",
    "169": "Responsavel nao estava no local",
    "205": "Sem Abastecimento no momento",
    "170": "Sem acesso ao hidrometro - Postergar",
    "167": "Servico Agendado com Cliente - Postergar",
    "27": "Solicitacao Improcedente",
    "213": "Solicitacao Improcedente",
    "4": "Solicitacao Indevida",
    "1": "Suspenso Desdobramento",
    "2": "Suspenso Parcela a Vista",
    "208": "Visitas Improdutivas"
};

  function formatMotivoNaoExecucaoSer(raw) {
    if (!hasValue(raw)) return null;
    const valor = String(raw).trim();

    if (MOTIVO_NAO_EXECUCAO_SER_MAP[valor]) return MOTIVO_NAO_EXECUCAO_SER_MAP[valor];
    if (!/^\d+$/.test(valor)) return valor;
    return valor;
  }

  function obterMotivoNaoExecucaoSer(activityData, fallback = null) {
    const valorGrade = formatMotivoNaoExecucaoSer(fallback);
    if (valorGrade) return valorGrade;

    const valorObjeto = formatMotivoNaoExecucaoSer(activityData?.[FIELD_MOTIVO_NAO_EXECUCAO_SER]);
    if (valorObjeto) return valorObjeto;

    return null;
  }

  const CACHE_TTL_MS      = 1000 * 60 * 30;
  const TEMPLATE_KEY      = "toa_sync_template_v2";
  const ACTIVITY_CACHE_KEY = "toa_activity_cache_v626_provider_formdata_pid";
  const CSRF_KEY          = "toa_csrf_token_v2";

  const tsNow = () => Date.now();

  function safeJsonParse(s, fallback = null) {
    try { return JSON.parse(s); } catch { return fallback; }
  }
  function saveSession(key, obj) { sessionStorage.setItem(key, JSON.stringify(obj)); }
  function loadSession(key, fallback) {
    const v = safeJsonParse(sessionStorage.getItem(key), null);
    return v ?? fallback;
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return m ? decodeURIComponent(m[1]) : "";
  }
  function setCsrf(token) {
    const t = String(token || "").trim();
    if (!t) return;
    saveSession(CSRF_KEY, { token: t, ts: tsNow() });
  }
  function obterCsrfTokenRobusto() {
    const saved = loadSession(CSRF_KEY, null);
    if (saved?.token) return saved.token;
    const fromStorage = (localStorage.getItem("CSRFSecureToken") || sessionStorage.getItem("CSRFSecureToken") || "").trim();
    if (fromStorage) { setCsrf(fromStorage); return fromStorage; }
    const fromMeta = (document.querySelector('meta[name="x-ofs-csrf-secure"]')?.getAttribute("content") || document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") || "").trim();
    if (fromMeta) { setCsrf(fromMeta); return fromMeta; }
    const fromCookie = (getCookie("CSRFSecureToken") || getCookie("csrf") || getCookie("csrfToken") || "").trim();
    if (fromCookie) { setCsrf(fromCookie); return fromCookie; }
    return "";
  }
  function getWindowIdSafe() {
    const m = String(window.location.search || "").match(/[?&]window_id=([^&]*)/i);
    return (m ? m[1] : "") || "0000000000-0000-0000";
  }
  function obterDataSelecionada() {
    const btn = document.querySelector('button[data-ofsc-id="toolbar-date-button-value"]');
    const title = btn?.getAttribute("title") || btn?.getAttribute("aria-label") || "";
    const iso = title.match(/(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
    return new Date().toISOString().slice(0, 10);
  }
  function getTemplate() { return loadSession(TEMPLATE_KEY, null); }

  function interceptCsrfFromFetch() {
    const origFetch = window.fetch;
    window.fetch = async function(input, init) {
      try {
        const headers = init?.headers;
        const getHeader = (k) => {
          if (!headers) return "";
          if (headers instanceof Headers) return headers.get(k) || "";
          if (Array.isArray(headers)) { const found = headers.find(([kk]) => String(kk).toLowerCase() === k); return found ? String(found[1] || "") : ""; }
          return String(headers[k] || headers[k.toLowerCase()] || "");
        };
        const t = getHeader("x-ofs-csrf-secure");
        if (t) setCsrf(t);
      } catch {}
      return origFetch.apply(this, arguments);
    };
  }
  function interceptCsrfFromXHR() {
    const origSet = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
      try { if (String(name).toLowerCase() === "x-ofs-csrf-secure" && value) setCsrf(value); } catch {}
      return origSet.call(this, name, value);
    };
  }
  function interceptTemplateFromSyncWrite() {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__toa_url = url; this.__toa_method = method;
      return origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function(body) {
      try {
        const url = String(this.__toa_url || "");
        if (url.includes("m=sync") && url.includes("a=write") && String(this.__toa_method || "").toUpperCase() === "POST" && body instanceof FormData) {
          const fd = body;
          const tpl = {
            capturedAt: tsNow(),
            __protocol: fd.get("__protocol") || "7",
            dv: fd.get("dv") || "",
            trust: fd.get("trust") || "",
            u: fd.get("u") || "",
            qid: String(fd.get("qid") || ""),
            restriction: fd.get("restriction") || "0",
            dispatcher: fd.get("dispatcher") || "1",
            skip_delta: fd.get("skip_delta") || "0",
          };
          if (tpl.dv && tpl.trust && tpl.u && tpl.qid) saveSession(TEMPLATE_KEY, tpl);
        }
      } catch {}
      return origSend.call(this, body);
    };
  }

  async function fetchActivity({ aid, pid, date }) {
    const tpl = getTemplate();
    if (!tpl?.qid || !tpl?.dv || !tpl?.trust || !tpl?.u) {
      console.warn('[AUDITORIA] Consulta nao realizada: template de sincronizacao ausente.', { aid });
      return null;
    }
    const csrf = obterCsrfTokenRobusto();
    if (!csrf) {
      console.warn('[AUDITORIA] Consulta nao realizada: CSRF ausente.', { aid });
      return null;
    }

    const windowId = getWindowIdSafe();
    const formData = new FormData();
    formData.append('m', 'sync');           formData.append('a', 'write');
    formData.append('ajax', '1');          formData.append('window_id', windowId);
    formData.append('__protocol', tpl.__protocol || '7');
    formData.append('dv', tpl.dv);         formData.append('pid', String(pid));
    formData.append('qid', String(tpl.qid));formData.append('u', tpl.u);
    formData.append('f', 'json');          formData.append('pids', JSON.stringify([String(pid)]));
    formData.append('aids', JSON.stringify([String(aid)]));
    formData.append('restriction', tpl.restriction || '0');
    formData.append('fakeIds', '{}');      formData.append('trust', tpl.trust);
    formData.append('fakeIdsClean', '0');  formData.append('dq', date);
    formData.append('date', date);         formData.append('dispatcher', tpl.dispatcher || '1');
    formData.append('requestedAid', String(aid));
    formData.append('requestedDate', date);formData.append('skip_delta', '0');

    try {
      const resp = await fetch(
        `${location.origin}/?m=sync&a=write&ajax=1&window_id=${encodeURIComponent(windowId)}`,
        {
          method: 'POST', credentials: 'include', body: formData,
          headers: {
            'Accept': 'application/json',
            'x-ofs-csrf-secure': csrf,
            'x-platform': '1',
            'x-requested-with': 'XMLHttpRequest'
          }
        }
      );
      if (!resp.ok) {
        console.warn('[AUDITORIA] Consulta individual sem sucesso HTTP.', { aid, pid, http: resp.status });
        return null;
      }
      const resposta = safeJsonParse(await resp.text(), null);
      const activityObj = resposta?.delta?.Activity;
      if (!activityObj || typeof activityObj !== 'object') return null;
      const atividade = activityObj[String(aid)] || null;
      if (!atividade || typeof atividade !== 'object') return null;

      const resolucao = resolverRecursoDaConsulta(resposta, aid, pid);
      if (!resolucao.equipe) {
        const forms = Object.values(resposta?.delta?.FormData || {});
        console.warn('[AUDITORIA] Recurso nao localizado na resposta individual.', {
          aid: String(aid), pid: String(pid), origem: resolucao.origem,
          temProviderNoPid: Boolean(resposta?.delta?.Provider?.[String(pid)]),
          temPnameNoPid: Boolean(resposta?.delta?.Provider?.[String(pid)]?.pname),
          totalFormularios: forms.length,
          formulariosMesmoAIDPID: forms.filter(f => String(f?.activity_id ?? '') === String(aid) && String(f?.provider_id ?? '') === String(pid)).length
        });
      }
      if (resolucao.origem === 'conflito_formdata') {
        console.warn('[AUDITORIA] Equipes conflitantes nos formularios.', {
          aid, pid, candidatos: resolucao.candidatos
        });
      }
      return {
        sucesso: true,
        atividade,
        recursoAtual: resolucao.equipe,
        origemRecurso: resolucao.origem,
        providerId: resolucao.providerId,
        candidatosRecurso: resolucao.candidatos
      };
    } catch (erro) {
      console.warn('[AUDITORIA] Erro na consulta individual.', { aid, pid, erro });
      return null;
    }
  }

  const consultasEmAndamento = new Map();
  async function getActivityData(aid, pid, date) {
    if (!pid || !date) {
      console.warn('[AUDITORIA] Consulta individual sem PID/data na grade.', { aid, pid, date });
      return null;
    }
    const cacheKey = `${aid}|${pid}|${date}`;
    const cache = loadSession(ACTIVITY_CACHE_KEY, {}) || {};
    const salvo = cache[cacheKey];
    if (salvo && (tsNow() - salvo.ts) < CACHE_TTL_MS && salvo.data?.recursoAtual) return salvo.data;
    if (consultasEmAndamento.has(cacheKey)) return consultasEmAndamento.get(cacheKey);

    const promessa = (async () => {
      const result = await fetchActivity({ aid, pid, date });
      if (result?.sucesso && result.recursoAtual) {

        const cacheAtual = loadSession(ACTIVITY_CACHE_KEY, {}) || {};
        cacheAtual[cacheKey] = { ts: tsNow(), data: result };
        try { saveSession(ACTIVITY_CACHE_KEY, cacheAtual); }
        catch (erro) { console.warn('[AUDITORIA] Cache individual indisponivel.', erro); }
      }
      return result;
    })();
    consultasEmAndamento.set(cacheKey, promessa);
    try { return await promessa; }
    finally { consultasEmAndamento.delete(cacheKey); }
  }

  interceptCsrfFromFetch();
  interceptCsrfFromXHR();
  interceptTemplateFromSyncWrite();
  const preCsrf = obterCsrfTokenRobusto();
  if (preCsrf) setCsrf(preCsrf);

  function rolarParaBaixo() {
    const databody = document.getElementById('datagrid-top:databody');
    if (databody) databody.scrollTop += 500;
  }
  function rolarParaTopo() {
    const databody = document.getElementById('datagrid-top:databody');
    if (databody) databody.scrollTop = 0;
  }

  function getCurrentAidSet() {
    return new Set(Array.from(document.querySelectorAll('div[aid]')).map(d => d.getAttribute('aid')));
  }

  function waitForGridToStabilize({ checkIntervalMs = 200, stableChecksNeeded = 3, maxWaitMs = 6000 } = {}) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let lastSet = getCurrentAidSet();
      let stableCount = 0;

      const tick = () => {
        const currentSet = getCurrentAidSet();
        const igual = currentSet.size === lastSet.size && [...currentSet].every(v => lastSet.has(v));
        stableCount = igual ? stableCount + 1 : 0;
        lastSet = currentSet;

        const esgotouTempo = (Date.now() - startedAt) >= maxWaitMs;
        if (stableCount >= stableChecksNeeded || esgotouTempo) {
          resolve();
        } else {
          setTimeout(tick, checkIntervalMs);
        }
      };

      setTimeout(tick, checkIntervalMs);
    });
  }

  function confirmAndCloseAudit() {
    const confirmed = window.confirm(
      'Deseja realmente fechar a auditoria? Os dados não salvos poderão ser perdidos.'
    );
    if (confirmed) mainModal.style.display = 'none';
    return confirmed;
  }

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      if (imageModal.style.display === 'flex') { imageModal.style.display = 'none'; return; }
      if (mainModal.style.display === 'block') { mainModal.style.display = 'none'; return; }
      rolarParaBaixo();
      waitForGridToStabilize()
        .then(() => {
          rolarParaTopo();
          return waitForGridToStabilize();
        })
        .then(() => { showAllImages(); });
    }
    if (e.key === 'Escape') {
      if (imageModal.style.display === 'flex') {
        imageModal.style.display = 'none';
      } else if (mainModal.style.display === 'block') {
        e.preventDefault();
        confirmAndCloseAudit();
      }
    }
    if (imageModal.style.display === 'flex') {
      if (e.key === 'ArrowLeft') prevImgBtn.onclick();
      else if (e.key === 'ArrowRight') nextImgBtn.onclick();
    }
  });

  const mainModal = document.createElement('div');
  Object.assign(mainModal.style, {
    display: 'none', position: 'fixed', zIndex: '500000', inset: '0',
    width: '100%', height: '100%', overflow: 'hidden',
    backgroundColor: 'rgba(0,75,85,0.48)',
    backdropFilter: 'blur(8px) saturate(82%)', WebkitBackdropFilter: 'blur(8px) saturate(82%)',
    padding: '0', boxSizing: 'border-box'
  });
  document.body.appendChild(mainModal);

  const mainModalContent = document.createElement('div');
  Object.assign(mainModalContent.style, {
    position: 'fixed', left: '50%', top: '16px', transform: 'translateX(-50%)',
    width: 'calc(100vw - 40px)', maxWidth: '1520px', height: 'calc(100vh - 32px)',
    margin: '0', overflow: 'auto', backgroundColor: '#0F1519',
    borderRadius: '14px', padding: '20px', color: '#F2F7F8',
    border: '1px solid #285A63', boxShadow: '0 24px 70px rgba(0,0,0,.48)'
  });
  mainModalContent.className = 'fa-modal-content';
  mainModal.appendChild(mainModalContent);

  const cleanStyle = document.createElement('style');
  cleanStyle.textContent = `
    .fa-modal-content {
      max-width: 1360px !important;
      padding: 18px !important;
      background: #16191d !important;
      color: #eef2f6 !important;
      font-family: "Segoe UI", Arial, sans-serif !important;
    }
    .fa-modal-header {
      position: sticky !important;
      top: 0 !important;
      z-index: 20 !important;
      margin: -18px -18px 14px !important;
      padding: 14px 18px !important;
      background: rgba(22,25,29,.97) !important;
      border-bottom: 1px solid #343a42 !important;
      backdrop-filter: blur(8px);
    }
    .fa-modal-header h2 {
      font-size: 19px !important;
      font-weight: 650 !important;
      letter-spacing: .1px !important;
    }
    .fa-filter-bar {
      gap: 10px 14px !important;
      padding: 12px !important;
      margin-bottom: 8px !important;
      background: #1d2127 !important;
      border: 1px solid #343a42 !important;
      border-radius: 9px !important;
    }
    .fa-filter-bar label { color: #aeb7c2 !important; font-weight: 600 !important; }
    .fa-filter-bar select {
      min-width: 150px !important;
      height: 34px !important;
      padding: 5px 30px 5px 9px !important;
      background: #111419 !important;
      border: 1px solid #46505c !important;
      border-radius: 6px !important;
      font-weight: 500 !important;
    }
    .fa-filter-bar button { height: 34px !important; box-shadow: none !important; }
    .fa-results-summary {
      padding: 7px 3px 11px !important;
      margin-bottom: 4px !important;
      color: #9da8b5 !important;
      font-size: 12px !important;
    }
    .fa-items-container { gap: 18px !important; }
    .fa-os-card {
      padding: 14px !important;
      background: #20242a !important;
      border: 1px solid #3a414b !important;
      border-radius: 10px !important;
      box-shadow: 0 5px 18px rgba(0,0,0,.20) !important;
    }
    .fa-info-grid {
      display: grid !important;
      grid-template-columns: repeat(4, minmax(0, 1fr)) !important;
      gap: 8px !important;
      margin-bottom: 10px !important;
    }
    .fa-info-grid > div {
      min-width: 0 !important;
      padding: 8px 10px !important;
      border-color: #353c45 !important;
      background: #181c21 !important;
    }
    .fa-info-grid > div span:first-child { color: #8995a3 !important; }
    .fa-tech-section, .fa-auto-analysis, .fa-review-section {
      margin-bottom: 10px !important;
      border-radius: 8px !important;
      box-shadow: none !important;
    }
    .fa-tech-section > div:first-child,
    .fa-auto-analysis > div:first-child {
      padding: 7px 10px !important;
      font-size: 11px !important;
      letter-spacing: .35px !important;
    }
    .fa-review-section {
      padding: 11px !important;
      background: #191d22 !important;
      border-color: #3a424d !important;
    }
    .fa-review-section button {
      padding: 7px 10px !important;
      border-radius: 6px !important;
      box-shadow: none !important;
      font-size: 11px !important;
    }
    .fa-review-section select,
    .fa-review-section textarea,
    .fa-review-section input {
      min-height: 34px !important;
      background: #111419 !important;
      border-color: #46505c !important;
    }
    .fa-audit-workspace {
      min-width: 0 !important;
      width: 100% !important;
      box-sizing: border-box !important;
    }
    .fa-image-grid {
      grid-template-columns: repeat(4, minmax(0, 1fr)) !important;
      gap: 9px !important;
      min-width: 0 !important;
      width: 100% !important;
      max-width: 100% !important;
      box-sizing: border-box !important;
      overflow: hidden !important;
    }
    .fa-image-grid > div {
      min-width: 0 !important;
      width: 100% !important;
      max-width: 100% !important;
      border-radius: 7px !important;
      box-sizing: border-box !important;
    }
    @media (max-width: 1050px) {
      .fa-info-grid { grid-template-columns: repeat(2, minmax(0,1fr)) !important; }
      .fa-image-grid { grid-template-columns: repeat(2, minmax(180px,1fr)) !important; }
      .fa-audit-workspace { grid-template-columns: 1fr !important; }
    }
    @media (max-width: 720px) {
      .fa-info-grid { grid-template-columns: 1fr !important; }
      .fa-image-grid { grid-template-columns: repeat(2, minmax(150px,1fr)) !important; }
      .fa-filter-bar { align-items: stretch !important; }
      .fa-description-opinion-section > div:last-child { grid-template-columns: 1fr !important; }
      .fa-alerts-layout { grid-template-columns: 1fr !important; }
      .fa-alerts-layout > * { grid-row: auto !important; }
      .fa-alerts-layout > div > div { min-width: 0 !important; }
    }
    :root{--sl-bg:#0F1519;--sl-panel:#151D22;--sl-card:#1A2329;--sl-field:#11181D;--sl-line:#2D4149;--sl-text:#F2F7F8;--sl-muted:#9FB0B6;--sl-water:#37B4C8;--sl-teal:#004B55}
    .fa-modal-content{max-width:1520px!important;background:linear-gradient(180deg,#11191E 0%,#0E1418 100%)!important;color:var(--sl-text)!important;border:1px solid #285A63!important;box-shadow:0 24px 70px rgba(0,0,0,.48)!important}
    .fa-modal-header{background:rgba(15,21,25,.97)!important;border-bottom:3px solid var(--sl-water)!important;box-shadow:0 5px 20px rgba(0,0,0,.30)!important;backdrop-filter:blur(10px)!important}
    .app-dark-brand{display:flex;align-items:center;gap:16px;min-width:360px}.app-dark-brand img{width:126px;height:auto;object-fit:contain;filter:drop-shadow(0 2px 5px rgba(0,0,0,.25))}.app-dark-copy{min-width:0}.app-dark-kicker{color:var(--sl-water);font-size:11px;font-weight:900;letter-spacing:1.3px;text-transform:uppercase;margin-bottom:3px}.app-dark-title{color:#F4FAFB!important;font-size:22px!important;font-weight:850!important;line-height:1.15!important;margin:0!important}
    .fa-filter-bar{background:#151D22!important;border:1px solid var(--sl-line)!important;border-radius:10px!important;box-shadow:0 5px 18px rgba(0,0,0,.18)!important}.fa-filter-bar label{color:#C3D0D4!important}.fa-filter-bar select,.fa-review-section select,.fa-review-section textarea,.fa-review-section input{background:#0C1216!important;color:#F2F7F8!important;border:1px solid #3B555E!important;color-scheme:dark!important}.fa-filter-bar select:focus,.fa-review-section select:focus,.fa-review-section textarea:focus,.fa-review-section input:focus{outline:none!important;border-color:var(--sl-water)!important;box-shadow:0 0 0 3px rgba(55,180,200,.14)!important}
    .fa-os-card{background:#182126!important;color:#F2F7F8!important;border:1px solid #30464F!important;border-top:4px solid var(--sl-water)!important;box-shadow:0 9px 28px rgba(0,0,0,.25)!important}.fa-os-card>div:first-child{border-bottom-color:#30464F!important}.fa-info-grid>div{background:#11181D!important;border-color:#2C4149!important}.fa-info-grid>div span:first-child{color:#83C8D4!important;font-weight:750!important}.fa-info-grid>div span:last-child{color:#F2F7F8!important;font-weight:650!important}
    .fa-tech-section,.fa-auto-analysis,.fa-review-section{border-color:#30464F!important}.fa-description-opinion-section>div:first-child{background:#16272D!important;color:#6DD0DF!important}.fa-description-opinion-section>div:last-child,.fa-description-opinion-section>div:last-child>div{background:#11181D!important;color:#F2F7F8!important}.fa-description-opinion-section span{color:#8EA5AC!important}.fa-description-opinion-section div{color:#F2F7F8!important}
    .fa-review-section{background:#141C21!important;border:1px solid #30464F!important}.fa-review-section>div:not(:first-child)>div{background:#0F161A!important}.fa-image-grid>div{border-color:#38545E!important;background:#0B1013!important;box-shadow:0 4px 12px rgba(0,0,0,.22)}.fa-results-summary{color:#AEBFC4!important}.fa-bottom-export-area{background:#151D22!important;border-color:#30464F!important}
    #auditoria-filtros button{box-shadow:0 3px 10px rgba(0,0,0,.24)!important}.fa-modal-header button{box-shadow:0 3px 10px rgba(0,0,0,.22)!important}
    @media(max-width:760px){.app-dark-brand{min-width:260px}.app-dark-brand img{width:92px}.app-dark-title{font-size:17px!important}.fa-modal-content{width:calc(100vw - 14px)!important;height:calc(100vh - 14px)!important;top:7px!important}}
  `;
  document.head.appendChild(cleanStyle);

  const modalHeader = document.createElement('div');
  Object.assign(modalHeader.style, {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: '20px', paddingBottom: '15px', borderBottom: '2px solid #333'
  });
  modalHeader.className = 'fa-modal-header';
  mainModalContent.appendChild(modalHeader);

  const modalBrand = document.createElement('div');
  modalBrand.className = 'app-dark-brand';
  const modalLogo = document.createElement('img');
  if (LOGO_DATA_URL) modalLogo.src = LOGO_DATA_URL; else modalLogo.style.display = 'none';
  modalLogo.alt = 'Logo';
  const modalBrandCopy = document.createElement('div');
  modalBrandCopy.className = 'app-dark-copy';
  const modalKicker = document.createElement('div');
  modalKicker.className = 'app-dark-kicker';
  modalKicker.textContent = 'Auditoria Operacional';
  const modalTitle = document.createElement('h2');
  modalTitle.className = 'app-dark-title';
  modalTitle.textContent = 'Auditoria de OS - Se Liga';
  modalBrandCopy.append(modalKicker, modalTitle);
  modalBrand.append(modalLogo, modalBrandCopy);
  modalHeader.appendChild(modalBrand);

  const modalHeaderActions = document.createElement('div');
  Object.assign(modalHeaderActions.style, {
    display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
    gap: '8px', flexWrap: 'wrap', marginLeft: '12px'
  });

  const osSearchInput = document.createElement('input');
  osSearchInput.type = 'search';
  osSearchInput.placeholder = 'Numero da O.S.';
  osSearchInput.setAttribute('aria-label', 'Numero da O.S. para pesquisa');
  Object.assign(osSearchInput.style, {
    width: '180px', height: '34px', padding: '7px 10px',
    backgroundColor: '#111419', color: 'white', border: '1px solid #46505c',
    borderRadius: '6px', fontSize: '13px', outline: 'none'
  });

  const osSearchBtn = document.createElement('button');
  osSearchBtn.type = 'button';
  osSearchBtn.innerHTML = '\ud83d\udd0d Pesquisar';
  Object.assign(osSearchBtn.style, {
    padding: '8px 14px', backgroundColor: '#34506b', color: 'white',
    border: 'none', borderRadius: '6px', cursor: 'pointer',
    fontSize: '14px', fontWeight: 'bold', whiteSpace: 'nowrap'
  });

  const topFiltersBtn = document.createElement('button');
  topFiltersBtn.type = 'button';
  topFiltersBtn.innerHTML = '\ud83d\udd0d Filtros';
  Object.assign(topFiltersBtn.style, {
    padding: '8px 14px', backgroundColor: '#34506b', color: 'white',
    border: 'none', borderRadius: '6px', cursor: 'pointer',
    fontSize: '14px', fontWeight: 'bold', whiteSpace: 'nowrap'
  });
  topFiltersBtn.onclick = () => {
    const filtros = document.getElementById('auditoria-filtros') || filterBar;
    filtros.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const closeMainBtn = document.createElement('button');
  closeMainBtn.innerHTML = '\u2715 Fechar';
  Object.assign(closeMainBtn.style, {
    padding: '8px 16px', backgroundColor: '#dc3545', color: 'white',
    border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold'
  });
  closeMainBtn.onclick = confirmAndCloseAudit;

  modalHeaderActions.appendChild(osSearchInput);
  modalHeaderActions.appendChild(osSearchBtn);
  modalHeaderActions.appendChild(topFiltersBtn);
  modalHeaderActions.appendChild(closeMainBtn);
  modalHeader.appendChild(modalHeaderActions);

  const filterBar = document.createElement('div');
  Object.assign(filterBar.style, {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center',
    gap: '10px 20px', marginBottom: '10px', paddingBottom: '15px', borderBottom: '1px solid #333'
  });
  filterBar.className = 'fa-filter-bar';
  filterBar.id = 'auditoria-filtros';
  mainModalContent.appendChild(filterBar);

  function createFilterSelect(labelText) {
    const group = document.createElement('div');
    Object.assign(group.style, { display: 'flex', alignItems: 'center', gap: '8px' });

    const label = document.createElement('label');
    label.textContent = labelText;
    Object.assign(label.style, { color: '#aaa', fontSize: '13px', fontWeight: 'bold', whiteSpace: 'nowrap' });

    const select = document.createElement('select');
    Object.assign(select.style, {
      padding: '7px 10px', backgroundColor: '#2a2a2a', color: 'white',
      border: '1px solid #555', borderRadius: '6px', fontSize: '13px',
      fontWeight: 'bold', cursor: 'pointer', maxWidth: '280px'
    });

    group.appendChild(label);
    group.appendChild(select);
    filterBar.appendChild(group);
    return select;
  }

  const situacaoFilterSelect = createFilterSelect('Situacao:');
  [
    { value: 'todos', text: 'Todos' },
    { value: 'concluido', text: '\u2714 Concluido' },
    { value: 'nao_concluido', text: '\u2716 Nao Concluido' },
    { value: 'preenchidos', text: 'Preenchidos' },
    { value: 'nao_preenchidos', text: 'Não Preenchidos' },
    { value: 'hora_maior_menor', text: 'Hora de término: maior → menor' },
  ].forEach(({ value, text }) => {
    const opt = document.createElement('option');
    opt.value = value; opt.textContent = text;
    situacaoFilterSelect.appendChild(opt);
  });
  situacaoFilterSelect.onchange = () => {
    activeFilters.situacao = situacaoFilterSelect.value;
    onFilterChanged();
  };

  const descricaoFilterSelect = createFilterSelect('Descricao:');
  descricaoFilterSelect.style.display = 'none';
  const descricaoFilterGroup = descricaoFilterSelect.parentElement;
  descricaoFilterGroup.style.position = 'relative';

  const descricaoMultiButton = document.createElement('button');
  descricaoMultiButton.type = 'button';
  descricaoMultiButton.textContent = 'Todos';
  Object.assign(descricaoMultiButton.style, {
    minWidth: '280px', maxWidth: '420px', height: '34px', padding: '5px 30px 5px 10px',
    backgroundColor: '#111419', color: 'white', border: '1px solid #46505c',
    borderRadius: '6px', cursor: 'pointer', textAlign: 'left', fontSize: '13px',
    fontWeight: 'bold', position: 'relative', overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  });
  descricaoMultiButton.innerHTML = '<span>Todos</span><span style="position:absolute;right:10px;">\u25be</span>';

  const descricaoMultiPanel = document.createElement('div');
  Object.assign(descricaoMultiPanel.style, {
    display: 'none', position: 'absolute', zIndex: '500100', top: '38px', left: '0',
    width: '520px', maxWidth: '80vw', maxHeight: '360px', overflow: 'hidden',
    backgroundColor: '#15191e', border: '1px solid #56606c', borderRadius: '8px',
    boxShadow: '0 12px 30px rgba(0,0,0,.55)'
  });

  const descricaoMultiActions = document.createElement('div');
  Object.assign(descricaoMultiActions.style, {
    display: 'flex', gap: '7px', padding: '9px', borderBottom: '1px solid #343b44',
    backgroundColor: '#1d2228', position: 'sticky', top: '0'
  });
  const descricaoSearch = document.createElement('input');
  descricaoSearch.placeholder = 'Pesquisar servico...';
  Object.assign(descricaoSearch.style, {
    flex: '1', minWidth: '150px', padding: '6px 8px', borderRadius: '5px',
    border: '1px solid #4b5563', backgroundColor: '#0f1216', color: 'white'
  });
  function createSmallAction(text) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.textContent = text;
    Object.assign(btn.style, {
      padding: '6px 9px', border: '1px solid #4b5563', borderRadius: '5px',
      backgroundColor: '#2a3038', color: 'white', cursor: 'pointer', fontSize: '11px'
    });
    return btn;
  }
  const marcarVisiveisBtn = createSmallAction('Marcar visiveis');
  const limparDescricaoBtn = createSmallAction('Limpar');
  descricaoMultiActions.appendChild(descricaoSearch);
  descricaoMultiActions.appendChild(marcarVisiveisBtn);
  descricaoMultiActions.appendChild(limparDescricaoBtn);

  const descricaoChecklist = document.createElement('div');
  Object.assign(descricaoChecklist.style, {
    maxHeight: '300px', overflowY: 'auto', padding: '7px'
  });
  descricaoMultiPanel.appendChild(descricaoMultiActions);
  descricaoMultiPanel.appendChild(descricaoChecklist);
  descricaoFilterGroup.appendChild(descricaoMultiButton);
  descricaoFilterGroup.appendChild(descricaoMultiPanel);

  function updateDescricaoButton() {
    const selected = activeFilters.descricoes || [];
    const label = selected.length === 0
      ? 'Todos'
      : selected.length === 1
        ? selected[0]
        : `${selected.length} servicos selecionados`;
    descricaoMultiButton.innerHTML = `<span>${label}</span><span style="position:absolute;right:10px;">\u25be</span>`;
    descricaoMultiButton.title = selected.length ? selected.join('\n') : 'Todos os servicos';
  }

  descricaoMultiButton.onclick = (event) => {
    event.stopPropagation();
    descricaoMultiPanel.style.display = descricaoMultiPanel.style.display === 'none' ? 'block' : 'none';
    if (descricaoMultiPanel.style.display === 'block') descricaoSearch.focus();
  };
  descricaoMultiPanel.onclick = event => event.stopPropagation();
  document.addEventListener('click', () => { descricaoMultiPanel.style.display = 'none'; });

  descricaoSearch.oninput = () => {
    const query = normalizeText(descricaoSearch.value);
    [...descricaoChecklist.querySelectorAll('label[data-description]')].forEach(label => {
      label.style.display = !query || normalizeText(label.dataset.description).includes(query) ? 'flex' : 'none';
    });
  };
  marcarVisiveisBtn.onclick = () => {
    const visible = [...descricaoChecklist.querySelectorAll('label[data-description]')]
      .filter(label => label.style.display !== 'none')
      .map(label => label.dataset.description);
    activeFilters.descricoes = [...new Set([...(activeFilters.descricoes || []), ...visible])];
    renderDescriptionChecklist();
    onFilterChanged();
  };
  limparDescricaoBtn.onclick = () => {
    activeFilters.descricoes = [];
    renderDescriptionChecklist();
    onFilterChanged();
  };

  const motivoFilterSelect = createFilterSelect('Motivo da Não Execução SER:');
  motivoFilterSelect.onchange = () => {
    activeFilters.motivo = motivoFilterSelect.value;
    onFilterChanged();
  };

  const analiseFilterSelect = createFilterSelect('Analise:');

  analiseFilterSelect.parentElement.remove();
  [
    { value: 'todos', text: 'Todos' },
    { value: 'nao_analisado', text: 'Nao analisados' },
    { value: 'correto', text: '\u2705 Tudo correto' },
    { value: 'desvio', text: '\u26d4 Desvio confirmado' },
    { value: 'revisao', text: '\ud83d\udd0e Revisao manual' },
    { value: 'aguardando', text: '\u23f3 Aguardando informacao' }
  ].forEach(({ value, text }) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    analiseFilterSelect.appendChild(opt);
  });
  analiseFilterSelect.onchange = () => {
    activeFilters.analise = analiseFilterSelect.value;
    renderCards();
  };

  const exportAnalysisBtn = document.createElement('button');
  exportAnalysisBtn.textContent = '\ud83d\udce5 Exportar Relatorio';
  Object.assign(exportAnalysisBtn.style, {
    padding: '8px 13px', backgroundColor: '#107c10', color: 'white',
    border: 'none', borderRadius: '6px', cursor: 'pointer',
    fontSize: '13px', fontWeight: 'bold'
  });
  filterBar.appendChild(exportAnalysisBtn);
  const exportPhotosXlsxBtn = document.createElement('button');
  exportPhotosXlsxBtn.textContent = '🖼️ XLSX Não Concluídas';
  Object.assign(exportPhotosXlsxBtn.style, {
    padding: '8px 12px', backgroundColor: '#007e87', color: '#fff', border: 'none',
    borderRadius: '6px', cursor: 'pointer', fontWeight: '700'
  });
  exportPhotosXlsxBtn.onclick = exportarFotosXlsx;
  filterBar.appendChild(exportPhotosXlsxBtn);

  const fetchMapsBtn = document.createElement('button');
  fetchMapsBtn.type = 'button';
  fetchMapsBtn.textContent = '🗺️ Buscar fotos do mapa';
  Object.assign(fetchMapsBtn.style, {
    padding: '8px 12px', backgroundColor: '#5b3fa8', color: '#fff', border: 'none',
    borderRadius: '6px', cursor: 'pointer', fontWeight: '700', whiteSpace: 'nowrap'
  });
  fetchMapsBtn.onclick = buscarMapasAutomaticamente;
  filterBar.appendChild(fetchMapsBtn);

  const saveAllAuditsBtn = document.createElement('button');
  saveAllAuditsBtn.type = 'button';
  saveAllAuditsBtn.textContent = 'Salvar todas as O.S.';
  Object.assign(saveAllAuditsBtn.style, {
    height: '34px', padding: '7px 14px', backgroundColor: '#0078d4', color: 'white',
    border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '13px',
    fontWeight: 'bold', whiteSpace: 'nowrap'
  });
  saveAllAuditsBtn.onclick = () => {
    const saveButtons = Array.from(itemsContainer.querySelectorAll('.fa-save-audit-button'));
    if (!saveButtons.length) {
      alert('Nenhuma O.S. exibida para salvar.');
      return;
    }

    let salvas = 0;
    let incompletas = 0;
    saveButtons.forEach(button => {
      if (typeof button.saveAuditSilently === 'function' && button.saveAuditSilently()) salvas++;
      else incompletas++;
    });

    renderCards();
    alert(`${salvas} O.S. salva(s). ${incompletas} O.S. não preenchida(s) foram ignoradas.`);
  };
  filterBar.appendChild(saveAllAuditsBtn);

  const resetAuditsBtn = document.createElement('button');
  resetAuditsBtn.type = 'button';
  resetAuditsBtn.textContent = '\ud83d\uddd1 Resetar auditoria';
  Object.assign(resetAuditsBtn.style, {
    height: '34px', padding: '7px 14px', backgroundColor: '#8b1e2d', color: 'white',
    border: '1px solid #b52a3d', borderRadius: '6px', cursor: 'pointer',
    fontSize: '13px', fontWeight: 'bold', whiteSpace: 'nowrap'
  });
  resetAuditsBtn.onclick = () => {
    const firstConfirmation = window.confirm(
      'Deseja apagar todas as auditorias e apontamentos salvos neste navegador?\n\n' +
      'Exporte o relatório antes de continuar. Esta ação não poderá ser desfeita.'
    );
    if (!firstConfirmation) return;

    const typedConfirmation = window.prompt('Para confirmar, digite RESETAR:');
    if (typedConfirmation !== 'RESETAR') {
      alert('Reset cancelado. Nenhum dado foi apagado.');
      return;
    }

    localStorage.removeItem(AUDIT_STORAGE_KEY);
    localStorage.removeItem(ANALYSIS_STORAGE_KEY);
    forcedSearchOS = '';
    osSearchInput.value = '';
    activeFilters = { situacao: 'todos', descricao: 'todos', descricoes: [], motivo: 'todos', analise: 'todos' };
    situacaoFilterSelect.value = 'todos';
    analiseFilterSelect.value = 'todos';
    motivoFilterSelect.value = 'todos';
    renderDescriptionChecklist();
    populateDynamicSelect(motivoFilterSelect, 'motivo', r => r.motivoSER);
    renderCards();
    alert('Memória da auditoria resetada com sucesso. O nome do auditor foi mantido.');
  };
  filterBar.appendChild(resetAuditsBtn);

  const resultsCountDiv = document.createElement('div');
  Object.assign(resultsCountDiv.style, { color: '#888', fontSize: '13px', marginBottom: '16px' });
  resultsCountDiv.className = 'fa-results-summary';
  mainModalContent.appendChild(resultsCountDiv);

  const itemsContainer = document.createElement('div');
  Object.assign(itemsContainer.style, { display: 'flex', flexDirection: 'column', gap: '30px' });
  itemsContainer.className = 'fa-items-container';
  mainModalContent.appendChild(itemsContainer);

  const imageModal = document.createElement('div');
  Object.assign(imageModal.style, {
    display: 'none', position: 'fixed', zIndex: '500001',
    left: '0', top: '0', width: '100%', height: '100%',
    backgroundColor: 'rgba(0,0,0,0.95)', alignItems: 'center',
    justifyContent: 'center', padding: '20px', boxSizing: 'border-box'
  });
  document.body.appendChild(imageModal);

  const imageModalContent = document.createElement('div');
  Object.assign(imageModalContent.style, {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', gap: '20px', maxWidth: '95%', maxHeight: '95vh'
  });
  imageModal.appendChild(imageModalContent);

  const modalImg = document.createElement('img');
  Object.assign(modalImg.style, {
    maxWidth: '90vw', maxHeight: '80vh', borderRadius: '8px',
    boxShadow: '0 0 20px rgba(255,255,255,0.3)', transition: 'transform 0.2s'
  });
  imageModalContent.appendChild(modalImg);

  let modalZoom = 1;
  let modalRotation = 0;
  function applyTransform() { modalImg.style.transform = `scale(${modalZoom}) rotate(${modalRotation}deg)`; }
  modalImg.addEventListener('wheel', function(e) {
    e.preventDefault();
    modalZoom = e.deltaY < 0 ? modalZoom + 0.1 : Math.max(0.1, modalZoom - 0.1);
    applyTransform();
  });

  const imageInfoDiv = document.createElement('div');
  Object.assign(imageInfoDiv.style, { color: 'white', fontSize: '16px', fontWeight: 'bold', textAlign: 'center' });
  imageModalContent.appendChild(imageInfoDiv);

  const imageControls = document.createElement('div');
  Object.assign(imageControls.style, {
    display: 'flex', justifyContent: 'center', gap: '15px',
    position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
    backgroundColor: 'rgba(0,0,0,0.8)', padding: '10px 20px', borderRadius: '8px'
  });
  imageModal.appendChild(imageControls);

  function createControlButton(text, color = '#444') {
    const btn = document.createElement('button');
    btn.textContent = text;
    Object.assign(btn.style, {
      padding: '8px 16px', backgroundColor: color, color: 'white',
      border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '14px', fontWeight: 'bold'
    });
    return btn;
  }

  const prevImgBtn     = createControlButton('\u25c0 Anterior');
  const downloadImgBtn = createControlButton('\u2b07 Download', '#28a745');
  const rotateImgBtn   = createControlButton('\u21bb Girar', '#fd7e14');
  const closeImgBtn    = createControlButton('\u2715 Fechar', '#dc3545');
  const nextImgBtn     = createControlButton('Proximo \u25b6');

  imageControls.appendChild(prevImgBtn);
  imageControls.appendChild(downloadImgBtn);
  imageControls.appendChild(rotateImgBtn);
  imageControls.appendChild(closeImgBtn);
  imageControls.appendChild(nextImgBtn);

  let currentImages = [];
  let currentImageIndex = 0;
  let currentOSInfo = '';

  function showImageModal(images, index, osInfo) {
    currentImages = images; currentImageIndex = index; currentOSInfo = osInfo;
    modalZoom = 1; modalRotation = 0;
    updateImageModal();
    imageModal.style.display = 'flex';
  }
  function updateImageModal() {
    if (currentImages.length === 0) { imageModal.style.display = 'none'; return; }
    modalImg.src = currentImages[currentImageIndex];
    applyTransform();
    imageInfoDiv.textContent = `${currentOSInfo} \u2014 Imagem ${currentImageIndex + 1} de ${currentImages.length}`;
  }

  prevImgBtn.onclick     = () => { currentImageIndex = (currentImageIndex - 1 + currentImages.length) % currentImages.length; modalZoom = 1; modalRotation = 0; updateImageModal(); };
  nextImgBtn.onclick     = () => { currentImageIndex = (currentImageIndex + 1) % currentImages.length; modalZoom = 1; modalRotation = 0; updateImageModal(); };
  rotateImgBtn.onclick   = () => { modalRotation = (modalRotation + 90) % 360; applyTransform(); };
  closeImgBtn.onclick    = () => { imageModal.style.display = 'none'; };
  downloadImgBtn.onclick = () => {
    const link = document.createElement('a');
    link.href = currentImages[currentImageIndex];
    link.download = `${currentOSInfo.replace(/[^a-zA-Z0-9]/g, '_')}_img${currentImageIndex + 1}.jpg`;
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
  };
  imageModal.onclick = (e) => { if (e.target === imageModal) imageModal.style.display = 'none'; };

  function buildUrls(aid) {
    return baseUrls.map(url => url.replace(/eid=\d+/, `eid=${aid}`).replace('&a=thumbnail', '&a=download'));
  }
  function getRowIndex(div) {
    const cell = div.closest('[data-row-index]');
    if (cell) return cell.getAttribute('data-row-index');
    const aid = div.getAttribute('aid');
    if (aid) {
      const parentCell = document.querySelector(`div[data-row-index] div[aid="${aid}"]`);
      if (parentCell) { const row = parentCell.closest('[data-row-index]'); if (row) return row.getAttribute('data-row-index'); }
    }
    return null;
  }
  function getGridContainer(div) {
    return div.closest('[data-oj-container="ojDataGrid"]') || div.closest('.oj-datagrid') || document;
  }
  function getOSFromDiv(div) {
    const rowIndex = getRowIndex(div);
    if (!rowIndex) return 'Desconhecida';
    const grid = getGridContainer(div);
    const osDiv = grid.querySelector(`div[data-row-index="${rowIndex}"][data-field="appt_number"]`);
    if (!osDiv) {
      const g = document.querySelector(`div[data-row-index="${rowIndex}"][data-field="appt_number"]`);
      return g ? g.textContent.trim() : 'Desconhecida';
    }
    return osDiv.textContent.trim();
  }
  function getMatriculaFromDiv(div) {
    const rowIndex = getRowIndex(div);
    if (!rowIndex) return 'Desconhecida';
    const grid = getGridContainer(div);
    const cell = grid.querySelector(`div[data-row-index="${rowIndex}"][data-field="226"]`)
      || document.querySelector(`div[data-row-index="${rowIndex}"][data-field="226"]`);
    if (cell) return cell.textContent.trim();
    const headers = grid.querySelectorAll('div.oj-datagrid-column-header-cell[data-column-index]');
    for (const header of headers) {
      const text = header.textContent.trim().toLowerCase();
      if (text.includes('matricula') || text.includes('matricula')) {
        const colIndex = header.getAttribute('data-column-index');
        const fallbackCell = grid.querySelector(`div[data-row-index="${rowIndex}"][data-column-index="${colIndex}"]`)
          || document.querySelector(`div[data-row-index="${rowIndex}"][data-column-index="${colIndex}"]`);
        if (fallbackCell) return fallbackCell.textContent.trim();
      }
    }
    return 'Desconhecida';
  }

  function getFieldValue(div, fieldName) {
    const rowIndex = getRowIndex(div);
    if (!rowIndex) return '';
    const grid = getGridContainer(div);
    const cell = grid.querySelector(`div[data-row-index="${rowIndex}"][data-field="${fieldName}"]`)
      || document.querySelector(`div[data-row-index="${rowIndex}"][data-field="${fieldName}"]`);
    return cell ? cell.textContent.trim() : '';
  }
  function getStatusFromDiv(div) {
    const rowIndex = getRowIndex(div);
    if (!rowIndex) return '';
    const grid = getGridContainer(div);
    const statusDiv = grid.querySelector(`div[data-row-index="${rowIndex}"][data-field="astatus"]`)
      || document.querySelector(`div[data-row-index="${rowIndex}"][data-field="astatus"]`);
    return statusDiv ? statusDiv.textContent.trim().toLowerCase() : '';
  }
  function getParInfo(div) {
    const el = div.closest('[par_pid]') || div.querySelector('[par_pid]') || div;
    const pid  = (el.getAttribute('par_pid') || div.getAttribute('par_pid') || '').trim();
    const date = (el.getAttribute('par_date') || div.getAttribute('par_date') || '').trim();
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : obterDataSelecionada();
    return { pid, date: validDate };
  }

  const AUDIT_STORAGE_KEY = 'auditoria_operacional_checklist_v25';
  const AUDIT_ACTIONS = [
    'Cadastrar HD',
    'Corrigir HD',
    'Verificar e/ou Cancelar O.S.',
    'Realizar Recomposição',
    'Realizar Extensão de Rede',
    'Providenciar Material',
    'Providenciar Caixa de Piso',
    'Providenciar Maquita',
    'Providenciar Maquitão',
    'Providenciar Martelete',
    'Providenciar Colar',
    'Providenciar Mureta',
    'Desdobrar Corretamente',
    'Registrar Foto da Fachada',
    'Localizar Endereço Correto',
    'Realizar Escavação',
    'Solicitar OS de Supressão',
    'Realizar Sondagem',
    'Reprogramar OS',
    'Tirar foto Nº do HD'
  ];

  const AUDIT_ACTION_MIGRATION = {
    'Cancelar O.S ou Ligar para identificar': 'Verificar e/ou Cancelar O.S.',
    'Recomposicao': 'Realizar Recomposição',
    'Extensao de Rede': 'Realizar Extensão de Rede',
    'Falta Material': 'Providenciar Material',
    'Falta de Material (Caixa Piso)': 'Providenciar Caixa de Piso',
    'Falta Ferramenta (Maquita)': 'Providenciar Maquita',
    'Falta Ferramenta (Maquitao)': 'Providenciar Maquitão',
    'Falta Ferramenta (Martelete)': 'Providenciar Martelete',
    'Falta material (Colar)': 'Providenciar Colar',
    'Falta material (Mureta)': 'Providenciar Mureta',
    'Fazer a interligacao na rede': 'Desdobrar Corretamente',
    'Foto da Fachada': 'Registrar Foto da Fachada',
    'Localizar Endereco Correto': 'Localizar Endereço Correto',
    'Necessita Escavacao': 'Realizar Escavação',
    'Reprogramar': 'Reprogramar OS',
    'Tirar foto Nº do HD.': 'Tirar foto Nº do HD'
  };

  function normalizarAcaoAuditoria(acao) {
    const valor = String(acao || '').trim();
    return AUDIT_ACTION_MIGRATION[valor] || valor;
  }

  const mapImagesByAuditKey = new Map();

  const mapCardUpdaters = new Map();

  const OBS_RAPIDA_KEY = 'auditoria_operacional_obs_rapida_v1';
  const OBS_RAPIDA_VALIDADE_MS = 45 * 24 * 60 * 60 * 1000;
  const obsCardUpdaters = new Map();
  function loadObsRapidas() {
    return safeJsonParse(localStorage.getItem(OBS_RAPIDA_KEY), {}) || {};
  }
  function obterObservacaoDaOS(chave) {
    const audit = loadAudits()[chave];
    if (audit) return String(audit.observacao || '');
    return String(loadObsRapidas()[chave]?.texto || '');
  }
  function gravarObservacaoDaOS(chave, texto) {
    const valor = String(texto || '').trim();
    const audits = loadAudits();
    if (audits[chave]) {
      audits[chave].observacao = valor;
      saveAudits(audits);
    }
    const obs = loadObsRapidas();
    const limite = Date.now() - OBS_RAPIDA_VALIDADE_MS;
    Object.keys(obs).forEach(k => { if (!obs[k] || (obs[k].ts || 0) < limite) delete obs[k]; });
    if (valor) obs[chave] = { texto: valor, ts: Date.now() };
    else delete obs[chave];
    localStorage.setItem(OBS_RAPIDA_KEY, JSON.stringify(obs));

    const atualizarCard = obsCardUpdaters.get(chave);
    if (atualizarCard) { try { atualizarCard(valor); } catch (erro) { console.warn('[AUDITORIA OBS]', erro); } }
    return valor;
  }

  const ASSISTENTE = {
    url: 'http://127.0.0.1:8765',
    disponivel: null, checadoEm: 0,
    fila: [], ativos: 0, maxAtivos: 2,
    resultados: new Map(), pendentes: new Map()
  };
  const ASSISTENTE_ESTILOS = {
    ok:         { bg: '#0B5D1E', borda: '#1f8a3a', texto: '\u2714 OK' },
    erro:       { bg: '#7a1020', borda: '#b0263a', texto: '\u26a0 Poss\u00edvel erro' },
    conferir:   { bg: '#7a5a00', borda: '#b88a00', texto: '\u2753 Conferir' },
    analisando: { bg: '#2f3740', borda: '#46505c', texto: '\u23f3 Analisando...' },
    off:        { bg: '#2f3740', borda: '#46505c', texto: 'Assistente desligado' },
    falha:      { bg: '#2f3740', borda: '#46505c', texto: 'Falha na an\u00e1lise' }
  };

  function assistenteRequisicao(metodo, rota, corpo, tempoMs = 90000) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') { reject(new Error('GM_xmlhttpRequest indisponivel')); return; }
      GM_xmlhttpRequest({
        method: metodo, url: ASSISTENTE.url + rota, timeout: tempoMs,
        headers: { 'Content-Type': 'application/json' },
        data: corpo ? JSON.stringify(corpo) : undefined,
        onload: r => {
          try {
            if (r.status >= 200 && r.status < 300) resolve(JSON.parse(r.responseText || '{}'));
            else reject(new Error(`HTTP ${r.status}`));
          } catch (erro) { reject(erro); }
        },
        onerror: () => reject(new Error('sem conexao com o assistente')),
        ontimeout: () => reject(new Error('o assistente demorou demais para responder'))
      });
    });
  }

  async function assistenteDisponivel() {
    const agora = Date.now();
    if (ASSISTENTE.disponivel !== null && agora - ASSISTENTE.checadoEm < 30000) return ASSISTENTE.disponivel;
    try { await assistenteRequisicao('GET', '/status', null, 3000); ASSISTENTE.disponivel = true; }
    catch (erro) { ASSISTENTE.disponivel = false; }
    ASSISTENTE.checadoEm = agora;
    return ASSISTENTE.disponivel;
  }

  function assistenteEmEscopo(motivo) {
    const t = normalizeText(motivo);
    return t.includes('inexistencia') || t.includes('necessita escavacao');
  }

  function assistenteProcessarFila() {
    while (ASSISTENTE.ativos < ASSISTENTE.maxAtivos && ASSISTENTE.fila.length) {
      const tarefa = ASSISTENTE.fila.shift();
      ASSISTENTE.ativos++;
      Promise.resolve().then(tarefa)
        .catch(erro => console.warn('[ASSISTENTE]', erro))
        .finally(() => { ASSISTENTE.ativos--; assistenteProcessarFila(); });
    }
  }

  function assistentePedirAnalise(chave, os, motivo, parecer, images) {
    if (ASSISTENTE.resultados.has(chave)) return Promise.resolve(ASSISTENTE.resultados.get(chave));
    if (ASSISTENTE.pendentes.has(chave)) return ASSISTENTE.pendentes.get(chave);
    const promessa = new Promise((resolve, reject) => {
      ASSISTENTE.fila.push(async () => {
        try {
          if (!(await assistenteDisponivel())) {
            const erro = new Error('assistente desligado'); erro.desligado = true; throw erro;
          }
          const fotos = [];
          for (let i = 0; i < images.length; i++) {

            try { fotos.push({ nome: `foto_${i + 1}.jpg`, base64: await erroOpFotoOriginal(images[i]).catch(() => erroOpMiniatura(images[i])) }); }
            catch (erro) { console.warn('[ASSISTENTE] foto', i + 1, erro); }
          }
          const res = await assistenteRequisicao('POST', '/analisar', { os, motivo, parecer, fotos });
          ASSISTENTE.resultados.set(chave, res);
          resolve(res);
        } catch (erro) {
          reject(erro);
        } finally {
          ASSISTENTE.pendentes.delete(chave);
        }
      });
      assistenteProcessarFila();
    });
    ASSISTENTE.pendentes.set(chave, promessa);
    return promessa;
  }

  function assistenteCriarSelo() {
    const selo = document.createElement('span');
    selo.className = 'fa-assistente-selo';
    Object.assign(selo.style, {
      display: 'inline-block', padding: '3px 10px', borderRadius: '20px', fontSize: '12px',
      fontWeight: 'bold', color: '#ffffff', cursor: 'help', whiteSpace: 'nowrap', letterSpacing: '0.3px'
    });
    selo.definir = (estado, dica = '') => {
      const e = ASSISTENTE_ESTILOS[estado] || ASSISTENTE_ESTILOS.falha;
      selo.textContent = `\ud83e\udd16 ${e.texto}`;
      selo.style.background = e.bg;
      selo.style.border = `1px solid ${e.borda}`;
      selo.title = dica;
    };
    return selo;
  }

  function assistenteDica(res) {
    const linhas = [res.observacao || ''];
    if (typeof res.melhor_foto === 'number') linhas.push(`Melhor foto: ${res.melhor_foto.toFixed(2)} (escava\u00e7\u00e3o: ${res.foto_os})`);
    if (res.local) {
      linhas.push(`Local: GPS de ${res.local.n_fotos_gps} foto(s)` +
        (typeof res.local.dist_ate_os_m === 'number' ? ` | a ${res.local.dist_ate_os_m} m do ponto da O.S. no mapa` : ''));
    }
    if (res.mapa) {
      linhas.push(`Ponto da O.S. no mapa: rede a ${res.mapa.dist_rede_m} m | matr\u00edculas vizinhas a at\u00e9 8 m: ${res.mapa.matriculas_vizinhas}` +
        (res.mapa.coordenada_precisa ? '' : ' | coordenada imprecisa'));
    } else if (res.tipo === 'INEX') {
      linhas.push('Mapa: O.S. fora do mapa');
    }
    linhas.push(res.decisao === 'conferir'
      ? 'Caso para confer\u00eancia: a Observa\u00e7\u00e3o n\u00e3o \u00e9 preenchida. Decida olhando as fotos.'
      : 'Clique no selo para colocar esta sugest\u00e3o na Observa\u00e7\u00e3o.');
    return linhas.filter(Boolean).join('\n');
  }

  function assistenteAplicar(selo, campoObs, res) {
    if (!res || !res.escopo) { selo.remove(); return; }
    selo.definir(res.decisao || 'conferir', assistenteDica(res));
    const usarSugestao = () => {
      if (!res.observacao) return;
      campoObs.value = res.observacao;
      campoObs.dataset.sugestaoAssistente = res.observacao;
      campoObs.style.borderColor = '#b88a00';
      campoObs.title = 'Sugest\u00e3o do assistente: revise antes de salvar.';
    };

    if (res.decisao === 'conferir') { selo.style.cursor = 'help'; selo.onclick = null; return; }
    if (!campoObs.value.trim()) usarSugestao();
    selo.style.cursor = 'pointer';
    selo.onclick = () => {
      if (!campoObs.value.trim() || campoObs.value === res.observacao ||
          confirm('Substituir a Observa\u00e7\u00e3o atual pela sugest\u00e3o do assistente?')) usarSugestao();
    };
    campoObs.addEventListener('input', () => {
      if (campoObs.value !== campoObs.dataset.sugestaoAssistente) { campoObs.style.borderColor = '#46505c'; campoObs.title = ''; }
    });
  }

  function assistenteAnalisarCard({ osInfo, chave, os, motivo, parecer, images, campoObs }) {
    if (!campoObs || !assistenteEmEscopo(motivo) || !Array.isArray(images) || !images.length) return;
    const selo = assistenteCriarSelo();
    const alvo = osInfo && osInfo.firstElementChild ? osInfo.firstElementChild : osInfo;
    if (!alvo) return;
    alvo.appendChild(selo);
    selo.definir('analisando', 'Aguardando o assistente local...');
    assistentePedirAnalise(chave, os, motivo, parecer, images)
      .then(res => assistenteAplicar(selo, campoObs, res))
      .catch(erro => {
        if (erro && erro.desligado) selo.definir('off', 'O assistente local n\u00e3o est\u00e1 aberto.\nInicie o iniciar_assistente.bat e recarregue o console.');
        else selo.definir('falha', `Falha na an\u00e1lise: ${erro && erro.message ? erro.message : erro}`);
      });
  }

  function assistenteRegistrarDecisaoFinal(chave, os, motivo, observacaoFinal, auditor) {
    const res = ASSISTENTE.resultados.get(chave);
    if (!res || !res.escopo) return;
    assistenteRequisicao('POST', '/decisao_final', {
      os, motivo, decisao_sugerida: res.decisao || '', observacao_sugerida: res.observacao || '',
      observacao_final: observacaoFinal || '', auditor: auditor || ''
    }, 5000).catch(() => {});
  }

  function criarBotaoObservacao(chave, os, { aoAbrir, aoFechar } = {}) {
    const grupo = document.createElement('span');
    grupo.className = 'fa-obs-rapida';
    Object.assign(grupo.style, { position: 'relative', display: 'inline-flex' });

    const botao = document.createElement('button');
    botao.type = 'button';
    Object.assign(botao.style, {
      padding: '4px 12px', backgroundColor: '#1B8A3A', color: '#ffffff', border: '1px solid #0F5F26',
      borderRadius: '5px', cursor: 'pointer', fontSize: '12px', fontWeight: '800', lineHeight: '1.3', whiteSpace: 'nowrap'
    });
    const pintar = () => {
      const texto = obterObservacaoDaOS(chave);
      botao.textContent = texto ? 'Obs ✓' : 'Obs';
      botao.title = texto ? `Observação desta O.S.:\n${texto}` : 'Adicionar uma observação a esta O.S.';
    };
    pintar();

    const caixa = document.createElement('div');
    Object.assign(caixa.style, {
      display: 'none', position: 'absolute', top: '100%', left: '0', marginTop: '6px', zIndex: '60',
      width: '400px', maxWidth: '80vw', padding: '11px', boxSizing: 'border-box', backgroundColor: '#10181C',
      border: '1px solid #2E7D46', borderRadius: '8px', boxShadow: '0 12px 30px rgba(0,0,0,.55)'
    });
    const tituloCaixa = document.createElement('div');
    tituloCaixa.textContent = `Observação da O.S. ${os}`;
    Object.assign(tituloCaixa.style, { fontSize: '13px', fontWeight: '700', color: '#F2F7F8', marginBottom: '7px' });
    const campo = document.createElement('textarea');
    campo.rows = 5;
    campo.placeholder = 'Escreva a observação...';
    Object.assign(campo.style, {
      width: '100%', boxSizing: 'border-box', resize: 'vertical', minHeight: '96px', padding: '8px',
      backgroundColor: '#0B1013', color: '#F2F7F8', border: '1px solid #3B555E', borderRadius: '6px',
      font: '13px/1.4 "Segoe UI", Arial, sans-serif'
    });

    campo.addEventListener('keydown', evento => { if (evento.key !== 'Escape') evento.stopPropagation(); });
    const nota = document.createElement('div');
    nota.textContent = 'Aparece no campo "Observação" desta O.S. no painel de auditoria e segue para o Excel.';
    Object.assign(nota.style, { fontSize: '11px', color: '#9FB0B6', margin: '6px 0 9px' });
    const rodape = document.createElement('div');
    Object.assign(rodape.style, { display: 'flex', justifyContent: 'flex-end', gap: '8px' });
    const estilizar = (b, fundo, borda) => Object.assign(b.style, {
      padding: '6px 14px', borderRadius: '6px', cursor: 'pointer', fontSize: '12.5px', fontWeight: '700',
      backgroundColor: fundo, color: '#ffffff', border: `1px solid ${borda}`
    });
    const cancelar = document.createElement('button');
    cancelar.type = 'button';
    cancelar.textContent = 'Cancelar';
    estilizar(cancelar, '#1A2329', '#3B555E');
    const salvar = document.createElement('button');
    salvar.type = 'button';
    salvar.textContent = 'Salvar';
    estilizar(salvar, '#1B8A3A', '#0F5F26');
    rodape.append(cancelar, salvar);
    caixa.append(tituloCaixa, campo, nota, rodape);

    const fecharCaixa = () => {
      if (caixa.style.display === 'none') return;
      caixa.style.display = 'none';
      if (aoFechar) aoFechar();
    };
    botao.onclick = evento => {
      evento.stopPropagation();
      if (caixa.style.display !== 'none') { fecharCaixa(); return; }
      campo.value = obterObservacaoDaOS(chave);
      caixa.style.display = 'block';
      campo.focus();
      if (aoAbrir) aoAbrir(fecharCaixa);
    };
    cancelar.onclick = fecharCaixa;
    salvar.onclick = () => {
      try {
        gravarObservacaoDaOS(chave, campo.value);
      } catch (erro) {
        console.error('[AUDITORIA OBS]', erro);
        alert('Não foi possível salvar a observação. Veja o console para o diagnóstico.');
        return;
      }
      fecharCaixa();
      pintar();
    };

    grupo.append(botao, caixa);
    return grupo;
  }

  async function buscarMapasAutomaticamente() {
    const pendentes = Array.isArray(allResults)
      ? allResults.filter(item => item && !isStatusConcluido(item.status) && !mapImagesByAuditKey.get(auditKey(item)))
      : [];
    if (!pendentes.length) {
      alert('Nenhuma O.S. não concluída sem foto do mapa.');
      return;
    }
    const textoOriginal = fetchMapsBtn.textContent;
    fetchMapsBtn.disabled = true;
    try {
      fetchMapsBtn.textContent = 'Procurando o mapa...';
      const estado = await MAPA_AUTO.cliente.verificar();
      if (!estado) {
        alert('Não encontrei o mapa aberto.\n\nAbra o arquivo HTML do mapa em outra aba deste navegador e confira se aparece o selo "Câmera da auditoria" no canto inferior esquerdo. Se o selo não aparecer, ative "Permitir acesso a URLs de arquivo" nas configurações da extensão Tampermonkey.');
        return;
      }
      if (!estado.pronto) {
        alert('O mapa ainda está carregando. Aguarde aparecer o selo "Câmera da auditoria" no canto inferior esquerdo da aba do mapa e tente de novo.');
        return;
      }
      const naoEncontradas = [];
      let anexadas = 0;
      let outrasFalhas = 0;
      let falhasSeguidas = 0;
      let motivoDaFalha = '';
      let semCamadaClientes = false;
      for (let i = 0; i < pendentes.length; i++) {
        const item = pendentes[i];
        fetchMapsBtn.textContent = `Mapas ${i + 1}/${pendentes.length}`;
        const resposta = await MAPA_AUTO.cliente.capturar(item.os);
        if (resposta.ok && resposta.dataUrl) {
          const chave = auditKey(item);
          mapImagesByAuditKey.set(chave, resposta.dataUrl);
          const atualizarCard = mapCardUpdaters.get(chave);
          if (atualizarCard) { try { atualizarCard(resposta.dataUrl); } catch (erroCard) { console.warn('[AUDITORIA MAPA]', erroCard); } }
          anexadas++;
          falhasSeguidas = 0;
          if (resposta.clientes === false) semCamadaClientes = true;
        } else if (resposta.codigo === 'nao-encontrada') {
          naoEncontradas.push(String(item.os));
          falhasSeguidas = 0;
        } else {

          outrasFalhas++;
          falhasSeguidas++;
          motivoDaFalha = resposta.motivo || 'falha na captura';
          console.warn('[AUDITORIA MAPA]', item.os, motivoDaFalha);
          if (falhasSeguidas >= 3) {
            outrasFalhas += pendentes.length - i - 1;
            break;
          }
        }
      }
      MAPA_AUTO.cliente.encerrar();

      const linhas = [`${anexadas} foto(s) do mapa anexada(s) de ${pendentes.length} O.S.`];
      if (naoEncontradas.length) {
        linhas.push('', `${naoEncontradas.length} O.S. não encontrada(s) no mapa (use o Ctrl+V manual se precisar):`);
        linhas.push(naoEncontradas.join(', '));
      }
      if (outrasFalhas) {
        linhas.push('', `${outrasFalhas} O.S. ficaram sem foto por falha na captura (${motivoDaFalha}). Recarregue a aba do mapa e clique de novo em "Buscar fotos do mapa": só as que faltam serão refeitas.`);
      }
      if (semCamadaClientes) linhas.push('', 'Atenção: este arquivo de mapa não tem a camada "Clientes ativos até 100 m da rede"; as fotos saíram sem ela.');
      alert(linhas.join('\n'));
    } catch (erro) {
      console.error('[AUDITORIA MAPA]', erro);
      alert('Não foi possível buscar as fotos do mapa. Verifique o console.');
    } finally {
      fetchMapsBtn.disabled = false;
      fetchMapsBtn.textContent = textoOriginal;
    }
  }

  function loadAudits() {
    return safeJsonParse(localStorage.getItem(AUDIT_STORAGE_KEY), {}) || {};
  }
  function saveAudits(data) {
    localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(data));
  }
  function auditKey(result) {
    return `${String(result.os || '').trim()}|${String(result.aid || '').trim()}`;
  }
  function countSavedAuditsForCurrentResults() {
    const audits = loadAudits();
    return allResults.filter(result => Boolean(audits[auditKey(result)])).length;
  }
  function calculateProtocol(audit) {
    const required = [
      audit.fachada, audit.comprova, audit.andamento, audit.parecer, audit.hd,
      audit.naoExecucao, audit.acaoCorretiva, audit.desdobramento
    ];
    if (required.some(value => !value)) return '';
    const respostaOk = value => ['Sim', 'NA'].includes(value);
    const checklistOk = respostaOk(audit.fachada) && respostaOk(audit.comprova) &&
      respostaOk(audit.andamento) && respostaOk(audit.parecer) && respostaOk(audit.hd) &&
      respostaOk(audit.naoExecucao) && audit.acaoCorretiva === 'Sim' &&
      respostaOk(audit.desdobramento);
    return checklistOk ? 'OK' : 'NOK';
  }
  async function carregarImagemParaMontagem(url) {
    const resposta = await fetch(url, { credentials: 'include', cache: 'force-cache' });
    if (!resposta.ok) throw new Error(`Falha HTTP ${resposta.status}`);
    const blob = await resposta.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
      const imagem = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Imagem inválida'));
        img.src = objectUrl;
      });
      return imagem;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function desenharMiniatura(ctx, imagem, x, y, largura, altura, legenda, fator = 1) {
    ctx.fillStyle = '#172126';
    ctx.fillRect(x, y, largura, altura);
    const faixa = 24 * fator;
    const areaH = altura - faixa;
    const escala = Math.max(largura / imagem.naturalWidth, areaH / imagem.naturalHeight);
    const dw = imagem.naturalWidth * escala;
    const dh = imagem.naturalHeight * escala;
    const dx = x + (largura - dw) / 2;
    const dy = y + (areaH - dh) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, largura, areaH);
    ctx.clip();
    ctx.drawImage(imagem, dx, dy, dw, dh);
    ctx.restore();
    ctx.fillStyle = 'rgba(0,0,0,.72)';
    ctx.fillRect(x, y + areaH, largura, faixa);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${13 * fator}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(legenda, x + largura / 2, y + areaH + faixa / 2);
    ctx.strokeStyle = '#60717a';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + .5, y + .5, largura - 1, altura - 1);
  }

  async function criarMontagemFotosXlsx(urls, progresso, escala = 1) {
    const lista = Array.isArray(urls) ? urls.filter(Boolean) : [];
    if (!lista.length) return null;
    const colunas = Math.min(4, lista.length);
    const linhas = Math.ceil(lista.length / colunas);
    const miniW = Math.round(220 * escala);
    const miniH = Math.round(165 * escala);
    const gap = Math.round(8 * escala);
    const margem = Math.round(8 * escala);
    const canvas = document.createElement('canvas');
    canvas.width = margem * 2 + colunas * miniW + (colunas - 1) * gap;
    canvas.height = margem * 2 + linhas * miniH + (linhas - 1) * gap;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#172126';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    let fotosValidas = 0;
    for (let i = 0; i < lista.length; i++) {
      if (progresso) progresso(i + 1, lista.length);
      const coluna = i % colunas;
      const linha = Math.floor(i / colunas);
      const x = margem + coluna * (miniW + gap);
      const y = margem + linha * (miniH + gap);
      try {
        const imagem = await carregarImagemParaMontagem(lista[i]);
        desenharMiniatura(ctx, imagem, x, y, miniW, miniH, `Foto ${i + 1} de ${lista.length}`, escala);
        fotosValidas++;
      } catch (erro) {
        ctx.fillStyle = '#303a40';
        ctx.fillRect(x, y, miniW, miniH);
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${13 * escala}px Arial`;
        ctx.textAlign = 'center';
        ctx.fillText(`Foto ${i + 1} indisponível`, x + miniW / 2, y + miniH / 2);
      }
    }
    if (!fotosValidas) return null;
    return {
      dataUrl: canvas.toDataURL('image/jpeg', escala > 1 ? 0.72 : 0.70),
      width: canvas.width,
      height: canvas.height,
      quantidade: lista.length
    };
  }

  let forcarImagensFlutuantes = false;
  let avisouSemCompactador = false;
  const compactadorDisponivel = () => typeof fflate !== 'undefined' &&
    typeof fflate.unzipSync === 'function' && typeof fflate.zipSync === 'function';

  async function embutirImagensNasCelulas(buffer, imagens) {

    await new Promise(resolve => setTimeout(resolve, 30));
    const partes = fflate.unzipSync(new Uint8Array(buffer));
    const ler = caminho => {
      if (!partes[caminho]) throw new Error(`Parte ausente no XLSX: ${caminho}`);
      return fflate.strFromU8(partes[caminho]);
    };
    const gravar = (caminho, texto) => { partes[caminho] = fflate.strToU8(texto); };
    const bytesDeBase64 = base64 => {
      const binario = atob(base64);
      const bytes = new Uint8Array(binario.length);
      for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
      return bytes;
    };
    const CABECALHO = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    const NS_PLANILHA = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const NS_PACOTE = 'http://schemas.openxmlformats.org/package/2006/relationships';
    const NS_DOC = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const NS_RICO = 'http://schemas.microsoft.com/office/spreadsheetml/2017/richdata';
    const caminhoPlanilha = 'xl/worksheets/sheet1.xml';

    const doc = new DOMParser().parseFromString(ler(caminhoPlanilha), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('Planilha ilegível');
    const celulas = new Map();
    Array.from(doc.getElementsByTagNameNS(NS_PLANILHA, 'c')).forEach(c => celulas.set(c.getAttribute('r'), c));
    const linhas = new Map();
    Array.from(doc.getElementsByTagNameNS(NS_PLANILHA, 'row')).forEach(r => linhas.set(r.getAttribute('r'), r));
    const indiceColuna = ref => String(ref).replace(/\d+/g, '').split('')
      .reduce((total, letra) => total * 26 + letra.charCodeAt(0) - 64, 0);

    const usadas = [];
    imagens.forEach(imagem => {
      const dados = String(imagem.dataUrl || '').match(/^data:image\/(png|jpe?g);base64,(.+)$/i);
      if (!dados) return;
      let celula = celulas.get(imagem.ref);
      if (!celula) {
        const linha = linhas.get(String(imagem.ref).replace(/\D/g, ''));
        if (!linha) return;
        celula = doc.createElementNS(NS_PLANILHA, 'c');
        celula.setAttribute('r', imagem.ref);
        const alvo = indiceColuna(imagem.ref);
        const seguinte = Array.from(linha.children).find(c => indiceColuna(c.getAttribute('r') || 'A') > alvo);
        linha.insertBefore(celula, seguinte || null);
        linha.removeAttribute('spans');
      }
      usadas.push({ base64: dados[2], extensao: /png/i.test(dados[1]) ? 'png' : 'jpeg' });
      while (celula.firstChild) celula.removeChild(celula.firstChild);
      celula.setAttribute('t', 'e');
      celula.setAttribute('vm', String(usadas.length));
      const valor = doc.createElementNS(NS_PLANILHA, 'v');
      valor.textContent = '#VALUE!';
      celula.appendChild(valor);
    });
    if (!usadas.length) return buffer;
    gravar(caminhoPlanilha, CABECALHO + new XMLSerializer().serializeToString(doc).replace(/^<\?xml[^>]*\?>\s*/, ''));

    const total = usadas.length;
    const sequencia = montar => usadas.map((imagem, i) => montar(i, imagem)).join('');
    usadas.forEach((imagem, i) => {

      partes[`xl/media/celula${i + 1}.${imagem.extensao}`] = [bytesDeBase64(imagem.base64), { level: 0 }];
    });
    gravar('xl/richData/richValueRel.xml', CABECALHO +
      `<richValueRels xmlns="http://schemas.microsoft.com/office/spreadsheetml/2022/richvaluerel" xmlns:r="${NS_DOC}">` +
      sequencia(i => `<rel r:id="rId${i + 1}"/>`) + '</richValueRels>');
    gravar('xl/richData/_rels/richValueRel.xml.rels', CABECALHO + `<Relationships xmlns="${NS_PACOTE}">` +
      sequencia((i, imagem) => `<Relationship Id="rId${i + 1}" Type="${NS_DOC}/image" Target="../media/celula${i + 1}.${imagem.extensao}"/>`) +
      '</Relationships>');
    gravar('xl/richData/rdrichvalue.xml', CABECALHO + `<rvData xmlns="${NS_RICO}" count="${total}">` +
      sequencia(i => `<rv s="0"><v>${i}</v><v>5</v></rv>`) + '</rvData>');
    gravar('xl/richData/rdrichvaluestructure.xml', CABECALHO + `<rvStructures xmlns="${NS_RICO}" count="1">` +
      '<s t="_localImage"><k n="_rvRel:LocalImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/></s></rvStructures>');
    gravar('xl/richData/rdRichValueTypes.xml', CABECALHO +
      '<rvTypesInfo xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata2" ' +
      'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x" ' +
      `xmlns:x="${NS_PLANILHA}"><global><keyFlags>` +
      '<key name="_Self"><flag name="ExcludeFromFile" value="1"/><flag name="ExcludeFromCalcComparison" value="1"/></key>' +
      ['_DisplayString', '_Flags', '_Format', '_SubLabel', '_Attribution', '_Icon', '_Display', '_CanonicalPropertyNames', '_ClassificationId']
        .map(nome => `<key name="${nome}"><flag name="ExcludeFromCalcComparison" value="1"/></key>`).join('') +
      '</keyFlags></global></rvTypesInfo>');
    gravar('xl/metadata.xml', CABECALHO + `<metadata xmlns="${NS_PLANILHA}" xmlns:xlrd="${NS_RICO}">` +
      '<metadataTypes count="1"><metadataType name="XLRICHVALUE" minSupportedVersion="120000" copy="1" pasteAll="1" ' +
      'pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1"/></metadataTypes>' +
      `<futureMetadata name="XLRICHVALUE" count="${total}">` +
      sequencia(i => `<bk><extLst><ext uri="{3e2802c4-a4d2-4d8b-9148-e3be6c30e623}"><xlrd:rvb i="${i}"/></ext></extLst></bk>`) +
      `</futureMetadata><valueMetadata count="${total}">` +
      sequencia(i => `<bk><rc t="1" v="${i}"/></bk>`) + '</valueMetadata></metadata>');

    let tipos = ler('[Content_Types].xml');
    ['jpeg', 'png'].forEach(extensao => {
      if (usadas.some(imagem => imagem.extensao === extensao) && !new RegExp(`Extension="${extensao}"`, 'i').test(tipos)) {
        tipos = tipos.replace(/(<Types[^>]*>)/, `$1<Default Extension="${extensao}" ContentType="image/${extensao}"/>`);
      }
    });
    tipos = tipos.replace('</Types>',
      '<Override PartName="/xl/metadata.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml"/>' +
      '<Override PartName="/xl/richData/rdRichValueTypes.xml" ContentType="application/vnd.ms-excel.rdrichvaluetypes+xml"/>' +
      '<Override PartName="/xl/richData/rdrichvalue.xml" ContentType="application/vnd.ms-excel.rdrichvalue+xml"/>' +
      '<Override PartName="/xl/richData/rdrichvaluestructure.xml" ContentType="application/vnd.ms-excel.rdrichvaluestructure+xml"/>' +
      '<Override PartName="/xl/richData/richValueRel.xml" ContentType="application/vnd.ms-excel.richvaluerel+xml"/></Types>');
    gravar('[Content_Types].xml', tipos);

    let relacoes = ler('xl/_rels/workbook.xml.rels');
    let maiorId = 0;
    relacoes.replace(/Id="rId(\d+)"/g, (trecho, numero) => { maiorId = Math.max(maiorId, Number(numero)); return trecho; });
    const novaRelacao = (tipo, alvo) => `<Relationship Id="rId${++maiorId}" Type="${tipo}" Target="${alvo}"/>`;
    relacoes = relacoes.replace('</Relationships>',
      novaRelacao(`${NS_DOC}/sheetMetadata`, 'metadata.xml') +
      novaRelacao('http://schemas.microsoft.com/office/2022/10/relationships/richValueRel', 'richData/richValueRel.xml') +
      novaRelacao('http://schemas.microsoft.com/office/2017/06/relationships/rdRichValue', 'richData/rdrichvalue.xml') +
      novaRelacao('http://schemas.microsoft.com/office/2017/06/relationships/rdRichValueStructure', 'richData/rdrichvaluestructure.xml') +
      novaRelacao('http://schemas.microsoft.com/office/2017/06/relationships/rdRichValueTypes', 'richData/rdRichValueTypes.xml') +
      '</Relationships>');
    gravar('xl/_rels/workbook.xml.rels', relacoes);

    return fflate.zipSync(partes, { level: 6 });
  }

  async function exportarFotosXlsx() {
    if (typeof ExcelJS === 'undefined') {
      alert('ExcelJS não foi carregado. Atualize a página e tente novamente.');
      return;
    }

    const lista = Array.isArray(allResults)
      ? allResults.filter(item => item && !isStatusConcluido(item.status))
      : [];
    if (!lista.length) {
      alert('Nenhuma O.S. não concluída disponível para exportação.');
      return;
    }

    const auditorias = loadAudits();
    const botaoTopo = exportPhotosXlsxBtn;
    const textoOriginal = botaoTopo.textContent;
    botaoTopo.disabled = true;
    if (!compactadorDisponivel() && !avisouSemCompactador) {
      avisouSemCompactador = true;
      alert('A biblioteca de compactação (fflate) não foi carregada. As imagens sairão soltas sobre as células, como na versão anterior. Atualize a página para tentar de novo.');
    }

    const imagensNaCelula = (compactadorDisponivel() && !forcarImagensFlutuantes) ? [] : null;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Auditoria de OS - Se Liga';
    workbook.created = new Date();
    const ws = workbook.addWorksheet('OS Não Concluídas', {
      views: [{ state: 'frozen', ySplit: 1, xSplit: 4 }]
    });

    ws.columns = [
      { header: 'Recurso', key: 'recurso', width: 18 },
      { header: 'Data', key: 'data', width: 14 },
      { header: 'Status da Atividade', key: 'status', width: 22 },
      { header: 'Ordem de Serviço', key: 'os', width: 18 },
      { header: 'ID Atividade', key: 'aid', width: 16 },
      { header: 'Descrição do Serviço', key: 'descricao', width: 42 },
      { header: 'Matrícula Unidade Comercial', key: 'matricula', width: 24 },
      { header: 'Hidrômetro', key: 'hidrometro', width: 18 },
      { header: 'Cidade', key: 'cidade', width: 22 },
      { header: 'Bairro', key: 'bairro', width: 22 },
      { header: 'Endereço', key: 'endereco', width: 42 },
      { header: 'Motivo da Não Execução SER', key: 'motivo', width: 34 },
      { header: 'Qual Ação?', key: 'qualAcao', width: 30 },
      { header: 'Observação', key: 'observacao', width: 40 },
      { header: 'Parecer da Solicitação', key: 'parecerSolicitacao', width: 55 },
      { header: 'Parecer da Execução', key: 'parecerExecucao', width: 55 },
      { header: 'Foto Mapa', key: 'fotoMapa', width: 18 },
      { header: 'Foto da Execução', key: 'fotosExecucao', width: 68 },
      { header: 'Responsabilidade', key: 'responsabilidade', width: 25 },
      { header: 'Ação', key: 'acao', width: 24 }
    ];

    ws.getColumn('fotoMapa').width = 36;

    ws.getRow(1).height = 32;
    ws.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF007E87' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF005B62' } } };
    });

    try {
      for (let i = 0; i < lista.length; i++) {
        const item = lista[i];
        const itemAuditKey = auditKey(item);
        const audit = auditorias[itemAuditKey] || {};
        const mapaImagemExportacao = mapImagesByAuditKey.get(itemAuditKey) || audit.mapaImagem || '';
        const rowNumber = i + 2;
        botaoTopo.textContent = `Gerando XLSX ${i + 1}/${lista.length}`;

        const row = ws.addRow({
          recurso: String(item.equipe || ''),
          data: String(item.dataEncerramento || item.date || ''),
          status: String(item.status || ''),
          os: String(item.os || ''),
          aid: String(item.aid || ''),
          descricao: String(item.descricao || ''),
          matricula: String(item.matricula || ''),
          hidrometro: String(item.hidrometro || ''),
          cidade: String(item.cidade || ''),
          bairro: String(item.bairro || ''),
          endereco: String(item.endereco || ''),
          motivo: String(item.motivoSER || ''),
          qualAcao: String(audit.qualAcao || ''),
          observacao: obterObservacaoDaOS(itemAuditKey),
          parecerSolicitacao: String(item.parecerSolicitacao || 'Não informado'),
          parecerExecucao: String(item.parecer || 'Não informado'),
          fotoMapa: mapaImagemExportacao ? 'Imagem anexada' : String(item.fotoMapa || 'Não disponível'),
          fotosExecucao: item.validImages?.length ? `${item.validImages.length} foto(s)` : 'Sem fotos',
          responsabilidade: String(item.setor || ''),
          acao: String(audit.acaoCorretiva || '')
        });

        row.alignment = { vertical: 'top', wrapText: true };
        row.getCell(4).font = { bold: true, color: { argb: 'FF005B62' } };
        for (let c = 1; c <= 20; c++) {
          row.getCell(c).border = {
            top: { style: 'thin', color: { argb: 'FFD5DEE2' } },
            left: { style: 'thin', color: { argb: 'FFD5DEE2' } },
            bottom: { style: 'thin', color: { argb: 'FFD5DEE2' } },
            right: { style: 'thin', color: { argb: 'FFD5DEE2' } }
          };
          if (i % 2 === 1) {
            row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F8F9' } };
          }
        }

        if (mapaImagemExportacao && imagensNaCelula) {
          imagensNaCelula.push({ ref: `Q${rowNumber}`, dataUrl: mapaImagemExportacao });
          row.height = Math.max(row.height || 0, 145);
        } else if (mapaImagemExportacao) {
          try {
            const mapImageId = workbook.addImage({ base64: mapaImagemExportacao, extension: 'jpeg' });
            ws.addImage(mapImageId, {
              tl: { col: 16.08, row: (rowNumber - 1) + 0.35 },

              ext: { width: 250, height: 180 },
              editAs: 'oneCell'
            });
            row.height = Math.max(row.height || 0, 145);
            row.getCell(17).alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
          } catch (erroMapa) {
            console.warn('[AUDITORIA MAPA] Falha ao inserir imagem no XLSX.', erroMapa);
            row.getCell(17).value = 'Imagem anexada, mas nao foi possivel inserir no XLSX';
          }
        }

        const montagem = await criarMontagemFotosXlsx(item.validImages, (foto, total) => {
          botaoTopo.textContent = `O.S. ${i + 1}/${lista.length} · Foto ${foto}/${total}`;
        }, imagensNaCelula ? 1.5 : 1);
        if (montagem && imagensNaCelula) {
          imagensNaCelula.push({ ref: `R${rowNumber}`, dataUrl: montagem.dataUrl });
          const alturaNaCelula = Math.round(480 * montagem.height / montagem.width);
          row.height = Math.max(row.height || 0, 105, alturaNaCelula * 0.75 + 10);
        } else if (montagem) {

          const larguraExcel = 500;
          const alturaExcel = Math.round(larguraExcel * montagem.height / montagem.width);
          row.height = Math.max(row.height || 0, 105, alturaExcel * 0.75 + 22);
          const imageId = workbook.addImage({ base64: montagem.dataUrl, extension: 'jpeg' });
          ws.addImage(imageId, {
            tl: { col: 17.05, row: (rowNumber - 1) + 0.16 },
            ext: { width: larguraExcel, height: alturaExcel },
            editAs: 'oneCell'
          });
          row.getCell(18).alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
        } else {
          row.height = Math.max(row.height || 0, 70);
        }
      }

      ws.autoFilter = { from: 'A1', to: 'T1' };
      ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
      let buffer = await workbook.xlsx.writeBuffer();
      if (imagensNaCelula && imagensNaCelula.length) {
        botaoTopo.textContent = 'Colocando imagens nas células...';
        try {
          buffer = await embutirImagensNasCelulas(buffer, imagensNaCelula);
        } catch (erroCelula) {
          console.error('[AUDITORIA XLSX] Falha ao colocar as imagens dentro das celulas.', erroCelula);
          forcarImagensFlutuantes = true;
          botaoTopo.textContent = textoOriginal;
          alert('Não foi possível colocar as imagens dentro das células. O arquivo será gerado de novo com as imagens soltas, como antes.');
          return await exportarFotosXlsx();
        }
      }
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const data = new Date().toISOString().slice(0, 10);
      link.href = url;
      link.download = `Auditoria_OS_Nao_Concluidas_Com_Fotos_${data}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (erro) {
      console.error('[AUDITORIA XLSX]', erro);
      alert('Não foi possível gerar o XLSX. Verifique o console.');
    } finally {
      botaoTopo.disabled = false;
      botaoTopo.textContent = textoOriginal;
    }
  }

  function exportAuditsCsv() {
    const audits = Object.values(loadAudits());
    if (!audits.length) {
      alert('Nenhuma auditoria salva para exportar.');
      return;
    }
    const header = [
      'Recurso','Data','Status da Atividade','Ordem de Servico','ID Atividade','Descricao do Servico',
      'Matricula Unidade Comercial','Hidrometro','Cidade','Bairro','Endereco','Motivo da Não Execução SER',
      'Auditor','Protocolo ok?','Foto da fachada ok?','A foto comprova resultado na O.S.?',
      'A Foto Comprova Andamento na O.S.?','Parecer de execucao explicativo ok?','HD cadastrado no Sansys igual foto?',
      'Motivo de nao execucao coerente?','Dispensa Acao Corretiva?',
      'Desdobramento ok?','Qual acao?','Observacao','Parecer da Solicitacao','Parecer da Execucao','Alertas automaticos',
      'Analise do desdobramento','Data da auditoria','Hora da auditoria',
      'Servico Adicional','Servico Posterior','Desdobramento Condicional',
      'DC 1','DC 2','DC 3','DC 4','DC 5','DC 6'
    ];
    function resultadoCorDesdobramento(result) {
      const analise = result?.analiseDesdobramento;
      if (!analise) return '';
      if (analise.nivel === 'erro') return 'Vermelho';
      if (analise.nivel === 'verificar') return 'Amarelo';
      return 'Verde';
    }
    function resultadoSimNao(value) {
      return String(value || '').toUpperCase().includes('SIM') ? 'Sim' : 'Nao';
    }
    function formatarDCExportacao(dc) {
      if (!dc) return '';
      const titulo = String(dc.titulo || 'DC').trim();
      const codigo = String(dc.codigo || '').trim();
      return codigo ? `${titulo}: ${codigo}` : titulo;
    }
    const rows = audits.map(audit => {
      const result = audit.base || {};
      const dataHoraAuditoria = String(audit.updatedAt || '').trim();
      const dataAuditoria = String(audit.auditDate || '').trim() ||
        dataHoraAuditoria.match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0] || '';
      const horaAuditoria = String(audit.auditTime || '').trim() ||
        dataHoraAuditoria.match(/\b\d{2}:\d{2}(?::\d{2})?\b/)?.[0] || '';
      const analiseCor = resultadoCorDesdobramento(result);
      const servicoAdicionalExportacao = resultadoSimNao(result.incluirAdicionais);
      const servicoPosteriorExportacao = Array.isArray(result.posteriores) && result.posteriores.length > 0 ? 'Sim' : 'Nao';
      const dcsExportacao = Array.isArray(result.desdobramentosCondicionais) ? result.desdobramentosCondicionais : [];
      const desdobramentoCondicionalExportacao = dcsExportacao.length > 0 ? 'Sim' : 'Nao';
      const colunasDC = Array.from({ length: 6 }, (_, index) => formatarDCExportacao(dcsExportacao[index]));
      return [
        result.equipe, result.dataEncerramento || result.date, result.status,
        result.os, String(result.aid || ''), result.descricao, result.matricula, result.hidrometro, result.cidade,
        result.bairro, result.endereco, result.motivoSER, audit.auditor,
        audit.protocolo, audit.fachada, audit.comprova, audit.andamento, audit.parecer,
        audit.hd, audit.naoExecucao, audit.acaoCorretiva,
        audit.desdobramento, audit.qualAcao || 'NA', audit.observacao,
        result.parecerSolicitacao || '', result.parecer || '',
        (result.alertasAutomaticos || []).join(' | '),
        analiseCor, dataAuditoria, horaAuditoria,
        servicoAdicionalExportacao, servicoPosteriorExportacao,
        desdobramentoCondicionalExportacao, ...colunasDC
      ];
    });
    const csv = '\uFEFF' + [header, ...rows].map(row => row.map(csvEscape).join(';')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `auditoria_operacional_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  const ANALYSIS_STORAGE_KEY = 'fotos_analise_apontamentos_v1';
  function loadAnalyses() {
    return safeJsonParse(localStorage.getItem(ANALYSIS_STORAGE_KEY), {}) || {};
  }
  function analysisKey(result) {
    return `${String(result.os || '').trim()}|${String(result.aid || '').trim()}`;
  }
  function getSavedAnalysis(result) {
    return loadAnalyses()[analysisKey(result)] || null;
  }
  function getAutomaticAlerts(result) {
    const alerts = [];
    if (result.alertaMaisDeDoisDC) {
      alerts.push('Acima do limite operacional de 2 DC distintos na Manutencao.');
    }
    if (result.alertaEscavacaoSemDesdobro) alerts.push('Escavacao sem desdobramento');
    if (result.alerta943701ComDesdobro) alerts.push('Desdobramento possivelmente indevido no codigo 943701');
    if (result.desvioServicoEsgoto) alerts.push('Servico de esgoto');
    if (result.desvioPosteriorSemSAA) alerts.push('Posterior sem SAA');
    if (result.alerta610806ComDesdobro) alerts.push('Vistoria em hidrante com desdobramento');
    if (result.alertaCaminhaoPipaComDesdobro) alerts.push('Caminhao-pipa com desdobramento');
    if (result.desvioMotivoNaoExecucao) alerts.push(`Motivo de nao execucao: ${result.motivoSER || ''}`);
    if (result.analiseDesdobramento?.nivel === 'erro') alerts.push('Erro na analise automatica do desdobramento');
    if (result.analiseDesdobramento?.nivel === 'verificar') alerts.push('Revisar analise automatica do desdobramento');
    return alerts;
  }
  function csvEscape(value) {
    const text = String(value ?? '').replace(/\r?\n/g, ' ');
    return `"${text.replace(/"/g, '""')}"`;
  }
  exportAnalysisBtn.onclick = exportAuditsCsv;

  let allResults = [];
  let auditoriaCarregando = false;
  let execucaoAuditoriaAtual = 0;
  const IMAGE_CACHE_KEY = 'auditoria_os_image_cache_v626';
  const IMAGE_CACHE_TTL_MS = 1000 * 60 * 60;
  let activeFilters = { situacao: 'todos', descricao: 'todos', descricoes: [], motivo: 'todos', analise: 'todos' };
  let forcedSearchOS = '';
  let currentCounts = { concluido: 0, naoConcluido: 0, pendente: 0 };

  function isStatusConcluido(value) {
    const status = normalizeText(value).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return status === 'concluido' || status === 'complete' || status === 'completed' ||
      status === 'finalizado' || status === 'finalizada';
  }

  function isResultConcluido(r) {
    return isStatusConcluido(r?.status);
  }

  function normalizeValue(v) {
    const s = (v === null || v === undefined) ? '' : String(v).trim();
    return s ? s : '(Vazio)';
  }

  function updateModalTitle() {
    const { concluido, naoConcluido, pendente } = currentCounts;
    const parts = [`${concluido} concluidas`];
    if (naoConcluido > 0) parts.push(`${naoConcluido} nao concluidas`);
    if (pendente > 0) parts.push(`${pendente} pendentes ignorados`);
    modalTitle.textContent = `Auditoria de OS - Se Liga (${parts.join(', ')})`;
  }

  function passesFilters(r, excludeKey, dadosSalvos = null) {

    if (excludeKey !== 'situacao' && activeFilters.situacao !== 'todos') {
      const isC = isResultConcluido(r);
      const isPreenchido = Boolean((dadosSalvos?.audits || loadAudits())[auditKey(r)]);
      if (activeFilters.situacao === 'concluido' && !isC) return false;
      if (activeFilters.situacao === 'nao_concluido' && isC) return false;
      if (activeFilters.situacao === 'preenchidos' && !isPreenchido) return false;
      if (activeFilters.situacao === 'nao_preenchidos' && isPreenchido) return false;

    }
    if (excludeKey !== 'descricao' && Array.isArray(activeFilters.descricoes) && activeFilters.descricoes.length > 0) {
      if (!activeFilters.descricoes.includes(normalizeValue(r.descricao))) return false;
    }
    if (excludeKey !== 'motivo' && activeFilters.motivo !== 'todos') {
      if (normalizeValue(r.motivoSER) !== activeFilters.motivo) return false;
    }
    if (excludeKey !== 'analise' && activeFilters.analise !== 'todos') {
      const savedAnalysis = dadosSalvos ? dadosSalvos.analyses[analysisKey(r)] : getSavedAnalysis(r);
      const resultStatus = savedAnalysis?.status || 'nao_analisado';
      if (resultStatus !== activeFilters.analise) return false;
    }
    return true;
  }

  function renderDescriptionChecklist() {
    if (!descricaoChecklist) return;
    const selected = new Set(activeFilters.descricoes || []);
    const dadosSalvos = { audits: loadAudits(), analyses: loadAnalyses() };
    const available = allResults
      .filter(r => passesFilters(r, 'descricao', dadosSalvos))
      .map(r => normalizeValue(r.descricao));
    const allDescriptions = Array.from(new Set([
      ...available,
      ...selected
    ])).sort((a, b) => a.localeCompare(b, 'pt-BR'));

    descricaoChecklist.innerHTML = '';
    allDescriptions.forEach(description => {
      const label = document.createElement('label');
      label.dataset.description = description;
      Object.assign(label.style, {
        display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '7px 8px',
        borderRadius: '5px', cursor: 'pointer', color: '#eef2f6', fontSize: '12px',
        lineHeight: '1.35'
      });
      label.onmouseenter = () => { label.style.backgroundColor = '#29313a'; };
      label.onmouseleave = () => { label.style.backgroundColor = 'transparent'; };
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selected.has(description);
      checkbox.style.marginTop = '2px';
      checkbox.onchange = () => {
        const current = new Set(activeFilters.descricoes || []);
        if (checkbox.checked) current.add(description); else current.delete(description);
        activeFilters.descricoes = [...current];
        updateDescricaoButton();
        onFilterChanged();
      };
      const text = document.createElement('span');
      text.textContent = description;
      label.appendChild(checkbox); label.appendChild(text);
      descricaoChecklist.appendChild(label);
    });
    updateDescricaoButton();
    descricaoSearch.oninput();
  }

  function populateDynamicSelect(select, filterKey, getValue) {
    if (filterKey === 'descricao') {
      renderDescriptionChecklist();
      return;
    }
    const dadosSalvos = { audits: loadAudits(), analyses: loadAnalyses() };
    const available = allResults.filter(r => passesFilters(r, filterKey, dadosSalvos));
    const uniqueValues = Array.from(new Set(available.map(r => normalizeValue(getValue(r)))))
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));

    const previousValue = activeFilters[filterKey];
    select.innerHTML = '';

    const allOpt = document.createElement('option');
    allOpt.value = 'todos';
    allOpt.textContent = 'Todos';
    select.appendChild(allOpt);

    uniqueValues.forEach(val => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = val;
      select.appendChild(opt);
    });

    if (previousValue !== 'todos' && uniqueValues.includes(previousValue)) {
      select.value = previousValue;
    } else {
      select.value = 'todos';
      activeFilters[filterKey] = 'todos';
    }
  }

  function onFilterChanged() {
    forcedSearchOS = '';
    populateDynamicSelect(descricaoFilterSelect, 'descricao', r => r.descricao);
    populateDynamicSelect(motivoFilterSelect, 'motivo', r => r.motivoSER);
    renderCards();
  }

  function appendBottomExportArea() {
    const saved = loadAnalyses();
    const savedCount = allResults.filter(result => Boolean(saved[analysisKey(result)])).length;

    const bottomArea = document.createElement('div');
    bottomArea.className = 'fa-bottom-export-area';
    Object.assign(bottomArea.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '14px', flexWrap: 'wrap', marginTop: '8px', padding: '16px',
      backgroundColor: '#1d2127', border: '1px solid #3a424d',
      borderRadius: '10px', boxShadow: '0 5px 18px rgba(0,0,0,.18)'
    });

    const info = document.createElement('div');
    info.innerHTML = `
      <div style="font-size:14px;font-weight:700;color:#eef2f6;">Fim da analise</div>
      <div style="font-size:12px;color:#9da8b5;margin-top:3px;">
        ${savedCount} apontamento${savedCount === 1 ? '' : 's'} salvo${savedCount === 1 ? '' : 's'} para exportacao.
      </div>
    `;

    const bottomExportBtn = document.createElement('button');
    bottomExportBtn.type = 'button';
    bottomExportBtn.textContent = '\uD83D\uDCE5 Exportar Relatorio';
    Object.assign(bottomExportBtn.style, {
      padding: '10px 16px', backgroundColor: '#107c10', color: 'white',
      border: 'none', borderRadius: '7px', cursor: 'pointer',
      fontSize: '13px', fontWeight: 'bold', minWidth: '210px'
    });
    bottomExportBtn.onmouseenter = () => { bottomExportBtn.style.backgroundColor = '#0b6a0b'; };
    bottomExportBtn.onmouseleave = () => { bottomExportBtn.style.backgroundColor = '#107c10'; };
    bottomExportBtn.onclick = exportAuditsCsv;

    const bottomButtons = document.createElement('div');
    Object.assign(bottomButtons.style, { display: 'flex', gap: '10px', flexWrap: 'wrap' });
    bottomButtons.appendChild(bottomExportBtn);
    const bottomPhotosXlsxBtn = document.createElement('button');
    bottomPhotosXlsxBtn.type = 'button';
    bottomPhotosXlsxBtn.textContent = '🖼️ XLSX Não Concluídas';
    Object.assign(bottomPhotosXlsxBtn.style, {
      padding: '10px 16px', backgroundColor: '#007e87', color: '#fff', border: 'none',
      borderRadius: '6px', cursor: 'pointer', fontWeight: '700'
    });
    bottomPhotosXlsxBtn.onclick = exportarFotosXlsx;
    bottomButtons.appendChild(bottomPhotosXlsxBtn);
    bottomArea.appendChild(info);
    bottomArea.appendChild(bottomButtons);
    itemsContainer.appendChild(bottomArea);
  }

  function atualizarResumoNaoAnalisadas(totalExibido, auditoriasSalvas = null) {
    const salvas = auditoriasSalvas || loadAudits();
    const naoAnalisadas = allResults.reduce((quantidade, item) =>
      quantidade + (salvas[auditKey(item)] ? 0 : 1), 0);
    resultsCountDiv.textContent = `Exibindo ${totalExibido} de ${allResults.length} O.S. | ` +
      `NÃO ANALISADAS: ${naoAnalisadas}`;
  }

  function minutosDaHoraTermino(valor) {
    const texto = String(valor || '').trim();
    const match = texto.match(/^(\d{1,2}):(\d{2})/);
    if (!match) return -1;
    const horas = Number(match[1]);
    const minutos = Number(match[2]);
    if (!Number.isFinite(horas) || !Number.isFinite(minutos) || horas > 23 || minutos > 59) return -1;
    return horas * 60 + minutos;
  }

  function renderCards() {
    itemsContainer.innerHTML = '';

    const dadosSalvos = { audits: loadAudits(), analyses: loadAnalyses() };
    const filteredByControls = allResults.filter(r => passesFilters(r, null, dadosSalvos));
    let filtered = forcedSearchOS
      ? allResults.filter(r => normalizeOSForSearch(r.os) === forcedSearchOS)
      : filteredByControls;
    if (!forcedSearchOS && activeFilters.situacao === 'hora_maior_menor') {
      filtered = [...filtered].sort((a, b) => {
        const horaB = minutosDaHoraTermino(b.horaTermino);
        const horaA = minutosDaHoraTermino(a.horaTermino);
        if (horaB !== horaA) return horaB - horaA;
        return String(a.os || '').localeCompare(String(b.os || ''), 'pt-BR', { numeric: true });
      });
    }

    atualizarResumoNaoAnalisadas(filtered.length, dadosSalvos.audits);

    if (filtered.length === 0) {
      const isFiltering = activeFilters.situacao !== 'todos' || (activeFilters.descricoes || []).length > 0 || activeFilters.motivo !== 'todos';
      const msg = isFiltering
        ? 'Nenhum item encontrado para os filtros selecionados.'
        : 'Nenhuma O.S. encontrada.';
      itemsContainer.innerHTML = `<div style="text-align:center;padding:40px;color:#aaa;">${msg}</div>`;
      return;
    }

    filtered.forEach((result, index) => createItemCard(result, index + 1, filtered.length));
    appendBottomExportArea();
  }

  function normalizeOSForSearch(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function focusOSCard(card) {
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const previousOutline = card.style.outline;
    const previousShadow = card.style.boxShadow;
    card.style.outline = '3px solid #B8860B';
    card.style.boxShadow = '0 0 0 5px rgba(184,134,11,0.28)';
    setTimeout(() => {
      card.style.outline = previousOutline;
      card.style.boxShadow = previousShadow;
    }, 3500);
  }

  function findRenderedOSCard(normalizedOS) {
    return Array.from(itemsContainer.querySelectorAll('.fa-os-card'))
      .find(card => card.dataset.osSearch === normalizedOS) || null;
  }

  function searchOS() {
    const normalizedOS = normalizeOSForSearch(osSearchInput.value);
    if (!normalizedOS) {
      forcedSearchOS = '';
      renderCards();
      osSearchInput.focus();
      return;
    }

    forcedSearchOS = '';
    const visibleCard = findRenderedOSCard(normalizedOS);
    if (visibleCard) {
      focusOSCard(visibleCard);
      return;
    }

    const existsInLoadedBase = allResults.some(r => normalizeOSForSearch(r.os) === normalizedOS);
    if (existsInLoadedBase) {
      forcedSearchOS = normalizedOS;
      renderCards();
      requestAnimationFrame(() => focusOSCard(findRenderedOSCard(normalizedOS)));
      return;
    }

    alert(`O.S. ${osSearchInput.value.trim()} nao encontrada na base carregada.`);
    osSearchInput.select();
  }

  osSearchBtn.onclick = searchOS;
  osSearchInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      searchOS();
    }
  });
  osSearchInput.addEventListener('search', () => {
    if (!osSearchInput.value.trim()) {
      forcedSearchOS = '';
      renderCards();
    }
  });

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  function getGridScrollContainer() {
    return document.getElementById('datagrid-top:databody') ||
      document.querySelector('.oj-datagrid-scroller') ||
      document.querySelector('[data-oj-container="ojDataGrid"] [style*="overflow"]');
  }

  function snapshotActivityFromDiv(div, equipesVisiveis = null) {
    const aid = String(div.getAttribute('aid') || '').trim();
    if (!aid) return null;
    const numeroOS = String(getOSFromDiv(div) || '').trim();
    if (!numeroOS || numeroOS === 'Desconhecida') return null;
    const { pid, date } = getParInfo(div);
    return {
      aid,
      pid,
      date,
      os: numeroOS,
      matricula: getMatriculaFromDiv(div),
      equipe: getEquipeFromDiv(div, equipesVisiveis),
      status: getStatusFromDiv(div),
      descricao: getFieldValue(div, '996'),
      cidade: getFieldValue(div, 'ccity'),
      bairro: getFieldValue(div, '218'),
      endereco: getFieldValue(div, 'caddress'),
      motivoSER: formatMotivoNaoExecucaoSer(getFieldValue(div, FIELD_MOTIVO_NAO_EXECUCAO_SER))
    };
  }

  async function collectAllActivitiesFromVirtualGrid(onProgress, isCancelled = () => false) {
    const scroller = getGridScrollContainer();
    const collected = new Map();
    const rejectedAids = new Map();
    const INTERVALO_ROLAGEM_MS = 250;
    const MAX_PASSAGENS = 4;
    const ESTABILIDADES_NO_FIM = 4;
    const MAX_ITERACOES = 1400;

    function captureVisibleRows() {
      let added = 0;
      const linhasNovas = Array.from(document.querySelectorAll('div[aid]'))
        .filter(div => {
          const aid = String(div.getAttribute('aid') || '').trim();
          return aid && !collected.has(aid);
        });
      if (!linhasNovas.length) return added;

      const equipesVisiveis = mapearEquipesVisiveis();
      linhasNovas.forEach(div => {
        const aid = String(div.getAttribute('aid') || '').trim();
        if (collected.has(aid)) return;
        const data = snapshotActivityFromDiv(div, equipesVisiveis);
        if (!data) {
          rejectedAids.set(aid, (rejectedAids.get(aid) || 0) + 1);
          return;
        }
        rejectedAids.delete(aid);
        collected.set(aid, Object.freeze({ ...data }));
        added++;
      });
      return added;
    }

    if (!scroller) {
      captureVisibleRows();
      return { activities: Object.freeze([...collected.values()]), diagnostic: { semScroller: true, passagens: [collected.size] } };
    }

    const originalTop = scroller.scrollTop;
    const passagens = [];

    for (let passagem = 1; passagem <= MAX_PASSAGENS; passagem++) {
      if (isCancelled()) break;
      scroller.scrollTop = 0;
      await sleep(INTERVALO_ROLAGEM_MS);
      let stableAtBottom = 0;
      let lastCount = collected.size;
      let lastHeight = scroller.scrollHeight;

      for (let iteracao = 0; iteracao < MAX_ITERACOES; iteracao++) {
        if (isCancelled()) break;
        const added = captureVisibleRows();
        const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const atBottom = scroller.scrollTop >= maxTop - 2;
        onProgress?.({ passagem, total: collected.size, added, atBottom, rejeitadas: rejectedAids.size });

        if (atBottom) {
          await sleep(INTERVALO_ROLAGEM_MS);
          captureVisibleRows();
          const stable = collected.size === lastCount && scroller.scrollHeight === lastHeight;
          stableAtBottom = stable ? stableAtBottom + 1 : 0;
          lastCount = collected.size;
          lastHeight = scroller.scrollHeight;
          if (stableAtBottom >= ESTABILIDADES_NO_FIM) break;
        } else {
          stableAtBottom = 0;
          lastCount = collected.size;
          lastHeight = scroller.scrollHeight;
        }

        const currentMaxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const step = Math.max(140, Math.floor(scroller.clientHeight * 0.55));
        scroller.scrollTop = Math.min(currentMaxTop, scroller.scrollTop + step);
        await sleep(INTERVALO_ROLAGEM_MS);
      }

      captureVisibleRows();
      passagens.push(collected.size);
      const semNovos = passagens.length >= 2 && passagens.at(-1) === passagens.at(-2);
      if (semNovos && rejectedAids.size === 0) break;
    }

    scroller.scrollTop = originalTop;
    await sleep(INTERVALO_ROLAGEM_MS);
    return {
      activities: Object.freeze([...collected.values()]),
      diagnostic: {
        semScroller: false,
        passagens,
        totalCongelado: collected.size,
        aidsRejeitados: [...rejectedAids.keys()],
        intervaloRolagemMs: INTERVALO_ROLAGEM_MS
      }
    };
  }

  async function carregarDetalheAtividade(data, opcoes = {}) {
          try {

          const [consultaIndividual, validImages] = await Promise.all([
            getActivityData(data.aid, data.pid, data.date),
            checkValidImages(buildUrls(data.aid), data.aid)
          ]);
          const activityData = consultaIndividual?.sucesso ? consultaIndividual.atividade : null;
          if (opcoes.completarDaAtividade && activityData) {

            const textoDe = valor => (valor === null || valor === undefined) ? '' : String(valor).trim();
            data = {
              ...data,
              descricao: data.descricao || textoDe(activityData['996']),
              cidade: data.cidade || textoDe(activityData.ccity),
              bairro: data.bairro || textoDe(activityData['218']),
              endereco: data.endereco || textoDe(activityData.caddress)
            };
          }

          const parecerSolicitacao = activityData?.[FIELD_PARECER_SOLICITACAO]
            ? String(activityData[FIELD_PARECER_SOLICITACAO]).trim()
            : (activityData?.ig_dsSolicitacao ? String(activityData.ig_dsSolicitacao).trim() : null);
          const parecer          = activityData?.[FIELD_PARECER]           ? String(activityData[FIELD_PARECER]).trim() : null;

          const horaTerminoRaw =
            activityData?.activity_end_time ??
            activityData?.end_time ??
            activityData?.time_end ??
            activityData?.completed_time ??
            activityData?.completion_time ??
            activityData?.endTime ??
            activityData?.timeEnd ??
            null;
          const horaTermino = formatHoraTermino(horaTerminoRaw);

          const dataEncerramentoRaw =
            activityData?.[FIELD_DATA_ENCERRAMENTO] ??
            activityData?.activity_date ??
            activityData?.appt_date ??
            activityData?.date ??
            data.date;
          const dataEncerramento = formatDataEncerramento(dataEncerramentoRaw);
          const incluirAdicionais = simNao(activityData?.[FIELD_INCLUIR_ADICIONAIS]);
          const ligacaoNova      = simNao(activityData?.[FIELD_LIGACAO_NOVA]);
          const numeroOSField    = activityData?.[FIELD_NUMERO_OS_FIELD]   || null;
          const codLocalidade    = null;
          const tipoPavimento    = activityData?.[FIELD_TIPO_PAVIMENTO]    || null;
          const extensaoVala     = activityData?.[FIELD_EXTENSAO_VALA]     ? activityData[FIELD_EXTENSAO_VALA] + " m" : null;
          const materialRamal    = activityData?.[FIELD_MATERIAL_RAMAL]    || null;
          const diametroRamal    = activityData?.[FIELD_DIAMETRO_RAMAL]    || null;
          const materialRede     = activityData?.[FIELD_MATERIAL_REDE]     || null;
          const profundidadeVala = activityData?.[FIELD_PROFUNDIDADE_VALA] || null;
          const tipoLigacao      = activityData?.[FIELD_TIPO_LIGACAO]      || null;
          const qtdRamais        = activityData?.[FIELD_QUANTIDADE_RAMAIS] || null;

          const posteriores = montarServicoPosterior(activityData);
          const desdobramentosCondicionais = montarDesdobramentosCondicionais(activityData);
          const qtdPosteriores = posteriores.length;
          const qtdDesdobramentosCondicionais = desdobramentosCondicionais.length;
          const incluirPosteriores = posteriores.length > 0 ? '✅ SIM' : '❌ NAO';
          const servicoPosterior1 = posteriores[0]?.descricao || null;
          const alertaMaisDeDoisDC = CODIGOS_MANUTENCAO_PARAMETRIZADOS.has(extractCodigo(data.descricao) || extractCodigo(activityData?.["996"])) && new Set(desdobramentosCondicionais.map(dc => dc.codigo).filter(Boolean)).size > 2;

          const extensaoValaNumero = parsePositiveNumber(activityData?.[FIELD_EXTENSAO_VALA]);
          const profundidadeValaNumero = parsePositiveNumber(activityData?.[FIELD_PROFUNDIDADE_VALA]);
          const teveEscavacao = extensaoValaNumero > 0 || profundidadeValaNumero > 0;
          const temDesdobroLocalizado = posteriores.length > 0 || desdobramentosCondicionais.length > 0;

          const codigoAbertura = extractCodigo(data.descricao) || extractCodigo(activityData?.["996"]);

          const identifierText = String(activityData?._identifier || '').trim();
          const osFromIdentifier = identifierText.match(/^[^\s-]+/)?.[0] || '';
          const osResolvida = String(
            activityData?.appt_number ||
            osFromIdentifier ||
            (data.os !== 'Desconhecida' ? data.os : '') ||
            data.aid
          ).trim();
          const ehServicoAdicional = /\/1$/.test(osResolvida);
          const alertaEscavacaoSemDesdobro = !ehServicoAdicional && teveEscavacao && !temDesdobroLocalizado;

          const statusGrade = data.status;
          const statusInterno = activityData?.astatus;
          const atividadeConcluida = isStatusConcluido(statusGrade) || isStatusConcluido(statusInterno);
          const statusResolvido = atividadeConcluida ? 'concluido' : normalizeText(statusGrade);

          const motivoNaoExecucaoRaw = obterMotivoNaoExecucaoSer(activityData, data.motivoSER);
          const motivoSERAtual = atividadeConcluida
            ? 'Nao se aplica'
            : (motivoNaoExecucaoRaw || 'Nao informado');

          const recursoResolvido = recurso(
            activityData,
            consultaIndividual?.recursoAtual || '',
            data.equipe,
            consultaIndividual?.origemRecurso || ''
          );
          const equipeResolvida = recursoResolvido.codigo;
          const origemRecurso = recursoResolvido.valido
            ? (consultaIndividual?.recursoAtual ? consultaIndividual.origemRecurso : 'grade_fallback')
            : (consultaIndividual?.origemRecurso || 'nao_identificado');
          const matriculaResolvida = resolveMatricula(data, activityData);

          const hidrometro = resolveHidrometro(data, activityData);

          const descricaoServicoNormalizada = normalizeText(data.descricao || activityData?.["996"]);
          const servicoCaminhaoPipa = descricaoServicoNormalizada.includes('abastecimento por caminhao pipa');

          const analiseDesdobramento = atividadeConcluida
            ? analisarDesdobramento({
                codigoAbertura,
                quantidadeInformada: activityData?.[FIELD_QUANTIDADE_POSTERIORES],
                posteriores, desdobramentosCondicionais,
                naoExigePorDescricao: servicoCaminhaoPipa,
                ehServicoAdicional, teveEscavacao
              })
            : null;

          const alerta943701ComDesdobro = !ehServicoAdicional && codigoAbertura === '943701' && temDesdobroLocalizado;

          const desvioServicoEsgoto = false;

          const alerta610806ComDesdobro = !ehServicoAdicional && codigoAbertura === '610806' && temDesdobroLocalizado;
          const alertaCaminhaoPipaComDesdobro = !ehServicoAdicional && servicoCaminhaoPipa && temDesdobroLocalizado;

          const motivoNormalizado = normalizeText(motivoSERAtual);
          const desvioMotivoNaoExecucao = !atividadeConcluida && (
            motivoNormalizado === 'endereco nao localizado' ||
            motivoNormalizado === 'solicitacao improcedente'
          );

          const posterioresReaterroRecomposicaoSemSAA = [];
          const desvioPosteriorSemSAA = false;

          const setor = EQUIPE_SETOR_MAP[equipeResolvida] || (equipeResolvida ? 'Equipe nao cadastrada' : 'Equipe nao identificada');

          return {
            ...data, equipe: equipeResolvida, origemRecurso,
            candidatosRecurso: consultaIndividual?.candidatosRecurso || [],
            matricula: matriculaResolvida, hidrometro,
            status: statusResolvido, os: osResolvida, motivoSER: motivoSERAtual, validImages, parecerSolicitacao, parecer,
            horaTermino, dataEncerramento,
            incluirAdicionais, ligacaoNova, numeroOSField, codLocalidade,
            tipoPavimento, extensaoVala, materialRamal, diametroRamal,
            materialRede, profundidadeVala, tipoLigacao, qtdRamais,
            incluirPosteriores, qtdPosteriores, servicoPosterior1, posteriores,
            desdobramentosCondicionais, qtdDesdobramentosCondicionais, alertaMaisDeDoisDC,
            teveEscavacao, alertaEscavacaoSemDesdobro,
            extensaoValaNumero, profundidadeValaNumero,
            alerta943701ComDesdobro, desvioServicoEsgoto,
            alerta610806ComDesdobro, servicoCaminhaoPipa, alertaCaminhaoPipaComDesdobro,
            desvioMotivoNaoExecucao,
            desvioPosteriorSemSAA, posterioresReaterroRecomposicaoSemSAA,
            codigoAbertura, analiseDesdobramento, ehServicoAdicional, setor,
          };
          } catch (erro) {
            console.error('[AUDITORIA] Falha ao carregar atividade', data?.aid, erro);
            return {
              ...data, os: data.os || data.aid, matricula: data.matricula || '', hidrometro: 'Nao Encontrado',
              equipe: data.equipe || '', origemRecurso: 'grade_fallback', status: data.status || '', validImages: [],
              posteriores: [], desdobramentosCondicionais: [], qtdDesdobramentosCondicionais: 0, alertaMaisDeDoisDC: false,
              incluirPosteriores: '❌ NAO', analiseDesdobramento: null,
              erroCarregamento: String(erro?.message || erro)
            };
          }
  }

  async function showAllImages() {
    if (auditoriaCarregando) {
      alert('A auditoria ja esta sendo carregada. Aguarde a conclusao antes de iniciar novamente.');
      return;
    }
    auditoriaCarregando = true;
    const inicioAuditoria = performance.now();
    try {
    const minhaExecucao = ++execucaoAuditoriaAtual;
    const isCancelled = () => minhaExecucao !== execucaoAuditoriaAtual;
    itemsContainer.innerHTML = '';
    activeFilters = { situacao: 'todos', descricao: 'todos', descricoes: [], motivo: 'todos', analise: 'todos' };
    situacaoFilterSelect.value = 'todos';
    analiseFilterSelect.value = 'todos';
    descricaoFilterSelect.innerHTML = '<option value="todos">Todos</option>';
    descricaoFilterSelect.value = 'todos';
    activeFilters.descricoes = [];
    renderDescriptionChecklist();
    motivoFilterSelect.innerHTML = '<option value="todos">Todos</option>';
    motivoFilterSelect.value = 'todos';

    mainModal.style.display = 'block';
    const loadingDiv = document.createElement('div');
    loadingDiv.textContent = 'Mapeando todas as atividades da grade...';
    Object.assign(loadingDiv.style, { textAlign: 'center', fontSize: '18px', padding: '20px', color: '#aaa' });
    itemsContainer.appendChild(loadingDiv);

    const coleta = await collectAllActivitiesFromVirtualGrid((progresso) => {
      loadingDiv.textContent = `Mapeando grade - passagem ${progresso.passagem}: ${progresso.total} atividades unicas`;
    }, isCancelled);
    if (isCancelled()) { auditoriaCarregando = false; loadingDiv.remove(); return; }
    const collectedData = coleta.activities;
    const inicioConsultas = performance.now();
    const diagnosticoColeta = coleta.diagnostic;
    console.info('[AUDITORIA] Lista congelada:', diagnosticoColeta);

    if (collectedData.length === 0) {
      loadingDiv.remove();
      alert('Nenhuma atividade encontrada na grade.');
      return;
    }

    const pendenteCount = collectedData.filter(data => normalizeText(data.status) === 'pendente').length;

    const osData = [...collectedData];
    const osCountConcluido = osData.filter(data => isStatusConcluido(data.status)).length;
    const osCountNaoConcluido = osData.filter(data => {
      const status = normalizeText(data.status);
      return status !== 'pendente' && !isStatusConcluido(status);
    }).length;
    currentCounts = { concluido: osCountConcluido, naoConcluido: osCountNaoConcluido, pendente: pendenteCount };
    updateModalTitle();
    loadingDiv.textContent = `Lista congelada: ${collectedData.length} atividades. Carregando dados e fotos...`;

    const CONCURRENCY = 6;
    const results = new Array(osData.length);
    let proximoIndice = 0;
    let concluidasCarga = 0;
    const trabalhador = async () => {
      while (!isCancelled()) {
        const indice = proximoIndice++;
        if (indice >= osData.length) return;
        const data = osData[indice];
        let resultado;
        try {
          resultado = await carregarDetalheAtividade(data);
        } catch (erro) {
          console.error('[AUDITORIA] Falha isolada no trabalhador da O.S.', data?.aid, erro);
          resultado = { ...data, validImages: [], erroCarregamento: String(erro?.message || erro) };
        }
        results[indice] = resultado;
        concluidasCarga++;
        loadingDiv.textContent = `Carregando dados e fotos... ${concluidasCarga}/${osData.length}`;
        resultsCountDiv.textContent = `Carregadas ${concluidasCarga} de ${osData.length} O.S.`;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, osData.length) }, () => trabalhador()));

    loadingDiv.remove();

    allResults = results.filter(Boolean);
    currentCounts = {
      concluido: allResults.filter(result => isStatusConcluido(result.status)).length,
      naoConcluido: allResults.filter(result => normalizeText(result.status) !== 'pendente' && !isStatusConcluido(result.status)).length,
      pendente: allResults.filter(result => normalizeText(result.status) === 'pendente').length
    };
    updateModalTitle();
    populateDynamicSelect(descricaoFilterSelect, 'descricao', r => r.descricao);
    populateDynamicSelect(motivoFilterSelect, 'motivo', r => r.motivoSER);
    renderCards();
    auditoriaCarregando = false;
    console.info('[AUDITORIA] Tempo de carregamento (ms):', {
      varreduraGrade: Math.round(inicioConsultas - inicioAuditoria),
      consultasFotosRender: Math.round(performance.now() - inicioConsultas),
      total: Math.round(performance.now() - inicioAuditoria),
      osComFotos: allResults.filter(item => item.validImages?.length > 0).length,
      osComRecurso: allResults.filter(item => Boolean(item.equipe)).length,
      osComFalha: allResults.filter(item => Boolean(item.erroCarregamento)).length
    });
    console.info('[AUDITORIA] Resumo final estavel:', {
      totalCongelado: osData.length,
      carregadas: allResults.length,
      pendentes: pendenteCount,
      diagnosticoColeta
    });
    } catch (erro) {
      console.error('[AUDITORIA] Falha geral no carregamento da auditoria.', erro);
      alert('Falha ao carregar auditoria. Confira o console para o diagnostico.');
    } finally {
      auditoriaCarregando = false;
    }
  }

  let imageCacheMemoria = null;
  function loadImageCache() {
    if (imageCacheMemoria === null) {
      imageCacheMemoria = safeJsonParse(sessionStorage.getItem(IMAGE_CACHE_KEY), {}) || {};
    }
    return imageCacheMemoria;
  }
  function saveImageCache(cache) {
    imageCacheMemoria = cache;
    try { sessionStorage.setItem(IMAGE_CACHE_KEY, JSON.stringify(cache)); }
    catch (erro) { console.warn('[AUDITORIA] Cache de fotos indisponivel.', erro); }
  }

  const PHOTO_MAX_IN_FLIGHT = 8;
  let photoInFlight = 0;
  const photoWaiters = [];
  async function withPhotoSlot(tarefa) {
    if (photoInFlight >= PHOTO_MAX_IN_FLIGHT) {
      await new Promise(resolve => photoWaiters.push(resolve));
    }
    photoInFlight++;
    try { return await tarefa(); }
    finally {
      photoInFlight--;
      const proximo = photoWaiters.shift();
      if (proximo) proximo();
    }
  }

  let photoHeadUnsupported = false;
  async function requestFoto(url, metodo, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const options = { method: metodo, credentials: 'include', signal: controller.signal };

      if (metodo === 'GET') options.headers = { Range: 'bytes=0-0' };
      const resposta = await fetch(url, options);
      const ct = (resposta.headers.get('content-type') || '').toLowerCase();
      const valida = resposta.ok && (!ct || ct.startsWith('image/') || ct.includes('octet-stream'));

      if (metodo === 'GET' && resposta.body) {
        try { await resposta.body.cancel(); } catch {}
      }
      return { valida, status: resposta.status, tipo: ct };
    } finally { clearTimeout(timer); }
  }

  async function checkImage(url) {
    return withPhotoSlot(async () => {
      try {
        if (!photoHeadUnsupported) {
          try {
            const head = await requestFoto(url, 'HEAD', 9000);
            if (head.valida) return url;
            if (![400, 403, 405, 501].includes(head.status)) return null;
            if (head.status === 405 || head.status === 501) photoHeadUnsupported = true;
          } catch (erro) {

            if (erro?.name === 'AbortError') return null;
          }
        }
        const get = await requestFoto(url, 'GET', 12000);
        return get.valida ? url : null;
      } catch { return null; }
    });
  }

  const photoRequestsInFlight = new Map();
  async function checkValidImages(urls, aid) {
    const key = String(aid);
    const cache = loadImageCache();
    const cached = cache[key];
    const ttl = cached?.images?.length ? IMAGE_CACHE_TTL_MS : 90 * 1000;
    if (cached && Date.now() - cached.ts < ttl) return cached.images || [];
    if (photoRequestsInFlight.has(key)) return photoRequestsInFlight.get(key);

    const trabalho = (async () => {
      const valid = [];
      const PHOTO_CONCURRENCY = 3;
      for (let i = 0; i < urls.length; i += PHOTO_CONCURRENCY) {
        const lote = urls.slice(i, i + PHOTO_CONCURRENCY);
        const resultados = await Promise.all(lote.map(checkImage));
        valid.push(...resultados.filter(Boolean));
      }
      const cacheAtual = loadImageCache();
      cacheAtual[key] = { ts: Date.now(), images: valid };
      saveImageCache(cacheAtual);
      return valid;
    })();
    photoRequestsInFlight.set(key, trabalho);
    try { return await trabalho; }
    finally { photoRequestsInFlight.delete(key); }
  }

  const ERRO_OP = {
    largura: 1280,
    escala: 1.5,
    margem: 16,
    ladoMiniatura: 640,
    qualidadeJpg: 0.9,
    fundo: '#0E1418'
  };
  const ERRO_OP_ICONE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" style="flex-shrink:0;display:block">' +
    '<path d="M12 3.2 L21.6 20 H2.4 Z" fill="#FFD21F" stroke="#000" stroke-width="2.2" stroke-linejoin="round"/>' +
    '<rect x="11" y="9" width="2" height="5.6" rx="1" fill="#000"/><circle cx="12" cy="17" r="1.25" fill="#000"/></svg>';

  function erroOpNomeArquivo(os, extensao) {
    return `OS_${String(os || 'sem_numero').replace(/[^a-zA-Z0-9]+/g, '_')}_erro_operacional.${extensao}`;
  }

  function erroOpBaixar(blob, nome) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = nome;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function erroOpMiniatura(url) {
    const imagem = await carregarImagemParaMontagem(url);
    const fator = Math.min(1, ERRO_OP.ladoMiniatura / Math.max(imagem.naturalWidth, imagem.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(imagem.naturalWidth * fator));
    canvas.height = Math.max(1, Math.round(imagem.naturalHeight * fator));
    canvas.getContext('2d').drawImage(imagem, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82);
  }

  async function erroOpFotoOriginal(url) {
    const resposta = await fetch(url, { credentials: 'include', cache: 'force-cache' });
    if (!resposta.ok) throw new Error(`Falha HTTP ${resposta.status}`);
    const blob = await resposta.blob();
    return new Promise((resolve, reject) => {
      const leitor = new FileReader();
      leitor.onload = () => resolve(String(leitor.result));
      leitor.onerror = () => reject(new Error('Falha ao ler a foto'));
      leitor.readAsDataURL(blob);
    });
  }

  async function erroOpMontarRelatorio(card, images) {
    const fotos = Array.isArray(images) ? images : [];
    const miniaturas = await Promise.all(fotos.map(url => erroOpMiniatura(url).catch(() => '')));

    const copia = card.cloneNode(true);
    copia.querySelectorAll('.fa-review-section, .fa-card-actions, .fa-erro-op, .fa-obs-rapida').forEach(no => no.remove());
    copia.style.setProperty('margin', '0', 'important');
    copia.style.setProperty('width', '100%', 'important');
    copia.style.setProperty('box-sizing', 'border-box', 'important');
    const area = copia.querySelector('.fa-audit-workspace');
    if (area) area.style.setProperty('display', 'block', 'important');
    const grade = copia.querySelector('.fa-image-grid');
    if (grade) {
      const colunas = Math.min(4, Math.max(1, fotos.length));
      grade.style.setProperty('grid-template-columns', `repeat(${colunas}, minmax(0, 1fr))`, 'important');
      Array.from(grade.querySelectorAll('img')).forEach((img, i) => {
        img.removeAttribute('loading');
        img.parentNode.setAttribute('data-foto-indice', String(i));
        if (miniaturas[i]) { img.src = miniaturas[i]; return; }
        const aviso = document.createElement('div');
        aviso.textContent = `Foto ${i + 1} indisponível`;
        Object.assign(aviso.style, { width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8f99a4', fontSize: '12px' });
        img.replaceWith(aviso);
      });
    }

    const palco = document.createElement('div');
    Object.assign(palco.style, {
      position: 'fixed', left: '-100000px', top: '0', width: `${ERRO_OP.largura}px`, zIndex: '-1'
    });
    palco.appendChild(copia);
    (card.parentNode || document.body).appendChild(palco);
    try {
      await Promise.all(Array.from(copia.querySelectorAll('img')).map(img => img.decode().catch(() => {})));
      const nos = [copia, ...copia.querySelectorAll('*')];
      const estilos = nos.map(no => {
        const calculado = getComputedStyle(no);
        let texto = '';
        for (let i = 0; i < calculado.length; i++) {
          const propriedade = calculado[i];
          texto += `${propriedade}:${calculado.getPropertyValue(propriedade)};`;
        }
        return texto;
      });
      const altura = Math.ceil(copia.getBoundingClientRect().height);
      nos.forEach((no, i) => no.setAttribute('style', estilos[i]));
      return { no: copia, largura: ERRO_OP.largura, altura };
    } finally {
      palco.remove();
    }
  }

  async function erroOpGerarCanvas(card, images) {
    const relatorio = await erroOpMontarRelatorio(card, images);
    const largura = relatorio.largura + ERRO_OP.margem * 2;
    const altura = relatorio.altura + ERRO_OP.margem * 2;
    const moldura = document.createElement('div');
    moldura.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    moldura.setAttribute('style',
      `width:${largura}px;height:${altura}px;box-sizing:border-box;padding:${ERRO_OP.margem}px;background:${ERRO_OP.fundo};margin:0;`);
    moldura.appendChild(relatorio.no);

    const xhtml = new XMLSerializer().serializeToString(moldura).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${largura}" height="${altura}">` +
      `<foreignObject x="0" y="0" width="${largura}" height="${altura}">${xhtml}</foreignObject></svg>`;
    const imagem = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('O navegador não conseguiu desenhar o relatório'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(largura * ERRO_OP.escala);
    canvas.height = Math.round(altura * ERRO_OP.escala);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = ERRO_OP.fundo;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(imagem, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function erroOpCanvasParaBlob(canvas, tipo, qualidade) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('Falha ao gerar a imagem'))), tipo, qualidade);
    });
  }

  async function erroOpCopiarImagem(card, images, os) {
    const promessaPng = erroOpGerarCanvas(card, images).then(canvas => erroOpCanvasParaBlob(canvas, 'image/png'));
    try {

      await navigator.clipboard.write([new ClipboardItem({ 'image/png': promessaPng })]);
      return 'Copiado!';
    } catch (erroCopia) {
      const png = await promessaPng;
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        return 'Copiado!';
      } catch (erroFinal) {
        console.warn('[ERRO OP] Copia recusada pelo navegador; imagem baixada.', erroFinal);
        erroOpBaixar(png, erroOpNomeArquivo(os, 'png'));
        return 'Baixado (PNG)';
      }
    }
  }

  async function erroOpBaixarJpg(card, images, os) {
    const canvas = await erroOpGerarCanvas(card, images);
    erroOpBaixar(await erroOpCanvasParaBlob(canvas, 'image/jpeg', ERRO_OP.qualidadeJpg), erroOpNomeArquivo(os, 'jpg'));
    return 'Baixado!';
  }

  async function erroOpBaixarHtml(card, images, os) {
    const fotos = Array.isArray(images) ? images : [];
    const [relatorio, originais] = await Promise.all([
      erroOpMontarRelatorio(card, images),
      Promise.all(fotos.map(url => erroOpFotoOriginal(url).catch(() => '')))
    ]);
    const escapar = texto => String(texto).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const titulo = `O.S. ${os} — Erro operacional`;
    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapar(titulo)}</title>
<style>
  html, body { margin: 0; background: ${ERRO_OP.fundo}; color: #F2F7F8; font-family: "Segoe UI", Arial, sans-serif; }
  .topo { display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: #FFD21F; color: #111; font-weight: 800; font-size: 15px; }
  .topo small { font-weight: 600; margin-left: auto; }
  .pagina { padding: 16px; overflow-x: auto; }
  .dica { padding: 0 16px 18px; color: #9FB0B6; font-size: 13px; }
  [data-foto-indice] { cursor: zoom-in !important; }
  #visor { position: fixed; inset: 0; display: none; flex-direction: column; background: rgba(4, 8, 10, .96); z-index: 10; }
  #visor.aberto { display: flex; }
  #visor header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: #10181C; border-bottom: 1px solid #2D4149; font-size: 14px; }
  #visor header strong { margin-right: auto; }
  #visor button, #visor a { background: #1A2329; color: #F2F7F8; border: 1px solid #3B555E; border-radius: 6px; padding: 7px 12px; font: inherit; font-size: 13px; cursor: pointer; text-decoration: none; }
  #visor button:hover, #visor a:hover { border-color: #37B4C8; }
  #palco { flex: 1; overflow: auto; display: flex; }
  #palco img { margin: auto; display: block; max-width: 100%; max-height: 100%; cursor: zoom-in; }
  #palco.real img { max-width: none; max-height: none; cursor: zoom-out; }
</style>
</head>
<body>
<div class="topo"><span>⚠ ${escapar(titulo)}</span><small>Gerado em ${escapar(new Date().toLocaleString('pt-BR'))}</small></div>
<div class="pagina">${relatorio.no.outerHTML}</div>
<div class="dica">Clique em uma foto para abrir em tamanho grande. No visor: setas do teclado trocam de foto, clique na foto alterna entre ajustada e tamanho real, Esc fecha.</div>
<div id="visor">
  <header>
    <strong id="legenda"></strong>
    <button type="button" id="anterior">‹ Anterior</button>
    <button type="button" id="proxima">Próxima ›</button>
    <button type="button" id="tamanho">Tamanho real</button>
    <a id="salvar" download>Salvar foto</a>
    <button type="button" id="fechar">Fechar ✕</button>
  </header>
  <div id="palco"><img id="foto" alt=""></div>
</div>
<script>
(function () {
  var FOTOS = ${JSON.stringify(originais).replace(/</g, '\\u003c')};
  var OS = ${JSON.stringify(String(os || '')).replace(/</g, '\\u003c')};
  var visor = document.getElementById('visor'), palco = document.getElementById('palco'), foto = document.getElementById('foto');
  var legenda = document.getElementById('legenda'), salvar = document.getElementById('salvar'), tamanho = document.getElementById('tamanho');
  var atual = 0;
  function mostrar(i) {
    if (!FOTOS.length) return;
    atual = (i + FOTOS.length) % FOTOS.length;
    palco.classList.remove('real'); tamanho.textContent = 'Tamanho real';
    foto.src = FOTOS[atual] || '';
    legenda.textContent = 'O.S. ' + OS + ' — Foto ' + (atual + 1) + ' de ' + FOTOS.length + (FOTOS[atual] ? '' : ' (indisponível)');
    salvar.href = FOTOS[atual] || '#';
    salvar.setAttribute('download', 'OS_' + OS.replace(/[^a-zA-Z0-9]+/g, '_') + '_foto' + (atual + 1) + '.jpg');
    visor.classList.add('aberto');
  }
  function alternar() { var real = palco.classList.toggle('real'); tamanho.textContent = real ? 'Ajustar à tela' : 'Tamanho real'; }
  function fechar() { visor.classList.remove('aberto'); foto.removeAttribute('src'); }
  Array.prototype.forEach.call(document.querySelectorAll('[data-foto-indice]'), function (no) {
    no.addEventListener('click', function () { mostrar(Number(no.getAttribute('data-foto-indice'))); });
  });
  document.getElementById('anterior').onclick = function () { mostrar(atual - 1); };
  document.getElementById('proxima').onclick = function () { mostrar(atual + 1); };
  document.getElementById('fechar').onclick = fechar;
  tamanho.onclick = alternar; foto.onclick = alternar;
  document.addEventListener('keydown', function (e) {
    if (!visor.classList.contains('aberto')) return;
    if (e.key === 'Escape') fechar();
    if (e.key === 'ArrowLeft') mostrar(atual - 1);
    if (e.key === 'ArrowRight') mostrar(atual + 1);
  });
})();
</` + `script>
</body>
</html>`;
    erroOpBaixar(new Blob([html], { type: 'text/html;charset=utf-8' }), erroOpNomeArquivo(os, 'html'));
    return 'Baixado!';
  }

  document.addEventListener('click', evento => {
    document.querySelectorAll('.fa-erro-op-menu').forEach(menu => {
      if (!menu.parentNode.contains(evento.target)) menu.style.display = 'none';
    });
  });

  function criarBotaoErroOp(card, images, os) {
    const grupo = document.createElement('span');
    grupo.className = 'fa-erro-op';
    Object.assign(grupo.style, { position: 'relative', display: 'inline-flex' });

    const rotulo = 'O.S. Erro Op';
    const botao = document.createElement('button');
    botao.type = 'button';
    botao.title = 'Gerar o detalhamento desta O.S. para relatório de erro operacional';
    const pintar = texto => { botao.innerHTML = `${ERRO_OP_ICONE}<span>${texto}</span>`; };
    pintar(rotulo);
    Object.assign(botao.style, {
      display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 11px',
      backgroundColor: '#FFD21F', color: '#111111', border: '1px solid #9A7B00', borderRadius: '5px',
      cursor: 'pointer', fontSize: '12px', fontWeight: '800', lineHeight: '1.3', whiteSpace: 'nowrap'
    });

    const menu = document.createElement('div');
    menu.className = 'fa-erro-op-menu';
    Object.assign(menu.style, {
      display: 'none', position: 'absolute', top: '100%', left: '0', marginTop: '5px', zIndex: '60',
      minWidth: '250px', padding: '5px', backgroundColor: '#10181C', border: '1px solid #3B555E',
      borderRadius: '7px', boxShadow: '0 10px 28px rgba(0,0,0,.5)'
    });

    let ocupado = false;
    const executar = async acao => {
      if (ocupado) return;
      ocupado = true;
      menu.style.display = 'none';
      pintar('Gerando...');
      botao.style.opacity = '.75';
      let resultado = 'Falhou';
      try {
        resultado = await acao(card, images, os);
      } catch (erro) {
        console.error('[ERRO OP]', erro);
        alert(`Não foi possível gerar o relatório da O.S. ${os}.\n\n${erro && erro.message ? erro.message : erro}`);
      } finally {
        ocupado = false;
        botao.style.opacity = '1';
        pintar(resultado === 'Falhou' ? resultado : `✓ ${resultado}`);
        setTimeout(() => { if (!ocupado) pintar(rotulo); }, 2500);
      }
    };

    [
      ['📋 Copiar imagem', 'para colar no relatório', erroOpCopiarImagem],
      ['🖼️ Baixar imagem (JPG)', 'arquivo leve para anexar', erroOpBaixarJpg],
      ['🔎 Baixar HTML', 'fotos abrem uma a uma, em tamanho grande', erroOpBaixarHtml]
    ].forEach(([titulo, detalhe, acao]) => {
      const opcao = document.createElement('button');
      opcao.type = 'button';
      opcao.innerHTML = `<span style="display:block;font-weight:700;color:#F2F7F8;">${titulo}</span>` +
        `<span style="display:block;font-size:11px;color:#9FB0B6;margin-top:1px;">${detalhe}</span>`;
      Object.assign(opcao.style, {
        display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', margin: '0',
        backgroundColor: 'transparent', border: 'none', borderRadius: '5px', cursor: 'pointer', fontSize: '12.5px'
      });
      opcao.onmouseenter = () => { opcao.style.backgroundColor = '#1D2A31'; };
      opcao.onmouseleave = () => { opcao.style.backgroundColor = 'transparent'; };

      opcao.onclick = evento => { evento.stopPropagation(); executar(acao); };
      menu.appendChild(opcao);
    });

    botao.onclick = evento => {
      evento.stopPropagation();
      if (ocupado) return;
      const abrir = menu.style.display === 'none';
      document.querySelectorAll('.fa-erro-op-menu').forEach(outro => { outro.style.display = 'none'; });
      menu.style.display = abrir ? 'block' : 'none';
    };

    grupo.appendChild(botao);
    grupo.appendChild(menu);
    return grupo;
  }

  const DETALHES = {
    eventoAbrir: 'ofs-abrir-detalhes',
    eventoEstado: 'ofs-detalhes-estado',
    attrOS: 'data-ofs-detalhes-os',
    attrBusca: 'data-ofs-detalhes-busca',
    attrAberto: 'data-ofs-detalhes-aberto',
    attrDisponivel: 'data-ofs-detalhes-disponivel'
  };
  let detalhesExecucao = 0;
  let fecharDetalhesAtuais = null;

  async function localizarAtividadeNaGrade(numeroOS, continuar = () => true) {
    const alvo = normalizeOSForSearch(numeroOS);
    if (!alvo) return null;
    const descartados = new Set();
    const procurarNasLinhasVisiveis = () => {
      let equipes = null;
      for (const div of document.querySelectorAll('div[aid]')) {
        const aid = String(div.getAttribute('aid') || '').trim();
        if (!aid || descartados.has(aid)) continue;
        const numero = String(getOSFromDiv(div) || '').trim();
        if (!numero || numero === 'Desconhecida') continue;
        if (normalizeOSForSearch(numero) !== alvo) { descartados.add(aid); continue; }
        equipes = equipes || mapearEquipesVisiveis();
        const dados = snapshotActivityFromDiv(div, equipes);
        if (dados) return dados;
      }
      return null;
    };

    let achada = procurarNasLinhasVisiveis();
    if (achada) return achada;
    const scroller = getGridScrollContainer();
    if (!scroller) return null;

    const topoOriginal = scroller.scrollTop;

    document.documentElement.setAttribute(DETALHES.attrBusca, String(Date.now()));
    try {
      for (let passagem = 1; passagem <= 2 && !achada && continuar(); passagem++) {
        scroller.scrollTop = 0;
        await sleep(250);
        let paradoNoFim = 0;
        for (let i = 0; i < 1400 && !achada && continuar(); i++) {
          achada = procurarNasLinhasVisiveis();
          if (achada) break;
          const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          if (scroller.scrollTop >= maxTop - 2) {
            if (++paradoNoFim >= 3) break;
            await sleep(250);
            continue;
          }
          paradoNoFim = 0;

          const fracao = passagem === 1 ? 0.8 : 0.55;
          scroller.scrollTop = Math.min(maxTop, scroller.scrollTop + Math.max(140, Math.floor(scroller.clientHeight * fracao)));
          await sleep(250);
        }
      }
    } finally {
      scroller.scrollTop = topoOriginal;
      document.documentElement.removeAttribute(DETALHES.attrBusca);
    }
    return achada;
  }

  async function abrirDetalhesRapidos(numeroOS) {
    if (fecharDetalhesAtuais) fecharDetalhesAtuais();
    const execucao = ++detalhesExecucao;
    const ativo = () => execucao === detalhesExecucao;
    const inicio = performance.now();

    const fundo = document.createElement('div');
    Object.assign(fundo.style, {
      position: 'fixed', inset: '0', zIndex: '500000', overflowY: 'auto', boxSizing: 'border-box',
      padding: '22px 16px', backgroundColor: 'rgba(5,10,13,.84)'
    });
    const painel = document.createElement('div');
    painel.className = 'fa-modal-content';
    Object.assign(painel.style, {
      width: '100%', margin: '0 auto', borderRadius: '12px', boxSizing: 'border-box', position: 'relative'
    });
    painel.style.setProperty('max-width', '1320px', 'important');

    const barra = document.createElement('div');
    Object.assign(barra.style, { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' });
    const titulo = document.createElement('strong');
    titulo.textContent = `Detalhes da O.S. ${numeroOS}`;
    Object.assign(titulo.style, { fontSize: '17px', marginRight: 'auto' });
    barra.appendChild(titulo);

    const botoesDeSaida = [];
    const criarBotaoDaBarra = (texto, dica, cores) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = texto;
      b.title = dica;
      Object.assign(b.style, {
        padding: '7px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '12.5px', fontWeight: '700',
        whiteSpace: 'nowrap', backgroundColor: cores.fundo, color: cores.texto, border: `1px solid ${cores.borda}`
      });
      barra.appendChild(b);
      return b;
    };
    const coresSaida = { fundo: '#FFD21F', texto: '#111111', borda: '#9A7B00' };
    [
      ['📋 Copiar imagem', 'Copia o detalhamento como imagem, para colar no relatório', erroOpCopiarImagem],
      ['🖼️ Baixar imagem (JPG)', 'Baixa o detalhamento como imagem', erroOpBaixarJpg],
      ['🔎 Baixar HTML', 'Baixa um arquivo em que as fotos abrem uma a uma, em tamanho grande', erroOpBaixarHtml]
    ].forEach(([texto, dica, acao]) => {
      const b = criarBotaoDaBarra(texto, dica, coresSaida);
      b.disabled = true;
      b.style.opacity = '.45';
      botoesDeSaida.push({ botao: b, texto, acao });
    });
    const fecharBtn = criarBotaoDaBarra('Fechar ✕', 'Fechar (Esc)', { fundo: '#1A2329', texto: '#F2F7F8', borda: '#3B555E' });

    const estado = document.createElement('div');
    Object.assign(estado.style, { padding: '26px 10px', textAlign: 'center', fontSize: '15px', color: '#AEBFC4' });
    estado.textContent = 'Localizando a O.S. na grade...';
    const corpo = document.createElement('div');
    painel.append(barra, estado, corpo);
    fundo.appendChild(painel);
    document.body.appendChild(fundo);

    let fecharCaixaObs = null;
    const aoTeclar = evento => {
      if (evento.key !== 'Escape') return;

      if (imageModal.style.display === 'flex') return;
      if (fecharCaixaObs) {

        evento.stopPropagation();
        evento.preventDefault();
        fecharCaixaObs();
        return;
      }

      evento.stopPropagation();
      evento.preventDefault();
      fechar();
    };
    function fechar() {
      if (fecharDetalhesAtuais === fechar) fecharDetalhesAtuais = null;
      if (ativo()) detalhesExecucao++;
      document.removeEventListener('keydown', aoTeclar, true);
      fundo.remove();
      document.documentElement.removeAttribute(DETALHES.attrAberto);
      document.dispatchEvent(new Event(DETALHES.eventoEstado));
    }
    fecharDetalhesAtuais = fechar;
    fecharBtn.onclick = fechar;
    fundo.addEventListener('mousedown', evento => { if (evento.target === fundo) fechar(); });
    document.addEventListener('keydown', aoTeclar, true);
    document.documentElement.setAttribute(DETALHES.attrAberto, '1');
    document.dispatchEvent(new Event(DETALHES.eventoEstado));

    try {
      const dadosDaGrade = await localizarAtividadeNaGrade(numeroOS, ativo);
      if (!ativo()) return;
      if (!dadosDaGrade) {
        estado.textContent = `A O.S. ${numeroOS} não foi encontrada na grade do Console. Confira se ela ainda aparece com a data e o filtro atuais.`;
        return;
      }
      estado.textContent = 'Carregando dados e fotos...';
      const resultado = await carregarDetalheAtividade(dadosDaGrade, { completarDaAtividade: true });
      if (!ativo()) return;

      const chaveAuditoria = auditKey(resultado);
      const atualizadorDoConsole = mapCardUpdaters.get(chaveAuditoria);
      const obsDoConsole = obsCardUpdaters.get(chaveAuditoria);
      const card = createItemCard(resultado, 1, 1, corpo);
      if (atualizadorDoConsole) mapCardUpdaters.set(chaveAuditoria, atualizadorDoConsole);
      else mapCardUpdaters.delete(chaveAuditoria);
      if (obsDoConsole) obsCardUpdaters.set(chaveAuditoria, obsDoConsole);
      else obsCardUpdaters.delete(chaveAuditoria);

      card.querySelectorAll('.fa-review-section, .fa-erro-op, .fa-card-actions > span').forEach(no => no.remove());
      const area = card.querySelector('.fa-audit-workspace');
      if (area) area.style.setProperty('display', 'block', 'important');

      const linhaTitulo = card.querySelector('.fa-os-titulo');
      if (linhaTitulo) {
        linhaTitulo.appendChild(criarBotaoObservacao(chaveAuditoria, resultado.os || numeroOS, {
          aoAbrir: fecharCaixa => { fecharCaixaObs = fecharCaixa; },
          aoFechar: () => { fecharCaixaObs = null; }
        }));
      }
      estado.remove();
      if (resultado.erroCarregamento) {
        const aviso = document.createElement('div');
        aviso.textContent = `Os dados desta O.S. não puderam ser carregados por completo (${resultado.erroCarregamento}).`;
        Object.assign(aviso.style, { margin: '0 0 12px', padding: '9px 12px', borderRadius: '6px', border: '1px solid #f0ad4e', color: '#ffd27a', fontSize: '13px' });
        corpo.before(aviso);
      }
      titulo.textContent = `Detalhes da O.S. ${resultado.os || numeroOS}`;
      console.info('[DETALHES] O.S.', resultado.os, 'carregada em', Math.round(performance.now() - inicio), 'ms');

      const fotos = resultado.validImages || [];
      let ocupado = false;
      botoesDeSaida.forEach(({ botao, texto, acao }) => {
        botao.disabled = false;
        botao.style.opacity = '1';

        botao.onclick = async () => {
          if (ocupado) return;
          ocupado = true;
          botao.textContent = 'Gerando...';
          let retorno = 'Falhou';
          try {
            retorno = await acao(card, fotos, resultado.os || numeroOS);
          } catch (erro) {
            console.error('[DETALHES]', erro);
            alert(`Não foi possível gerar o arquivo da O.S. ${resultado.os || numeroOS}.\n\n${erro && erro.message ? erro.message : erro}`);
          } finally {
            ocupado = false;
            botao.textContent = retorno === 'Falhou' ? retorno : `✓ ${retorno}`;
            setTimeout(() => { if (!ocupado) botao.textContent = texto; }, 2500);
          }
        };
      });
    } catch (erro) {
      console.error('[DETALHES] Falha ao abrir os detalhes da O.S.', numeroOS, erro);
      if (ativo()) estado.textContent = `Não foi possível carregar os detalhes da O.S. ${numeroOS}. Veja o console para o diagnóstico.`;
    }
  }

  document.addEventListener(DETALHES.eventoAbrir, () => {
    const numero = String(document.documentElement.getAttribute(DETALHES.attrOS) || '').trim();
    if (numero) abrirDetalhesRapidos(numero);
  });

  if (window.top === window.self) document.documentElement.setAttribute(DETALHES.attrDisponivel, '1');

  function createItemCard({
    aid, os, matricula, hidrometro, status, descricao, cidade, bairro, endereco, motivoSER, parecerSolicitacao, parecer,
    horaTermino, dataEncerramento,
    incluirAdicionais, ligacaoNova, numeroOSField, codLocalidade,
    tipoPavimento, extensaoVala, materialRamal, diametroRamal,
    materialRede, profundidadeVala, tipoLigacao, qtdRamais,
    incluirPosteriores, qtdPosteriores, servicoPosterior1, posteriores,
    desdobramentosCondicionais, qtdDesdobramentosCondicionais, alertaMaisDeDoisDC,
    teveEscavacao, alertaEscavacaoSemDesdobro,
    extensaoValaNumero, profundidadeValaNumero,
    alerta943701ComDesdobro, desvioServicoEsgoto,
    alerta610806ComDesdobro, servicoCaminhaoPipa, alertaCaminhaoPipaComDesdobro,
    desvioMotivoNaoExecucao,
    desvioPosteriorSemSAA, posterioresReaterroRecomposicaoSemSAA,
    equipe, setor, codigoAbertura, analiseDesdobramento, ehServicoAdicional,
    origemRecurso, candidatosRecurso = [],
    validImages: images = []
  }, posicaoAtual = 1, totalAtual = 1, destino = null) {
    posteriores = Array.isArray(posteriores) ? posteriores : [];
    desdobramentosCondicionais = Array.isArray(desdobramentosCondicionais) ? desdobramentosCondicionais : [];
    const card = document.createElement('div');
    card.className = 'fa-os-card';
    card.dataset.osSearch = normalizeOSForSearch(os);
    card.dataset.osOriginal = String(os || '').trim();
    Object.assign(card.style, { backgroundColor: '#2a2a2a', borderRadius: '8px', padding: '15px', border: '1px solid #444' });

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
      marginBottom: '12px', paddingBottom: '10px', borderBottom: '1px solid #444'
    });

    const isConcluido  = isStatusConcluido(status);
    const statusColor  = '#FFFFFF';
    const statusBg     = isConcluido ? '#0B5D1E' : '#6A0D25';
    const statusBorder = isConcluido ? '#0B5D1E' : '#6A0D25';
    const statusLabel  = isConcluido ? '\u2714 Concluido' : '\u2716 Nao Concluido';

    const osInfo = document.createElement('div');
    osInfo.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <strong style="font-size:16px;">O.S.: ${os}</strong>
        <span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:bold;
          color:${statusColor};background:${statusBg};border:1px solid ${statusBorder};letter-spacing:0.3px;">
          ${statusLabel}
        </span>
      </div>
      <span style="color:#aaa;font-size:14px;">Recurso: ${equipe || 'Nao identificado'} | Matricula: ${matricula}</span>
    `;
    if (origemRecurso === 'conflito_formdata' && candidatosRecurso.length) {
      const conflitos = document.createElement('div');
      conflitos.textContent = `Equipes conflitantes: ${candidatosRecurso.join(', ')}`;
      conflitos.style.color = '#ffd27a';
      conflitos.style.fontSize = '11px';
      osInfo.appendChild(conflitos);
    }

    if (osInfo.firstElementChild) {
      osInfo.firstElementChild.classList.add('fa-os-titulo');
      osInfo.firstElementChild.appendChild(criarBotaoErroOp(card, images, os));
    }
    header.appendChild(osInfo);
    const headerActions = document.createElement('div');
    headerActions.className = 'fa-card-actions';
    Object.assign(headerActions.style, { display: 'flex', alignItems: 'center', gap: '8px', flexShrink: '0', marginLeft: '10px' });
    const osCounter = document.createElement('span');
    osCounter.textContent = `${posicaoAtual}/${totalAtual}`;
    Object.assign(osCounter.style, { padding: '5px 9px', borderRadius: '5px', backgroundColor: '#111419', border: '1px solid #46505c', color: '#d7e3ef', fontSize: '12px', fontWeight: 'bold', whiteSpace: 'nowrap' });
    headerActions.appendChild(osCounter);

    const copyBtn = document.createElement('button');
    copyBtn.innerHTML = '\ud83d\udccb Copiar OS';
    Object.assign(copyBtn.style, {
      padding: '6px 12px', backgroundColor: '#6c757d', color: 'white',
      border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
      flexShrink: '0', marginLeft: '10px'
    });
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(os).then(() => {
        copyBtn.innerHTML = '\u2713 Copiado!';
        setTimeout(() => { copyBtn.innerHTML = '\ud83d\udccb Copiar OS'; }, 2000);
      });
    };
    headerActions.appendChild(copyBtn);

    const copyHidroBtn = document.createElement('button');
    copyHidroBtn.innerHTML = '\ud83d\udca7 Hidro';
    Object.assign(copyHidroBtn.style, {
      padding: '6px 12px', backgroundColor: '#263238', color: '#80cbc4',
      border: '1px solid #80cbc4', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
      fontWeight: 'bold', flexShrink: '0'
    });
    copyHidroBtn.onclick = () => {
      const hidroTexto = String(hidrometro || '').trim();
      if (!hidroTexto || normalizeText(hidroTexto) === 'nao encontrado') {
        copyHidroBtn.innerHTML = '\u26a0 Sem hidro';
        setTimeout(() => { copyHidroBtn.innerHTML = '\ud83d\udca7 Hidro'; }, 2000);
        return;
      }
      navigator.clipboard.writeText(hidroTexto).then(() => {
        copyHidroBtn.innerHTML = '\u2713 Copiado!';
        setTimeout(() => { copyHidroBtn.innerHTML = '\ud83d\udca7 Hidro'; }, 2000);
      });
    };
    headerActions.appendChild(copyHidroBtn);

    const copyMatriculaBtn = document.createElement('button');
    copyMatriculaBtn.innerHTML = '\ud83d\udccb Matricula';
    Object.assign(copyMatriculaBtn.style, {
      padding: '6px 12px', backgroundColor: '#000000', color: 'white',
      border: '1px solid #333333', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
      flexShrink: '0'
    });
    copyMatriculaBtn.onclick = () => {
      const matriculaTexto = String(matricula || '').trim();
      if (!matriculaTexto) {
        copyMatriculaBtn.innerHTML = '\u26a0 Sem matricula';
        setTimeout(() => { copyMatriculaBtn.innerHTML = '\ud83d\udccb Matricula'; }, 2000);
        return;
      }
      navigator.clipboard.writeText(matriculaTexto).then(() => {
        copyMatriculaBtn.innerHTML = '\u2713 Copiado!';
        setTimeout(() => { copyMatriculaBtn.innerHTML = '\ud83d\udccb Matricula'; }, 2000);
      });
    };
    headerActions.appendChild(copyMatriculaBtn);
    header.appendChild(headerActions);
    card.appendChild(header);

    if (alerta943701ComDesdobro) {
      card.style.border = '2px solid #ffb300';
      card.style.boxShadow = '0 0 0 2px rgba(255,179,0,0.18)';

      const alert943701 = document.createElement('div');
      Object.assign(alert943701.style, {
        display: 'flex', alignItems: 'center', gap: '14px',
        marginBottom: '14px', padding: '12px 14px', borderRadius: '8px',
        background: 'linear-gradient(90deg, rgba(255,179,0,0.30), rgba(255,193,7,0.14))',
        border: '2px solid #ffb300', color: '#fff8e1'
      });
      alert943701.innerHTML = `
        <div style="font-size:34px;line-height:1;flex-shrink:0;">\ud83d\udd0e</div>
        <div>
          <div style="font-size:15px;font-weight:800;color:#ffd54f;margin-bottom:4px;">
            ANALISAR: CODIGO 943701 COM DESDOBRAMENTO
          </div>
          <div style="font-size:13px;line-height:1.45;color:#fff;">
            O servico 943701 - Verificacao Previa de Vazamento Agua - Improcedente nao exige desdobramento,
            porem foi localizado servico posterior. Verificar se o desdobramento foi realizado indevidamente.
          </div>
        </div>
      `;
      card.appendChild(alert943701);
    }

    if (desvioServicoEsgoto) {
      card.style.border = '2px solid #f44336';
      card.style.boxShadow = '0 0 0 2px rgba(244,67,54,0.22)';

      const sewerAlert = document.createElement('div');
      Object.assign(sewerAlert.style, {
        display: 'flex', alignItems: 'center', gap: '14px',
        marginBottom: '14px', padding: '12px 14px', borderRadius: '8px',
        background: 'linear-gradient(90deg, rgba(183,28,28,0.42), rgba(244,67,54,0.16))',
        border: '2px solid #f44336', color: '#ffebee'
      });
      sewerAlert.innerHTML = `
        <div style="font-size:34px;line-height:1;flex-shrink:0;">\u26d4</div>
        <div>
          <div style="font-size:15px;font-weight:800;color:#ff8a80;margin-bottom:4px;">
            DESVIO: SERVICO DE ESGOTO
          </div>
          <div style="font-size:13px;line-height:1.45;color:#fff;">
            A descricao do servico contem a palavra "Esgoto". Esta O.S. deve ser identificada como desvio.
          </div>
        </div>
      `;
      card.appendChild(sewerAlert);
    }

    if (desvioPosteriorSemSAA) {
      card.style.border = '2px solid #e53935';
      card.style.boxShadow = '0 0 0 2px rgba(229,57,53,0.22)';

      const posteriorSaaAlert = document.createElement('div');
      Object.assign(posteriorSaaAlert.style, {
        display: 'flex', alignItems: 'center', gap: '14px',
        marginBottom: '14px', padding: '12px 14px', borderRadius: '8px',
        background: 'linear-gradient(90deg, rgba(183,28,28,0.44), rgba(229,57,53,0.18))',
        border: '2px solid #e53935', color: '#ffebee'
      });

      const listaPosterioresSemSAA = posterioresReaterroRecomposicaoSemSAA
        .map(posterior => CODIGO_DESCRICAO_MAP[posterior.codigo] || posterior.descricao || posterior.codigo)
        .join('<br>');

      posteriorSaaAlert.innerHTML = `
        <div style="font-size:34px;line-height:1;flex-shrink:0;">\ud83d\udea8</div>
        <div>
          <div style="font-size:15px;font-weight:800;color:#ff8a80;margin-bottom:4px;">
            DESVIO: POSTERIOR DE REATERRO/RECOMPOSICAO SEM SAA
          </div>
          <div style="font-size:13px;line-height:1.5;color:#fff;">
            Foi localizado posterior de reaterro ou recomposicao sem o termo SAA na descricao:<br>
            <strong>${listaPosterioresSemSAA}</strong><br>
            Verificar se o codigo posterior foi selecionado incorretamente.
          </div>
        </div>
      `;
      card.appendChild(posteriorSaaAlert);
    }

    if (alerta610806ComDesdobro || alertaCaminhaoPipaComDesdobro) {
      card.style.border = '2px solid #ffb300';
      const title = alerta610806ComDesdobro
        ? 'ANALISAR: VISTORIA EM HIDRANTE COM DESDOBRAMENTO'
        : 'ANALISAR: ABASTECIMENTO POR CAMINHAO-PIPA COM DESDOBRAMENTO';
      const message = alerta610806ComDesdobro
        ? 'O codigo 610806 nao exige desdobramento, porem foi localizado servico posterior.'
        : 'Abastecimento por caminhao-pipa nao exige desdobramento, porem foi localizado servico posterior.';
      const alert = document.createElement('div');
      Object.assign(alert.style, {
        marginBottom: '14px', padding: '12px 14px', borderRadius: '8px',
        background: 'rgba(255,179,0,0.20)', border: '2px solid #ffb300', color: '#fff'
      });
      alert.innerHTML = `<strong style="color:#ffd54f;">\ud83d\udd0e ${title}</strong><br>${message} Verificar se o desdobramento foi realizado indevidamente.`;
      card.appendChild(alert);
    }

    if (desvioMotivoNaoExecucao) {
      card.style.border = '2px solid #f44336';
      const alert = document.createElement('div');
      Object.assign(alert.style, {
        marginBottom: '14px', padding: '12px 14px', borderRadius: '8px',
        background: 'rgba(183,28,28,0.38)', border: '2px solid #f44336', color: '#fff'
      });
      alert.innerHTML = `<strong style="color:#ff8a80;">\u26d4 DESVIO: MOTIVO DE NAO EXECUCAO</strong><br>A atividade foi nao concluida/postergada com o motivo: <strong>${motivoSER}</strong>.`;
      card.appendChild(alert);
    }

    const infoGrid = document.createElement('div');
    infoGrid.className = 'fa-info-grid';
    Object.assign(infoGrid.style, { display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '14px', fontSize: '13px' });

    function infoItem(label, value, { highlight = false, fullWidth = false, blue = false, preWrap = false } = {}) {
      if (!value || !String(value).trim()) return null;
      const wrap = document.createElement('div');
      let bg     = '#1a1a1a', border = '#333';
      if (highlight) { bg = 'rgba(220,53,69,0.15)'; border = 'rgba(220,53,69,0.5)'; }
      if (blue)      { bg = 'rgba(0,123,255,0.08)'; border = 'rgba(0,123,255,0.3)'; }
      Object.assign(wrap.style, {
        backgroundColor: bg, border: `1px solid ${border}`, borderRadius: '6px',
        padding: '7px 10px',
        flex: fullWidth ? '1 1 100%' : '1 1 200px',
        minWidth: fullWidth ? '100%' : '160px',
        maxWidth: fullWidth ? '100%' : 'none',
        boxSizing: 'border-box',
      });
      wrap.innerHTML = `<span style="color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">${label}</span><br>
        <span style="color:#eee;${preWrap ? 'white-space:pre-wrap;' : ''}">${value}</span>`;
      return wrap;
    }

    [
      { label: 'Equipe',                    value: equipe                   },
      { label: 'Cidade',                    value: cidade                   },
      { label: 'Bairro',                    value: bairro                   },
      { label: 'Endereco',                  value: endereco                 },
      { label: 'Data de Encerramento',      value: dataEncerramento || 'Nao informada' },
      { label: 'Hora de Término da O.S.',     value: horaTermino || 'Não informada' },
      { label: 'Hidrometro',                value: hidrometro || 'Nao Encontrado', blue: true },
      { label: 'Descricao do Servico',       value: descricao || 'Nao informada', blue: true },
    ].forEach(({ label, value, highlight, blue, fullWidth, preWrap }) => {
      const el = infoItem(label, value, { highlight, blue, fullWidth, preWrap });
      if (el) infoGrid.appendChild(el);
    });

    if (infoGrid.children.length > 0) card.appendChild(infoGrid);

    if (isConcluido) {

      const temDC = desdobramentosCondicionais.length > 0;
      const temSP = posteriores.length > 0;
      const desdobramentoAberto = temSP || temDC;
      const nivelAnalise = analiseDesdobramento?.nivel || 'verificar';
      const palette = nivelAnalise === 'erro'
        ? { bg: '#3a171b', dark: '#2b1114', border: '#dc3545', color: '#ff7b86', icon: '❌' }
        : nivelAnalise === 'verificar'
          ? { bg: '#3a2d12', dark: '#2b210d', border: '#f0ad4e', color: '#ffd27a', icon: '⚠️' }
          : { bg: '#15351f', dark: '#102818', border: '#28a745', color: '#82d99b', icon: '✅' };

      const analysisSection = document.createElement('div');
      analysisSection.className = 'fa-auto-analysis';
      Object.assign(analysisSection.style, { marginBottom: '14px', borderRadius: '8px', overflow: 'hidden', border: `2px solid ${palette.border}`, backgroundColor: '#1b1f24' });
      const analysisHeader = document.createElement('div');
      analysisHeader.textContent = `${palette.icon} Analise de Desdobramento`;
      Object.assign(analysisHeader.style, { padding: '7px 12px', fontSize: '12px', fontWeight: 'bold', color: palette.color, backgroundColor: palette.bg, borderBottom: `1px solid ${palette.border}` });
      analysisSection.appendChild(analysisHeader);

      const analysisGrid = document.createElement('div');
      analysisGrid.className = 'fa-alerts-layout';
      Object.assign(analysisGrid.style, {
        display: 'grid', gridTemplateColumns: '1fr',
        gap: '1px', backgroundColor: '#3a414a'
      });

      function addTitle(parent, text) {
        const title = document.createElement('div');
        title.textContent = text;
        Object.assign(title.style, {
          color: '#b7bec7', fontSize: '10px', fontWeight: '800',
          textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: '5px'
        });
        parent.appendChild(title);
      }

      function markerCompact(isYes, reduced = false) {
        const group = document.createElement('div');
        Object.assign(group.style, {
          display: 'grid', gridTemplateColumns: `repeat(2, ${reduced ? '44px' : '58px'})`, gap: reduced ? '3px' : '4px',
          justifyContent: 'end', alignItems: 'center'
        });
        [[true, 'Sim'], [false, 'Nao']].forEach(([value, label]) => {
          const active = isYes === value;
          const item = document.createElement('div');
          item.textContent = `${active ? '●' : '○'} ${label}`;
          Object.assign(item.style, {
            height: reduced ? '19px' : '25px', display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: reduced ? '3px' : '4px', border: `1px solid ${active ? palette.border : '#46505c'}`,
            backgroundColor: '#171b20',
            color: active ? palette.color : '#7f8994', fontSize: reduced ? '9px' : '11px',
            fontWeight: active ? '800' : '600', boxSizing: 'border-box'
          });
          group.appendChild(item);
        });
        return group;
      }

      const adicionalSim = String(incluirAdicionais || '').includes('SIM');
      const posteriorSim = posteriores.length > 0;
      const osAdicionalVisual = /\/1$/.test(String(os || '').trim())
        ? String(os || '').trim()
        : `${String(os || '').trim()}/1`;

      const descricaoPosterior = posteriores.length
        ? posteriores.map(p => p.descricao || formatServicoPosterior(p.valorOriginal || p.codigo) || p.codigo || p.valorOriginal).join(' | ')
        : 'Sem Servico Posterior';
      const corDescricaoPosterior = posteriores.length ? palette.color : '#f0f3f6';

      const avisosPanel = document.createElement('div');
      Object.assign(avisosPanel.style, {
        backgroundColor: '#1b1f24', padding: '6px 9px',
        minWidth: '0', boxSizing: 'border-box',
        display: 'flex', alignItems: 'flex-start', gap: '10px', flexWrap: 'wrap'
      });
      const avisosTitulo = document.createElement('div');
      avisosTitulo.textContent = 'AVISOS';
      Object.assign(avisosTitulo.style, {
        color: '#b7bec7', fontSize: '10px', fontWeight: '800',
        letterSpacing: '.4px', paddingTop: '2px', whiteSpace: 'nowrap'
      });
      avisosPanel.appendChild(avisosTitulo);
      const avisosLista = [...(analiseDesdobramento?.mensagens || [])];
      if (!avisosLista.length && nivelAnalise === 'verificar') avisosLista.push('Confira imagem se necessita.');
      if (!avisosLista.length) avisosLista.push(nivelAnalise === 'ok' ? 'Sem alertas.' : 'Verificar analise.');
      avisosLista.forEach(texto => {
        const linha = document.createElement('div');
        linha.textContent = `• ${texto}`;
        Object.assign(linha.style, {
          color: palette.color, fontSize: '11px', fontWeight: '700',
          lineHeight: '1.35', marginBottom: '0'
        });
        avisosPanel.appendChild(linha);
      });
      analysisGrid.appendChild(avisosPanel);

      const topArea = document.createElement('div');
      Object.assign(topArea.style, {
        display: 'grid', gridTemplateColumns: '165px minmax(210px,.9fr) 165px minmax(250px,1.2fr)',
        gap: '1px', backgroundColor: '#3a414a'
      });

      function booleanBox(title, isYes) {
        const box = document.createElement('div');
        Object.assign(box.style, {
          backgroundColor: '#1b1f24', padding: '5px 7px', minWidth: '0',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center'
        });
        addTitle(box, title);
        const markers = markerCompact(isYes);
        markers.style.justifyContent = 'center';
        box.appendChild(markers);
        return box;
      }
      function descriptionBox(title, text, color = '#f0f3f6') {
        const box = document.createElement('div');
        Object.assign(box.style, { backgroundColor: '#1b1f24', padding: '5px 8px', minWidth: '0' });
        addTitle(box, title);
        const value = document.createElement('div');
        value.textContent = text;
        Object.assign(value.style, { color, fontSize: '12px', fontWeight: '700', whiteSpace: 'pre-line', lineHeight: '1.4' });
        box.appendChild(value);
        return box;
      }

      topArea.appendChild(booleanBox('Servico Adicional', adicionalSim));
      topArea.appendChild(descriptionBox('Descricao Adicional', adicionalSim ? osAdicionalVisual : 'Sem Servico Adicional'));
      topArea.appendChild(booleanBox('Servico Posterior', posteriorSim));
      topArea.appendChild(descriptionBox('Descricao Servico Posterior', descricaoPosterior, corDescricaoPosterior));
      analysisGrid.appendChild(topArea);

      const dcArea = document.createElement('div');
      Object.assign(dcArea.style, {
        backgroundColor: '#1b1f24',
        padding: temDC ? '6px 8px' : '5px 8px',
        minWidth: '0', width: '100%', boxSizing: 'border-box'
      });

      if (!temDC) {

        const dcEmptyRow = document.createElement('div');
        Object.assign(dcEmptyRow.style, {
          display: 'grid',
          gridTemplateColumns: 'max-content max-content minmax(0,1fr)',
          alignItems: 'center',
          gap: '8px',
          minHeight: '28px'
        });

        const dcTitle = document.createElement('div');
        dcTitle.textContent = 'Desdobramento Condicional';
        Object.assign(dcTitle.style, {
          color: '#b7bec7', fontSize: '10px', fontWeight: '800',
          textTransform: 'uppercase', letterSpacing: '.4px', whiteSpace: 'nowrap'
        });
        dcEmptyRow.appendChild(dcTitle);
        dcEmptyRow.appendChild(markerCompact(false));

        const dcEmptyText = document.createElement('div');
        dcEmptyText.textContent = 'Sem Desdobramento Condicional';
        Object.assign(dcEmptyText.style, {
          color: nivelAnalise === 'ok' ? '#82d99b' : '#f0f3f6',
          fontSize: '12px', fontWeight: '700', paddingLeft: '6px'
        });
        dcEmptyRow.appendChild(dcEmptyText);
        dcArea.appendChild(dcEmptyRow);
      } else {

        const dcHeader = document.createElement('div');
        Object.assign(dcHeader.style, {
          display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
          gap: '6px', marginBottom: '6px'
        });
        const dcTitle = document.createElement('div');
        dcTitle.textContent = 'Desdobramento Condicional';
        Object.assign(dcTitle.style, {
          color: '#b7bec7', fontSize: '10px', fontWeight: '800',
          textTransform: 'uppercase', letterSpacing: '.4px', whiteSpace: 'nowrap'
        });
        dcHeader.appendChild(dcTitle);
        dcHeader.appendChild(markerCompact(true));
        dcArea.appendChild(dcHeader);

        const dcGrid = document.createElement('div');
        Object.assign(dcGrid.style, {
          display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: '3px 6px'
        });
        const ORDEM_VISUAL_DC = [
          FIELD_DC_ASFALTO_VIA_LOCAL, FIELD_DC_ASFALTO_VIA_ARTERIAL,
          FIELD_DC_LAJOTA_VIA_LOCAL, FIELD_DC_LAJOTA_VIA_ARTERIAL,
          FIELD_DC_CALCADA_VIA_LOCAL, FIELD_DC_CALCADA_VIA_ARTERIAL
        ];
        const camposDcOrdenados = ORDEM_VISUAL_DC
          .map(campo => CAMPOS_DESDOBRAMENTO_CONDICIONAL.find(config => config.campo === campo))
          .filter(Boolean);
        camposDcOrdenados.forEach(config => {
          const preenchido = desdobramentosCondicionais.find(dc => dc.fieldId === config.campo);
          const slot = document.createElement('div');
          Object.assign(slot.style, {
            minHeight: '24px', padding: '3px 7px', borderRadius: '4px', boxSizing: 'border-box',
            backgroundColor: preenchido ? 'rgba(255,255,255,.045)' : 'rgba(255,255,255,.025)',
            border: `1px solid ${preenchido ? palette.border : '#3b424b'}`,
            boxShadow: 'none',
            display: 'flex', alignItems: 'center', gap: '6px'
          });
          const resumo = document.createElement('div');
          resumo.textContent = config.titulo;
          Object.assign(resumo.style, {
            color: preenchido ? palette.color : '#747d87', fontSize: '10px',
            fontWeight: '800', textTransform: 'uppercase', whiteSpace: 'nowrap', flexShrink: '0', fontSize: '9px'
          });
          resumo.textContent = `${config.titulo}:`;
          slot.appendChild(resumo);
          const detalhe = document.createElement('div');
          detalhe.textContent = preenchido
            ? (preenchido.descricao || formatServicoPosterior(preenchido.codigo) || preenchido.codigo)
            : 'Nao informado';
          Object.assign(detalhe.style, {
            color: preenchido ? '#f0f3f6' : '#59616a', fontSize: '10px',
            lineHeight: '1.3', fontWeight: preenchido ? '650' : '500', minWidth: '0'
          });
          slot.appendChild(detalhe);
          dcGrid.appendChild(slot);
        });
        dcArea.appendChild(dcGrid);
      }
      if (!CODIGOS_SE_LIGA.has(codigoAbertura) || temDC) {

        analysisGrid.appendChild(dcArea);
      }

      analysisSection.appendChild(analysisGrid);
      card.appendChild(analysisSection);
    }

    const descricaoParecerSection = document.createElement('div');
    descricaoParecerSection.className = 'fa-tech-section fa-description-opinion-section';
    Object.assign(descricaoParecerSection.style, {
      marginBottom: '14px', borderRadius: '8px', overflow: 'hidden',
      border: '1px solid #3a3a3a'
    });
    const descricaoParecerHeader = document.createElement('div');
    descricaoParecerHeader.textContent = 'Parecer de Solicitacao & Execucao';
    Object.assign(descricaoParecerHeader.style, {
      backgroundColor: '#263238', padding: '7px 12px', fontSize: '11px',
      fontWeight: 'bold', color: '#80cbc4', textTransform: 'uppercase', letterSpacing: '.45px'
    });
    descricaoParecerSection.appendChild(descricaoParecerHeader);

    const descricaoParecerGrid = document.createElement('div');
    Object.assign(descricaoParecerGrid.style, {
      display: 'grid', gridTemplateColumns: 'minmax(180px,.65fr) minmax(180px,.65fr) minmax(360px,1.7fr)',
      gap: '1px', backgroundColor: '#3a3a3a'
    });
    [
      ['Parecer de Solicitacao', parecerSolicitacao || 'Nao informado', true],
      ['Motivo da Não Execução SER', motivoSER || 'Nao se aplica', false],
      ['Parecer de Execucao', parecer || 'Nao informado', true]
    ].forEach(([label, value, maior]) => {
      const cell = document.createElement('div');
      Object.assign(cell.style, {
        backgroundColor: '#222', padding: '9px 10px', minWidth: '0',
        minHeight: maior ? '68px' : '48px', boxSizing: 'border-box'
      });
      const labelEl = document.createElement('span');
      labelEl.textContent = label;
      Object.assign(labelEl.style, {
        color: '#888', fontSize: '10px', textTransform: 'uppercase',
        letterSpacing: '.4px', display: 'block', marginBottom: '4px'
      });
      const valueEl = document.createElement('div');
      valueEl.textContent = value;
      Object.assign(valueEl.style, {
        color: '#ddd', fontSize: maior ? '13px' : '12px', fontWeight: '650',
        lineHeight: '1.45', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'
      });
      cell.appendChild(labelEl);
      cell.appendChild(valueEl);
      descricaoParecerGrid.appendChild(cell);
    });
    descricaoParecerSection.appendChild(descricaoParecerGrid);
    card.appendChild(descricaoParecerSection);

    const resultForAudit = {
      aid, os, matricula, hidrometro, status, descricao, cidade, bairro, endereco, motivoSER,
      parecerSolicitacao, parecer, equipe, setor, codigoAbertura, dataEncerramento, horaTermino,
      incluirAdicionais, incluirPosteriores, posteriores,
      desdobramentosCondicionais, qtdDesdobramentosCondicionais, alertaMaisDeDoisDC,
      alertaEscavacaoSemDesdobro, alerta943701ComDesdobro, desvioServicoEsgoto,
      desvioPosteriorSemSAA, alerta610806ComDesdobro,
      alertaCaminhaoPipaComDesdobro, desvioMotivoNaoExecucao,
      analiseDesdobramento
    };
    const savedAudit = loadAudits()[auditKey(resultForAudit)] || {};
    const automaticAlerts = getAutomaticAlerts(resultForAudit);
    const auditSection = document.createElement('div');
    auditSection.className = 'fa-review-section';
    Object.assign(auditSection.style, {
      marginBottom: '14px', padding: '12px', borderRadius: '8px',
      backgroundColor: '#1b2026', border: '1px solid #46515d'
    });
    const auditTitle = document.createElement('div');
    auditTitle.textContent = 'Checklist da Auditoria';
    Object.assign(auditTitle.style, {
      fontSize: '14px', fontWeight: 'bold', marginBottom: '10px', color: '#fff'
    });
    auditSection.appendChild(auditTitle);
    const auditGrid = document.createElement('div');
    Object.assign(auditGrid.style, {
      display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: '10px'
    });
    const controls = {};
    const questions = [
      ['fachada', 'Foto da Fachada Ok?', '1', '1'],
      ['comprova', 'A Foto Comprova Resultado na O.S.?', '1', '2'],
      ['andamento', 'A Foto Comprova Andamento na O.S.?', '1', '3'],
      ['parecer', 'Parecer de Execucao Explicativo?', '2', '1'],
      ['hd', 'HD no Sansys e Igual a Foto?', '2', '2'],
      ['acaoCorretiva', 'Dispensa Acao Corretiva?', '2', '3'],
      ['desdobramento', 'Desdobramento Ok?', '3', '1'],
      ['naoExecucao', 'Motivo de Nao Execucao Coerente?', '3', '2']
    ];
    questions.forEach(([key, label, row, column]) => {
      const box = document.createElement('div');
      Object.assign(box.style, {
        background: '#111419', padding: '9px', borderRadius: '6px',
        gridRow: row, gridColumn: column
      });
      box.innerHTML = `<label style="display:block;font-size:12px;font-weight:bold;margin-bottom:6px;">${label}</label><select style="width:100%;background:#0d1014;color:#fff;border:1px solid #46505c;border-radius:5px;padding:8px;"><option value="">Selecione</option><option>Sim</option><option>Nao</option><option>NA</option></select>`;
      controls[key] = box.querySelector('select');
      controls[key].value = savedAudit[key] || '';
      auditGrid.appendChild(box);
    });
    const actionBox = document.createElement('div');
    Object.assign(actionBox.style, {
      background: '#111419', padding: '9px', borderRadius: '6px',
      gridRow: '3', gridColumn: '3'
    });
    actionBox.innerHTML = `<label style="display:block;font-size:12px;font-weight:bold;margin-bottom:6px;">Qual acao?</label><select style="width:100%;background:#0d1014;color:#fff;border:1px solid #46505c;border-radius:5px;padding:8px;"><option value="">Selecione</option>${AUDIT_ACTIONS.map(action => `<option>${action}</option>`).join('')}</select>`;
    controls.qualAcao = actionBox.querySelector('select');
    controls.qualAcao.value = normalizarAcaoAuditoria(savedAudit.qualAcao);
    auditGrid.appendChild(actionBox);
    const obsBox = document.createElement('div');
    Object.assign(obsBox.style, {
      background: '#111419', padding: '9px', borderRadius: '6px', gridRow: '4', gridColumn: '1'
    });
    obsBox.innerHTML = '<label style="display:block;font-size:12px;font-weight:bold;margin-bottom:6px;">Observacao</label><textarea rows="2" style="height:56px;resize:vertical;width:100%;box-sizing:border-box;background:#0d1014;color:#fff;border:1px solid #46505c;border-radius:5px;padding:8px;"></textarea>';
    controls.observacao = obsBox.querySelector('textarea');

    controls.observacao.value = obterObservacaoDaOS(auditKey(resultForAudit));
    obsCardUpdaters.set(auditKey(resultForAudit), texto => { controls.observacao.value = texto; });
    auditGrid.appendChild(obsBox);

    assistenteAnalisarCard({
      osInfo, chave: auditKey(resultForAudit), os, motivo: motivoSER, parecer,
      images, campoObs: controls.observacao
    });

    const mapImageBox = document.createElement('div');
    Object.assign(mapImageBox.style, {
      background: '#111419', padding: '7px 9px', borderRadius: '6px',
      gridRow: '4', gridColumn: '2', minHeight: '44px', maxHeight: '76px', overflow: 'hidden'
    });
    const mapImageLabel = document.createElement('label');
    mapImageLabel.textContent = 'Foto do mapa';
    Object.assign(mapImageLabel.style, {
      display: 'block', fontSize: '12px', fontWeight: 'bold', marginBottom: '4px'
    });
    const mapPasteArea = document.createElement('div');
    mapPasteArea.tabIndex = 0;
    mapPasteArea.setAttribute('role', 'button');
    mapPasteArea.setAttribute('aria-label', 'Clique e pressione Ctrl+V para colar a foto do mapa');
    Object.assign(mapPasteArea.style, {
      height: '32px', boxSizing: 'border-box', display: 'flex', alignItems: 'center',
      justifyContent: 'center', padding: '5px 8px', background: '#0d1014',
      color: '#aebbc0', border: '1px dashed #465f68', borderRadius: '5px',
      cursor: 'text', fontSize: '11px', textAlign: 'center', outline: 'none'
    });
    const currentAuditKey = auditKey(resultForAudit);
    let mapImageDataUrl = mapImagesByAuditKey.get(currentAuditKey) || savedAudit.mapaImagem || '';
    let mapImageFileName = savedAudit.mapaImagemNome || '';
    function updateMapPasteStatus(message = '') {
      const attached = Boolean(mapImageDataUrl);
      mapPasteArea.textContent = message || (attached ? 'Imagem anexada - Ctrl+V para substituir' : 'Clique aqui e pressione Ctrl+V');
      mapPasteArea.style.color = attached ? '#8fe3a1' : '#aebbc0';
      mapPasteArea.style.borderColor = attached ? '#39a856' : '#465f68';
    }
    mapCardUpdaters.set(currentAuditKey, dataUrl => {
      mapImageDataUrl = dataUrl;
      mapImageFileName = `mapa_${String(os || aid || 'OS').trim()}.jpg`;
      updateMapPasteStatus();
    });
    async function compactMapImage(file) {
      const sourceUrl = URL.createObjectURL(file);
      try {
        const image = await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('Imagem invalida'));
          img.src = sourceUrl;
        });

        const maxWidth = 1600;
        const maxHeight = 1100;
        const scale = Math.min(1, maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.90);
      } finally {
        URL.revokeObjectURL(sourceUrl);
      }
    }
    mapPasteArea.addEventListener('click', () => mapPasteArea.focus());
    mapPasteArea.addEventListener('focus', () => {
      mapPasteArea.style.boxShadow = '0 0 0 2px rgba(55,180,200,.18)';
    });
    mapPasteArea.addEventListener('blur', () => {
      mapPasteArea.style.boxShadow = 'none';
    });
    mapPasteArea.addEventListener('paste', async event => {
      const imageItem = Array.from(event.clipboardData?.items || [])
        .find(item => item.type && item.type.startsWith('image/'));
      if (!imageItem) {
        updateMapPasteStatus('Nenhuma imagem copiada');
        setTimeout(() => updateMapPasteStatus(), 1800);
        return;
      }
      event.preventDefault();
      const file = imageItem.getAsFile();
      try {
        updateMapPasteStatus('Processando imagem...');
        mapImageDataUrl = await compactMapImage(file);
        mapImageFileName = `mapa_${String(os || aid || 'OS').trim()}.jpg`;
        mapImagesByAuditKey.set(currentAuditKey, mapImageDataUrl);
        updateMapPasteStatus();
      } catch (erro) {
        console.error('[AUDITORIA MAPA]', erro);
        mapImageDataUrl = '';
        mapImageFileName = '';
        mapImagesByAuditKey.delete(currentAuditKey);
        updateMapPasteStatus('Falha ao colar imagem');
        alert('Nao foi possivel colar a foto do mapa. Faca o print e tente novamente.');
      }
    });
    updateMapPasteStatus();
    mapImageBox.appendChild(mapImageLabel);
    mapImageBox.appendChild(mapPasteArea);
    auditGrid.appendChild(mapImageBox);

    const auditorBox = document.createElement('div');
    Object.assign(auditorBox.style, { background: '#111419', padding: '9px', borderRadius: '6px', gridRow: '4', gridColumn: '3' });
    auditorBox.innerHTML = '<label style="display:block;font-size:12px;font-weight:bold;margin-bottom:6px;">Auditor</label><input style="width:100%;box-sizing:border-box;background:#0d1014;color:#fff;border:1px solid #46505c;border-radius:5px;padding:8px;">';
    controls.auditor = auditorBox.querySelector('input');
    controls.auditor.value = savedAudit.auditor || localStorage.getItem('auditoria_operacional_auditor') || '';
    auditGrid.appendChild(auditorBox);
    auditSection.appendChild(auditGrid);

    function toggleAuditAction() {
      controls.qualAcao.disabled = controls.acaoCorretiva.value !== 'Nao';
      if (controls.qualAcao.disabled) controls.qualAcao.value = '';
    }
    controls.acaoCorretiva.onchange = toggleAuditAction;
    toggleAuditAction();

    const auditButtons = document.createElement('div');
    Object.assign(auditButtons.style, {
      display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px', flexWrap: 'wrap'
    });
    const allOkButton = document.createElement('button');
    allOkButton.textContent = 'Tudo OK';
    const semPermissaoMaterialButton = document.createElement('button');
    semPermissaoMaterialButton.textContent = 'Sem Permissão/Material';
    const extensaoEscavacaoButton = document.createElement('button');
    extensaoEscavacaoButton.textContent = 'Extensão/Escavação';
    const saveAuditButton = document.createElement('button');
    saveAuditButton.textContent = 'Salvar';
    [allOkButton, semPermissaoMaterialButton, extensaoEscavacaoButton, saveAuditButton].forEach(button => Object.assign(button.style, {
      padding: '8px 12px', border: 'none', borderRadius: '6px', color: '#fff',
      fontWeight: 'bold', cursor: 'pointer'
    }));
    allOkButton.style.backgroundColor = '#107c10';
    semPermissaoMaterialButton.style.backgroundColor = '#8a5a00';
    extensaoEscavacaoButton.style.backgroundColor = '#7b1fa2';
    saveAuditButton.style.backgroundColor = '#0078d4';
    const auditInfo = document.createElement('span');
    Object.assign(auditInfo.style, { fontSize: '12px', color: '#aaa' });
    auditInfo.textContent = savedAudit.protocolo
      ? `Resultado: ${savedAudit.protocolo} | Salvas: ${countSavedAuditsForCurrentResults()}/${allResults.length} | Salvo em ${savedAudit.updatedAt}`
      : `Nao auditada | Salvas: ${countSavedAuditsForCurrentResults()}/${allResults.length}`;

    allOkButton.onclick = () => {
      controls.fachada.value = 'Sim';
      controls.comprova.value = 'Sim';
      controls.andamento.value = 'Sim';
      controls.parecer.value = 'Sim';
      controls.hd.value = 'Sim';
      controls.naoExecucao.value = 'NA';
      controls.acaoCorretiva.value = 'Sim';
      controls.desdobramento.value = analiseDesdobramento ? 'Sim' : 'NA';
      toggleAuditAction();
    };

    function abrirSelecaoDeAcao() {
      controls.qualAcao.value = '';
      controls.qualAcao.disabled = false;
      controls.qualAcao.focus();
      if (typeof controls.qualAcao.showPicker === 'function') {
        try { controls.qualAcao.showPicker(); } catch {}
      } else {
        controls.qualAcao.click();
      }
    }

    semPermissaoMaterialButton.onclick = () => {
      controls.fachada.value = 'Sim';
      controls.comprova.value = 'NA';
      controls.andamento.value = 'NA';
      controls.parecer.value = 'Sim';
      controls.hd.value = 'NA';
      controls.acaoCorretiva.value = 'Nao';
      controls.desdobramento.value = 'NA';
      controls.naoExecucao.value = 'Sim';
      toggleAuditAction();
      abrirSelecaoDeAcao();
    };

    extensaoEscavacaoButton.onclick = () => {
      controls.fachada.value = 'Sim';
      controls.comprova.value = 'Nao';
      controls.andamento.value = 'Nao';
      controls.parecer.value = 'Sim';
      controls.hd.value = 'NA';
      controls.acaoCorretiva.value = 'Nao';
      controls.desdobramento.value = 'NA';
      controls.naoExecucao.value = 'Sim';
      toggleAuditAction();
      abrirSelecaoDeAcao();
    };

    function saveCurrentAudit(showAlerts = true) {
      const audit = {};
      Object.entries(controls).forEach(([key, control]) => audit[key] = control.value.trim());
      audit.qualAcao = normalizarAcaoAuditoria(audit.qualAcao);
      audit.mapaImagemNome = mapImageFileName;
      if (mapImageDataUrl) mapImagesByAuditKey.set(auditKey(resultForAudit), mapImageDataUrl);
      delete audit.mapaImagem;
      const required = [
        audit.fachada, audit.comprova, audit.andamento, audit.parecer, audit.hd,
        audit.naoExecucao, audit.acaoCorretiva, audit.desdobramento
      ];
      if (required.some(value => !value)) {
        if (showAlerts) alert('Preencha todas as perguntas da auditoria.');
        return false;
      }
      if (audit.acaoCorretiva === 'Nao' && !audit.qualAcao) {
        if (showAlerts) alert('Selecione a acao recomendada.');
        return false;
      }
      audit.protocolo = calculateProtocol(audit);
      const agora = new Date();
      audit.auditDate = agora.toLocaleDateString('pt-BR');
      audit.auditTime = agora.toLocaleTimeString('pt-BR', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      });
      audit.updatedAt = `${audit.auditDate}, ${audit.auditTime}`;
      audit.base = {
        ...resultForAudit,
        alertasAutomaticos: automaticAlerts,
        analiseDesdobramentoResumo: analiseDesdobramento
          ? [analiseDesdobramento.necessidade, analiseDesdobramento.equipeDesdobrou,
             analiseDesdobramento.corretamente, ...analiseDesdobramento.mensagens].join(' | ')
          : 'Nao se aplica'
      };
      const audits = loadAudits();
      audits[auditKey(resultForAudit)] = audit;
      saveAudits(audits);

      assistenteRegistrarDecisaoFinal(auditKey(resultForAudit), os, motivoSER, audit.observacao, audit.auditor);
      localStorage.setItem('auditoria_operacional_auditor', audit.auditor);
      auditInfo.textContent = `Resultado: ${audit.protocolo} | Salvas: ${countSavedAuditsForCurrentResults()}/${allResults.length} | Salvo em ${audit.updatedAt}`;

      atualizarResumoNaoAnalisadas(itemsContainer.querySelectorAll('.fa-os-card').length, audits);
      return true;
    }
    saveAuditButton.classList.add('fa-save-audit-button');
    saveAuditButton.saveAuditSilently = () => saveCurrentAudit(false);
    saveAuditButton.onclick = () => saveCurrentAudit(true);

    auditButtons.appendChild(allOkButton);
    auditButtons.appendChild(semPermissaoMaterialButton);
    auditButtons.appendChild(extensaoEscavacaoButton);
    auditButtons.appendChild(saveAuditButton);
    auditButtons.appendChild(auditInfo);
    auditSection.appendChild(auditButtons);

    if (!images || images.length === 0) {
      const semFotos = document.createElement('div');
      semFotos.textContent = 'Fotos nao carregadas ou nao localizadas. Os dados e alertas da O.S. continuam disponiveis.';
      Object.assign(semFotos.style, {
        padding: '10px 12px', marginBottom: '10px', borderRadius: '6px',
        background: 'rgba(255,179,0,0.12)', border: '1px solid rgba(255,179,0,0.45)',
        color: '#ffe0b2', fontSize: '12px'
      });
      card.appendChild(semFotos);
    }
    const imageGrid = document.createElement('div');
    imageGrid.className = 'fa-image-grid';
    Object.assign(imageGrid.style, {
      display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
      gap: '10px', minHeight: '70px'
    });

    if (!images || images.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'Nenhuma foto encontrada nesta O.S.';
      Object.assign(empty.style, {
        color: '#8f99a4', padding: '12px', border: '1px solid #3d4650',
        borderRadius: '6px', minHeight: '44px', boxSizing: 'border-box'
      });
      imageGrid.appendChild(empty);
    } else {
      images.forEach((imgUrl, idx) => {
        const imgContainer = document.createElement('div');
        Object.assign(imgContainer.style, {
          position: 'relative', cursor: 'pointer', borderRadius: '7px', overflow: 'hidden',
          aspectRatio: '4/3', border: '1px solid #46505c', backgroundColor: '#111'
        });
        const img = document.createElement('img');
        img.src = imgUrl;
        img.loading = 'lazy';
        Object.assign(img.style, {
          width: '100%', height: '100%', objectFit: 'cover', display: 'block'
        });
        const overlay = document.createElement('div');
        overlay.textContent = `Foto ${idx + 1} de ${images.length}`;
        Object.assign(overlay.style, {
          position: 'absolute', bottom: '0', left: '0', right: '0', padding: '5px 7px',
          backgroundColor: 'rgba(0,0,0,.65)', color: '#fff', fontSize: '12px', textAlign: 'center'
        });
        imgContainer.appendChild(img);
        imgContainer.appendChild(overlay);
        imgContainer.onclick = () => showImageModal(images, idx, `OS: ${os}`);
        imageGrid.appendChild(imgContainer);
      });
    }

    const auditWorkspace = document.createElement('div');
    auditWorkspace.className = 'fa-audit-workspace';
    Object.assign(auditWorkspace.style, {
      display: 'grid',
      gridTemplateColumns: 'minmax(420px, 45%) minmax(0, 1fr)',
      gap: '14px',
      alignItems: 'start',
      width: '100%',
      maxWidth: '100%',
      minWidth: '0',
      boxSizing: 'border-box',
      overflow: 'hidden'
    });
    auditWorkspace.appendChild(auditSection);
    auditWorkspace.appendChild(imageGrid);
    card.appendChild(auditWorkspace);
    (destino || itemsContainer).appendChild(card);
    return card;
  }

})();