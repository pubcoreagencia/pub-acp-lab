# FASE 5 — GPT Free -> Local Orchestrator Integration Research

Data da Pesquisa: 15 de Setembro de 2026  
Workspace: C:\Users\Matheus Paes\Documents\ChatGPT\PUB-ACP-POC  
Repositório: pubcoreagencia/pub-acp-lab  

---

## 1. Executive Summary

> **Pergunta:** Como podemos eliminar o copy/paste entre ChatGPT Free e Antigravity?

**Resposta Técnica Direta:**
**Não existe atualmente nenhum caminho oficial direto, seguro e com custo zero via ChatGPT Free** para invocar ferramentas e receber respostas programáticas de uma máquina local sem violar os Termos de Serviço ou exigir recursos restritos a planos pagos/organizações.

A razão técnica central é que:
1. O ecossistema oficial da OpenAI para execução e expansão de ferramentas externas baseia-se em **MCP (Model Context Protocol)** e **Apps/Connectors com Developer Mode**, ambos restritos às contas corporativas/pagas (**ChatGPT Business, Enterprise e Edu**, com beta seletivo no Plus/Pro).
2. O **OpenAI Secure MCP Tunnel (openai/tunnel-client)** requer autenticação via **Runtime API Key da OpenAI Platform** e organização com perfil Tunnels Read + Use.
3. A criação de novos **Custom GPTs com Actions** para contas pessoais (Free, Plus, Pro) foi descontinuada pela OpenAI em favor de plugins/conectores corporativos.
4. Qualquer tentativa de automatizar a interface web do ChatGPT Free (via extensões que raspem DOM, emulem digitação ou interceptem tokens de sessão web) enquadra-se na categoria **FRÁGIL, NÃO RECOMENDADA e com alto risco de quebra e infração de ToS**.

Portanto, para manter a arquitetura profissional da PUB sem hacks:
* **No ecossistema OpenAI Oficial:** O primeiro caminho viável exige assinatura ou API billing (ChatGPT Business/Enterprise ou OpenAI API direta).
* **Para manter custo zero (R$ 0) e zero copy/paste:** O orquestrador deve ser desacoplado da interface web do ChatGPT Free, utilizando modelos abertos locais (ex.: Ollama), endpoints compatíveis com a API OpenAI em ferramentas livres, ou operando o Antigravity como executor autônomo via PUB-ACP-BRIDGE.

---

## 2. Capability Matrix

| Mecanismo | Free | API Req | MCP Req | Localhost Direto | Write/Exec | Oficial | Viabilidade Geral |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **OpenAI Secure MCP Tunnel (openai/tunnel-client)** | NÃO | SIM (Platform) | SIM | SIM (via tunnel) | SIM | SIM | **INVIÁVEL NO FREE** (Requer API Key do Platform) |
| **ChatGPT MCP Developer Mode (Apps & Connectors)** | NÃO | NÃO | SIM | NÃO (precisa tunnel) | SIM | SIM | **INVIÁVEL NO FREE** (Restrito a Business/Enterprise/Edu) |
| **GPT Actions / Custom GPTs** | NÃO | NÃO | NÃO | NÃO (só HTTPS público) | SIM | DESCONTINUADO | **INVIÁVEL NO FREE** (Criação bloqueada em contas pessoais) |
| **Integrated Terminal (ChatGPT Desktop)** | SIM/PARCIAL | NÃO | NÃO | SIM | NÃO PROGRAMÁTICO | SIM | **INVIÁVEL P/ AUTOMAÇÃO** (Apenas interativo humano) |
| **Browser Extension + Local Daemon (Injeção DOM/Userscript)** | SIM | NÃO | NÃO | SIM (via fetch localhost) | CONDICIONAL | NÃO (Terceiro) | **FRÁGIL / NÃO RECOMENDADO** (Risco de ToS, quebra fácil) |
| **OpenAI API Direta (Orquestrador Python/Node)** | NÃO | SIM (Pay-as-you-go) | OPCIONAL | SIM | SIM | SIM | **VIÁVEL COM POUCOS CENTAVOS** (Elimina copy/paste 100%) |
| **Local LLM Orchestrator (Ollama / Llama 3 / Qwen)** | SIM | NÃO (R$ 0) | SIM/ACP | SIM | SIM | SIM | **VIÁVEL ZERO CUSTO** (100% autônomo e local) |

