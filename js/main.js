/**
 * main.js
 * 起動とクリック。
 *
 * マスは戦闘のたびに renderMap() で作り直される。
 * listener は #app に1つだけ付け、押された要素で処理を分ける。
 *   .map-cell                     … game.dispatch()
 *   [data-action="select-card"]   … game.select()
 *   [data-action="toggle-formation"] … game.toggleFormation()
 *   [data-action="evolve"]        … game.evolve()
 *   [data-action="save"]          … game.save()
 *   [data-action="reset"]         … game.reset()
 */
(function () {
  'use strict';

  const app = document.getElementById('app');
  const game = ConquestGame.start(app);

  /* 次の処理から同じ state を触れるように残す。 */
  ConquestGame.current = game;

  app.addEventListener('click', function (event) {
    const formationButton = event.target.closest('[data-action="toggle-formation"]');
    if (formationButton && app.contains(formationButton)) {
      game.toggleFormation(Number(formationButton.dataset.instanceId));
      return;
    }

    const cardButton = event.target.closest('[data-action="select-card"]');
    if (cardButton && app.contains(cardButton)) {
      game.select(Number(cardButton.dataset.instanceId));
      return;
    }

    const evolveButton = event.target.closest('[data-action="evolve"]');
    if (evolveButton && app.contains(evolveButton)) {
      game.evolve(evolveButton.dataset.templateId);
      return;
    }

    const saveButton = event.target.closest('[data-action="save"]');
    if (saveButton && app.contains(saveButton)) {
      game.save();
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
