#!/usr/bin/env node
// ============================================================
//  fetch-openmeteo.js  — NOVA FONTE CONFIÁVEL
//  Open-Meteo: API gratuita, sem autenticação, sem bloqueio
//  Fornece precipitação histórica por coordenada geográfica
//  Cobre as 15 posições das estações sintéticas com dados reais
//  Documentação: https://open-meteo.com/en/docs/historical-weather-api
// ============================================================
'use strict';

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const HORAS  = parseInt(process.env.HORAS || '120', 10);
const OUTPUT = path.join(__dirname, '..', 'data', 'openmeteo.json');

// Posições das estações de referência — Bacia do Rio Taquari e Serra Gaúcha
// Cada posição é consultada individualmente na API Open-Meteo
const ESTACOES_REF = [
  { id:'OM001', name:'Muçum',           lat:-29.169, lon:-51.868 },
  { id:'OM002', name:'Encantado',       lat:-29.234, lon:-51.869 },
  { id:'OM003', name:'Roca Sales',      lat:-29.492, lon:-51.882 },
  { id:'OM004', name:'Venâncio Aires',  lat:-29.612, lon:-52.190 },
  { id:'OM005', name:'Lajeado',         lat:-29.461, lon:-51.962 },
  { id:'OM006', name:'Arroio do Meio',  lat:-29.395, lon:-51.937 },
  { id:'OM007', name:'Estrela',         lat:-29.505, lon:-51.956 },
  { id:'OM008', name:'Taquari',         lat:-29.797, lon:-51.864 },
  { id:'OM009', name:'Colinas',         lat:-29.396, lon:-51.855 },
  { id:'OM010', name:'Marquês do Erval',lat:-29.650, lon:-52.020 },
  { id:'OM011', name:'Caxias do Sul',   lat:-29.168, lon:-51.180 },
  { id:'OM012', name:'Bento Gonçalves', lat:-29.170, lon:-51.519 },
  { id:'OM013', name:'Nova Petrópolis', lat:-29.372, lon:-51.113 },
  { id:'OM014', name:'Gramado',         lat:-29.378, lon:-50.873 },
  { id:'OM015', name:'Canela',          lat:-29.361, lon:-50.813 },
  { id:'OM016', name:'São Francisco Paula',lat:-29.443,lon:-50.582 },
  { id:'OM017', name:'Pelotas',         lat:-31.767, lon:-52.342 },
  { id:'OM018', name:'Porto Alegre',    lat:-30.034, lon:-51.218 },
  { id:'OM019', name:'Santa Maria',     lat:-29.688, lon:-53.807 },
  { id:'OM020', name:'Ijuí',            lat:-28.387, lon:-53.915 },
];

function fmtDate(d) { return d.toISOString().split('T')[0]; }

async function fetchPrecipEstacao(est, dataIni, dataFim) {
  // API Open-Meteo Historical — retorna precipitação horária
  // Soma das últimas N horas = P120 (ou P24, P72 conforme configuração)
  const url = 'https://archive-api.open-meteo.com/v1/archive' +
    `?latitude=${est.lat}&longitude=${est.lon}` +
    `&start_date=${dataIni}&end_date=${dataFim}` +
    '&hourly=precipitation' +
    '&timezone=America%2FSao_Paulo';

  const resp = await axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': 'EWS-Bot/1.0' }
  });

  const data   = resp.data;
  const times  = data?.hourly?.time         || [];
  const precip = data?.hourly?.precipitation || [];

  // Somar apenas as horas dentro da janela HORAS
  const corte = Date.now() - HORAS * 3600 * 1000;
  let soma = 0;
  for (let i = 0; i < times.length; i++) {
    const ts = new Date(times[i]).getTime();
    const v  = parseFloat(precip[i] || 0);
    if (ts >= corte && !isNaN(v)) soma += v;
  }

  return parseFloat(soma.toFixed(1));
}

async function main() {
  const agora  = new Date();
  // Open-Meteo archive tem delay de ~5 dias — buscar período com dados
  const fim    = new Date(agora.getTime() - 1 * 24 * 3600 * 1000); // ontem
  const inicio = new Date(fim.getTime()   - (HORAS / 24 + 1) * 24 * 3600 * 1000);
  const dataIni = fmtDate(inicio);
  const dataFim = fmtDate(fim);

  console.log(`[OPENMETEO] ${ESTACOES_REF.length} estações · período ${dataIni}→${dataFim}`);

  const CONCORRENCIA = 5;
  const resultado    = [];

  for (let i = 0; i < ESTACOES_REF.length; i += CONCORRENCIA) {
    const lote   = ESTACOES_REF.slice(i, i + CONCORRENCIA);
    const results = await Promise.allSettled(lote.map(async est => {
      try {
        const p120 = await fetchPrecipEstacao(est, dataIni, dataFim);
        return { id: est.id, name: est.name, lat: est.lat, lon: est.lon,
                 p120, source: 'Open-Meteo' };
      } catch (err) {
        console.warn(`  ${est.name}: ${err.message}`);
        return { id: est.id, name: est.name, lat: est.lat, lon: est.lon,
                 p120: 0, source: 'Open-Meteo' };
      }
    }));

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) resultado.push(r.value);
    }
    // Rate limit: Open-Meteo permite ~10 req/s gratuito
    await new Promise(r => setTimeout(r, 500));
  }

  const comDados = resultado.filter(e => e.p120 > 0).length;
  const maxP120  = resultado.reduce((mx, e) => Math.max(mx, e.p120), 0);

  const output = {
    fonte:      'Open-Meteo (ERA5 Reanalysis)',
    descricao:  'Dados de reanálise ERA5 — precipitação horária por coordenada',
    api:        'https://archive-api.open-meteo.com',
    horas:      HORAS,
    atualizado: agora.toISOString(),
    periodo:    { inicio: dataIni, fim: dataFim },
    total:      resultado.length,
    com_dados:  comDados,
    p120_max:   maxP120,
    estacoes:   resultado
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2), 'utf8');
  console.log(`[OPENMETEO] ✅ ${resultado.length} estações · max ${maxP120} mm`);
}

main().catch(err => {
  console.error(`[OPENMETEO] ❌ ${err.message}`);
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify({
    fonte: 'Open-Meteo', horas: HORAS,
    atualizado: new Date().toISOString(),
    total: 0, estacoes: [], erro: err.message
  }, null, 2), 'utf8');
  process.exit(0);
});