---

## 3. Análise Detalhada dos Candidatos

### 3.1. OpenAI Secure MCP Tunnel (openai/tunnel-client)
* **Repositório Oficial:** openai/tunnel-client
* **Finalidade:** Criar uma conexão HTTPS de saída (outbound) do computador do usuário para o plano de controle de túneis da OpenAI, permitindo que produtos OpenAI alcancem servidores MCP locais sem abrir portas públicas.
* **Autenticação Obrigatória:** Exige um 	unnel_id e uma **Runtime API Key** gerada no console da OpenAI Platform (platform.openai.com/settings/organization/api-keys).
* **Suporte a ChatGPT Free:** **NÃO.** O túnel precisa ser associado a uma organização e workspace com permissão Tunnels Read + Use.
* **Veredito:** Incompatível com o requisito de gratuidade total e ausência de conta de API da OpenAI.

### 3.2. MCP no ChatGPT (Apps & Connectors / Developer Mode)
* **Documentação Oficial:** OpenAI Help Center (*Model Context Protocol in ChatGPT*).
* **Disponibilidade:**
  * **Business, Enterprise, Edu:** Acesso completo com  Developer Mode sob Workspace Settings -> Permissions & Roles -> Connected Data. Permite registrar servidores MCP remotos/tuneados para leitura e escrita.
  * **Free:** Não possui suporte a Developer Mode para criação/adição de servidores MCP customizados. O toggle não está habilitado ou não conecta ferramentas externas.
* **Veredito:** O ecossistema MCP nativo do ChatGPT Web é voltado a planos corporativos.

### 3.3. GPT Actions / Custom GPTs
* **Situação Atual:** A OpenAI iniciou a descontinuação gradual de novos Custom GPTs em contas pessoais (Free, Plus, Pro), restringindo criação e publicação a planos Business/Enterprise com transição para ecossistema de plugins/apps unificados.
* **Limitação de Rede:** Mesmo onde ainda funcionam legados, GPT Actions exigem um endpoint HTTPS com certificado público e OpenAPI Schema estrito, recusando endereços privados como localhost ou 127.0.0.1.
* **Veredito:** Inviável no ChatGPT Free.

### 3.4. Open-Source Bridges Investigados

| Projeto | Como Integra | Plano Req. | Requer API? | Requer Túnel? | Funciona no Free? | Execução Local? | Risco / Fragilidade |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **yuga-hashimoto/localant** | Gateway MCP com sandbox Node.js e allowlist de comandos | Pago (Business/Ent) | NÃO | SIM (Cloudflare/Ngrok) | NÃO | SIM | Médio (Depende de MCP no ChatGPT) |
| **mingrath/chatgpt-sol-local-bridge** | MCP Server com ferramentas de shell e arquivos via túnel | Pago (Business/Ent) | NÃO | SIM | NÃO | SIM | Médio (Depende de Developer Mode) |
| **hoangcoderr/chatgpt-local-coder** | MCP Server local (40+ tools) exposto via Pinggy/Cloudflared | Pago (Plus/Ent com Dev Mode) | NÃO | SIM | NÃO | SIM | Alto (URL do túnel expõe shell) |
| **int04/ChatCmd** | Ponte MCP multi-provedor (ChatGPT, Grok, Gemini) | Pago / API | Depende | SIM | NÃO | SIM | Médio |
| **ChatGPT Browser Extensions (Userscript/Tampermonkey)** | Injeta script na aba do ChatGPT, escuta mensagens e faz etch('http://localhost') | Free | NÃO | NÃO | SIM | SIM | **MUITO ALTO** (Quebra com updates de DOM da OpenAI, risco de bloqueio de conta) |

---

## 4. Respostas Objetivas às Perguntas Obrigatórias

### PERGUNTA A: Existe hoje uma forma oficial de ChatGPT Free -> local machine -> PUB-ACP-BRIDGE sem API paga?
**NÃO.** A OpenAI não disponibiliza mecanismos oficiais para que instâncias do ChatGPT Free executem tool calling ou chamadas de rede arbitrárias para o localhost da máquina do usuário.

