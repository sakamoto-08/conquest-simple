/**
 * main.js
 * 起動とクリック。
 *
 * マスは戦闘のたびに renderMap() で作り直される。
 * listener は #app に1つだけ付け、押された .map-cell の data-row / data-col を読む。
 * 勝敗とゴールドの更新は game.dispatch() に任せる。
 */
(function () {
  'use strict';

  const app = document.getElementById('app');
  const game = ConquestGame.start(app);

  /* 次の処理から同じ state を触れるように残す。 */
  ConquestGame.current = game;

  app.addEventListener('click', function (event) {
    const cellElement = event.target.closest('.map-cell');
    if (!cellElement || !app.contains(cellElement)) {
      return;
    }

    game.dispatch(
      Number(cellElement.dataset.row),
      Number(cellElement.dataset.col)
    );
  });
})();
