# PUB ACP | External Capability Allocation

**Status:** Boundary record
**Date:** 2026-09-16

## Purpose

Registrar a posição do ACP diante do research externo. O ACP absorve contratos e adapters quando necessários, mas não incorpora runtimes externos nem duplica PDL, PUB Machine, PUB Neural ou Control Room.

**Princípio:** o ACP é a autoridade de execução governada, não um catálogo de agentes ou ferramentas.

## OpenHands

Source: https://github.com/openhands

Usar apenas como referência arquitetural para separação entre agente, backend e ambiente de execução. Não transplantar o runtime OpenHands para o ACP.

## Browser Use

Source: https://github.com/browser-use/browser-use

Pode existir uma interface/adaptador de capability no ACP para solicitar uma operação de browser ao PUB Machine.

O ACP deve controlar contrato, autorização, timeout, contexto e retorno da operação. A implementação concreta do browser permanece no PUB Machine.

Fluxo:

`PDL/Control Room → ACP → Machine Browser Capability → resultado → ACP → consumidor`

## Crawl4AI / Maxun

Sources:
- https://github.com/unclecode/crawl4AI
- https://github.com/getmaxun/maxun

O ACP não vira crawler/scraper. Quando necessário, expõe uma fronteira governada para solicitar uma capability do PUB Machine.

## Coolify

Source: https://github.com/coollabsio/coolify

Infraestrutura e deployment pertencem ao PUB Machine. O ACP pode receber/expor apenas contratos de execução relevantes, sem incorporar o control plane de infraestrutura.

## Non-duplication rules

1. ClosedLoopEngine continua como autoridade única de execução.
2. PDL decide e planeja.
3. PUB Machine executa capacidades especializadas.
4. PUB Neural armazena conhecimento e evidências.
5. Control Room observa e coordena.
6. Nenhum projeto externo pesquisado deve ser copiado integralmente para o ACP.
7. Adapters devem ser pequenos, contratuais e substituíveis.

## Priority

### P0
- Preservar contratos públicos e segurança.
- Definir capability request/response boundary para Machine.
- Garantir timeout, authorization e fail-closed behavior.

### P1
- Browser capability adapter quando houver demanda operacional real.
- Research/data capability adapter quando PDL precisar acionar Machine.

### P2
- Remote capability workers e interfaces adicionais somente após evidência de necessidade.
