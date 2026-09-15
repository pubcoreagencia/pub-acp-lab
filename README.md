# PUB-ACP-BRIDGE

Ponte de transporte autônoma e programática conectando Clientes Orquestradores (como instâncias GPT, backends ou scripts) ao **Google Antigravity CLI (`agy`)** através do protocolo padronizado **ACP (Agent Client Protocol)**, sem intervenção humana e sem copy/paste.

---

## 1. Arquitetura

```text
+-------------------------------------------------------------+
|                     CLIENTE ORQUESTRADOR                    |
|             (Node.js / Python / Backend / API)              |
+-------------------------------------------------------------+
                              |
                    JSON-RPC / NDJSON
                     ou API PubAcpBridge
                              v
+-------------------------------------------------------------+
|                       PUB-ACP-BRIDGE                       |
|
        (bridge.js / server.js - Gerenciador de Sessões)     |
+-------------------------------------------------------------+
                              |
                       ACP Protocol v2
                       (stdio JSON-RPC)
                              v
+-------------------------------------------------------------+
|                        ADAPTER ACP                        |
|
             (agy-agent-acp / dongitran @ a314a06)           |
+-------------------------------------------------------------+
                              |
                    NDJSON bidirecional stdio
                    --input-format stream-json
                    --output-format stream-json
                              v
+-------------------------------------------------------------+
|                   ANTIGRAVITY CLI (agy.exe)                 |
|
             Processo persistente / Agente IA              |
+-------------------------------------------------------------+
                              |
                      Tool Calls nativos
                      (view_file, replace, run)
                              v
+-------------------------------------------------------------+
|                    FILESYSTEM DO WORKSPACE                 |
|                 (C\:\\...\\PUB-ACP-POC)                    |
+-------------------------------------------------------------+
```

---

## 2. Componentes

1. `bridge.js`: Módulo central reutilizável (`PubAcpBridge`) que gerencia o ciclo de vida do processo ACP, executa o handshake `initialize`, cria sessões (`session/new`), despacha prompts (`session/prompt`), mapeia eventos em tempo real (`chunk`, `tool_call`, `usage`) e garante encerramento gracioso com timeouts e tratamento de erros estruturados.
2. `server.js`: Interface CLI em NDJSON sobre stdin/stdout para permitir consumo por orquestradores desacoplados de qualquer linguagem.
3. `test-suite.js`: Suíte de testes automatizada validando todos os turnos de leitura, escrita, contexto na mesma sessão, correção de bugs em código e resiliência a falhas.

---

## 3. Protocolo de Entrada e Saída (server.js)

Comunicação via **NDJSON** (uma linha JSON por mensagem) sobre `stdin` e `stdout`.

### 3.1. Mensagens de Entrada (Orquestrador -> Bridge)

#### Criar Sessão:
```json
{"id": 1, "action": "create_session", "cwd": "C:\\\\Users\\\\Matheus Paes\\\\Documents\\\\ChatGPT\\\\PUB-ACP-POC"}
```

#### Enviar Prompt (com streaming):
```json
{"id": 2, "action": "prompt", "sessionId": "UUID-DA-SESSAO", "prompt": "Leia o arquivo index.js"}
```

#### Fechar Bridge:
```json
{"id": 3, "action": "close"}
```

### 3.2. Mensagens de Saída (Bridge -> Orquestrador)

#### Inicialização / Pronto:
```json
{"type": "ready", "status": "OK", "protocol": "PUB-ACP-BRIDGE/1.0"}
```

#### Confirmação de Sessão:
```json
{"id": 1, "type": "session_created", "sessionId": "3063f523-72b8-4f26-9626-8bb6fc212637"}
```

#### Chunks de Streaming (em tempo real):
```json
{"id": 2, "type": "chunk", "sessionId": "...", "chunk": "O arquivo contém..."}
```

#### Notificação de Tool Call do Agente:
```json
{"id": 2, "type": "tool_call", "sessionId": "...", "title": "view_file", "toolInput": {"AbsolutePath": "..."}}
```

#### Conclusão do Turno:
```json
{"id": 2, "type": "prompt_result", "sessionId": "...", "stopReason": "end_turn", "response": "..."}
```

