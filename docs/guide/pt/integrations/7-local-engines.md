# Motores de IA locais

Execute o Specrails com modelos hospedados por você — Ollama, llama.cpp, LM Studio, vLLM ou qualquer servidor que fale a API chat-completions da OpenAI. Uma vez conectado, um endpoint local é um motor como qualquer outro: aparece no cabeçalho do rail, em Adicionar spec (Quick e Explore), no chat lateral e nas missões do agente.

## Conectar um endpoint

1. Abra **Configurações ▸ Agentes Specrails ▸ Conexões de provedor** e escolha **Adicionar motor local**.
2. Informe um id, a URL base (por exemplo `http://127.0.0.1:11434/v1`) e, se o servidor exigir chave, o **nome da variável de ambiente** que a contém. A chave nunca é armazenada — o Specrails a lê do ambiente do app ao iniciar cada execução.
3. Clique em **Testar conexão**. O indicador fica verde quando o servidor responde e os modelos disponíveis são listados. Escolha um modelo padrão.
4. **Salvar**. O motor fica disponível na hora — sem reiniciar.

> Abrir o app pelo Finder, Dock ou menu Iniciar não herda os exports do shell. Se o cartão disser que a variável *não está definida no processo do app*, defina-a no sistema ou inicie o app por um terminal que a tenha. Servidores sem chave não precisam de nada disso.

Cada conexão também tem a configuração **Loop do agente**. **Compacto** (padrão) conduz modelos pequenos por passos curtos e estruturados — é o que permite a um modelo de 7–14B concluir o implement; **Livre** é o loop agêntico clássico para modelos fortes (~30B+). Ajuste a **janela de contexto** ao tamanho real do seu servidor para que o Specrails compacte antes que o servidor rejeite um pedido.

## O que você ganha

- Rails (implement, batch, freestyle, loops personalizados), Explore e specs Quick, chat e missões rodam no modelo local.
- As missões mantêm suas ferramentas Specrails e seus servidores MCP externos.
- As sessões são retomadas entre turnos; jobs interativos funcionam.
- O custo é honesto: os tokens são registrados, o custo fica *desconhecido* a menos que você informe tarifas (então é marcado como *estimado*).

Indisponível em motores locais: perfis de agente e papéis personalizados, enriquecimento SMASH / Contract Layer, anexos e telemetria do pipeline. O Project Builder funciona em modo só-saída (sem ferramentas); o contrato do blueprint é rígido, então use um modelo capaz.

> Missões precisam de uma **janela de contexto grande** no servidor (64k tokens ou mais): o prompt do operador mais os schemas de ferramentas do Specrails são grandes. Chat e Explore funcionam bem com 32k. Se um turno falhar com *exceeds the available context size*, aumente a janela (Ollama `OLLAMA_CONTEXT_LENGTH`, llama.cpp `-c`, LM Studio *Context Length*).

## Só tem um motor local?

Nada a configurar. O Specrails oferece os motores que sua máquina realmente consegue executar e escolhe o padrão com uma única regra em todo lugar: um CLI instalado (Claude → Codex → Gemini → Kimi) ou, se não houver, o primeiro motor local cujo endpoint responda. Em uma máquina só com um endpoint local, rails, Add Spec, chat, **missões do agente e o Project Builder** começam nele — sem tocar em nenhum seletor. Um motor cujo servidor está fora do ar simplesmente não é oferecido até voltar a responder. Missões existentes mantêm o motor com que foram criadas; o seletor continua permitindo trocar.

## Escolher um modelo

A qualidade depende do modelo, não do Specrails. Para rails use um modelo de código ajustado para tool calling com 30B parâmetros ou mais; modelos instruct menores servem para chat, Explore e specs Quick. Experimente **Freestyle** ou uma sessão Explore antes de confiar um rail implement completo a um modelo novo.

## Desativar

Defina `SPECRAILS_LOCAL_ENGINES=false` no ambiente do app para ocultar motores locais em toda parte. As conexões salvas são mantidas e continuam válidas como provedores por papel do runtime programático.
