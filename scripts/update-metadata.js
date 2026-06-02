#!/usr/bin/env node
// ============================================================
//  update-metadata.js  v2.1
//  Mescla CEMADEN + ANA + SNIRH + INMET + Open-Meteo
// ============================================================
'use strict';

const fs   = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data');

const SINTETICAS = [
  { id:'SYN001', name:'Muçum',           lat:-29.169, lon:-51.868, p120:0, source:'SINTÉTICO' },
  { id:'SYN002', name:'Encantado',       lat:-29.234, lon:-51.869, p120:0, source:'SINTÉTICO' },
  { id:'SYN003', name:'Roca Sales',      lat:-29.492, lon:-51.882, p120:0, source:'SINTÉTICO' },
  { id:'SYN004', name:'Venâncio Aires',  lat:-29.612, lon:-52.190, p120:0, source:'SINTÉTICO' },
  { id:'SYN005', name:'Lajeado',         lat:-29.461, lon:-51.962, p120:0, source:'SINTÉTICO' },
  { id:'SYN006', name:'Arroio do Meio',  lat:-29.395, lon:-51.937, p120:0, source:'SINTÉTICO' },
  { id:'SYN007', name:'Estrela',         lat:-29.505, lon:-51.956, p120:0, source:'SINTÉTICO' },
  { id:'SYN008', name:'Taquari',         lat:-29.797, lon:-51.864, p120:0, source:'SINTÉTICO' },
  { id:'SYN009', name:'Colinas',         lat:-29.396, lon:-51.855, p120:0, source:'SINTÉTICO' },
  { id:'SYN010', name:'Marquês do Erval',lat:-29.650, lon:-52.020, p120:0, source:'SINTÉTICO' },
];

const RAIO_DEDUP = 0.009;

function lerJSON(arquivo) {
  try {
    if (!fs.existsSync(arquivo)) return null;
    return JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  } catch (_) { return null; }
}

function deduplicar(estacoes) {
  const unicas = [];
  for (const est of estacoes) {
    if (isNaN(est.lat) || isNaN(est.lon)) continue;
    const dup = unicas.find(u =>
      Math.abs(u.lat - est.lat) < RAIO_DEDUP &&
      Math.abs(u.lon - est.lon) < RAIO_DEDUP
    );
    if (!dup) {
      unicas.push({ ...est });
    } else if (est.source !== 'SINTÉTICO' && est.p120 >= dup.p120) {
      Object.assign(dup, est);
    }
  }
  return unicas;
}

function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const agora = new Date().toISOString();

  const cemaden   = lerJSON(path.join(DATA_DIR, 'cemaden.json'));
  const ana       = lerJSON(path.join(DATA_DIR, 'ana.json'));
  const snirh     = lerJSON(path.join(DATA_DIR, 'snirh.json'));
  const inmet     = lerJSON(path.join(DATA_DIR, 'inmet.json'));
  const openmeteo = lerJSON(path.join(DATA_DIR, 'openmeteo.json'));

  const estCemaden   = cemaden?.estacoes   || [];
  const estAna       = ana?.estacoes       || [];
  const estSNIRH     = snirh?.estacoes     || [];
  const estINMET     = inmet?.estacoes     || [];
  const estOpenMeteo = openmeteo?.estacoes || [];

  console.log(`[MERGE] CEMADEN:    ${estCemaden.length}`);
  console.log(`[MERGE] ANA:        ${estAna.length}`);
  console.log(`[MERGE] SNIRH:      ${estSNIRH.length}`);
  console.log(`[MERGE] INMET:      ${estINMET.length}`);
  console.log(`[MERGE] Open-Meteo: ${estOpenMeteo.length}`);

  // Open-Meteo tem prioridade sobre sintéticos mas não sobre fontes reais
  let merged = [...estCemaden, ...estAna, ...estSNIRH, ...estINMET, ...estOpenMeteo];

  let sinteticasAdicionadas = 0;
  for (const syn of SINTETICAS) {
    const temReal = merged.find(e =>
      Math.abs(e.lat - syn.lat) < 0.15 &&
      Math.abs(e.lon - syn.lon) < 0.15 &&
      e.source !== 'SINTÉTICO'
    );
    if (!temReal) {
      merged.push(syn);
      sinteticasAdicionadas++;
    }
  }

  merged = deduplicar(merged);
  merged.sort((a, b) => b.p120 - a.p120);

  const comDados  = merged.filter(e => e.p120 > 0).length;
  const maxP120   = merged.reduce((mx, e) => Math.max(mx, e.p120), 0);
  const mediaP120 = merged.length > 0
    ? (merged.reduce((s, e) => s + e.p120, 0) / merged.length).toFixed(1) : '0';
  const porFonte  = merged.reduce((acc, e) => {
    acc[e.source] = (acc[e.source] || 0) + 1; return acc;
  }, {});

  console.log(`[MERGE] Total: ${merged.length} | Com dados: ${comDados}`);
  console.log(`[MERGE] P120 máx: ${maxP120} mm | Por fonte:`, JSON.stringify(porFonte));

  const mergedOutput = {
    versao: '2.1', atualizado: agora, total: merged.length,
    com_dados: comDados, sem_dados: merged.length - comDados,
    sinteticas_adicionadas: sinteticasAdicionadas,
    p120_max_mm: maxP120, p120_media_mm: parseFloat(mediaP120),
    fontes: {
      cemaden: estCemaden.length, ana: estAna.length,
      snirh: estSNIRH.length, inmet: estINMET.length,
      openmeteo: estOpenMeteo.length, sintetico: sinteticasAdicionadas
    },
    por_fonte: porFonte, estacoes: merged
  };

  fs.writeFileSync(path.join(DATA_DIR, 'merged.json'),
    JSON.stringify(mergedOutput, null, 2), 'utf8');

  const fontesAtivas = Object.keys(porFonte).filter(f => f !== 'SINTÉTICO');
  const saude = fontesAtivas.length >= 2 ? 'OK'
    : fontesAtivas.length === 1 ? 'DEGRADADO' : 'FALLBACK_SINTETICO';

  const status = {
    versao: '2.1', atualizado: agora, total_estacoes: merged.length,
    com_dados: comDados, p120_max_mm: maxP120,
    fontes_ativas: [...fontesAtivas, ...(sinteticasAdicionadas > 0 ? ['SINTÉTICO'] : [])],
    por_fonte: porFonte, saude,
    proximo_update: new Date(Date.now() + 6 * 3600 * 1000).toISOString()
  };

  fs.writeFileSync(path.join(DATA_DIR, 'status.json'),
    JSON.stringify(status, null, 2), 'utf8');

  console.log(`[MERGE] ✅ Concluído | Saúde: ${saude}`);
}

main();
