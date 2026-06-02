#!/usr/bin/env node
// ============================================================
//  fetch-cemaden.js  v2.1
//  FIX: múltiplos domínios fallback + SSL permissivo + timeout 30s
// ============================================================
'use strict';

const axios = require('axios');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const UF     = process.env.UF    || 'RS';
const HORAS  = process.env.HORAS || '120';
const OUTPUT = path.join(__dirname, '..', 'data', 'cemaden.json');

// SSL permissivo — servidores .gov.br frequentemente têm cert inválido
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// URLs candidatas em ordem de prioridade
const URLS_CANDIDATAS = [
  `https://sjc.salvar.cemaden.gov.br/resources/graficos/interativo/getJson.php?uf=${UF}&tipoestacao=1&ultimasHoras=${HORAS}`,
  `https://alertas2.cemaden.gov.br/resources/graficos/interativo/getJson.php?uf=${UF}&tipoestacao=1&ultimasHoras=${HORAS}`,
  `http://sjc.salvar.cemaden.gov.br/resources/graficos/interativo/getJson.php?uf=${UF}&tipoestacao=1&ultimasHoras=${HORAS}`,
];

const AXIOS_CONFIG = {
  timeout: 30000,
  httpsAgent,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://alertas2.cemaden.gov.br/',
  }
};

async function main() {
  console.log(`[CEMADEN] UF=${UF} horas=${HORAS}`);

  for (const url of URLS_CANDIDATAS) {
    console.log(`[CEMADEN] Tentando: ${url}`);
    try {
      const resp = await axios.get(url, AXIOS_CONFIG);
      const data = resp.data;

      if (!Array.isArray(data)) {
        console.warn(`[CEMADEN] Formato inesperado em ${url}: ${typeof data}`);
        continue;
      }

      const estacoes = data
        .filter(g => g.latitude && g.longitude && g.valorMedida !== null)
        .map(g => ({
          id:     String(g.codEstacao || ''),
          name:   g.nomeMunicipio || `CEMADEN-${g.codEstacao}`,
          lat:    parseFloat(g.latitude),
          lon:    parseFloat(g.longitude),
          p120:   parseFloat(g.valorMedida || 0),
          source: 'CEMADEN'
        }))
        .filter(g => !isNaN(g.lat) && !isNaN(g.lon));

      const output = {
        fonte: 'CEMADEN', uf: UF, horas: parseInt(HORAS),
        atualizado: new Date().toISOString(),
        total: estacoes.length, estacoes
      };

      fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
      fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2), 'utf8');
      console.log(`[CEMADEN] ✅ ${estacoes.length} estações salvas (via ${url.split('/')[2]})`);
      return; // Sucesso — encerra

    } catch (err) {
      console.warn(`[CEMADEN] ❌ Falha em ${url.split('/')[2]}: ${err.message}`);
    }
  }

  // Todas as URLs falharam
  console.error('[CEMADEN] ❌ Todas as URLs falharam.');
  preservarOuCriarVazio('Todas as URLs CEMADEN inacessíveis');
}

function preservarOuCriarVazio(motivo) {
  if (fs.existsSync(OUTPUT)) {
    console.log('[CEMADEN] ⚠️ Mantendo dados anteriores.');
    try {
      const ex = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
      ex.ultimo_erro = motivo;
      ex.ultimo_erro_ts = new Date().toISOString();
      fs.writeFileSync(OUTPUT, JSON.stringify(ex, null, 2), 'utf8');
    } catch (_) {}
  } else {
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, JSON.stringify({
      fonte: 'CEMADEN', uf: UF, horas: parseInt(HORAS),
      atualizado: new Date().toISOString(),
      total: 0, estacoes: [], erro: motivo
    }, null, 2), 'utf8');
  }
  process.exit(0);
}

main().catch(err => { preservarOuCriarVazio(err.message); });
