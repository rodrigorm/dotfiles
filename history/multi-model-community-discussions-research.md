# Relatos publicos de uso de Sol, Astra e Luna

Pesquisa realizada em 13 de setembro de 2026. O objetivo foi encontrar o que
pessoas realmente relataram sobre `gpt-5.6-sol`, `gpt-6-astra` e
`gpt-5.6-luna`: papeis, niveis de effort, qualidade, autonomia, custo,
latencia, falhas e trade-offs.

Este documento registra relatos de primeira mao. Nao e um guia de configuracao,
nao mede popularidade e nao transforma reclamacoes em fatos sobre os pesos dos
modelos. O arquivo anterior
[`multi-model-agent-configurations-research.md`](multi-model-agent-configurations-research.md)
nao foi usado como evidencia de experiencia de usuario.

## Resultado executivo

- Nao foi encontrada uma fonte publica de usuario que prove o mapeamento
  universal `Sol = principal`, `Astra = advisor` e `Luna = executor`.
- O relato mais explicito de alocacao usa Astra como orquestrador e para escrita
  ou gates de revisao, e Sol para codificacao e revisao em `xhigh`. O autor diz
  que usar Astra para tudo e caro e talvez desnecessario.
- Relatos de usuarios descrevem Astra como muito capaz em tarefas dificeis,
  mas tambem associam seu uso a supervisao maior, consumo de quota, loops,
  bloqueios e variacao por conta, cliente ou rota.
- O melhor relato comparativo entre modelos encontrou Sol, em `Extra High`,
  fazendo uma revisao causal que Astra, em `Max`, nao fez. Isso e uma
  experiencia pareada, nao um benchmark controlado.
- Luna aparece como modelo de worker/verificador e em testes com effort alto.
  Um benchmark relata que a qualidade dos runs concluidos permaneceu estavel,
  enquanto tempo e custo pioraram nas faixas altas apos uma mudanca de CLI.
- A amostra e enviesada: nove registros sao issues do GitHub, onde problemas
  sao naturalmente sobrerrepresentados, e um e um post pessoal. Nao ha base
  para estimar prevalencia.

## Metodo e limites

Foram priorizados posts diretamente acessiveis em issues, comentarios e blog
pessoal. Para cada fonte foram conservados autor, data, URL, modelo, effort e
ambiente quando o autor os informou. Parafrases sao identificadas como tais;
frases curtas entre aspas permanecem no idioma original.

As buscas cobriram os IDs completos, nomes curtos, `advisor`, `orchestrator`,
`subagent`, `worker`, `medium`, `high` e `xhigh`. Catalogos, documentacao,
arquivos de configuracao, snippets de buscador e comentarios de bots foram
descartados como evidencia de experiencia.

Reddit ficou atras de login ou desafio JavaScript; a API de busca alternativa
retornou resultados ruidosos. As buscas exatas no Hacker News nao retornaram
resultados. Google retornou `429` e Brave retornou CAPTCHA. Nenhum thread ou
post nao verificado foi incluido abaixo.

## Relatos selecionados

### 1. Astra para orquestracao; Sol para codigo e revisao

