/**
 * Bundled sample projects. The repository is embedded as source text (not a
 * Tauri resource) so it ships in the server bundle, the npm package and the
 * packaged sidecar with no extra resource path, env variable or file lookup.
 *
 * Keep the files free of backticks and `${`: they are template literals here.
 */
import type { SampleDefinition, SampleLocale, SampleSpecText } from './domain'

const LOGIC_JS = `// Pure game rules: no DOM, so they are easy to test.
export const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
]

export function winner(board) {
  for (const [a, b, c] of LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a]
  }
  return null
}

export function isDraw(board) {
  return board.every(Boolean) && winner(board) === null
}

export function nextPlayer(board) {
  const x = board.filter((cell) => cell === 'X').length
  const o = board.filter((cell) => cell === 'O').length
  return x <= o ? 'X' : 'O'
}

export function play(board, index) {
  if (board[index] || winner(board)) return board
  const next = board.slice()
  next[index] = nextPlayer(board)
  return next
}
`

const GAME_JS = `import { isDraw, nextPlayer, play, winner } from './logic.js'

let board = Array(9).fill(null)

const boardEl = document.getElementById('board')
const statusEl = document.getElementById('status')

function statusText() {
  const won = winner(board)
  if (won) return 'Player ' + won + ' wins'
  if (isDraw(board)) return 'It is a draw'
  return 'Player ' + nextPlayer(board) + ' to move'
}

function render() {
  boardEl.innerHTML = ''
  board.forEach((cell, index) => {
    const button = document.createElement('button')
    button.className = 'cell'
    button.type = 'button'
    button.textContent = cell || ''
    button.setAttribute('aria-label', 'Cell ' + (index + 1))
    button.addEventListener('click', () => {
      board = play(board, index)
      render()
    })
    boardEl.appendChild(button)
  })
  statusEl.textContent = statusText()
}

render()
`

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tic-tac-toe</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <main>
      <h1>Tic-tac-toe</h1>
      <p id="status" role="status"></p>
      <div id="board" class="board"></div>
    </main>
    <script type="module" src="game.js"></script>
  </body>
