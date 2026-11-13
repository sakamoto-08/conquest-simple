/**
 * main.js
 * 起動とクリック。
 *
 * マスは戦闘のたびに renderMap() で作り直される。
 * listener は #app に1つだけ付け、押された要素で処理を分ける。
 *   .map-cell             … game.dispatch()
 *   [data-action="evolve"] … game.evolve()
 *   [data-action="reset"]  … game.reset()
 */
(function () {
  'use strict';

  const app = document.getElementById('app');
  const game = ConquestGame.start(app);

  /* 次の処理から同じ state を触れるように残す。 */
  ConquestGame.current = game;

  app.addEventListener('click', function (event) {
    const evolveButton = event.target.closest('[data-action="evolve"]');
    if (evolveButton && app.contains(evolveButton)) {
      game.evolve(evolveButton.dataset.templateId);
      return;
    }

    const resetButton = event.target.closest('[data-action="reset"]');
    if (resetButton && app.contains(resetButton)) {
      game.reset();
      return;
    }

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
