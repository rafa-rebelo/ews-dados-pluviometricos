#!/usr/bin/env node
// ============================================================
//  update-metadata.js  —  versão 2.0
//  Mescla CEMADEN + ANA + SNIRH + INMET em merged.json
//  Adiciona estações sintéticas como fallback posicional
//  Gera status.json com resumo operacional
// ============================================================
'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// ── Estações sintéticas — Bacia do Rio Taquari / Serra Gaúcha ──
// Posições geográficas reais de municípios vulneráveis a deslizamentos.
// Usadas como referência posicional quando nenhuma fonte real tem
// cobertura próxima. Os valores p120 = 0 são substituídos pelo
// GPM IMERG na etapa de IDW do GEE.
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
  { id:'SYN011', name:'Nova Bassano',    lat:-28.728, lon:-51.710, p120:0, source:'SINTÉTICO' },
  { id:'SYN012', name:'Bento Gonçalves', lat:-29.170, lon:-51.519, p120:0, source:'SINTÉTICO' },
  { id:'SYN013', name:'Caxias do Sul',   lat:-29.168, lon:-51.180, p120:0, source:'SINTÉTICO' },
  { id:'SYN014', name:'Petrópolis-RS',   lat:-29.334, lon:-51.109, p120:0, source:'SINTÉTICO' },
  { id:'SYN015', name:'Nova Petrópolis', lat:-29.372, lon:-51.113, p120:0, source:'SINTÉTICO' }
];

// Raio de deduplicação geográfica (graus decimais ≈ 1 km)
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
    const duplicata = unicas.find(u =>
      Math.abs(u.lat - est.lat) < RAIO_DEDUP &&
      Math.abs(u.lon - est.lon) < RAIO_DEDUP
    );
    if (!duplicata) {
      unicas.push({ ...est });
    } else if (
      est.source !== 'SINTÉTICO' &&
      (duplicata.source === 'SINTÉTICO' || est.p120 > duplicata.p120)
    ) {
      // Preferir dados reais e valores mais altos de precipitação
      Object.assign(duplicata, est);
    }
  }
  return unicas;
}

function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const agora = new Date().toISOString();

  // ── Ler todas as fontes ───────────────────────────────────────
  const cemaden = lerJSON(path.join(DATA_DIR, 'cemaden.json'));
  const ana     = lerJSON(path.join(DATA_DIR, 'ana.json'));
  const snirh   = lerJSON(path.join(DATA_DIR, 'snirh.json'));
  const inmet   = lerJSON(path.join(DATA_DIR, 'inmet.json'));

  const estCemaden = (cemaden?.estacoes) || [];
  const estAna     = (ana?.estacoes)     || [];
  const estSNIRH   = (snirh?.estacoes)   || [];
  const estINMET   = (inmet?.estacoes)   || [];

  console.log(`[MERGE] CEMADEN: ${estCemaden.length}`);
  console.log(`[MERGE] ANA:     ${estAna.length}`);
  console.log(`[MERGE] SNIRH:   ${estSNIRH.length}`);
  console.log(`[MERGE] INMET:   ${estINMET.length}`);

  // ── Mesclar todas as fontes ───────────────────────────────────
  // Prioridade: CEMADEN (mais frequente) > ANA > SNIRH > INMET > Sintético
  let merged = [...estCemaden, ...estAna, ...estSNIRH, ...estINMET];

  // Adicionar sintéticas apenas onde não há estação real próxima
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

  // Deduplicar e ordenar por precipitação decrescente
  merged = deduplicar(merged);
  merged.sort((a, b) => b.p120 - a.p120);

  // ── Estatísticas ──────────────────────────────────────────────
  const comDados  = merged.filter(e => e.p120 > 0).length;
  const semDados  = merged.filter(e => e.p120 === 0).length;
  const maxP120   = merged.reduce((mx, e) => Math.max(mx, e.p120), 0);
  const mediaP120 = merged.length > 0
    ? (merged.reduce((s, e) => s + e.p120, 0) / merged.length).toFixed(1)
    : '0';

  // Distribuição por fonte
  const porFonte = merged.reduce((acc, e) => {
    acc[e.source] = (acc[e.source] || 0) + 1;
    return acc;
  }, {});

  console.log(`[MERGE] Total único: ${merged.length} estações`);
  console.log(`[MERGE] Com dados: ${comDados} | Sem dados: ${semDados}`);
  console.log(`[MERGE] P120 máx: ${maxP120} mm | média: ${mediaP120} mm`);
  console.log(`[MERGE] Por fonte:`, JSON.stringify(porFonte));

  // ── merged.json — lido pelo GEE ──────────────────────────────
  const mergedOutput = {
    versao:                   '2.0',
    atualizado:               agora,
    total:                    merged.length,
    com_dados:                comDados,
    sem_dados:                semDados,
    sinteticas_adicionadas:   sinteticasAdicionadas,
    p120_max_mm:              maxP120,
    p120_media_mm:            parseFloat(mediaP120),
    fontes: {
      cemaden:   estCemaden.length,
      ana:       estAna.length,
      snirh:     estSNIRH.length,
      inmet:     estINMET.length,
      sintetico: sinteticasAdicionadas
    },
    por_fonte:  porFonte,
    estacoes:   merged
  };

  fs.writeFileSync(
    path.join(DATA_DIR, 'merged.json'),
    JSON.stringify(mergedOutput, null, 2), 'utf8'
  );

  // ── status.json — monitoramento rápido ───────────────────────
  const fontesAtivas = [];
  if (estCemaden.length > 0) fontesAtivas.push('CEMADEN');
  if (estAna.length     > 0) fontesAtivas.push('ANA');
  if (estSNIRH.length   > 0) fontesAtivas.push('SNIRH');
  if (estINMET.length   > 0) fontesAtivas.push('INMET');
  if (sinteticasAdicionadas > 0) fontesAtivas.push('SINTÉTICO');

  const saude = fontesAtivas.filter(f => f !== 'SINTÉTICO').length >= 2
    ? 'OK'
    : fontesAtivas.filter(f => f !== 'SINTÉTICO').length === 1
      ? 'DEGRADADO'
      : 'FALLBACK_SINTETICO';

  const status = {
    versao:          '2.0',
    atualizado:      agora,
    total_estacoes:  merged.length,
    com_dados:       comDados,
    p120_max_mm:     maxP120,
    p120_media_mm:   parseFloat(mediaP120),
    fontes_ativas:   fontesAtivas,
    por_fonte:       porFonte,
    saude:           saude,
    proximo_update:  new Date(Date.now() + 6 * 3600 * 1000).toISOString()
  };

  fs.writeFileSync(
    path.join(DATA_DIR, 'status.json'),
    JSON.stringify(status, null, 2), 'utf8'
  );

  console.log(`[MERGE] ✅ merged.json e status.json atualizados`);
  console.log(`[MERGE] Saúde: ${saude}`);
}

main();
