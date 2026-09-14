# Configuracoes multi-modelo para agentes de codigo

Pesquisa e atualizacao realizadas em 12 de setembro de 2026 com documentacao,
codigo-fonte e buscas publicas. Nao foram feitos login, chamadas a APIs de
modelos ou testes de execucao. O objetivo foi verificar configuracoes reais para
um agente principal, um consultor e workers, em mais de um harness.

## Conclusao executiva

Os nomes nao sao apenas apelidos de comunidade: a documentacao atual da OpenAI
lista `gpt-6-astra`, `gpt-5.6-sol` e `gpt-5.6-luna` como modelos reais, com os
nomes exibidos Astra, 5.6 Sol e 5.6 Luna ([catalogo da API](https://developers.openai.com/api/docs/models),
[catalogo do Codex](https://developers.openai.com/codex/models/)). A variante
`gpt-5.6-luna-fast`, entretanto, aparece no OMO; nao a encontrei no catalogo
oficial consultado. Ela deve ser tratada como variante/alias do harness ou do
provedor ate que o endpoint de modelos usado localmente confirme o contrario.

Nao encontrei uma configuracao publica universal que imponha exatamente “Sol
principal, Astra advisor e Luna executor”. As buscas literais encontraram os
tres IDs em catalogos, documentacao e algumas tabelas de roteamento, mas nao
provaram esse mapeamento exato como default. A tabela do aidevops e a evidencia
mais direta: Sol `medium` no tier thinking, Astra `low` como specialist_advisor
e Luna `low` no tier simple. O tier thinking nao fixa o modelo de toda sessao.
Outro exemplo proximo e o oh-my-openagent (antigo oh-my-opencode): ele separa o modelo da sessao dos
modelos dos agentes delegados, usa cadeias ordenadas com fallbacks e permite
misturar provedores. No snapshot atual, os papéis efetivos variam: Sol aparece
no principal recomendado e no `oracle`, Astra aparece no `plan-reviewer` e nas
categorias difíceis, e Luna aparece em exploracao/documentacao e tarefas
rapidas.

O padrao que se repete nos outros harnesses e:

```text
sessao principal/orquestrador
    -> agente de analise ou revisao, read-only, com modelo e effort proprios
    -> worker/executor com modelo mais barato ou mais rapido
```

Ha tres mecanismos concretos para integrar modelos e harnesses:

- PAL MCP e uma camada comunitaria de provedores e ferramentas que tambem
  oferece o `clink`, uma ponte para CLIs externos.
- `clink` executa CLIs reais como subprocessos, com roles, referencias de
  arquivos, isolamento de contexto e continuacao; nao e apenas um alias de
  modelo.
- O caminho oficial atual do Codex e o app-server ou o Codex SDK. O antigo
  `codex mcp-server` foi removido; o app-server usa seu proprio JSON-RPC e nao
  e um servidor MCP drop-in.

MCP continua sendo usado para ferramentas e dados. PAL documenta uma ponte
comunitaria para chamar outro CLI, enquanto o Codex oficial documenta
app-server/SDK para clientes e automacao. Nenhuma dessas fontes transforma MCP
em um protocolo universal para um modelo Claude chamar o Codex como modelo
advisor.

## Precos do catalogo da API

Precos Standard para contexto curto, em USD por 1 milhao de tokens de
entrada/saida, conforme o [catalogo de precos da API](https://developers.openai.com/api/docs/pricing/):

| Modelo | Entrada | Saida |
|---|---:|---:|
| `gpt-6-astra` | $10.00 | $50.00 |
| `gpt-5.6-sol` | $4.00 | $20.00 |
| `gpt-5.6-luna` | $0.20 | $1.20 |

Esta tabela omite deliberadamente cache, escrita de cache, contexto longo,
Batch, Flex, Fast mode, data residency, chamadas de ferramentas e precos de
planos/subscricoes. Os valores nao sao precos do Codex via ChatGPT; sao precos
listados para a API.

## Integracoes reais entre harnesses

### PAL MCP e `clink`

O projeto [`BeehiveInnovations/pal-mcp-server`](https://github.com/BeehiveInnovations/pal-mcp-server),
antigo Zen MCP, documenta uma camada MCP para varios provedores e uma ponte
CLI-to-CLI. A analise usa o commit
[`7afc7c1cc96e23992c8f105f960132c657883bb1`](https://github.com/BeehiveInnovations/pal-mcp-server/tree/7afc7c1cc96e23992c8f105f960132c657883bb1).

Instalacao documentada:

```bash
git clone https://github.com/BeehiveInnovations/pal-mcp-server.git
cd pal-mcp-server
./run-server.sh
```

Ou, para uma instalacao via `uvx`, o launcher documentado e:

```bash
uvx --from git+https://github.com/BeehiveInnovations/pal-mcp-server.git pal-mcp-server
```

Uso documentado do `clink`:

```text
clink with codex codereviewer to audit auth/ for OWASP Top 10 vulnerabilities
```

O codigo-fonte de [`tools/clink.py`](https://github.com/BeehiveInnovations/pal-mcp-server/blob/7afc7c1cc96e23992c8f105f960132c657883bb1/tools/clink.py)
registra o tool MCP `clink` com `prompt`, `cli_name`, `role`, referencias de
arquivos, imagens e `continuation_id`. O registry aceita configuracoes em
`conf/cli_clients/` e `~/.pal/cli_clients`; as roles distribuidas incluem
`default`, `planner` e `codereviewer`. [`clink/agents/base.py`](https://github.com/BeehiveInnovations/pal-mcp-server/blob/7afc7c1cc96e23992c8f105f960132c657883bb1/clink/agents/base.py)
confirma que o prompt e enviado a um subprocesso CLI por stdin e que os
argumentos vem do arquivo de configuracao.

O preset Codex em [`conf/cli_clients/codex.json`](https://github.com/BeehiveInnovations/pal-mcp-server/blob/7afc7c1cc96e23992c8f105f960132c657883bb1/conf/cli_clients/codex.json)
combina `codex exec` com `--json`,
`--dangerously-bypass-approvals-and-sandbox` e
`--enable web_search_request`. O preset tambem define `planner` e
`codereviewer`. O limite de resposta do tool e 20.000 caracteres; respostas
maiores sao resumidas por `<SUMMARY>` ou truncadas. Isso torna a integracao
concreta, mas introduz dois cuidados: exige que o CLI externo esteja instalado
e pode conceder escrita/execucao ampla se os flags distribuidos nao forem
removidos.

### Codex: app-server e SDK atuais

A antiga pagina [Agents SDK](https://developers.openai.com/codex/guides/agents-sdk/)
agora informa que `codex mcp-server` e `codex-mcp-server` foram removidos. A
integracao oficial atual e o
[Codex app-server](https://developers.openai.com/codex/app-server.md), que
oferece autenticacao, historico, aprovacoes e eventos de agente por JSON-RPC.
Ele nao e servidor MCP nem substituto drop-in de um cliente MCP. O Codex ainda
aceita servidores MCP externos, gerenciados por `codex mcp`.

Comandos documentados:

```bash
codex app-server --listen ws://127.0.0.1:4500
codex --remote ws://127.0.0.1:4500
pip install openai-codex
npm install @openai/codex-sdk
```

O app-server expoe `thread/start`, `thread/resume`, `thread/fork`,
`turn/start`, `turn/steer` e eventos incrementais; `model` e `effort` podem
ser escolhidos na thread/turn. Para jobs e CI, a propria documentacao recomenda
o SDK, que controla threads locais pelo app-server. WebSocket remoto exige TLS
e autenticacao; o transporte WebSocket/app-server esta marcado como
experimental e sem suporte para workloads de producao.

## Identidade dos modelos

O catalogo oficial da API descreve:

| ID | Nome | Uso documentado | Reasoning documentado |
|---|---|---|---|
| `gpt-6-astra` | GPT-6 Astra | Trabalho mais dificil de ponta a ponta | `low`, `medium`, `high`, `xhigh`, `max` |
| `gpt-5.6-sol` | GPT-5.6 Sol | Trabalho profissional complexo; alias `gpt-5.6` | `none`, `low`, `medium`, `high`, `xhigh`, `max` |
| `gpt-5.6-terra` | GPT-5.6 Terra | Equilibrio entre capacidade e custo | `none`, `low`, `medium`, `high`, `xhigh`, `max` |
| `gpt-5.6-luna` | GPT-5.6 Luna | Carga clara, repetitiva e sensivel a custo | `none`, `low`, `medium`, `high`, `xhigh`, `max` |

O Codex tambem oferece `Ultra`, mas a documentacao o descreve como um modo de
delegacao para subagents paralelos. `Ultra` nao deve ser confundido com um
valor comum de `reasoning_effort` da API ([modelos do Codex](https://developers.openai.com/codex/models/),
[subagents do Codex](https://developers.openai.com/codex/agent-configuration/subagents.md)).

## Exemplo 1: OMO no OpenCode

O repositorio atual e
[`code-yeongyu/oh-my-openagent`](https://github.com/code-yeongyu/oh-my-openagent),
renomeado a partir de `oh-my-opencode`. A analise abaixo usa a branch `dev` no
commit [`34b1b00baffe447040ccdb9014872128610cddef`](https://github.com/code-yeongyu/oh-my-openagent/tree/34b1b00baffe447040ccdb9014872128610cddef).

### Modelo principal e categorias

O guia declara que o profile escolhe somente o modelo da sessao principal; os
agentes delegados e categorias mantem suas proprias cadeias
([`agent-model-matching.md`](https://github.com/code-yeongyu/oh-my-openagent/blob/34b1b00baffe447040ccdb9014872128610cddef/docs/guide/agent-model-matching.md)).
As cadeias efetivas incluem:

```text
simple-work:
  openai|openai-codex/gpt-5.6-luna-fast (low)
  -> deepseek/deepseek-v4-flash
  -> anthropic|github-copilot/claude-haiku-4-5

deep-work:
  openai|openai-codex|github-copilot|opencode/gpt-6-astra (high)
  -> os mesmos provedores/gpt-5.6-sol (medium)
```

O profile pode ser selecionado assim:

```jsonc
{ "model_profile": "deep-work" }
```

Ou pode fixar um modelo literal, por exemplo
`"model_profile": "openai/gpt-5.6-sol"`. O documento diz que um valor
`provider/model` e um `--model` explicito vencem a selecao automatica.

### Agentes e executores

O arquivo de exemplo distribuido pelo projeto configura:

```jsonc
{
  "agents": {
    "explore": { "model": "openai/gpt-5.6-luna-fast", "reasoning": "low" },
    "librarian": { "model": "openai/gpt-5.6-luna-fast", "reasoning": "low" },
    "plan-consultant": { "model": "anthropic/claude-sonnet-4-6" },
    "plan-reviewer": { "model": "openai/gpt-6-astra", "reasoning": "high" }
  },
  "categories": {
    "quick": { "model": "openai/gpt-5.6-luna-fast", "reasoning": "low" },
    "deep": { "model": "openai/gpt-6-astra", "reasoning": "high" },
    "ultrabrain": { "model": "openai/gpt-6-astra", "reasoning": "max" }
  }
}
```

Fonte: [`docs/examples/default.jsonc`](https://github.com/code-yeongyu/oh-my-openagent/blob/34b1b00baffe447040ccdb9014872128610cddef/docs/examples/default.jsonc).
Essa e uma configuracao concreta de Luna para workers de busca, Astra para
revisao/trabalho dificil e Claude para consulta de planejamento. Ela nao
define Sol como principal por si mesma.

Os requisitos internos mostram a diferenca entre papel e modelo:

- `sisyphus` e o orquestrador caro; sua cadeia chega a `gpt-5.6-sol` em
  `medium`, depois de Claude e Kimi.
- `oracle` e explicitamente um agente `advisor`, read-only; sua primeira
  escolha OpenAI e `gpt-5.6-sol` em `xhigh`.
- `explore` e `librarian` priorizam `gpt-5.6-luna-fast` em `low`.
- `plan-reviewer` prioriza `gpt-6-astra` em `xhigh`/`high`, conforme o harness
  e o provedor.

Fontes: [`agent-model-requirements.ts`](https://github.com/code-yeongyu/oh-my-openagent/blob/34b1b00baffe447040ccdb9014872128610cddef/packages/model-core/src/agent-model-requirements.ts),
[`oracle.ts`](https://github.com/code-yeongyu/oh-my-openagent/blob/34b1b00baffe447040ccdb9014872128610cddef/packages/omo-opencode/src/agents/oracle.ts),
[`plan-reviewer.ts`](https://github.com/code-yeongyu/oh-my-openagent/blob/34b1b00baffe447040ccdb9014872128610cddef/packages/senpi-task/src/agents/builtin/plan-reviewer.ts).

O nome `oracle` e a funcao de advisor estao comprovados no codigo. O modelo
usado pelo advisor e resolvido pela cadeia; ele nao e fixado universalmente em
Astra.

### Roteamento entre provedores

O profile `deep-work` lista o mesmo modelo sob
`openai`, `openai-codex`, `github-copilot` e `opencode`. A primeira combinacao
que o registro local consegue servir vence. Isso permite usar o mesmo papel
com API OpenAI, login Codex, Copilot ou gateway, mas nao significa que Sol,
Astra e Luna sejam chamados simultaneamente nem que um provedor delegue para
outro ([`builtin-profiles.ts`](https://github.com/code-yeongyu/oh-my-openagent/blob/34b1b00baffe447040ccdb9014872128610cddef/packages/omo-senpi/src/components/model-profile/builtin-profiles.ts)).

## Exemplo 2: OMO atraves do adapter Codex

O pacote [`omo-codex`](https://github.com/code-yeongyu/oh-my-openagent/blob/34b1b00baffe447040ccdb9014872128610cddef/packages/omo-codex/README.md)
leva regras, MCPs, ultrawork, hooks e agentes TOML ao Codex CLI pelo sistema
nativo de plugins. O instalador copia os TOMLs para `~/.codex/agents/` e
compartilha a configuracao do host Codex.

No snapshot consultado, o README declara:

```text
root model: gpt-6-astra
model_context_window: 600000
model_reasoning_effort: high
plan_mode_reasoning_effort: xhigh
```

Os TOMLs atuais do pacote confirmam Astra nos papéis operacionais:

- `explorer`: `gpt-6-astra`, `low`, service tier `fast`;
- `librarian`: `gpt-6-astra`, `low`, service tier `fast`;
- `lazycodex-qa-executor`: `gpt-6-astra`, `high`;
- `lazycodex-worker-high`: `gpt-6-astra`, `medium`;
- `lazycodex-code-reviewer`: `gpt-6-astra`, `medium`.

Fontes: [`explorer.toml`](https://github.com/code-yeongyu/oh-my-openagent/blob/34b1b00baffe447040ccdb9014872128610cddef/packages/omo-codex/plugin/components/ultrawork/agents/explorer.toml),
[`librarian.toml`](https://github.com/code-yeongyu/oh-my-openagent/blob/34b1b00baffe447040ccdb9014872128610cddef/packages/omo-codex/plugin/components/ultrawork/agents/librarian.toml),
[`lazycodex-qa-executor.toml`](https://github.com/code-yeongyu/oh-my-openagent/blob/34b1b00baffe447040ccdb9014872128610cddef/packages/omo-codex/plugin/components/ultrawork/agents/lazycodex-qa-executor.toml),
[`lazycodex-worker-high.toml`](https://github.com/code-yeongyu/oh-my-openagent/blob/34b1b00baffe447040ccdb9014872128610cddef/packages/omo-codex/plugin/components/ultrawork/agents/lazycodex-worker-high.toml).

O arquivo de migracao registra Sol e Luna como valores anteriores em varios
papéis e Astra como o valor atual. Isso e historico de upgrade, nao evidencia
de que o adapter atual rode Luna como executor
([`managed-agent-reasoning-defaults.ts`](https://github.com/code-yeongyu/oh-my-openagent/blob/34b1b00baffe447040ccdb9014872128610cddef/packages/omo-codex/src/install/managed-agent-reasoning-defaults.ts)).

Este e o exemplo mais forte de uma mesma camada de orquestracao atravessando
harnesses: OMO tem uma edicao OpenCode e uma edicao Codex. Ainda assim, os
defaults nao sao identicos; cada adapter possui catalogo e arquivos de agentes
proprios.

## Exemplo 3: subagents nativos do Codex

A documentacao oficial do Codex aceita agentes em `.codex/agents/*.toml` ou
`~/.codex/agents/`. Cada arquivo pode definir `model` e
`model_reasoning_effort`, alem de instrucoes, sandbox e MCP. A precedencia
documentada e: valor do spawn, defaults de `[agents]` e valor do agente pai.

O exemplo oficial de revisao distribui tarefas entre tres modelos:

```toml
# .codex/agents/pr-explorer.toml
name = "pr_explorer"
model = "gpt-5.3-codex-spark"
model_reasoning_effort = "medium"
sandbox_mode = "read-only"

# .codex/agents/reviewer.toml
name = "reviewer"
model = "gpt-5.6-terra"
model_reasoning_effort = "high"
sandbox_mode = "read-only"

# .codex/agents/docs-researcher.toml
name = "docs_researcher"
model = "gpt-5.6-luna"
model_reasoning_effort = "medium"

[mcp_servers.openaiDeveloperDocs]
url = "https://developers.openai.com/mcp"
```

Fonte: [`subagents.md`](https://developers.openai.com/codex/agent-configuration/subagents.md).
Este e um caso verificavel de modelo forte para revisao, modelo rapido para
documentacao e um terceiro agente de exploracao. O MCP fornece documentacao ao
agente; nao troca o modelo do agente.

O Codex CLI, desktop app e extensao IDE compartilham o `config.toml` e a
configuracao MCP ([documentacao MCP](https://developers.openai.com/codex/extend/mcp.md)).
Isso e uma integracao entre superficies do Codex. Para Claude Code invocar um
CLI externo, PAL/`clink` oferece a ponte comunitaria documentada; para construir
um cliente Codex proprio, o caminho oficial e app-server/SDK, nao um servidor MCP
que represente o Codex como modelo consultor.

## Exemplo 4: subagents e teams do Claude Code

Claude Code permite arquivos Markdown em `.claude/agents/` ou
`~/.claude/agents/`. O campo `model` aceita alias (`sonnet`, `opus`, `haiku`,
`fable`), ID completo ou `inherit`; `effort` aceita `low`, `medium`, `high`,
`xhigh` e `max`. A definicao tambem pode limitar ferramentas e fornecer
`mcpServers` ao subagent ([subagents](https://code.claude.com/docs/en/sub-agents)).

Exemplo minimo documentado:

```markdown
---
name: code-improver
description: Scans files and suggests improvements
tools: Read, Grep, Glob
model: sonnet
---

You are a code improvement specialist.
```

A resolucao do modelo segue, nessa ordem, o modelo passado na invocacao, o
campo do agente, `CLAUDE_CODE_SUBAGENT_MODEL` e o modelo da conversa principal.
Agent teams adicionam um lead e sessoes independentes; podem escolher um
modelo por teammate, mas continuam sendo sessoes Claude Code
([agent teams](https://code.claude.com/docs/en/agent-teams)).

O MCP do Claude Code permite chamar ferramentas externas
([MCP](https://code.claude.com/docs/en/mcp)). PAL/`clink` usa esse mecanismo para
executar outro CLI e devolver sua resposta. O modelo externo e configurado no
CLI ou na ponte, separadamente do campo `model` dos subagents Claude Code.

## Exemplo 5: Aider architect/editor

O Aider documenta um fluxo de dois modelos chamado `architect`:

1. O modelo principal recebe o pedido e propoe a solucao arquitetural.
2. O editor recebe a proposta e produz instrucoes de edicao concretas.

O modelo principal e escolhido por `--model`; o segundo por
`--editor-model`. O Aider tambem expoe `--reasoning-effort`, e a documentacao
lista suporte a modelos OpenAI, Anthropic e outros provedores.

Exemplo de interface real:

```bash
aider --model <architect-model> --editor-model <editor-model> --architect
```

Como combinacao concreta, a propria pagina de modos cita `o1` como architect
e `gpt-4o` ou Sonnet como editor.

Fontes: [chat modes](https://aider.chat/docs/usage/modes.html),
[options reference](https://aider.chat/docs/config/options.html),
[OpenAI](https://aider.chat/docs/llms/openai.html).

Esse fluxo comprova a separacao advisor/executor em dois requests, inclusive
com modelos diferentes. Ele nao cria uma malha geral de subagents nem atribui
os nomes Sol/Astra/Luna a esses papéis.

## Configuracao, reasoning e fallbacks

Os harnesses usam chaves diferentes para a mesma ideia:

| Harness | Modelo por papel | Reasoning | Delegacao |
|---|---|---|---|
| OMO/OpenCode | `provider/model` em `agents`, `categories` e profiles | `reasoning`/`variant`; OpenCode passa opcoes do provedor | `task`, agentes curados e categorias |
| OMO/Codex | `model` em TOML e catalogo gerenciado | `model_reasoning_effort` | agentes nativos/plugins Codex |
| Codex nativo | `model` em `.codex/agents/*.toml` | `model_reasoning_effort` | spawn de subagents; `Ultra` pode paralelizar |
| Claude Code | `model` no frontmatter ou na invocacao | `effort` | Agent tool; teams experimentais |
| Aider | `--model` e `--editor-model` | `--reasoning-effort` | pipeline architect -> editor |

Em OMO, uma cadeia e fallback de disponibilidade: a primeira entrada que o
registro consegue servir vence. Em Codex e Claude Code, a configuracao explicita
do agente vence o default do pai conforme as regras de precedencia de cada
produto. Portanto, “modelo recomendado”, “modelo primario” e “primeiro fallback”
sao estados diferentes e devem ser registrados separadamente.

## Resposta para a combinacao investigada

O mapeamento mais defensavel, com as fontes atuais, e:

| Papel informal | Evidencia mais proxima | Observacao |
|---|---|---|
| Sol como principal | OMO recomenda Sol como configuracao GPT e oferece `deep-work` Astra -> Sol; Codex lista Sol como modelo principal | Nao e o default unico: OMO `capable` pode iniciar em Claude Fable, e Codex pode iniciar em Astra |
| Astra como advisor/reviewer | OMO usa Astra em `plan-reviewer`, `deep`, `ultrabrain` e nos executores atuais do adapter Codex | O agente chamado `oracle`, que e advisor, prioriza Sol em `xhigh` no snapshot analisado |
| Luna como executor | OMO usa Luna-fast em `quick`, `explore` e `librarian`; Codex oficial usa Luna em exemplo de pesquisa | Os executores Codex atuais do OMO usam Astra; `luna-fast` nao foi confirmada no catalogo OpenAI |

A tabela do aidevops abaixo documenta a separacao mais proxima da pergunta.
As fontes nao permitem atribuir a origem da frase nem medir sua popularidade.

## Buscas publicas pelo trio

Foram feitas buscas literais sem tentar medir prevalencia ou adocao:

```bash
gh search code gpt-5.6-sol gpt-6-astra gpt-5.6-luna --match file --limit 100
gh search code gpt-5.6-sol gpt-6-astra gpt-5.6-luna advisor --match file --limit 50
gh search issues gpt-5.6-sol gpt-6-astra gpt-5.6-luna in:title,body --limit 100
```

Os resultados de codigo foram majoritariamente catalogos, documentacao e
tabelas de compatibilidade. Alguns resultados relevantes foram:

- [`marcusquinn/aidevops/.agents/configs/model-routing-table.json`](https://github.com/marcusquinn/aidevops/blob/58edd9a619912dceaeafc63bb3dae37e6df64cf6/.agents/configs/model-routing-table.json)
  contem Luna `low` no tier simples, Terra `low` no tier standard, Sol `medium`
  no tier de raciocinio e Astra `low` como `specialist_advisor`. O advisor recebe
  somente pedidos explicitos e delimitados; o pai mantem a execucao e valida o
  resultado. A escalada de capacidade e `simple -> standard -> thinking`.
  Astra fica fora dessa escalada e dos fallbacks de disponibilidade. E uma
  politica proxima, mas nao fixa Sol como principal de toda sessao.
- [`robertphyatt/ironclaude/advisor-fallback`](https://github.com/robertphyatt/ironclaude/blob/f61d0a2c3c9d5a759829d3b598137e0f0fe37632/worker/skills/advisor-fallback/SKILL.md)
  documenta a cadeia `gpt-5.6-luna -> gpt-5.6-terra -> gpt-5.6-sol ->
  gpt-6-astra` para revisao escalonada; nao e o trio fixo solicitado.
- [`MadAppGang/claudish#238`](https://github.com/MadAppGang/claudish/issues/238)
  testa os tres modelos no mesmo estudo de cache, mas nao descreve roteamento
  de papeis.
- Resultados em `openinterpreter`, `openclaw` e no proprio OMO mostram os tres
  IDs juntos em catalogos ou documentacao; isso nao prova uma politica de
  principal/advisor/executor.

A busca web exata tambem retornou resultados genericos e nenhum guia primario
com o mapeamento completo. Portanto, os resultados confirmam co-ocorrencia
publica dos IDs e configuracoes proximas, mas nao um default universal. Nao foi
calculada prevalencia.

## Proposta recomendada (nao default observado)

Uma politica operacional coerente com custo e funcao, para configurar
explicitamente quando o harness permitir, seria:

| Papel | Modelo | Reasoning sugerido | Motivo |
|---|---|---|---|
| Principal/orquestrador | `gpt-5.6-sol` | `medium`; `high` em tarefas de alto risco | Trabalho profissional complexo sem pagar Astra em toda sessao |
| Advisor/reviewer | `gpt-6-astra` | `high`; escalar para `xhigh` quando necessario | Revisao independente e decisoes dificeis |
| Executor | `gpt-5.6-luna` | `medium`; `low` para exploracao | Transformacoes claras, busca e tarefas sensiveis a custo |

Essa e uma recomendacao de alocacao, nao um default observado no OMO, PAL,
Codex ou Claude Code. Fallbacks por indisponibilidade devem ser configurados
separadamente e nao devem ser confundidos com a atribuicao primaria.

## Caveats

- OMO foi auditado na branch `dev`, nao em uma release estavel; os defaults
  podem mudar.
- Os timestamps UTC dos commits consultados podem aparecer como 13/09/2026,
  embora a pesquisa local tenha sido registrada em 12/09/2026.
- IDs oficiais do modelo nao garantem disponibilidade na conta, no provider ou
  no cliente. O Codex documenta disponibilidade dependente de rollout, login e
  superficie.
- PAL e uma integracao comunitaria: seus presets `clink` executam CLIs externos
  com flags de permissao amplos por padrao; remova esses flags ou use um
  workspace confiavel.
- O antigo Codex MCP server foi removido. App-server e SDK sao os caminhos
  oficiais atuais; app-server nao e um cliente MCP drop-in e seu transporte
  WebSocket continua experimental.
- Nao foi encontrada uma feature nativa do Claude Code que atribua Codex como
  modelo advisor. PAL fornece uma ponte comunitaria documentada, enquanto uma
  ponte propria exigiria manter um servidor/adapter adicional.
- As buscas publicas foram amostrais e orientadas a encontrar configuracoes;
  nao constituem medicao de prevalencia, popularidade ou uso real.

## Fontes primarias consultadas

- [OpenAI API model catalog](https://developers.openai.com/api/docs/models)
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing/)
- [Codex model catalog](https://developers.openai.com/codex/models/)
- [Codex subagents](https://developers.openai.com/codex/agent-configuration/subagents.md)
- [Codex MCP](https://developers.openai.com/codex/extend/mcp.md)
- [Codex app-server](https://developers.openai.com/codex/app-server.md)
- [Codex SDK](https://developers.openai.com/codex/codex-sdk.md)
- [Codex Agents SDK removal](https://developers.openai.com/codex/guides/agents-sdk/)
- [PAL MCP](https://github.com/BeehiveInnovations/pal-mcp-server)
- [PAL getting started](https://github.com/BeehiveInnovations/pal-mcp-server/blob/7afc7c1cc96e23992c8f105f960132c657883bb1/docs/getting-started.md)
- [PAL `clink`](https://github.com/BeehiveInnovations/pal-mcp-server/blob/7afc7c1cc96e23992c8f105f960132c657883bb1/docs/tools/clink.md)
- [PAL name change](https://github.com/BeehiveInnovations/pal-mcp-server/blob/7afc7c1cc96e23992c8f105f960132c657883bb1/docs/name-change.md)
- [OpenCode agents](https://opencode.ai/docs/agents/)
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Aider chat modes](https://aider.chat/docs/usage/modes.html)
- [Aider options](https://aider.chat/docs/config/options.html)
