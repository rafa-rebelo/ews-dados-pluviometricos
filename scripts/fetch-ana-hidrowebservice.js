#!/usr/bin/env node
// ============================================================
//  fetch-ana-hidrowebservice.js  v1.0
//  ANA HidroWebService — OAuth + inventário + série adotada
//  Campos confirmados via Network DevTools:
//    Inventário: Altitude, Bacia_Nome, Latitude, Longitude,
//                Estacao_Nome, Municipio_Nome, codigoestacao,
//                Tipo_Estacao, Operando, UF_Estacao
//    Série:      Chuva_Adotada, Chuva_Adotada_Status,
//                Data_Hora_Medicao, codigoestacao
// ============================================================
'use strict';

const axios  = require('axios');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');

// ── Credenciais via GitHub Secrets ───────────────────────────
const IDENTIFICADOR = process.env.ANA_IDENTIFICADOR; // CPF sem pontos
const SENHA         = process.env.ANA_SENHA;
const UF            = process.env.UF    || 'RS';
const HORAS         = parseInt(process.env.HORAS || '120', 10);
const MAX_EST       = 100; // máximo de estações por execução
const OUTPUT        = path.join(__dirname, '..', 'data', 'ana.json');

const BASE = 'https://www.ana.gov.br/hidrowebservice/EstacoesTelemetricas';
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function fmtDate(d) { return d.toISOString().split('T')[0]; }

// ── Passo 1: Autenticar e obter token (válido 60 min) ────────
async function obterToken() {
  console.log('[ANA-HWS] Autenticando...');
  const resp = await axios.get(`${BASE}/OAUth/v1`, {
    timeout: 20000,
    httpsAgent,
    headers: {
      'Identificador': IDENTIFICADOR,
      'Senha':         SENHA,
      'accept':        '*/*'
    }
  });

  // Estrutura confirmada:
  // { status, code, message, items: { sucesso, token, validade,
  //   tokenautenticacao, respostaautenticacao } }
  const token = resp.data?.items?.tokenautenticacao;
  if (!token) {
    throw new Error(
      'tokenautenticacao não encontrado. Resposta: ' +
      JSON.stringify(resp.data).substring(0, 200)
    );
  }
  console.log('[ANA-HWS] ✅ Token obtido (válido 60 min)');
  return token;
}

// ── Passo 2: Listar estações pluviométricas ──────────────────
async function listarEstacoes(token) {
  console.log(`[ANA-HWS] Listando estações UF=${UF}...`);

  const resp = await axios.get(`${BASE}/HidroInventarioEstacoes/v1`, {
    timeout: 60000,
    httpsAgent,
    headers: {
      'Authorization': `Bearer ${token}`,
      'accept':        '*/*'
    },
    params: {
      'Unidade Federativa': UF
    }
  });

  // Estrutura confirmada: { status, code, message, items: [...] }
  const items = resp.data?.items || [];

  // Filtrar apenas estações pluviométricas ativas
  // Campo Tipo_Estacao: "Pluviometrica", "Fluviometrica", etc.
  // Campo Operando: "1" = ativa
  const pluvio = items.filter(e =>
    e.Tipo_Estacao &&
    e.Tipo_Estacao.toLowerCase().includes('pluvi') &&
    e.Operando === '1' &&
    e.Latitude  && e.Latitude  !== '0' &&
    e.Longitude && e.Longitude !== '0'
  );

  console.log(
    `[ANA-HWS] ${items.length} estações totais → ` +
    `${pluvio.length} pluviométricas ativas`
  );
  return pluvio;
}

// ── Passo 3: Buscar série adotada de chuva por estação ───────
async function buscarChuva(token, codEstacao, dataBusca) {
  const resp = await axios.get(
    `${BASE}/HidroinfoanaSerieTelemetricaAdotada/v1`, {
    timeout: 15000,
    httpsAgent,
    headers: {
      'Authorization': `Bearer ${token}`,
      'accept':        '*/*'
    },
    params: {
      'Código da Estação':    codEstacao,
      'Tipo Filtro Data':     'DATA_LEITURA',
      'Data de Busca':        dataBusca,
      'Range Intervalo de busca': 'DIAS_7'
    }
  });
  return resp.data?.items || [];
}

// ── Somar mm dentro da janela HORAS ─────────────────────────
function somarChuva(medicoes, horas) {
  const corte = Date.now() - horas * 3600 * 1000;
  return medicoes.reduce((soma, m) => {
    const ts = new Date(
      m.Data_Hora_Medicao || m.Data_Atualizacao || 0
    ).getTime();
    const v  = parseFloat(m.Chuva_Adotada || 0);
    // Ignorar medições com qualidade ruim (status 2)
    const ok = String(m.Chuva_Adotada_Status || '0') !== '2';
    return soma + (ts >= corte && !isNaN(v) && ok ? v : 0);
  }, 0);
}

