<!-- guide-revision: mission-first-v1 -->

# Ligar um fornecedor de IA {#ai-providers}

O Specrails coordena a sua CLI do Claude ou do Codex já autenticada. A instalação do fornecedor, o acesso à conta e a faturação dos modelos continuam separados da aplicação.

## Ligar e verificar

Instale a CLI pretendida seguindo as instruções oficiais e inicie sessão com a conta que pretende usar. Verifique a disponibilidade no Specrails e, depois, selecione um modelo suportado e as definições para a missão ou o rail.

Uma verificação de deteção bem-sucedida não garante quota nem disponibilidade de rede para a próxima chamada. Resolva os erros de autenticação e de compatibilidade antes de voltar a tentar uma implementação.

## Perceber o limite

A app guarda os registos do projeto localmente, enquanto os pedidos aos modelos e as integrações configuradas podem enviar contexto para fora da sua máquina. Escolha as referências e os anexos a fornecer tendo isso em conta.

As capacidades diferem: os controlos de raciocínio, as respostas estruturadas, os subagentes e o direcionamento do turno ativo não são intercambiáveis entre fornecedores. Consulte [as definições de execução do fornecedor](../pipeline/picking-an-engine-per-rail) e [o direcionamento](../pipeline/the-job-detail-view).

A seleção Sonnet executa o Claude Sonnet 5.5 (`claude-sonnet-5-5`). [Anthropic](https://platform.claude.com/docs/en/models/sonnet-5-5/overview).