---

## 4. Uso Programático em Node.js (bridge.js)

```javascript
const { PubAcpBridge } = require('./bridge.js');

async function main() {
  const bridge = new PubAcpBridge({
    workspaceDir: process.cwd(),
    timeoutMs: 180000,
    skipPermissions: false // Modo seguro/scoped ativo por padrão
  });

  // 1. Inicia o adaptador e realiza handshake ACP
  await bridge.start();

  // 2. Cria sessão persistente
  const sessionId = await bridge.createSession();

  // 3. Primeiro turno: Leitura
  const r1 = await bridge.prompt(
    sessionId,
    'Leia hello.txt',
    (chunk) => process.stdout.write(chunk),
    (tool, params) => console.log('Tool acionada:', tool)
  );

  // 4. Segundo turno (MESMA sessão): Escrita mantendo contexto
  const r2 = await bridge.prompt(
    sessionId,
    'Altere hello.txt para BRIDGE_SESSION_OK'
  );

  // 5. Encerramento limpo
  await bridge.close();
}
main();
```

---

## 5. Tratamento de Erros e Resiliência

O bridge possui tratamento estruturado para:
* **Processo AGY ou Adapter inexistente**: Rejeita imediatamente na inicialização com mensagem explícita.
* **Timeouts**: Cada chamada JSON-RPC possui temporizador configurável (padrão: 240s) para evitar travamentos.
* **JSON Inválido**: Capturado sem derrubar o processo, emitindo evento de erro estruturado.
* **Queda do processo**: Se o processo sofrer crash, todas as requisições pendentes são rejeitadas.
* **Sessão inexistente**: Validação prévia imediata antes de enviar comandos à CLI.

---

## 6. Segurança e Permissões Scoped

* **Execução Autônoma Scoped**: A partir da versão `v0.2.0`, a flag `--dangerously-skip-permissions` não é mais necessária nem utilizada por padrão.
* **Permissões Granulares em `settings.json`**: O Antigravity CLI é configurado em `~/.gemini/antigravity-cli/settings.json` com regras granulares restritas ao diretório do workspace e comandos específicos:
  ```json
  {
    "permissions": {
      "allow": [
        "read_file(C:\\\\Users\\\\Matheus Paes\\\\Documents\\\\ChatGPT\\\\PUB-ACP-POC\\\\**)",
        "read_file(C:/Users/Matheus Paes/Documents/ChatGPT/PUB-ACP-POC/**)",
        "write_file(C:\\\\Users\\\\Matheus Paes\\\\Documents\\\\ChatGPT\\\\PUB-ACP-POC\\\\**)",
        "write_file(C:/Users/Matheus Paes/Documents/ChatGPT/PUB-ACP-POC/**)",
        "write_file(C:\\\\Users\\\\Matheus Paes\\\\Documents\\\\ChatGPT\\\\PUB-ACP-POC\\\\hello.txt)",
        "write_file(C:/Users/Matheus Paes/Documents/ChatGPT/PUB-ACP-POC/hello.txt)",
        "write_file(C:\\\\Users\\\\Matheus Paes\\\\Documents\\\\ChatGPT\\\\PUB-ACP-POC\\\\calc.js)",
        "write_file(C:/Users/Matheus Paes/Documents/ChatGPT/PUB-ACP-POC/calc.js)",
        "command(node -v)",
        "command(node calc.js)",
        "command(node -e \"console.log(require('./calc.js').multiply(2, 3))\")",
        "command(node -e \"const { multiply } = require('./calc.js'); console.log(multiply(2, 3));\")"
      ]
    }
  }
  ```
* **Bloqueio Automático Fora do Escopo**: Comandos não autorizados (ex.: `whoami`) ou tentativas de leitura fora do workspace (ex.: `C:\Windows\System32\drivers\etc\hosts`) são automaticamente bloqueados e negados pelo motor de permissões do Antigravity CLI no modo headless.
* **Isolamento Total**: Toda a operação está confinada ao diretório do POC. Nenhum arquivo ou repositório da PUB (PDL, PUB Neural, PP, PUB Ecom) foi acessado ou afetado.