</html>
`

const STYLE_CSS = `body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #14151f; color: #eceefa; }
main { text-align: center; }
.board { display: grid; grid-template-columns: repeat(3, 5.5rem); gap: 0.5rem; justify-content: center; }
.cell { height: 5.5rem; font-size: 2.25rem; border-radius: 0.5rem; border: 1px solid #3a3d55; background: #1d1f2e; color: inherit; cursor: pointer; }
.cell:hover { background: #262941; }
`

const LOGIC_TEST_JS = `import test from 'node:test'
import assert from 'node:assert/strict'
import { isDraw, nextPlayer, play, winner } from './logic.js'

test('X moves first and players alternate', () => {
  const empty = Array(9).fill(null)
  assert.equal(nextPlayer(empty), 'X')
  assert.equal(nextPlayer(play(empty, 0)), 'O')
})

test('a taken cell cannot be played again', () => {
  const once = play(Array(9).fill(null), 4)
  assert.deepEqual(play(once, 4), once)
})

test('three in a row wins and ends the game', () => {
  const board = ['X', 'X', 'X', 'O', 'O', null, null, null, null]
  assert.equal(winner(board), 'X')
  assert.deepEqual(play(board, 8), board)
})

test('a full board without a winner is a draw', () => {
  const board = ['X', 'O', 'X', 'X', 'O', 'O', 'O', 'X', 'X']
  assert.equal(winner(board), null)
  assert.equal(isDraw(board), true)
})
`

const PACKAGE_JSON = `{
  "name": "tic-tac-toe",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "A tiny browser game used as the Specrails sample project.",
  "scripts": {
    "test": "node --test"
  }
}
`

const README_MD = `# Tic-tac-toe

A tiny browser game, bundled with Specrails Desktop as a sample project.

- \`logic.js\` holds the rules (pure functions), \`logic.test.js\` tests them.
- \`game.js\`, \`index.html\` and \`style.css\` draw the board.

Run the tests with \`npm test\`. Open \`index.html\` in a browser to play.
`

const GITIGNORE = `node_modules/
.specrails/
.DS_Store
`

type Texts = Record<SampleLocale, SampleSpecText>

const RESTART: Texts = {
  en: { title: 'Add a Restart button', summary: 'Let players start a new game without reloading the page.',
    description: 'Add a "Restart" button under the board. Pressing it clears all nine cells and starts a new game with X to move.\n\nKeep the rule in logic.js (for example a newBoard() function) and cover it with a test in logic.test.js.\n\nAcceptance: after Restart the board is empty and the status line says it is X\'s turn; npm test passes.' },
  es: { title: 'Añadir un botón Reiniciar', summary: 'Permite empezar una partida nueva sin recargar la página.',
    description: 'Añade un botón "Reiniciar" bajo el tablero. Al pulsarlo se vacían las nueve casillas y empieza una partida nueva con el turno de X.\n\nMantén la regla en logic.js (por ejemplo una función newBoard()) y cúbrela con un test en logic.test.js.\n\nCriterio de aceptación: tras Reiniciar el tablero está vacío y el estado indica que le toca a X; npm test pasa.' },
  fr: { title: 'Ajouter un bouton Recommencer', summary: 'Permet de lancer une nouvelle partie sans recharger la page.',
    description: 'Ajoute un bouton "Recommencer" sous le plateau. Un clic vide les neuf cases et lance une nouvelle partie avec X qui joue en premier.\n\nGarde la règle dans logic.js (par exemple une fonction newBoard()) et couvre-la par un test dans logic.test.js.\n\nCritère d\'acceptation : après Recommencer, le plateau est vide et le statut indique que c\'est à X de jouer ; npm test réussit.' },
  de: { title: 'Neustart-Button hinzufügen', summary: 'Ein neues Spiel starten, ohne die Seite neu zu laden.',
    description: 'Füge unter dem Spielfeld einen Button "Neustart" hinzu. Ein Klick leert alle neun Felder und startet ein neues Spiel, in dem X beginnt.\n\nHalte die Regel in logic.js (zum Beispiel eine Funktion newBoard()) und decke sie mit einem Test in logic.test.js ab.\n\nAkzeptanzkriterium: Nach dem Neustart ist das Feld leer und die Statuszeile zeigt, dass X am Zug ist; npm test läuft durch.' },
  pt: { title: 'Adicionar um botão Reiniciar', summary: 'Permite começar um novo jogo sem recarregar a página.',
    description: 'Adiciona um botão "Reiniciar" abaixo do tabuleiro. Ao clicar, as nove casas ficam vazias e começa um novo jogo com a vez do X.\n\nMantém a regra em logic.js (por exemplo uma função newBoard()) e cobre-a com um teste em logic.test.js.\n\nCritério de aceitação: depois de Reiniciar o tabuleiro está vazio e o estado indica que é a vez do X; npm test passa.' },
  it: { title: 'Aggiungere un pulsante Ricomincia', summary: 'Permette di iniziare una nuova partita senza ricaricare la pagina.',
    description: 'Aggiungi un pulsante "Ricomincia" sotto la griglia. Premendolo si svuotano le nove caselle e inizia una nuova partita con il turno di X.\n\nMantieni la regola in logic.js (per esempio una funzione newBoard()) e coprila con un test in logic.test.js.\n\nCriterio di accettazione: dopo Ricomincia la griglia è vuota e lo stato indica che tocca a X; npm test passa.' },
  zh: { title: '添加“重新开始”按钮', summary: '无需刷新页面即可开始新一局。',
    description: '在棋盘下方添加“重新开始”按钮。点击后清空九个格子，并以 X 先手开始新的一局。\n\n把规则放在 logic.js 中（例如 newBoard() 函数），并在 logic.test.js 中添加测试。\n\n验收标准：点击后棋盘为空，状态栏显示轮到 X；npm test 通过。' },
  ja: { title: '「もう一度」ボタンを追加', summary: 'ページを再読み込みせずに新しいゲームを始められるようにします。',
    description: '盤面の下に「もう一度」ボタンを追加します。押すと9つのマスがすべて空になり、X の先手で新しいゲームが始まります。\n\nルールは logic.js に置き（例: newBoard() 関数）、logic.test.js でテストします。\n\n受け入れ条件: ボタンを押すと盤面が空になり、ステータスに X の番と表示されること。npm test が通ること。' },
}

const WIN_LINE: Texts = {
  en: { title: 'Highlight the winning line', summary: 'Show which three cells made the win.',
    description: 'When a player wins, highlight the three winning cells (for example with a background colour).\n\nAdd a winningLine(board) function to logic.js that returns the three indexes, or null when nobody has won, and test it in logic.test.js.\n\nAcceptance: a won game shows exactly three highlighted cells; npm test passes.' },
  es: { title: 'Resaltar la línea ganadora', summary: 'Muestra qué tres casillas dieron la victoria.',
    description: 'Cuando alguien gana, resalta las tres casillas ganadoras (por ejemplo con un color de fondo).\n\nAñade a logic.js una función winningLine(board) que devuelva los tres índices, o null si nadie ha ganado, y pruébala en logic.test.js.\n\nCriterio de aceptación: una partida ganada muestra exactamente tres casillas resaltadas; npm test pasa.' },
  fr: { title: 'Mettre en évidence la ligne gagnante', summary: 'Montre les trois cases qui ont donné la victoire.',
    description: 'Quand un joueur gagne, mets en évidence les trois cases gagnantes (par exemple avec une couleur de fond).\n\nAjoute à logic.js une fonction winningLine(board) qui renvoie les trois indices, ou null si personne n\'a gagné, et teste-la dans logic.test.js.\n\nCritère d\'acceptation : une partie gagnée affiche exactement trois cases en évidence ; npm test réussit.' },
  de: { title: 'Gewinnlinie hervorheben', summary: 'Zeigt, welche drei Felder den Sieg gebracht haben.',
    description: 'Wenn ein Spieler gewinnt, hebe die drei Gewinnfelder hervor (zum Beispiel mit einer Hintergrundfarbe).\n\nFüge logic.js eine Funktion winningLine(board) hinzu, die die drei Indizes zurückgibt, oder null, wenn niemand gewonnen hat, und teste sie in logic.test.js.\n\nAkzeptanzkriterium: Ein gewonnenes Spiel zeigt genau drei hervorgehobene Felder; npm test läuft durch.' },
  pt: { title: 'Destacar a linha vencedora', summary: 'Mostra quais três casas deram a vitória.',
    description: 'Quando alguém ganha, destaca as três casas vencedoras (por exemplo com uma cor de fundo).\n\nAdiciona a logic.js uma função winningLine(board) que devolve os três índices, ou null se ninguém ganhou, e testa-a em logic.test.js.\n\nCritério de aceitação: um jogo ganho mostra exatamente três casas destacadas; npm test passa.' },
  it: { title: 'Evidenziare la linea vincente', summary: 'Mostra quali tre caselle hanno dato la vittoria.',
    description: 'Quando un giocatore vince, evidenzia le tre caselle vincenti (per esempio con un colore di sfondo).\n\nAggiungi a logic.js una funzione winningLine(board) che restituisce i tre indici, oppure null se nessuno ha vinto, e testala in logic.test.js.\n\nCriterio di accettazione: una partita vinta mostra esattamente tre caselle evidenziate; npm test passa.' },
  zh: { title: '高亮获胜连线', summary: '显示是哪三个格子取得了胜利。',
    description: '当有玩家获胜时，高亮显示三个获胜格子（例如使用背景色）。\n\n在 logic.js 中添加 winningLine(board) 函数，返回这三个索引；无人获胜时返回 null，并在 logic.test.js 中测试。\n\n验收标准：获胜的一局恰好显示三个高亮格子；npm test 通过。' },
  ja: { title: '勝利ラインをハイライト', summary: 'どの3マスで勝ったかを表示します。',
    description: '誰かが勝ったら、勝利した3マスをハイライトします（例: 背景色）。\n\nlogic.js に winningLine(board) 関数を追加し、3つのインデックスを返します（勝者がいなければ null）。logic.test.js でテストします。\n\n受け入れ条件: 勝利したゲームでちょうど3マスがハイライトされること。npm test が通ること。' },
}

const SCORE: Texts = {
  en: { title: 'Keep score across rounds', summary: 'Count wins for X, wins for O and draws.',
    description: 'Show a small scoreboard above the board with wins for X, wins for O and draws. The score carries over when the players press Restart or finish a game, and starts at zero when the page loads.\n\nKeep the counting in logic.js (for example addResult(score, result)) and test it in logic.test.js.\n\nAcceptance: after two X wins and one draw the scoreboard reads X 2, O 0, Draws 1; npm test passes.' },
  es: { title: 'Llevar la puntuación entre partidas', summary: 'Cuenta las victorias de X, las de O y los empates.',
    description: 'Muestra un pequeño marcador sobre el tablero con las victorias de X, las de O y los empates. La puntuación se mantiene al reiniciar o terminar una partida y empieza en cero al cargar la página.\n\nMantén el recuento en logic.js (por ejemplo addResult(score, result)) y pruébalo en logic.test.js.\n\nCriterio de aceptación: tras dos victorias de X y un empate el marcador muestra X 2, O 0, Empates 1; npm test pasa.' },
  fr: { title: 'Garder le score entre les parties', summary: 'Compte les victoires de X, celles de O et les égalités.',
    description: 'Affiche un petit tableau de score au-dessus du plateau avec les victoires de X, celles de O et les égalités. Le score est conservé quand on recommence ou termine une partie, et repart de zéro au chargement de la page.\n\nGarde le décompte dans logic.js (par exemple addResult(score, result)) et teste-le dans logic.test.js.\n\nCritère d\'acceptation : après deux victoires de X et une égalité, le tableau affiche X 2, O 0, Égalités 1 ; npm test réussit.' },
  de: { title: 'Punktestand über Runden führen', summary: 'Zählt Siege von X, Siege von O und Unentschieden.',
    description: 'Zeige über dem Spielfeld eine kleine Anzeige mit den Siegen von X, den Siegen von O und den Unentschieden. Der Stand bleibt beim Neustart oder nach einem beendeten Spiel erhalten und beginnt beim Laden der Seite bei null.\n\nHalte die Zählung in logic.js (zum Beispiel addResult(score, result)) und teste sie in logic.test.js.\n\nAkzeptanzkriterium: Nach zwei Siegen von X und einem Unentschieden zeigt die Anzeige X 2, O 0, Unentschieden 1; npm test läuft durch.' },
  pt: { title: 'Manter a pontuação entre jogos', summary: 'Conta as vitórias do X, as do O e os empates.',
    description: 'Mostra um pequeno placar acima do tabuleiro com as vitórias do X, as do O e os empates. A pontuação mantém-se ao reiniciar ou terminar um jogo e começa em zero quando a página carrega.\n\nMantém a contagem em logic.js (por exemplo addResult(score, result)) e testa-a em logic.test.js.\n\nCritério de aceitação: depois de duas vitórias do X e um empate o placar mostra X 2, O 0, Empates 1; npm test passa.' },
  it: { title: 'Tenere il punteggio tra le partite', summary: 'Conta le vittorie di X, quelle di O e i pareggi.',
    description: 'Mostra un piccolo tabellone sopra la griglia con le vittorie di X, quelle di O e i pareggi. Il punteggio resta quando si ricomincia o si finisce una partita e riparte da zero al caricamento della pagina.\n\nMantieni il conteggio in logic.js (per esempio addResult(score, result)) e testalo in logic.test.js.\n\nCriterio di accettazione: dopo due vittorie di X e un pareggio il tabellone mostra X 2, O 0, Pareggi 1; npm test passa.' },
  zh: { title: '跨局记录比分', summary: '统计 X 的胜场、O 的胜场和平局。',
    description: '在棋盘上方显示一个小计分板，包含 X 的胜场、O 的胜场和平局。重新开始或结束一局后比分保留，页面加载时从零开始。\n\n把计分逻辑放在 logic.js 中（例如 addResult(score, result)），并在 logic.test.js 中测试。\n\n验收标准：X 赢两局、平一局后，计分板显示 X 2、O 0、平局 1；npm test 通过。' },
  ja: { title: 'ラウンドをまたいでスコアを記録', summary: 'X の勝ち、O の勝ち、引き分けを数えます。',
    description: '盤面の上に、X の勝ち・O の勝ち・引き分けを表示する小さなスコアボードを追加します。ゲームを終えたり「もう一度」を押してもスコアは保持され、ページを読み込むと 0 から始まります。\n\n集計は logic.js に置き（例: addResult(score, result)）、logic.test.js でテストします。\n\n受け入れ条件: X が2勝して1回引き分けると、X 2・O 0・引き分け 1 と表示されること。npm test が通ること。' },
}

export const TIC_TAC_TOE: SampleDefinition = {
  id: 'tic-tac-toe',
  name: 'tic-tac-toe',
  commitMessage: 'Initial commit: tic-tac-toe sample',
  files: {
    'index.html': INDEX_HTML,
    'game.js': GAME_JS,
    'logic.js': LOGIC_JS,
    'logic.test.js': LOGIC_TEST_JS,
    'style.css': STYLE_CSS,
    'package.json': PACKAGE_JSON,
    'README.md': README_MD,
    '.gitignore': GITIGNORE,
  },
  specs: [
    { key: 'restart-button', priority: 'high', labels: ['sample', 'ui'], effort: 'small', text: RESTART },
    { key: 'winning-line', priority: 'medium', labels: ['sample', 'ui'], effort: 'small', text: WIN_LINE },
    { key: 'scoreboard', priority: 'medium', labels: ['sample', 'ui'], effort: 'medium', text: SCORE },
  ],
}

export const SAMPLE_CATALOG: readonly SampleDefinition[] = [TIC_TAC_TOE]
