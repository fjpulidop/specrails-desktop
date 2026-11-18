# Atualizações {#updates}

O Specrails mantém duas coisas atualizadas: o próprio app **Specrails Desktop** e o framework **specrails-core** usado pelos seus projetos. Ambos ficam em **Configurações ▸ Atualizações**.

## Canal de atualização

Escolha com que rapidez você recebe novas versões:

- **Mais recente** (padrão): cada versão assim que é publicada. Você recebe novidades e correções primeiro.
- **Estável**: apenas versões que passaram pelo menos uma semana em Mais recente com CI verde e depois foram promovidas pelos mantenedores. Escolha se sua equipe prefere menos atualizações, bem testadas.

O canal vale para o app e para o specrails-core. Se o specrails-core ainda não tiver versão estável, o Core segue Mais recente e o cartão do Core avisa.

No Estável, se nenhuma versão tiver sido promovida ainda, **Verificar atualizações** avisa em vez de oferecer uma versão de Mais recente.

## Como as atualizações chegam

- **Specrails Desktop** verifica ao iniciar e a cada 6 horas. Quando há uma atualização, um pequeno botão **Atualizar** aparece na barra de estado assim que o app fica inativo por cerca de 30 segundos, nunca por cima de uma janela ou de um diálogo abertos. Clique nele para abrir o cartão de atualização: baixe, instale e reinicie a partir dele. **Dispensar** ignora essa versão. Você também pode clicar em **Verificar atualizações** aqui; o cartão aparece então diretamente nas Configurações.
- **specrails-core** nunca se atualiza sozinho. Clique em **Procurar atualizações** no cartão do Core e depois em **Atualizar**. Seus projetos passam para o novo framework sem reiniciar o app.

## Bom saber

- Trocar de Mais recente para Estável nunca faz downgrade. Você fica na sua versão até o Estável alcançá-la.
- Toda atualização é assinada e verificada antes de ser instalada, nos dois canais.

## Quando há trabalho em andamento

O cartão de atualização verifica o que um reinício interromperia. Se ainda há turnos de missão ou execuções em andamento, ele avisa e oferece:

- **Instalar quando nada estiver em execução**: o cartão espera e reinicia sozinho assim que o último turno ou execução termina.
- **Reiniciar agora**: reinicia mesmo assim. O trabalho interrompido é oferecido de novo depois do reinício.

## Depois de um reinício

Se o Specrails fechar, reiniciar para uma atualização ou parar inesperadamente com trabalho em andamento, a próxima abertura mostra **Continue de onde parou**: as missões que estavam no meio de um turno e as execuções que o reinício pausou, cada uma com sua caixa de seleção. Nada é retomado sozinho. As missões continuam na própria sessão (com uma nota curta de que o app reiniciou); as execuções usam o Retomar de sempre. **Agora não** descarta a lista; as execuções pausadas continuam na Caixa de entrada. Escape ou um clique fora apenas a ocultam: ela volta a aparecer na próxima abertura.

É a única janela que se abre sozinha ao iniciar. Se o app também parou inesperadamente, a explicação aparece como uma barra no topo da janela (ela nunca bloqueia você). Em uma primeira instalação, o tour da plataforma espera por uma abertura sem nenhuma das duas.
