#!/usr/bin/env node
// ============================================================
//  fetch-inmet.js
//  Busca dados de estações automáticas do INMET
//  API REST aberta — sem autenticação
//  Salva em data/inmet.json
// ============================================================
'use strict';

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const UF      = process.env.UF    || 'RS';
const HORAS   = parseInt(process.env.HORAS || '120', 10);
const MAX_EST = 50;
const OUTPUT  = path.join(__dirname, '..', 'data', 'inmet.json');

const INMET_BASE = 'https://apitempo.inmet.gov.br';

function fmtDate(d) { return d.toISOString().split('T')[0]; }

async function listarEstacoes(uf) {
  // Tipo T = automáticas (telemetria em tempo real)
  const url = `${INMET_BASE}/estacoes/T/${uf}`;
  console.log(`[INMET] Listando estações: ${url}`);
  const resp = await axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': 'EWS-GitHub-Bot/1.0' }
  });
  return Array.isArray(resp.data) ? resp.data : [];
}

async function fetchDadosEstacao(cod, dataIni, dataFim) {
  const url = `${INMET_BASE}/estacao/dados/${dataIni}/${dataFim}/${cod}`;
  const resp = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'EWS-GitHub-Bot/1.0' }
  });
  return Array.isArray(resp.data) ? resp.data : [];
}

function somarChuva(dados) {
  return dados.reduce((soma, d) => {
    // Campo horário de chuva no INMET
    const v = parseFloat(
      d.CHUVA            ||
      d.precipitacao     ||
      d.PRE_INS          || 0
    );
    return soma + (isNaN(v) ? 0 : v);
  }, 0);
}

async function main() {
  const agora  = new Date();
  const inicio = new Date(agora.getTime() - HORAS * 3600 * 1000);
  const dataFim = fmtDate(agora);
  const dataIni = fmtDate(inicio);

  console.log(`[INMET] UF=${UF} período=${dataIni}→${dataFim}`);

  let estacoes = [];
  try {
    estacoes = await listarEstacoes(UF);
    console.log(`[INMET] ${estacoes.length} estações automáticas encontradas`);
  } catch (err) {
    console.error(`[INMET] ❌ Erro ao listar: ${err.message}`);
    salvarFallback(err.message, agora);
    return;
  }

  const amostra      = estacoes.slice(0, MAX_EST);
  const CONCORRENCIA = 8;
  const resultado    = [];

  for (let i = 0; i < amostra.length; i += CONCORRENCIA) {
    const lote = amostra.slice(i, i + CONCORRENCIA);

    const results = await Promise.allSettled(lote.map(async (est) => {
      const cod = est.CD_ESTACAO || est.codigo;
      const lat = parseFloat(est.VL_LATITUDE  || est.latitude  || 0);
      const lon = parseFloat(est.VL_LONGITUDE || est.longitude || 0);

      if (!cod || isNaN(lat) || isNaN(lon) || lat === 0) return null;

      let p120 = 0;
      try {
        const dados = await fetchDadosEstacao(cod, dataIni, dataFim);
        p120 = somarChuva(dados);
      } catch (_) { /* estação sem dados no período */ }

      return {
        id:     String(cod),
        name:   est.DC_NOME   || est.nome   || `INMET-${cod}`,
        lat:    lat,
        lon:    lon,
        p120:   parseFloat(p120.toFixed(1)),
        source: 'INMET',
        tipo:   est.TP_ESTACAO || 'T'
      };
    }));

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        resultado.push(r.value);
      }
    }
    process.stdout.write(
      `  Lote ${Math.min(i + CONCORRENCIA, amostra.length)}/` +
      `${amostra.length} processado\r`);
  }

  console.log('');
  const comDados = resultado.filter(e => e.p120 > 0);

  const output = {
    fonte:      'INMET — Estações Automáticas (EMAS)',
    endpoint:   INMET_BASE,
    uf:         UF,
    horas:      HORAS,
    atualizado: agora.toISOString(),
    total:      resultado.length,
    com_dados:  comDados.length,
    estacoes:   resultado
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2), 'utf8');
  console.log(`[INMET] ✅ ${resultado.length} estações salvas` +
    ` (${comDados.length} com dados > 0 mm)`);
}

function salvarFallback(mensagemErro, agora) {
  if (fs.existsSync(OUTPUT)) {
    try {
      const ex = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
      ex.ultimo_erro    = mensagemErro;
      ex.ultimo_erro_ts = agora.toISOString();
      fs.writeFileSync(OUTPUT, JSON.stringify(ex, null, 2), 'utf8');
    } catch (_) {}
  } else {
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, JSON.stringify({
      fonte: 'INMET', uf: UF, horas: HORAS,
      atualizado: agora.toISOString(),
      total: 0, com_dados: 0, estacoes: [],
      erro: mensagemErro
    }, null, 2), 'utf8');
  }
  process.exit(0);
}

main().catch(err => {
  console.error(`[INMET] Erro fatal: ${err.message}`);
  salvarFallback(err.message, new Date());
});