### PERGUNTA B: Se não existe, qual é a alternativa mais próxima que exige menor mudança, menor custo e mantém o bridge atual sem transformar em PDL?
Existem duas alternativas viáveis:
1. **Alternativa Econômica Oficial (API OpenAI Pay-as-you-go):**
   * Criar um script orquestrador leve (ex.: orchestrator-openai.js) de ~100 linhas consumindo a API oficial da OpenAI (modelo gpt-4o-mini).
   * **Custo:** Frações de centavos de dólar (geralmente < R$ 1,00 para centenas de iterações do POC).
   * **Vantagem:** 100% oficial, estável, suporta Tool Calling nativo, consome diretamente o server.js do PUB-ACP-BRIDGE, zero copy/paste, zero risco de quebra de interface web.
2. **Alternativa Zero Custo Total (R$ 0 - Modelo Local como Orquestrador):**
   * Usar um modelo aberto local (ex.: Ollama com llama3.2 ou qwen2.5-coder) rodando na máquina como cérebro de teste, despachando tarefas para o PUB-ACP-BRIDGE.
   * **Custo:** R$ 0,00.
   * **Vantagem:** Totalmente independente de cloud, sem limites de taxa, compatível com o contrato NDJSON construído na Fase 4.

### PERGUNTA C: Qual é o primeiro plano/produto OpenAI que permitiria essa integração oficialmente?
* **Via Interface Web / MCP:** **ChatGPT Business** (ou **Plus** em regiões/contas com Developer Mode beta ativo), combinado com um túnel seguro (Cloudflare Tunnel ou openai/tunnel-client).
* **Via API Programática:** **OpenAI Platform API (Tier 1 Pay-as-you-go)**, sem necessidade de assinatura mensal fixa de US$ 20.

### PERGUNTA D: Classificação dos Mecanismos Técnicos
* **OpenAI Secure MCP Tunnel (openai/tunnel-client):** OFICIAL (mas requer API/Plano corporativo).
* **ChatGPT Apps Developer Mode:** OFICIAL (restrito a Business/Enterprise).
* **Custom GPT Actions:** DESCONTINUADO / NÃO RECOMENDADO.
* **Projetos MCP Comunitários (localant, chatgpt-local-coder):** TERCEIRO (requerem Developer Mode e túnel público).
* **Extensões de Navegador / Interceptação DOM na Web:** FRÁGIL / NÃO RECOMENDADO (alta probabilidade de quebra contínua e risco de moderação por automação não autorizada).

---

## 5. Arquitetura Recomendada e Decisão

### Decisão:
```text
GO WITH PAID API / LOCAL AGENT DECISION GATE
(NO-GO PARA CHATGPT FREE WEB NATIVO)
```

### Justificativa:
O PUB-ACP-BRIDGE está 100% provado e operacional (conforme demonstrado pelo orchestrator-sim.js na Fase 4). O gargalo exclusivo é a inexistência de conectores de saída no plano **ChatGPT Free Web**. Tentar forçar o ChatGPT Free Web via raspagem de tela/DOM é tecnicamente insustentável para um laboratório sério.

### Próxima Fase Recomendada (FASE 6):
**Opção Recomendada:** Criar um orquestrador desacoplado (orchestrator-client) capaz de plugar alternativamente:
1. Um client de API padrão OpenAI (para quando houver chave API disponível);
2. Ou um runner CLI que conecte agentes externos diretamente ao server.js do pub-acp-lab.

---

## 6. Fontes Consultadas

1. **OpenAI Help Center — Model Context Protocol in ChatGPT:**
   https://help.openai.com/en/articles/10255554-model-context-protocol-in-chatgpt
2. **OpenAI Official GitHub — Secure MCP Tunnel Client:**
   https://github.com/openai/tunnel-client
3. **OpenAI Help Center — Connected Data & Developer Mode:**
   https://help.openai.com/en/articles/10255555-developer-mode-and-connectors
4. **OpenAI Help Center — Custom GPTs Updates and Plugin Migration:**
   https://help.openai.com/en/articles/8555545-actions-in-gpts
5. **Community MCP Implementations:**
   * https://github.com/yuga-hashimoto/localant
   * https://github.com/hoangcoderr/chatgpt-local-coder
   * https://github.com/mingrath/chatgpt-sol-local-bridge
   * https://github.com/int04/ChatCmd