// ── Função principal ─────────────────────────────────────────
async function main() {
  if (!IDENTIFICADOR || !SENHA) {
    console.error('[ANA-HWS] ❌ Secrets ANA_IDENTIFICADOR e ANA_SENHA não definidos');
    console.error('  → Adicione em: Settings → Secrets → Actions');
    preservarOuCriarVazio('Credenciais não configuradas');
    return;
  }

  const agora    = new Date();
  const dataBusca = fmtDate(agora);

  // Autenticar
  let token;
  try {
    token = await obterToken();
  } catch (err) {
    console.error(`[ANA-HWS] ❌ Falha na autenticação: ${err.message}`);
    preservarOuCriarVazio(err.message);
    return;
  }

  // Listar estações
  let estacoes;
  try {
    estacoes = await listarEstacoes(token);
  } catch (err) {
    console.error(`[ANA-HWS] ❌ Falha ao listar estações: ${err.message}`);
    preservarOuCriarVazio(err.message);
    return;
  }

  if (estacoes.length === 0) {
    console.warn('[ANA-HWS] ⚠️ Nenhuma estação pluviométrica encontrada');
    preservarOuCriarVazio('Nenhuma estação retornada');
    return;
  }

  // Processar em paralelo com concorrência limitada
  const amostra    = estacoes.slice(0, MAX_EST);
  const CONC       = 8;
  const resultado  = [];
  let tokenAge     = Date.now(); // controle de renovação do token

  for (let i = 0; i < amostra.length; i += CONC) {

    // Renovar token se estiver próximo de 55 min
    if (Date.now() - tokenAge > 55 * 60 * 1000) {
      try {
        token    = await obterToken();
        tokenAge = Date.now();
      } catch (_) { /* continua com token atual */ }
    }

    const lote   = amostra.slice(i, i + CONC);
    const results = await Promise.allSettled(lote.map(async est => {
      const cod = est.codigoestacao;
      const lat = parseFloat(est.Latitude);
      const lon = parseFloat(est.Longitude);

      if (!cod || isNaN(lat) || isNaN(lon)) return null;

      let p120 = 0;
      try {
        const medicoes = await buscarChuva(token, cod, dataBusca);
        p120 = somarChuva(medicoes, HORAS);
      } catch (_) {}

      return {
        id:     String(cod),
        name:   est.Estacao_Nome || est.Municipio_Nome || `ANA-${cod}`,
        lat:    lat,
        lon:    lon,
        p120:   parseFloat(p120.toFixed(1)),
        source: 'ANA-HidroWebService',
        bacia:  est.Bacia_Nome  || '',
        uf:     est.UF_Estacao  || UF
      };
    }));

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) resultado.push(r.value);
    }

    // Respeitar rate limit da ANA
    await new Promise(r => setTimeout(r, 800));
    process.stdout.write(
      `  [ANA-HWS] ${Math.min(i+CONC, amostra.length)}/${amostra.length} estações\r`
    );
  }
  console.log('');

  const comDados = resultado.filter(e => e.p120 > 0);
  console.log(
    `[ANA-HWS] ✅ ${resultado.length} estações · ` +
    `${comDados.length} com chuva > 0mm`
  );

  const output = {
    fonte:      'ANA HidroWebService (OAuth)',
    endpoint:   BASE,
    uf:         UF,
    horas:      HORAS,
    atualizado: agora.toISOString(),
    total:      resultado.length,
    com_dados:  comDados.length,
    estacoes:   resultado
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2), 'utf8');
}

function preservarOuCriarVazio(motivo) {
  if (fs.existsSync(OUTPUT)) {
    try {
      const ex = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
      ex.ultimo_erro    = motivo;
      ex.ultimo_erro_ts = new Date().toISOString();
      fs.writeFileSync(OUTPUT, JSON.stringify(ex, null, 2), 'utf8');
      console.log('[ANA-HWS] ⚠️ Mantendo dados anteriores.');
    } catch (_) {}
  } else {
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, JSON.stringify({
      fonte: 'ANA HidroWebService', uf: UF, horas: HORAS,
      atualizado: new Date().toISOString(),
      total: 0, com_dados: 0, estacoes: [], erro: motivo
    }, null, 2), 'utf8');
  }
  process.exit(0);
}

main().catch(err => {
  console.error(`[ANA-HWS] ❌ Erro fatal: ${err.message}`);
  preservarOuCriarVazio(err.message);
});
