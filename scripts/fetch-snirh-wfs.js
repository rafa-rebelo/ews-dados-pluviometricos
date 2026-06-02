#!/usr/bin/env node
// ============================================================
//  fetch-snirh-wfs.js
//  Busca estações pluviométricas do SNIRH via protocolo OGC/WFS
//  Salva em data/snirh.json
//
//  Protocolo: OGC Web Feature Service (WFS) 2.0.0
//  Formato:   GeoJSON (application/json)
//  Normas:    ISO 19115, ISO 19128, OGC WFS 2.0.0, GML 3.2
// ============================================================
'use strict';

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const UF      = process.env.UF    || 'RS';
const HORAS   = parseInt(process.env.HORAS || '120', 10);
const MAX_EST = 60;
const OUTPUT  = path.join(__dirname, '..', 'data', 'snirh.json');

// Endpoint WFS público do SNIRH/ANA
const SNIRH_WFS = 'https://geoservicos.snirh.gov.br/geoserver/SNIRH/ows';

// Endpoint alternativo — Portal HidroWeb GeoServer
const HIDROWEB_WFS = 'https://hidroweb.ana.gov.br/geoserver/HidroWeb/ows';

function isoDate(d) { return d.toISOString(); }
function fmtDate(d) { return d.toISOString().split('T')[0]; }

async function fetchWFS(baseUrl, typeName, cqlFilter) {
  const params = new URLSearchParams({
    service:      'WFS',
    version:      '2.0.0',
    request:      'GetFeature',
    typeName:     typeName,
    outputFormat: 'application/json',
    count:        String(MAX_EST)
  });
  if (cqlFilter) { params.append('CQL_FILTER', cqlFilter); }

  const url = `${baseUrl}?${params.toString()}`;
  console.log(`[SNIRH-WFS] GET ${url.substring(0, 120)}...`);

  const resp = await axios.get(url, {
    timeout: 25000,
    headers: {
      'User-Agent': 'EWS-GitHub-Bot/1.0',
      'Accept':     'application/json, application/geo+json'
    }
  });

  const geojson = resp.data;
  if (!geojson || !Array.isArray(geojson.features)) {
    throw new Error(`WFS retornou formato inesperado: ${typeof geojson}`);
  }
  return geojson.features;
}

async function tentarSNIRH(uf, dataIni, dataFim) {
  // Tentativa 1: camada de estações pluviométricas SNIRH
  const layersCandidatas = [
    'SNIRH:estacoes_pluviometricas',
    'SNIRH:Estacoes',
    'HidroWeb:EstacoesTelemetricas'
  ];

  for (const layer of layersCandidatas) {
    try {
      const base = layer.startsWith('HidroWeb') ? HIDROWEB_WFS : SNIRH_WFS;
      const features = await fetchWFS(base, layer, `uf='${uf}'`);
      if (features.length > 0) {
        console.log(`[SNIRH-WFS] Camada ${layer}: ${features.length} features`);
        return { features, layer };
      }
    } catch (e) {
      console.warn(`[SNIRH-WFS] Camada ${layer} falhou: ${e.message}`);
    }
  }
  return { features: [], layer: null };
}

function extrairEstacoesGeoJSON(features) {
  const estacoes = [];
  for (const feat of features) {
    const props  = feat.properties || {};
    const geom   = feat.geometry   || {};
    const coords = (geom.coordinates || [0, 0]);

    // Coordenadas: GeoJSON usa [lon, lat]
    const lon = parseFloat(coords[0]);
    const lat = parseFloat(coords[1]);

    // Campos possíveis dependendo da camada WFS
    const cod  = props.cod_estacao || props.codigo    ||
                 props.CD_ESTACAO  || props.estacao   || null;
    const nome = props.nome        || props.municipio ||
                 props.DC_NOME     || `SNIRH-${cod}`;

    // Precipitação — pode vir direto na feature ou requer busca separada
    const p120 = parseFloat(
      props.precip_acum  || props.chuva_acum ||
      props.CHUVA        || props.valor      || 0
    );

    if (cod && !isNaN(lat) && !isNaN(lon)) {
      estacoes.push({
        id:     String(cod),
        name:   String(nome),
        lat:    lat,
        lon:    lon,
        p120:   parseFloat(p120.toFixed(1)),
        source: 'SNIRH'
      });
    }
  }
  return estacoes;
}

async function main() {
  const agora  = new Date();
  const inicio = new Date(agora.getTime() - HORAS * 3600 * 1000);

  console.log(`[SNIRH-WFS] UF=${UF} horas=${HORAS}`);

  try {
    const { features, layer } = await tentarSNIRH(
      UF, isoDate(inicio), isoDate(agora));

    const estacoes = extrairEstacoesGeoJSON(features);
    const comDados = estacoes.filter(e => e.p120 > 0);

    const output = {
      fonte:      'SNIRH — Portal de Geoserviços (OGC/WFS)',
      protocolo:  'WFS 2.0.0 | ISO 19115 | ISO 19128 | GML 3.2',
      camada:     layer || 'indisponível',
      endpoint:   SNIRH_WFS,
      uf:         UF,
      horas:      HORAS,
      atualizado: agora.toISOString(),
      total:      estacoes.length,
      com_dados:  comDados.length,
      estacoes:   estacoes
    };

    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2), 'utf8');
    console.log(`[SNIRH-WFS] ✅ ${estacoes.length} estações salvas` +
      ` (${comDados.length} com dados > 0 mm)`);

  } catch (err) {
    console.error(`[SNIRH-WFS] ❌ ${err.message}`);
    // Preservar dados anteriores em caso de falha
    if (!fs.existsSync(OUTPUT)) {
      fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
      fs.writeFileSync(OUTPUT, JSON.stringify({
        fonte: 'SNIRH (OGC/WFS)', uf: UF, horas: HORAS,
        atualizado: agora.toISOString(),
        total: 0, com_dados: 0, estacoes: [],
        erro: err.message
      }, null, 2), 'utf8');
    } else {
      // Atualizar apenas o campo de erro
      try {
        const ex = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
        ex.ultimo_erro    = err.message;
        ex.ultimo_erro_ts = agora.toISOString();
        fs.writeFileSync(OUTPUT, JSON.stringify(ex, null, 2), 'utf8');
      } catch (_) {}
    }
    process.exit(0); // Não falhar o workflow
  }
}

main();
