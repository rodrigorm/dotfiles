# OpenCode TUI e múltiplos workdirs na versão 1.18.17

Pesquisa realizada em 12 de agosto de 2026 para decidir se o argumento de diretório do wrapper `oc` pode ser removido sem limitar o uso remoto pela TUI.

Foram consultados somente a release, a documentação e o código-fonte oficiais do OpenCode. A auditoria foi feita na tag [`v1.18.17`](https://github.com/anomalyco/opencode/releases/tag/v1.18.17), commit imutável [`02546dfc2e4515a4f90aaf9ceb3890df2ac2b479`](https://github.com/anomalyco/opencode/tree/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479). A instalação local também foi verificada: `opencode --version` retornou `1.18.17`, e `opencode attach --help` apresentou a opção `--dir` como “directory to run in”.

## Conclusão

**A TUI não possui um seletor de múltiplos projetos equivalente ao da Web.**

Um único `opencode serve` suporta simultaneamente múltiplos diretórios e projetos. Entretanto, cada processo TUI é iniciado com um diretório-base e permanece associado ao projeto resolvido a partir dele:

- `opencode /caminho` inicia a TUI local naquele caminho;
- `opencode attach URL --dir /caminho/no-host` inicia a TUI remota naquele caminho do host do servidor;
- `opencode attach URL` sem `--dir` não seleciona um diretório no cliente: o servidor usa o próprio `process.cwd()`, isto é, o diretório em que `opencode serve` foi iniciado;
- dentro da TUI, `/sessions` pode alternar sessões do projeto atual e `/move` pode mover uma sessão entre diretórios, subdiretórios, cópias ou worktrees conhecidos **do mesmo projeto**;
- a TUI não oferece um comando para abrir um caminho arbitrário pertencente a outro projeto, nem um project picker equivalente ao da Web.

Portanto, **o argumento posicional `DIRECTORY` pode ser removido de `oc` sem reduzir a capacidade do servidor ou da Web**, mas isso não significa que o diretório deixou de importar para a TUI. Para abrir outro projeto pela TUI, o usuário deve iniciar outro attach — ou sair do attach atual e reconectar — informando um caminho absoluto existente na máquina remota:

```bash
opencode attach https://maquina.tailnet.ts.net:4096 --dir /caminho/no-host
```

Se `oc` deixar de aceitar `DIRECTORY`, ainda será necessário definir um diretório de inicialização determinístico para `opencode serve`, pois ele continuará sendo o fallback de um `attach` sem `--dir`. Usar o diretório home do host é uma escolha previsível; simplesmente herdar o diretório de onde `oc` foi chamado mantém um default implícito e variável.

## TUI local

O comando principal da TUI aceita um argumento posicional `[project]`. Ele resolve esse caminho contra `PWD` ou usa o diretório corrente, executa `chdir` e passa o caminho resultante para a TUI ([definição e resolução do diretório](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/opencode/src/cli/cmd/tui.ts#L66-L80), [inicialização do worker e passagem do diretório](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/opencode/src/cli/cmd/tui.ts#L198-L208), [criação da TUI com o `cwd`](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/opencode/src/cli/cmd/tui.ts#L251-L297)).

Isso significa que:

```bash
opencode ~/src/projeto-a
```

e:

```bash
opencode ~/src/projeto-b
```

são duas inicializações da TUI com dois contextos diferentes. A TUI local não começa globalmente e depois apresenta um seletor arbitrário de projetos como a Web.

## `opencode attach` com e sem `--dir`

O comando `attach` declara explicitamente `--dir` ([opção da CLI](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/opencode/src/cli/cmd/attach.ts#L17-L20)). Seu comportamento é:

1. Se nenhum `--dir` for fornecido, mantém `directory` como `undefined`.
2. Se o caminho existir no dispositivo que está executando a TUI, tenta `chdir` e o normaliza com `process.cwd()`.
3. Se ele não existir localmente — o caso normal de um caminho que só existe no host remoto — transmite a string sem alteração ([resolução local ou passagem do caminho remoto](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/opencode/src/cli/cmd/attach.ts#L70-L79)).
4. O valor é passado ao cliente da TUI ([validação e inicialização](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/opencode/src/cli/cmd/attach.ts#L114-L145)).

O SDK da TUI é criado com um único `props.directory` e não expõe um setter para substituí-lo durante a vida daquele processo ([criação do SDK](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/tui/src/context/sdk.tsx#L13-L30), [contexto exposto](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/tui/src/context/sdk.tsx#L141-L149)). O SDK envia esse diretório ao servidor por `x-opencode-directory` ou pelo parâmetro de query equivalente ([cliente oficial do SDK](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/sdk/js/src/v2/client.ts#L15-L32), [configuração do header](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/sdk/js/src/v2/client.ts#L59-L68)).

Convém usar um caminho **absoluto no host remoto**. Um caminho relativo pode ser resolvido no dispositivo cliente se existir ali ou contra o `cwd` do servidor se for transmitido sem resolução, o que torna o resultado ambíguo entre máquinas.

### Attach sem diretório

Sem `--dir`, o cliente não envia uma seleção. O middleware do servidor escolhe, nesta ordem:

1. o diretório já gravado na sessão para requisições associadas a uma sessão;
2. o parâmetro `directory` da URL;
3. o header `x-opencode-directory`;
4. `process.cwd()` do processo servidor.

Essa ordem está implementada no [roteamento de workspace](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts#L86-L88) e na [seleção da sessão ou diretório default](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts#L160-L184).

Assim, no wrapper atual:

```bash
(cd "$WORKING_DIRECTORY" && opencode serve ...)
```

o `WORKING_DIRECTORY` não limita o servidor a esse projeto, mas define o fallback de `opencode attach URL` sem `--dir`.

## O que pode ser trocado dentro da TUI

### Sessões

A TUI oferece `/sessions` para alternar sessões ([registro do comando](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/tui/src/app.tsx#L570-L579)). Por padrão, a lista é filtrada pelo path correspondente ao diretório atual. Mesmo quando o usuário desabilita esse filtro, a consulta continua usando `scope: "project"`; ela não passa a listar todos os projetos do servidor ([construção da consulta](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/tui/src/context/sync.tsx#L160-L173), [comando que alterna o filtro](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/tui/src/app.tsx#L934-L944)).

Ao abrir uma sessão existente, as operações destinadas àquela sessão são roteadas pelo backend usando o `session.directory`. Isso permite operar sessões de diretórios diferentes dentro do mesmo projeto, sem transformar a TUI em um seletor global de projetos ([roteamento por ID e diretório da sessão](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts#L220-L233)).

### `/move`

A TUI oferece `/move`, descrito na interface como “Move to another project dir” ([registro do comando](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/tui/src/component/prompt/index.tsx#L535-L555)). A palavra “project” nessa descrição não significa “qualquer outro projeto”: o próprio lembrete injetado depois da mudança diz que continua sendo o mesmo projeto ([semântica explícita](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/tui/src/component/prompt/move.tsx#L14-L16)).

O picker consulta `project.directories(projectID)` e mostra as cópias, worktrees e subdiretórios conhecidos daquele `projectID` ([carregamento dos diretórios](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/tui/src/component/dialog-move-session.tsx#L73-L83), [montagem das opções](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/tui/src/component/dialog-move-session.tsx#L112-L183)). A escolha é então enviada ao control plane para mover a sessão ([execução do move](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/tui/src/component/prompt/move.tsx#L117-L151)). O backend rejeita explicitamente uma tentativa de mover a sessão para um projeto diferente ([validação do projeto](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/opencode/src/server/routes/instance/httpapi/handlers/control-plane.ts#L30-L34)).

### `/workspaces` e `/warp`

Os comandos experimentais de workspace não são equivalentes ao project picker da Web. `/workspaces` administra workspaces registrados, e `/warp` associa a sessão a um workspace experimental. Eles não oferecem um navegador arbitrário de diretórios ou uma troca irrestrita entre projetos. O comando é inclusive ocultado quando `OPENCODE_EXPERIMENTAL_WORKSPACES` está desativado ([registro de `/workspaces`](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/tui/src/app.tsx#L610-L618), [registro de `/warp`](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/tui/src/component/prompt/index.tsx#L535-L546)).

## Por que um único servidor suporta todos os projetos

`opencode serve` foi deliberadamente transformado em um servidor sem contexto de projeto inicial. A definição do comando usa `instance: false` e documenta que as instâncias são carregadas por requisição por meio de `x-opencode-directory` ([implementação de `serve`](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/opencode/src/cli/cmd/serve.ts#L6-L22)).

No servidor:

- o middleware extrai o diretório de cada requisição;
- o `InstanceStore` normaliza o caminho;
- mantém um cache `Map` indexado por diretório;
- cria e inicializa uma instância nova quando o diretório ainda não está no cache.

Isso está visível no [modelo do store e criação da instância](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/opencode/src/project/instance-store.ts#L15-L63) e no [carregamento/cache por diretório](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/opencode/src/project/instance-store.ts#L108-L123).

Logo, iniciar o servidor em `$HOME`, `/` ou um repositório específico só define o diretório default para requisições que não declaram um. Isso não impede que a Web ou outro cliente usem qualquer caminho acessível ao processo no mesmo host.

## Diferença em relação à Web

A Web mantém uma coleção de projetos por servidor e navega entre eles. Ela possui comandos para abrir o project picker e ir ao projeto anterior ou seguinte ([comandos de projeto](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/app/src/pages/layout.tsx#L898-L927)).

O seletor chama `pickDirectory` com `multiple: true` e abre cada diretório selecionado no contexto do servidor remoto ([picker multiprojeto](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/app/src/pages/layout.tsx#L1368-L1388)). O home também mantém seleção, lista e abertura de projetos por conexão de servidor ([controle de projetos no home](https://github.com/anomalyco/opencode/blob/02546dfc2e4515a4f90aaf9ceb3890df2ac2b479/packages/app/src/pages/home/home-controller.ts#L49-L114)).

Esta é a capacidade que não existe na TUI 1.18.17: escolher livremente vários projetos do filesystem remoto dentro do mesmo processo TUI.

## Implicação recomendada para `oc`

Se o argumento posicional for removido posteriormente, o contrato mais claro seria:

1. `oc` inicia um único `opencode serve` em um diretório default estável, preferencialmente `$HOME` do host;
2. Web e Desktop continuam abrindo e alternando múltiplos diretórios pelo seletor próprio;
3. a linha de ajuda para TUI mostra explicitamente o caminho remoto:

   ```bash
   opencode attach https://maquina.tailnet.ts.net:4096 --dir /caminho/no-host
   ```

4. `opencode attach URL` sem `--dir` é documentado como abertura do diretório default do servidor, não como TUI multiprojeto;
5. para trabalhar simultaneamente em dois projetos pela TUI, usam-se dois processos `attach`, cada um com seu `--dir`.

Não é necessário manter `DIRECTORY` em `oc` para viabilizar múltiplos projetos. É necessário, porém, não prometer que a TUI consegue selecioná-los como a Web e preservar uma maneira explícita de escolher o diretório remoto por `attach --dir`.
