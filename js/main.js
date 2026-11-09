/**
 * main.js
 * 起動口。ページ読み込み時に初期 state を作り、マップを #app へ出す。
 *
 * 派遣や戦闘を足すときは、ここで保持している game を使う。
 *   game.state.map[row][col] を更新し、game.renderMap() で描き直す。
 *   結果の一文は game.renderLog('...') でログ領域へ出せる。
 */
(function () {
  'use strict';

  const app = document.getElementById('app');
  const game = ConquestGame.start(app);

  /* 次の処理から同じ state を触れるように残す。 */
  ConquestGame.current = game;
})();
