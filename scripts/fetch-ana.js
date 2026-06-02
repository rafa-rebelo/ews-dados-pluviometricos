#!/usr/bin/env node
// ============================================================
//  fetch-ana.js  v2.1
//  FIX: timeout 60s + retry 2x + SSL permissivo + User-Agent browser
// ============================================================
'use strict';

const axios = require('axios');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const UF      = process.env.UF    || 'RS';
const HORAS   = parseInt(process.env.HORAS || '120', 10);
const MAX_EST = 50;
const OUTPUT  = path.join(__dirname, '..', 'data', 'ana.json');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Referer': 'https://telemetria.ana.gov.br/',
  'Origin': 'https://telemetria.ana.gov.br',
};

// URLs candidatas para listar estações
const ESTACOES_URLS = [
  `https://telemetria.ana.gov.br/api/Estacao/GetEstacoes?tipoEstacao=2&uf=${UF}`,
  `http://telemetria.ana.gov.br/api/Estacao/GetEstacoes?tipoEstacao=2&uf=${UF}`,
];

function fmtDate(d) { return d.toISOString().split('T')[0]; }

async function tentarGet(url, timeout = 60000) {
  return axios.get(url, { timeout, httpsAgent, headers: HEADERS });
}

async function tentarComRetry(url, tentativas = 2, timeout = 60000) {
  for (let i = 0; i < tentativas; i++) {
    try {
      return await tentarGet(url, timeout);
    } catch (err) {
      console.warn(`  Tentativa ${i+1}/${tentativas} falhou: ${err.message}`);
      if (i < tentativas - 1) {
        await new Promise(r => setTimeout(r, 3000)); // esperar 3s antes de retry
      } else {
        throw err;
      }
    }
  }
}

async function listarEstacoes() {
  for (const url of ESTACOES_URLS) {
    console.log(`[ANA] Listando estações: ${url}`);
    try {
      const resp = await tentarComRetry(url, 2, 60000);
      const data = resp.data;
      if (Array.isArray(data) && data.length > 0) return data;
      if (data?.estacoes && data.estacoes.length > 0) return data.estacoes;
    } catch (err) {
      console.warn(`[ANA] URL ${url.split('/')[2]} falhou: ${err.message}`);
    }
  }
  throw new Error('Nenhuma URL da ANA respondeu');
}

async function fetchDados(cod, dataIni, dataFim) {
  const urls = [
    `https://telemetria.ana.gov.br/api/Dados/GetDados?codEstacao=${cod}&dataInicio=${dataIni}&dataFim=${dataFim}`,
    `http://telemetria.ana.gov.br/api/Dados/GetDados?codEstacao=${cod}&dataInicio=${dataIni}&dataFim=${dataFim}`,
  ];
  for (const url of urls) {
    try {
      const resp = await tentarGet(url, 15000);
      const data = resp.data;
      if (Array.isArray(data)) return data;
      if (data?.medicoes) return data.medicoes;
    } catch (_) {}
  }
  return [];
}

function somarMedicoes(medicoes, horas) {
  const corte = Date.now() - horas * 3600 * 1000;
  return medicoes.reduce((soma, m) => {
    const ts = new Date(m.dataMedicao || m.DataMedicao || m.data || 0).getTime();
    const v  = parseFloat(m.valor || m.Valor || 0);
    return soma + (ts >= corte && !isNaN(v) ? v : 0);
  }, 0);
}

async function main() {
  const agora  = new Date();
  const inicio = new Date(agora.getTime() - HORAS * 3600 * 1000);
  console.log(`[ANA] UF=${UF} período=${fmtDate(inicio)}→${fmtDate(agora)}`);

  let todasEstacoes = [];
  try {
    todasEstacoes = await listarEstacoes();
    console.log(`[ANA] ${todasEstacoes.length} estações encontradas`);
  } catch (err) {
    console.error(`[ANA] ❌ ${err.message}`);
    preservarOuCriarVazio(err.message);
    return;
  }

  const amostra      = todasEstacoes.slice(0, MAX_EST);
  const CONCORRENCIA = 5; // Reduzido para não sobrecarregar o servidor
  const resultado    = [];

  for (let i = 0; i < amostra.length; i += CONCORRENCIA) {
    const lote   = amostra.slice(i, i + CONCORRENCIA);
    const results = await Promise.allSettled(lote.map(async est => {
      const cod = est.codigo || est.Codigo || est.codEstacao;
      const lat = parseFloat(est.latitude  || est.VL_LATITUDE  || 0);
      const lon = parseFloat(est.longitude || est.VL_LONGITUDE || 0);
      if (!cod || isNaN(lat) || isNaN(lon) || lat === 0) return null;

      let p120 = 0;
      try {
        const medicoes = await fetchDados(cod, fmtDate(inicio), fmtDate(agora));
        p120 = somarMedicoes(medicoes, HORAS);
      } catch (_) {}

      return {
        id: String(cod), name: est.nome || est.DC_NOME || `ANA-${cod}`,
        lat, lon, p120: parseFloat(p120.toFixed(1)), source: 'ANA'
      };
    }));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) resultado.push(r.value);
    }
    process.stdout.write(`  ${Math.min(i+CONCORRENCIA, amostra.length)}/${amostra.length}\r`);
  }
  console.log('');

  const output = {
    fonte: 'ANA HidroWeb', uf: UF, horas: HORAS,
    atualizado: agora.toISOString(), total: resultado.length, estacoes: resultado
  };
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2), 'utf8');
  console.log(`[ANA] ✅ ${resultado.length} estações salvas`);
}

function preservarOuCriarVazio(motivo) {
  if (fs.existsSync(OUTPUT)) {
    try {
      const ex = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
      ex.ultimo_erro = motivo; ex.ultimo_erro_ts = new Date().toISOString();
      fs.writeFileSync(OUTPUT, JSON.stringify(ex, null, 2), 'utf8');
    } catch (_) {}
  } else {
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, JSON.stringify({
      fonte: 'ANA HidroWeb', uf: UF, horas: HORAS,
      atualizado: new Date().toISOString(), total: 0, estacoes: [], erro: motivo
    }, null, 2), 'utf8');
  }
  process.exit(0);
}

main().catch(err => { preservarOuCriarVazio(err.message); });
