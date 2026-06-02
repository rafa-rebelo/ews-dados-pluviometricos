# EWS — Dados Pluviométricos Automáticos
### Sistema de Alerta Precoce de Deslizamentos · GEE · Bacia do Rio Taquari (RS)

[![Atualizar Dados](https://github.com/rafarebelo/ews-dados-pluviometricos/actions/workflows/atualizar-dados.yml/badge.svg)](https://github.com/rafarebelo/ews-dados-pluviometricos/actions/workflows/atualizar-dados.yml)

---

## O que este repositório faz

A cada **6 horas**, o GitHub Actions executa automaticamente:

1. Busca dados do **CEMADEN** (rede pluviométrica nacional)
2. Busca dados da **ANA HidroWeb** (telemetria fluvial)
3. Mescla as duas fontes, remove duplicatas por proximidade geográfica
4. Adiciona estações sintéticas históricas como fallback para posições sem cobertura
5. Salva os JSONs atualizados no repositório
6. GitHub Pages serve os arquivos via HTTPS sem restrição de CORS

---

## Arquivos gerados (acessíveis via GitHub Pages)

| Arquivo | Conteúdo | URL |
|---|---|---|
| `data/merged.json` | Todas as estações mescladas — **usado pelo GEE** | `https://rafarebelo.github.io/ews-dados-pluviometricos/data/merged.json` |
| `data/cemaden.json` | Apenas estações CEMADEN | `…/data/cemaden.json` |
| `data/ana.json` | Apenas estações ANA | `…/data/ana.json` |
| `data/status.json` | Resumo rápido do estado atual | `…/data/status.json` |

---

## Como o GEE consome os dados

No script GEE (Ag.6b), a variável `GITHUB_DATA_URL` aponta para o `merged.json`:

```javascript
var GITHUB_DATA_URL =
  'https://rafarebelo.github.io/ews-dados-pluviometricos/data/merged.json';
```

O GEE lê o JSON, extrai as estações com `p120 > 0` e aplica a interpolação IDW
para corrigir o viés espacial do GPM IMERG (~10 km).

---

## Estrutura do `merged.json`

```json
{
  "atualizado": "2024-05-15T12:00:00.000Z",
  "total": 47,
  "com_dados": 32,
  "p120_max_mm": 187.4,
  "estacoes": [
    {
      "id": "42600000",
      "name": "Muçum",
      "lat": -29.169,
      "lon": -51.868,
      "p120": 187.4,
      "source": "ANA"
    }
  ]
}
```

---

## Atualização manual

Para forçar uma atualização fora do agendamento:

1. Vá em **Actions** → **Atualizar Dados Pluviométricos EWS**
2. Clique em **Run workflow** → **Run workflow**

---

## Configuração inicial (uma vez)

### 1. Habilitar GitHub Pages

- Vá em **Settings** → **Pages**
- Source: **Deploy from a branch**
- Branch: `main` · Folder: `/ (root)`
- Salvar

### 2. Permitir que o GitHub Actions faça commits

- Vá em **Settings** → **Actions** → **General**
- Em "Workflow permissions": marque **Read and write permissions**
- Salvar

---

## Custo

**Zero.** GitHub Actions oferece 2.000 minutos gratuitos por mês.
Cada execução leva ~2 minutos → 4 execuções/dia × 30 dias = 240 minutos/mês.
Margem de 1.760 minutos gratuitos sobrando.

---

## Créditos

- **CEMADEN** — Centro Nacional de Monitoramento e Alertas de Desastres Naturais
- **ANA** — Agência Nacional de Águas e Saneamento Básico (HidroWeb Telemetria)
- **GPM IMERG** — NASA Global Precipitation Measurement
- **Google Earth Engine** — plataforma de análise geoespacial
