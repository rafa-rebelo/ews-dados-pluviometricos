#!/usr/bin/env node
// ============================================================
//  fetch-cemaden.js
//  Busca dados pluviométricos do CEMADEN (RS por padrão)
//  e salva em data/cemaden.json
// ============================================================
'use strict';

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const UF    = process.env.UF    || 'RS';
const HORAS = process.env.HORAS || '120';

const URL = `https://sjc.salvar.cemaden.gov.br/resources/graficos/interativo/` +
            `getJson.php?uf=${UF}&tipoestacao=1&ultimasHoras=${HORAS}`;

const OUTPUT = path.join(__dirname, '..', 'data', 'cemaden.json');

async function main() {
  console.log(`[CEMADEN] Buscando dados de ${UF} nas últimas ${HORAS}h...`);
  console.log(`[CEMADEN] URL: ${URL}`);

  try {
    const resp = await axios.get(URL, {
      timeout: 20000,
      headers: { 'User-Agent': 'EWS-GitHub-Bot/1.0' }
    });

    const data = resp.data;

    if (!Array.isArray(data)) {
      throw new Error(`Formato inesperado: ${typeof data}`);
    }

    // Normalizar campos para estrutura padrão do sistema EWS
    const estacoes = data
      .filter(g => g.latitude && g.longitude && g.valorMedida !== null)
      .map(g => ({
        id:     String(g.codEstacao || g.codestacao || ''),
        name:   g.nomeMunicipio || g.nomeestacao || `CEMADEN-${g.codEstacao}`,
        lat:    parseFloat(g.latitude),
        lon:    parseFloat(g.longitude),
        p120:   parseFloat(g.valorMedida || 0),
        source: 'CEMADEN',
        uf:     UF
      }))
      .filter(g => !isNaN(g.lat) && !isNaN(g.lon) && !isNaN(g.p120));

    const output = {
      fonte:       'CEMADEN',
      uf:          UF,
      horas:       parseInt(HORAS),
      atualizado:  new Date().toISOString(),
      total:       estacoes.length,
      estacoes:    estacoes
    };

    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2), 'utf8');

    console.log(`[CEMADEN] ✅ ${estacoes.length} estações salvas em ${OUTPUT}`);

    // Mostrar algumas estações para log
    estacoes.slice(0, 3).forEach(e => {
      console.log(`  → ${e.name}: ${e.p120} mm (${e.lat.toFixed(4)}, ${e.lon.toFixed(4)})`);
    });

  } catch (err) {
    console.error(`[CEMADEN] ❌ Erro: ${err.message}`);

    // Em caso de falha, preservar o arquivo existente se houver
    if (fs.existsSync(OUTPUT)) {
      console.log('[CEMADEN] ⚠️  Mantendo dados anteriores.');
      // Atualizar apenas o campo de erro no JSON existente
      try {
        const existing = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
        existing.ultimo_erro   = err.message;
        existing.ultimo_erro_ts = new Date().toISOString();
        fs.writeFileSync(OUTPUT, JSON.stringify(existing, null, 2), 'utf8');
      } catch (_) { /* ignora erro de parse */ }
    } else {
      // Criar arquivo vazio com marcador de erro
      const fallback = {
        fonte:      'CEMADEN',
        uf:         UF,
        horas:      parseInt(HORAS),
        atualizado: new Date().toISOString(),
        total:      0,
        estacoes:   [],
        erro:       err.message
      };
      fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
      fs.writeFileSync(OUTPUT, JSON.stringify(fallback, null, 2), 'utf8');
    }

    process.exit(0); // Não falhar o workflow — continua com ANA e sintético
  }
}

main();
