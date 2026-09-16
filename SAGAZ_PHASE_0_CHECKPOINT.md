# SAGAZ FARM OS — PHASE 0 CHECKPOINT & ARCHITECTURE DISCOVERY

Data: 2026-09-16  
Status: **PHASE 0 COMPLETE — AUDIT APPROVED**

---

## 1. Contexto e Descoberta de Ambiente

O projeto **SAGAZ FARM OS** constitui uma nova aplicação autônoma orientada ao ecossistema PUB.
Na auditoria inicial realizada no diretório atual de trabalho (`PUB-ACP-POC` / repositório `pubcoreagencia/pub-acp-lab`), constatou-se:

- **Stack Atual do Diretório**: Node.js v26.7.0 (CommonJS), npm v11.19.0.
- **Natureza do Repositório**: Trata-se estritamente do **ACP-LAB** (Ponte de transporte autônomo e automação física de navegador via Chrome CDP na porta 9555 conectando ao ChatGPT Free).
- **Frontend**: NOT PRESENT.
- **Backend de Aplicação**: NOT PRESENT.
- **Database / Persistência**: NOT PRESENT.
- **Autenticação**: NOT PRESENT.
- **Integração PUB Prototype (PP)**: O repositório vizinho `PUB PROTOTYPE` é uma infraestrutura independente de prototipagem em Express 5 + PostgreSQL. Não há acoplamento nem dependência técnica entre SAGAZ e PP. O PP foi mantido 100% intocado.

---

## 2. Decisão Arquitetural e Regra de Isolamento

> **ISOLAMENTO MANDATÓRIO:**  
> O SAGAZ FARM OS **NÃO** será construído dentro do repositório `pub-acp-lab` (`PUB-ACP-POC`).  
> O ACP-LAB permanece exclusivamente como infraestrutura de transporte e automação de agente.  
> O SAGAZ FARM OS terá seu próprio repositório/workspace isolado antes do início da Phase 1.

---

## 3. Mapeamento de Domínio (Revisão Conceitual)

Entidades identificadas e suas relações conceituais:

- **Farm**: Fazenda / Unidade controladora principal.
- **FarmUnit**: Galpões, aviários, piquetes ou módulos físicos de alojamento.
- **FlockLot**: Lotes de aves (linhagem, alojamento, quantidades, idade, custos de formação).
- **FlockLifecycleEvent**: Eventos vitais com rastreabilidade auditável (vacinações, trocas de ração, pesagens, descartes, mortalidade, transferências). Permanece como entidade própria para evitar poluição no histórico do lote.
- **EggProduction**: Apontamentos diários de postura (ovos coletados, ovos trincados/descarte, ovos vendáveis).
- **FeedStock**: Gestão de estoque de insumos e sacarias de ração (saldo, fornecedor, lote, custo/kg).
- **FeedConsumption**: Apontamentos diários de fornecimento alimentar por lote/galpão.
- **HatchCycle**: Ciclos de incubação/reprodução artificial ou natural (ovos incubados, perdas no processo, eclosão).
- **Sale**: Transações comerciais de ovos, aves de descarte e subprodutos.
- **Revenue**: Contas a receber e receitas operacionais realizadas.
- **Expense**: Despesas fixas (mão de obra, energia, manutenção) e despesas variáveis (ração, medicamentos, embalagens).
- **Alert**: Disparos de anomalias operacionais (queda de postura, pico de mortalidade, estoque crítico).
- **ScaleSimulation**: Cenários de simulação paramétrica de ampliação e impacto estrutural.
- **SagazModel**: Módulo executivo do modelo de negócio (investimento, viabilidade, margens e payback).

---

## 4. Fórmulas de Negócio (Pontos de Teste para Phase 1)

As fórmulas identificadas devem receber suíte dedicada de testes unitários com TDD na Phase 1:
- **Mortalidade e Plantel Atual**: Taxa percentual acumulada e saldo vivo real.
- **Idade do Lote**: Cálculo em semanas a partir da data de alojamento.
- **Taxa de Postura (%) & Ovos por Ave**: Rendimento zootécnico diário e semanal.
- **Consumo Médio Diário por Ave (g/ave/dia)**: Controle nutricional por ave alojada.
- **Custo Diário de Alimentação**: Consumo físico ponderado pelo custo médio do insumo.
- **Conversão Alimentar (kg/dz ou kg/kg)**: Eficiência produtiva por dúzia ou quilo de ovo.
- **Custo Médio Ponderado por Ovo / Dúzia**: Apropriação de custos diretos e indiretos.
- **Taxa de Eclosão (%)**: Rendimento do ciclo de incubação.
- **Margem de Contribuição**: Preço médio ponderado subtraído do custo variável unitário.
- **Break-even Operacional (Ponto de Equilíbrio)**: Volume mínimo de ovos e receita mínima necessária para zerar custos fixos.
- **Simulações de Escala & Payback**: Curvas de retorno sobre investimento do modelo SAGAZ.

*Nota: Todas as fórmulas serão validadas e refinadas com dados zootécnicos reais durante a modelagem da Phase 1.*

---

## 5. Decisão de Persistência (Pendente para Phase 1)

Critério inegociável: **A persistência final deve ser real e sobreviver a recargas, fechamentos de navegador e reinicializações.** É terminantemente proibido o uso de mock/fake API como solução de arquitetura final.

Na Phase 1 será avaliada a melhor estratégia entre:
1. **Supabase / PostgreSQL**: Banco relacional robusto, auth nativa, multi-tenant e pronto para produção.
2. **SQLite (local / embedded)**: Simplicidade, zero latência e isolamento no ambiente do produtor.
3. **IndexedDB / Local-first com sincronização**: Resiliência offline no campo com exportação/sincronização.

Critérios de decisão: Facilidade de desenvolvimento, segurança dos lançamentos da granja, capacidade multi-unidade e custo operacional.

---

## 6. Roadmap das Fases

- **PHASE 0**: Audit / Architecture / Environment Discovery (CONCLUÍDA)
- **PHASE 1**: Foundation / Workspace Setup / Persistence / Navigation / Seed / Domain Tests
- **PHASE 2**: Flock / Lifecycle & Manejo
- **PHASE 3**: Production / Feed / Stock
- **PHASE 4**: Sales / Finance / Break-even
- **PHASE 5**: Reproduction / Alerts & Anomalias
- **PHASE 6**: Dashboard Executivo / Scale Simulation
- **PHASE 7**: Modelo SAGAZ (Viabilidade, Margens & Payback)
- **PHASE 8**: E2E Testing / Validation / Production Polish
