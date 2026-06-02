#!/usr/bin/env node
// ============================================================
//  fetch-ana.js
//  Busca dados pluviométricos da ANA HidroWeb (Telemetria)
//  e salva em data/ana.json
//  Máximo de 60 estações por execução (limite de tempo CI)
// ============================================================
'use strict';

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const UF      = process.env.UF    || 'RS';
const HORAS   = parseInt(process.env.HORAS || '120', 10);
const MAX_EST = 60;

const ANA_BASE = 'https://telemetria.ana.gov.br/api';
const OUTPUT   = path.join(__dirname, '..', 'data', 'ana.json');

function fmtDate(d) {
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

async function fetchEstacoes() {
  const url = `${ANA_BASE}/Estacao/GetEstacoes?tipoEstacao=2&uf=${UF}`;
  console.log(`[ANA] Listando estações: ${url}`);
  const resp = await axios.get(url, {
    timeout: 20000,
    headers: { 'User-Agent': 'EWS-GitHub-Bot/1.0' }
  });
  const data = resp.data;
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.estacoes)) return data.estacoes;
  return [];
}

async function fetchDados(cod, dataIni, dataFim) {
  const url = `${ANA_BASE}/Dados/GetDados` +
    `?codEstacao=${cod}&dataInicio=${dataIni}&dataFim=${dataFim}`;
  const resp = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'EWS-GitHub-Bot/1.0' }
  });
  const data = resp.data;
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.medicoes)) return data.medicoes;
  if (data && Array.isArray(data.dados))    return data.dados;
  return [];
}

function somarMedicoes(medicoes, horasJanela) {
  const corte = Date.now() - horasJanela * 3600 * 1000;
  let total = 0;
  for (const m of medicoes) {
    const ts = new Date(m.dataMedicao || m.DataMedicao || m.data || 0).getTime();
    const v  = parseFloat(m.valor || m.Valor || m.chuva || 0);
    if (ts >= corte && !isNaN(v)) total += v;
  }
  return parseFloat(total.toFixed(1));
}

async function main() {
  const agora  = new Date();
  const inicio = new Date(agora.getTime() - HORAS * 3600 * 1000);
  const dataFim = fmtDate(agora);
  const dataIni = fmtDate(inicio);

  console.log(`[ANA] UF=${UF} período=${dataIni}→${dataFim}`);

  let todasEstacoes = [];
  try {
    todasEstacoes = await fetchEstacoes();
    console.log(`[ANA] ${todasEstacoes.length} estações encontradas. Processando até ${MAX_EST}...`);
  } catch (err) {
    console.error(`[ANA] ❌ Erro ao listar estações: ${err.message}`);
    salvarFallback(err.message);
    process.exit(0);
  }

  const amostra = todasEstacoes.slice(0, MAX_EST);

  // Processar em paralelo com concorrência limitada a 10 simultâneas
  const CONCORRENCIA = 10;
  const estacoesFinal = [];

  for (let i = 0; i < amostra.length; i += CONCORRENCIA) {
    const lote = amostra.slice(i, i + CONCORRENCIA);
    const results = await Promise.allSettled(lote.map(async (est) => {
      const cod = est.codigo || est.Codigo || est.codEstacao;
      const lat = parseFloat(est.latitude  || est.Latitude  || 0);
      const lon = parseFloat(est.longitude || est.Longitude || 0);

      if (!cod || isNaN(lat) || isNaN(lon)) return null;

      let p120 = 0;
      try {
        const medicoes = await fetchDados(cod, dataIni, dataFim);
        p120 = somarMedicoes(medicoes, HORAS);
      } catch (_) { /* estação inacessível */ }

      return {
        id:     String(cod),
        name:   est.nome || est.Nome || `ANA-${cod}`,
        lat:    lat,
        lon:    lon,
        p120:   p120,
        source: 'ANA',
        uf:     UF
      };
    }));

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        estacoesFinal.push(r.value);
      }
    }
    process.stdout.write(`  Lote ${Math.min(i + CONCORRENCIA, amostra.length)}/${amostra.length} processado\r`);
  }

  console.log('');

  const output = {
    fonte:      'ANA HidroWeb',
    uf:         UF,
    horas:      HORAS,
    atualizado: agora.toISOString(),
    total:      estacoesFinal.length,
    estacoes:   estacoesFinal
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2), 'utf8');

  const comDados = estacoesFinal.filter(e => e.p120 > 0);
  console.log(`[ANA] ✅ ${estacoesFinal.length} estações salvas (${comDados.length} com dados > 0mm)`);
  comDados.slice(0, 3).forEach(e => {
    console.log(`  → ${e.name}: ${e.p120} mm`);
  });
}

function salvarFallback(mensagemErro) {
  if (fs.existsSync(OUTPUT)) {
    console.log('[ANA] ⚠️  Mantendo dados anteriores.');
    try {
      const existing = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
      existing.ultimo_erro    = mensagemErro;
      existing.ultimo_erro_ts = new Date().toISOString();
      fs.writeFileSync(OUTPUT, JSON.stringify(existing, null, 2), 'utf8');
    } catch (_) {}
  } else {
    const fallback = {
      fonte: 'ANA HidroWeb', uf: UF, horas: HORAS,
      atualizado: new Date().toISOString(), total: 0,
      estacoes: [], erro: mensagemErro
    };
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, JSON.stringify(fallback, null, 2), 'utf8');
  }
}

main().catch(err => {
  console.error(`[ANA] ❌ Erro fatal: ${err.message}`);
  salvarFallback(err.message);
  process.exit(0);
});
