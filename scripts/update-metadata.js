#!/usr/bin/env node
// ============================================================
//  update-metadata.js
//  Mescla dados do CEMADEN e ANA em um único arquivo merged.json
//  Adiciona estações sintéticas históricas como fallback
//  para garantir que o GEE sempre tenha dados disponíveis.
//  Também gera status.json com resumo do estado atual.
// ============================================================
'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// ── Estações sintéticas — Bacia do Rio Taquari (RS) ──────────
// Baseadas em eventos históricos de deslizamento (2023, 2024).
// Usadas como fallback quando CEMADEN e ANA estão indisponíveis.
// Os valores de p120 são substituídos por zeros na inicialização
// e só servem como posições geográficas de referência.
const SINTETICAS = [
  { id:'SYN001', name:'Muçum',         lat:-29.169, lon:-51.868, p120:0, source:'SINTÉTICO' },
  { id:'SYN002', name:'Encantado',     lat:-29.234, lon:-51.869, p120:0, source:'SINTÉTICO' },
  { id:'SYN003', name:'Roca Sales',    lat:-29.492, lon:-51.882, p120:0, source:'SINTÉTICO' },
  { id:'SYN004', name:'Venâncio Aires',lat:-29.612, lon:-52.190, p120:0, source:'SINTÉTICO' },
  { id:'SYN005', name:'Lajeado',       lat:-29.461, lon:-51.962, p120:0, source:'SINTÉTICO' },
  { id:'SYN006', name:'Arroio do Meio',lat:-29.395, lon:-51.937, p120:0, source:'SINTÉTICO' },
  { id:'SYN007', name:'Estrela',       lat:-29.505, lon:-51.956, p120:0, source:'SINTÉTICO' },
  { id:'SYN008', name:'Taquari',       lat:-29.797, lon:-51.864, p120:0, source:'SINTÉTICO' },
  { id:'SYN009', name:'Colinas',       lat:-29.396, lon:-51.855, p120:0, source:'SINTÉTICO' },
  { id:'SYN010', name:'Marques Erval', lat:-29.650, lon:-52.020, p120:0, source:'SINTÉTICO' }
];

function lerJSON(arquivo) {
  try {
    return JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  } catch (_) {
    return null;
  }
}

function deduplicar(estacoes) {
  // Remove duplicatas por proximidade geográfica (< 0.01°  ≈ 1 km)
  const unicas = [];
  for (const est of estacoes) {
    const duplicata = unicas.find(u =>
      Math.abs(u.lat - est.lat) < 0.01 &&
      Math.abs(u.lon - est.lon) < 0.01
    );
    if (!duplicata) {
      unicas.push(est);
    } else if (est.source !== 'SINTÉTICO' && duplicata.source === 'SINTÉTICO') {
      // Preferir dados reais sobre sintéticos
      Object.assign(duplicata, est);
    }
  }
  return unicas;
}

function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const agora = new Date().toISOString();

  // ── Carregar dados das fontes ─────────────────────────────────
  const cemaden = lerJSON(path.join(DATA_DIR, 'cemaden.json'));
  const ana     = lerJSON(path.join(DATA_DIR, 'ana.json'));

  const estCemaden = (cemaden && Array.isArray(cemaden.estacoes))
    ? cemaden.estacoes : [];
  const estAna = (ana && Array.isArray(ana.estacoes))
    ? ana.estacoes : [];

  console.log(`[MERGE] CEMADEN: ${estCemaden.length} estações`);
  console.log(`[MERGE] ANA:     ${estAna.length} estações`);

  // ── Mesclar: CEMADEN + ANA + Sintéticas como fallback ────────
  let merged = [...estCemaden, ...estAna];

  // Adicionar sintéticas apenas para posições sem dado real próximo
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

  // Remover duplicatas
  merged = deduplicar(merged);

  // Ordenar por p120 decrescente (mais chuva primeiro)
  merged.sort((a, b) => b.p120 - a.p120);

  const comDados  = merged.filter(e => e.p120 > 0).length;
  const semDados  = merged.filter(e => e.p120 === 0).length;
  const maxP120   = merged.reduce((mx, e) => Math.max(mx, e.p120), 0);
  const mediaP120 = merged.length > 0
    ? (merged.reduce((s, e) => s + e.p120, 0) / merged.length).toFixed(1)
    : '0';

  console.log(`[MERGE] Total: ${merged.length} estações (${comDados} com dados, ${sinteticasAdicionadas} sintéticas adicionadas)`);
  console.log(`[MERGE] P120 máx: ${maxP120} mm | média: ${mediaP120} mm`);

  // ── Salvar merged.json (lido pelo GEE) ───────────────────────
  const mergedOutput = {
    atualizado:           agora,
    total:                merged.length,
    com_dados:            comDados,
    sem_dados:            semDados,
    sinteticas_adicionadas: sinteticasAdicionadas,
    p120_max_mm:          maxP120,
    p120_media_mm:        parseFloat(mediaP120),
    fontes: {
      cemaden: estCemaden.length,
      ana:     estAna.length,
      sintetico: sinteticasAdicionadas
    },
    estacoes: merged
  };

  fs.writeFileSync(
    path.join(DATA_DIR, 'merged.json'),
    JSON.stringify(mergedOutput, null, 2),
    'utf8'
  );

  // ── Salvar status.json (monitoramento rápido) ─────────────────
  const status = {
    atualizado:    agora,
    total_estacoes: merged.length,
    com_dados:     comDados,
    p120_max_mm:   maxP120,
    fontes_ativas: [
      ...(estCemaden.length > 0 ? ['CEMADEN'] : []),
      ...(estAna.length     > 0 ? ['ANA']     : []),
      ...(sinteticasAdicionadas > 0 ? ['SINTÉTICO'] : [])
    ],
    proximo_update: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
    saude: estCemaden.length > 0 || estAna.length > 0 ? 'OK' : 'FALLBACK_SINTETICO'
  };

  fs.writeFileSync(
    path.join(DATA_DIR, 'status.json'),
    JSON.stringify(status, null, 2),
    'utf8'
  );

  console.log(`[MERGE] ✅ merged.json e status.json salvos em ${DATA_DIR}`);
  console.log(`[MERGE] Saúde do sistema: ${status.saude}`);
}

main();