**Fonte:** Baochun Li, 5 de setembro de 2026, ["How I use GPT 6 Astra"](https://baochun.org/2026-09-05/).

**Contexto declarado:** Codex; o autor descreve seu proprio prompt de uso.

- O agente orquestrador usa `gpt-6-astra` em `high`.
- Subagentes de escrita, inclusive partes de artigo ou plano, usam Astra em
  `high`.
- Subagentes de codigo e revisao usam `gpt-5.6-sol` em `xhigh`.
- Gates de revisao de fase usam Astra em `medium`.
- O prompt exige subagentes novos por tarefa, ciclo implementacao-revisao,
  TDD e proibe subagentes aninhados.

O motivo explicitado e pratico: **"I find using Astra for everything a bit too
expensive and perhaps unnecessary."** O post e evidencia de uma politica de
alocacao realmente usada por uma pessoa, nao de que essa politica seja um
default da ferramenta. Tambem nao apresenta metricas de qualidade ou uma
comparacao de resultados. Luna nao aparece nesse relato.

### 2. Sol encontrou a causa; Astra produziu mais diagnostico, mas ficou no enquadramento

**Fonte:** FrankRomanos, 7 de setembro de 2026, ["GPT-6 Astra regresses exploratory problem formation vs GPT-5.2/5.5/5.6 Sol in complex engineering work"](https://github.com/openai/codex/issues/43485).

**Contexto declarado:** usuario pesado de Codex, trabalhando em um RPG Unity
grande e de longa duracao. A comparacao principal foi entre Astra `Max` e Sol
`Extra High` no mesmo problema de causa-raiz.

O autor diz que Astra foi **"extremely capable as an executor"**, rapido,
preciso e disciplinado quando o problema ja esta bem definido. No caso
comparado, Astra recebeu mais interacao e recursos de investigacao, criou
instrumentacao util e encontrou defeitos secundarios reais, mas continuou
majoritariamente dentro da hipotese inicial do usuario.

Sol recebeu pouca orientacao adicional. Ao notar artefatos diagnosticos
produzidos pela investigacao paralela de Astra, identificou uma divergencia de
identidade entre eventos `Started` e `Ended`, inferiu que um
`PresentationOperator` antigo nunca era liberado e ligou varios sintomas a
essa causa unica. O autor aplicou a correcao e relatou que o conjunto de
sintomas desapareceu como previsto ([validacao posterior](https://github.com/openai/codex/issues/43485#issuecomment-5572353433)).

A leitura do autor e que mais reasoning nao resolveu a escolha de ramo: Astra
teve `Max`, mais interacao e mais instrumentacao; Sol, em `Extra High`, fez a
revisao de hipotese decisiva. A comparacao nao e perfeitamente controlada,
porque os dois caminhos nao receberam exatamente as mesmas interacoes.

### 3. Melhor pico de raciocinio, pior previsibilidade de entrega

**Fonte:** maikolb, 5 de setembro de 2026, ["GPT-5.6 Sol and GPT-6 Astra in Codex: higher intelligence, lower autonomous completion and operational reliability"](https://github.com/openai/codex/issues/42937).

**Contexto declarado:** Codex Desktop no Windows 11, assinatura ChatGPT Pro,
uso de tarefas longas de codigo, pesquisa, debugging, edicao de repositorio e
execucao com ferramentas. O autor usou Sol e depois Astra no Codex; nao
informou effort comparavel para a observacao principal.

O relato separa capacidade maxima de entrega aceita. Segundo o autor, os dois
modelos podem produzir trabalho excelente, e Astra pode ser mais capaz em
analise dificil. Ainda assim, em sua rotina:

- tarefas terminam em analise, planejamento, implementacao parcial ou alegacao
  prematura de conclusao;
- o usuario precisa pedir `continue`, `check`, `fix` ou `finish`;
- restricoes explicitas sao esquecidas ou substituidas por uma interpretacao do
  modelo;
- o custo pratico passa a incluir supervisao, correcao e verificacao;
- Astra frequentemente exibe o mesmo padrao de forma mais intensa que Sol.

A formula resumida pelo autor e **"Intelligence goes up while operational
reliability goes down."** Ele ressalva que isso e uma observacao de workflow,
nao um benchmark universal, e que ha tarefas concluidas muito bem. A parte
sobre conversas comuns do ChatGPT foi mantida fora desta sintese, pois nao e
experiencia de Codex com os papeis investigados.

### 4. Luna em effort alto: qualidade concluida estavel, tempo e custo em regressao

**Fonte:** Pawel Huryn (`phuryn`), 28 de agosto de 2026, ["Luna: radical performance regression at high effort in a newer Codex CLI"](https://github.com/openai/codex/issues/41318).

**Contexto declarado:** benchmark com 105 bugs plantados em dois repositorios
de producao, usando `codex exec`, uma sessao agentica longa por repositorio,
Windows e autenticacao de conta ChatGPT. O autor testou Luna de `low` a `max`.

Comparando uma CLI antiga com uma nova:

- Luna `max` na CLI antiga terminou em cerca de 85 minutos, custo estimado de
  `$1.80` e 64M de tokens de entrada faturados.
- Luna `xhigh` na CLI nova levou cerca de 135 minutos, `$2.50` e 83M de
  tokens; portanto uma faixa abaixo de `max` ficou mais cara e lenta que o
  `max` antigo.
- Luna `max` na CLI nova rodou 3h23 em uma perna, gerou log de 54 MB, entrou em
  reprocessamento de contexto e nao convergiu; o autor interrompeu.
- Nos runs concluidos, a corretude nao piorou. A taxa de bugs corrigidos foi
  `4, 9, 13, 23, 33` de 105 para `low`, `medium`, `high`, `xhigh` e `max`.
- O autor diz que o problema ficou concentrado nas faixas altas; `low` e
  `medium` eram curtos o bastante para nao atingir o limite de compactacao.

O proprio autor atribui a observacao principalmente a interacao entre CLI,
compactacao e contexto, nao necessariamente a uma mudanca de capacidade de
Luna. Um comentario de `NeoHuncho` relata um loop semelhante em Luna `max`,
mas isso continua sendo corroboracao anedotica no mesmo issue
([comentario](https://github.com/openai/codex/issues/41318#issuecomment-5490710608)).

### 5. Luna como verificador/worker: disponivel no pai, rejeitada no filho

**Fonte:** vanessa49, 20 de agosto de 2026, ["spawn_agent rejects gpt-5.6-luna while parent runtime and another project can use Luna"](https://github.com/openai/codex/issues/39714).

**Contexto declarado:** Codex Desktop 0.147.0-alpha.6.6 no Windows 11.

O autor conseguiu executar um probe direto com `gpt-5.6-luna`, mas o caminho
`spawn_agent` rejeitou o mesmo ID como desconhecido e ofereceu apenas Sol e
Terra. Em outro projeto, o papel `luna_verifier` funcionava com:

```text
model: gpt-5.6-luna
model_reasoning_effort: medium
sandbox_mode: read-only
```

Nesse projeto anterior o filho iniciou e devolveu a verificacao; no projeto
atual, com o mesmo schema, o despacho falhou antes da execucao. Este e um
relato direto de Luna sendo escolhida como papel de verificacao/executor, mas
nao mede a qualidade do trabalho de Luna. Ele mostra uma diferenca entre
disponibilidade no runtime principal e disponibilidade no caminho de filhos.

### 6. Sol `high` vira `low` ao iniciar Voice

**Fonte:** mt-rody, 30 de agosto de 2026, ["[Windows][Voice Chat] Starting voice silently resets GPT-5.6 Sol High to Low"](https://github.com/openai/codex/issues/41727).

**Contexto declarado:** Codex Desktop no Windows, runtime 0.151.0-alpha.7.2.
O default do usuario era:

```toml
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
```

Ao iniciar Realtime Voice, o novo task era registrado como Sol `low`. O autor
verificou eventos `thread_settings_applied`, nao apenas o texto do seletor, e
observou o mesmo reset em tres sessoes. Em uma sessao mais longa, `high` voltou
a `low` e precisou ser restaurado manualmente.

O relato nao julga a qualidade de Sol. Ele e evidencia de que o effort
selecionado pode nao ser o effort efetivo, algo que torna comparacoes de
qualidade entre `high`, `low` e outros modos menos confiaveis quando o cliente
nao registra o valor aplicado.

### 7. Percepcao de degradacao de Sol e necessidade de trocar para Astra

**Fonte principal:** montella1507, 9 de setembro de 2026, ["GPT-5.6 SOL degraded when GPT-6 got released"](https://github.com/openai/codex/issues/44190).

**Contexto declarado:** Codex App 26.903.61454, plano Pro 20x, macOS. O autor
relata que, nos dias anteriores, Sol ficou muito mais lento, parava sem motivo,
alucinava mais e entregava cerca de 10% da qualidade percebida tres ou quatro
dias antes. Ele associa temporalmente o inicio ao lancamento de GPT-6, mas nao
apresenta teste controlado nem effort.

No mesmo thread, berasamas relata uma percepcao semelhante: precisou usar Astra
para a mesma tarefa que Sol havia resolvido bem, mas Astra consumiu muito mais
tokens ([comentario de 12 de setembro](https://github.com/openai/codex/issues/44190#issuecomment-5642746806)).
Isso e uma conversa com duas experiencias pessoais, nao uma medicao
independente de degradacao nem prova de causalidade pelo lancamento.

### 8. Astra antes e depois de throttling: mesma selecao, saida menor

**Fonte:** sun-jingtao, 11 de setembro de 2026, ["GPT-6 Astra output quality dropped by half after account-level capacity throttling"](https://github.com/openai/codex/issues/44851).

**Contexto declarado:** Codex Desktop e CLI 0.153.4 no macOS, conta ChatGPT
Pro. O autor comparou prompts e effort `high`/`ultra` antes e depois de a conta
receber erros de capacidade.

O exemplo principal foi uma animacao SVG de um pelicano em bicicleta:

- Antes, Astra `high` gerou 7.621 tokens de saida, 564 de reasoning, arquivo de
  14,4 KB, abriu o resultado no navegador e refatorou.
- Depois, com prompt identico e `high`, gerou 3.758 tokens de saida, 395 de
  reasoning, arquivo de 6,8 KB e nao fez a verificacao no navegador.
- Antes, Astra `ultra` gerou 14.124 tokens de saida e arquivo de 24,8 KB.
- Depois, `ultra` gerou 8.909 tokens e arquivo de 7,6 KB.

O autor interpreta a diferenca como queda de profundidade e qualidade apos o
throttling, mantendo modelo, effort e binario solicitados. As ressalvas sao
importantes: duas execucoes anteriores contra seis posteriores, tarefa SVG
ruidosa e impossibilidade de ver qual modelo realmente serviu cada request.
Portanto o relato mostra uma experiencia de conta/servico, nao isola uma
mudanca nos pesos de Astra.

### 9. Sol nativo mais lento que o mesmo Sol via OpenRouter

**Fonte:** Statuspm, 8 de setembro de 2026, ["2026.8.2: GPT-5.6 Sol via native Codex is materially slower than the same model via OpenRouter"](https://github.com/openclaw/openclaw/issues/141820).

**Contexto declarado:** OpenClaw 2026.8.2, Ubuntu, `openai/gpt-5.6-sol`, uma
rota nativa Codex/OAuth app-server e uma rota OpenRouter. O autor executou a
mesma tarefa limitada de tres verificacoes independentes.

- Rota nativa: 40,889 segundos, cinco chamadas de ferramenta, uma chamada de
  falha/recuperacao; resultado correto.
- OpenRouter: 24,395 segundos, tres de tres chamadas, nenhuma falha; resultado
  correto.

Na canary do autor, o mesmo Sol ficou aproximadamente 40% mais rapido via
OpenRouter. Isso e evidencia de trade-off de rota, runtime e recuperacao, nao
de que um provedor tenha um Sol intrinsecamente melhor. A revisao automatica do
projeto ressalta que as trajetorias de ferramentas diferiram e que ainda nao
havia reproducao de alta confianca na versao atual
([revisao](https://github.com/openclaw/openclaw/issues/141820#issuecomment-5578853818)).

### 10. Astra Ultra: capacidade valorizada, quota considerada insustentavel

**Fonte:** GGBondBlueWhale, 5 de setembro de 2026, ["GPT-6 Astra Ultra consumes ~30% of a 20x Pro weekly quota during a ~1-hour task"](https://github.com/openai/codex/issues/43029).

**Contexto declarado:** Codex no macOS, Pro 20x, Astra `Ultra`, tarefa SwiftUI
de cerca de uma hora com implementacao, compilacao, testes e tres subagentes.

O autor diz apreciar a capacidade de Astra, mas observou cerca de 30% da quota
semanal consumida por uma unica tarefa. Ele nao sabe separar atribuicao do
modelo, overhead de agentes, retries ou contabilidade, e pede verificacao dos
dados em vez de afirmar uma causa.

O mesmo autor publicou depois uma medicao relacionada: dois Goals com Astra
`Ultra`, totalizando cerca de 80 minutos, consumiram aproximadamente 50% da
quota semanal ([issue posterior](https://github.com/openai/codex/issues/43967)).
As duas observacoes sao do mesmo usuario e nao devem ser contadas como
replicacoes independentes. O ponto de experiencia e o trade-off: a capacidade
e valorizada, mas o custo de uso continuo limita a sustentabilidade pratica.

## O que os relatos permitem dizer sobre papeis

| Papel investigado | O que aparece em relatos diretos | O que nao foi demonstrado |
|---|---|---|
| Principal/orquestrador | Baochun diz usar Astra para orquestracao; Frank e maikolb relatam Sol e Astra em sessoes principais de Codex | Que Sol seja o principal universal ou que Astra seja sempre orquestrador |
| Advisor/revisor | Baochun usa Astra em escrita e gates de revisao; Frank compara investigacao de Astra com diagnostico de Sol | Que usuarios chamem Astra de `advisor` com uma semantica comum entre harnesses |
| Executor/worker | Luna aparece como `luna_verifier` em `medium`/read-only e nos runs agenticos de Pawel; Baochun usa Sol para codigo/revisao | Que Luna seja sempre o executor, ou que seu caminho de filho esteja disponivel em toda conta/cliente |

Os relatos mostram escolhas locais de papel. Eles nao definem uma arquitetura
universal. Em especial, o relato de `luna_verifier` e sobre disponibilidade e
despacho; nao deve ser convertido em afirmacao de qualidade do executor.

## Variantes e effort

- **Sol:** aparece em `high`, `xhigh` e `Extra High`; mt-rody documenta `high`
  configurado sendo aplicado como `low` em Voice. Nao se deve comparar
  resultados sem confirmar o effort efetivo.
- **Astra:** aparece em `medium`, `high`, `Max` e `Ultra`. O relato de Baochun
  usa `high` para escrita/orquestracao e `medium` para gate; Frank compara
  `Max` com Sol `Extra High`; sun-jingtao compara `high` e `ultra` antes e
  depois de throttling.
- **Luna:** aparece em `medium` como verificador, e em `low`, `medium`, `high`,
  `xhigh` e `max` no benchmark de Pawel. Nesse benchmark, o efeito observado
  nas faixas altas foi sobretudo tempo, custo e convergencia.
- Os autores usam nomes de produto como `Max`, `Ultra` e `Extra High` do modo
  como aparecem em suas ferramentas. Este documento nao presume que sejam a
  mesma escala tecnica entre clientes.

## Padroes e tensoes

### Experiencias favoraveis

- Astra e descrita como extremamente capaz, rapida e precisa quando o problema
  ja esta bem formulado.
- Sol e descrito como capaz de produzir bons resultados e, em um caso, de
  revisar uma hipotese causal enganosa.
- Luna concluiu runs do benchmark com qualidade/corretude preservada apesar do
  problema de custo e latencia nas faixas altas.
- O mesmo modelo Sol produziu resultados corretos em ambas as rotas do teste do
  OpenClaw; a diferenca observada foi operacional.

### Experiencias desfavoraveis

- Astra: loops, supervisao, bloqueios, quota alta e possivel variacao apos
  throttling.
- Sol: queixas de degradacao, menor autonomia, capacidade/latencia e effort
  sendo sobrescrito em uma superficie.
- Luna: rejeicao como subagent em alguns caminhos e nao convergencia em effort
  alto sob uma versao especifica da CLI.

### Tensoes que nao devem ser apagadas

- Maior capacidade maxima nao implicou automaticamente melhor descoberta da
  causa-raiz ou entrega autonoma.
- Mais effort pode aumentar tempo e custo sem aumentar a qualidade de um run
  concluido.
- Um resultado pior pode pertencer ao cliente, runtime, rota, throttling,
  compactacao ou contabilidade, e nao ao modelo isolado.
- Relatos positivos e negativos coexistem. A amostra nao permite escolher uma
  narrativa unica sobre cada modelo.

## Fontes excluidas e limites de interpretacao

- Nenhum resultado de documentacao oficial, catalogo ou arquivo de configuracao
  foi contado como experiencia de usuario.
- Nenhum dos URLs de Reddit tentados foi incluido, porque o conteudo do post ou
  comentario nao ficou acessivel para verificacao direta.
- Nenhum snippet de buscador foi usado como citacao.
- Issues de bot, issues que apenas pedem suporte de modelo e tabelas de
  compatibilidade foram excluidos.
- A maioria das fontes vem do tracker do Codex e portanto tem vies de selecao
  para bugs e degradacoes.
- Varios relatos misturam modelo com cliente, app-server, provider, quota ou
  versao da CLI. As ressalvas de cada item sao parte da evidencia, nao detalhes
  descartaveis.
- Nao ha dados suficientes para afirmar que um modelo e universalmente melhor,
  que um lancamento causou degradacao, ou que o trio de papeis e um padrao de
  comunidade.

## Conclusao

O material publico verificavel sustenta uma conclusao mais estreita: usuarios
estao experimentando diferentes alocacoes de Sol, Astra e Luna por papel e
effort, mas os resultados dependem fortemente de tarefa, cliente, rota,
throttling e versao do harness. Astra recebe elogios por capacidade maxima e
tambem queixas de supervisao e custo. Sol aparece tanto como principal eficaz
quanto como modelo percebido como degradado, dependendo do contexto. Luna e
usada como worker/verificador em alguns relatos, mas sua disponibilidade no
caminho de subagents e inconsistente.

Nao foi encontrada evidencia primaria suficiente para transformar
`Sol-principal / Astra-advisor / Luna-executor` em um fato geral. O que existe
e um conjunto pequeno, atribuivel e heterogeneo de experiencias, com varias
hipoteses de causa ainda abertas.
