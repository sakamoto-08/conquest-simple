/**
 * game.js
 * マップの描画と、マスへの派遣。
 *
 * データは ConquestData、クリックの受け取りは main.js が担当する。
 * 派遣で state が変わったら renderMap() と renderLog() で画面を追従させる。
 *
 * 戦闘に出すカードは getDispatchUnit() だけが決める。
 * 所持のうち power が一番高い1枚を派遣する。
 * 進化で cards に強いカードを足すと、次の派遣から自動で切り替わる。
 * レベルはカードに level が付いたとき、表示名へ足す。
 *
 * 公開 API は globalThis.ConquestGame。
 */
(function () {
  'use strict';

  /**
   * 未探索マスに隠したゴールドを数値で出すかどうか。
   * false のときは未探索を "Void" にする。探索済みは常に "Claimed"。
   */
  const SHOW_HIDDEN_GOLD = false;

  /**
   * ゴールドで追加できるカード。
   * 種類や価格を変えるときは、この配列の行を足すか書き換える。
   * templateId は ConquestData.CARD_TEMPLATES のキー。
   * label はボタンに出す文言。
   */
  const EVOLUTIONS = [
    { templateId: 'orc', cost: 50, label: 'Evolve Orc' },
    { templateId: 'dragon', cost: 120, label: 'Evolve Dragon' },
  ];

  /**
   * マスに出す文字列。
   * 表示の切り替えはここだけに閉じる。DOM 側は返ってきた文字を載せる。
   *
   * @param {{ gold: number, isRevealed: boolean }} cell
   * @returns {string}
   */
  function formatCellLabel(cell) {
    if (cell.isRevealed) {
      return 'Claimed';
    }
    if (SHOW_HIDDEN_GOLD) {
      return String(cell.gold);
    }
    return 'Void';
  }

  /**
   * カードの表示名。level が無いあいだは名前だけ。
   * @param {{ name: string, level?: number }} card
   * @returns {string}
   */
  function formatCardName(card) {
    if (card.level == null) {
      return card.name;
    }
    return card.name + ' Lv.' + card.level;
  }

  /**
   * カード1枚、または編成配列を、ログ用の名前にする。
   * @param {object|object[]} unit
   * @returns {string}
   */
  function formatUnitName(unit) {
    const cards = Array.isArray(unit) ? unit : [unit];
    return cards.map(formatCardName).join('・');
  }

  /**
   * 今回派遣するカード。所持のうち power が最大の1枚。
   * 同じ戦闘力なら、配列の先にあるカードを残す。
   * 戻り値はそのまま resolveBattle に渡せる。
   *
   * @param {{ cards: object[] }} player
   * @returns {object}
   */
  function getDispatchUnit(player) {
    if (!player.cards.length) {
      throw new Error('派遣できるカードがありません');
    }
    return player.cards.reduce(function (strongest, card) {
      if (card.power > strongest.power) {
        return card;
      }
      return strongest;
    });
  }

  /**
   * 進化メニューから1件を取る。未知の id は null。
   * @param {string} templateId
   * @returns {{ templateId: string, cost: number, label: string }|null}
   */
  function findEvolution(templateId) {
    for (let i = 0; i < EVOLUTIONS.length; i++) {
      if (EVOLUTIONS[i].templateId === templateId) {
        return EVOLUTIONS[i];
      }
    }
    return null;
  }

  /**
   * 戦闘ログの一文。先頭で勝敗を出し、獲得と所持を短く続ける。
   * 勝利: Victory! ゴブリンがオークを倒した。+28 Gold（所持: 28）
   * 敗北: Defeated... ゴブリンはオークに敗れた。（所持: 0）
   *
   * @param {{ unit: object|object[], enemy: { name: string }, battle: { result: string, rewardGold: number } }} outcome
   * @param {{ gold: number }} player
   * @returns {string}
   */
  function formatBattleLog(outcome, player) {
    const unitName = formatUnitName(outcome.unit);
    const enemyName = outcome.enemy.name;
    const held = '（所持:\u00A0' + player.gold + '）';

    if (outcome.battle.result === 'win') {
      return 'Victory! ' + unitName + 'が' + enemyName + 'を倒した。+' +
        outcome.battle.rewardGold + '\u00A0Gold' + held;
    }
    return 'Defeated... ' + unitName + 'は' + enemyName + 'に敗れた。' + held;
  }

  /**
   * マス1つ分の要素。
   * 未探索は button で "Void"。探索済みは "Claimed" とし、disabled にして再クリックできないようにする。
   * 行と列は data-row / data-col。クリック位置の特定は main.js が行う。
   *
   * @param {{ gold: number, isRevealed: boolean, enemy: object|null }} cell
   * @param {number} row
   * @param {number} col
   * @returns {HTMLButtonElement}
   */
  function createCellElement(cell, row, col) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'map-cell';
    element.classList.add(cell.isRevealed ? 'is-revealed' : 'is-hidden');
    element.dataset.row = String(row);
    element.dataset.col = String(col);
    element.disabled = cell.isRevealed;

    const label = document.createElement('span');
    label.className = 'map-cell-label';
    label.textContent = formatCellLabel(cell);
    element.appendChild(label);

    return element;
  }

  /**
   * 3×3 のグリッド。列数はマップの行数から決める。
   * @param {Array<Array<object>>} map
   * @returns {HTMLElement}
   */
  function createMapElement(map) {
    const size = map.length;
    const grid = document.createElement('div');
    grid.className = 'map-grid';
    grid.style.setProperty('--map-size', String(size));
    grid.setAttribute('aria-label', size + '×' + size + 'のマップ');

    map.forEach(function (row, rowIndex) {
      row.forEach(function (cell, colIndex) {
        grid.appendChild(createCellElement(cell, rowIndex, colIndex));
      });
    });

    return grid;
  }

  /**
   * 画面の枠。
   * [data-region="status"] … 派遣カードと所持ゴールド。
   * [data-region="map"] … マップ。再描画で中身だけ入れ替える。
   * [data-action="evolve"] … ゴールドでカードを追加するボタン。押す処理は main.js。
   * [data-action="reset"] … 初期状態へ戻すボタン。押す処理は main.js。
   * [data-region="log"] … 戦闘結果。空のあいだは表示しない。
   * @returns {HTMLElement}
   */
  function createBoardElement() {
    const board = document.createElement('div');
    board.className = 'board';

    const statusHost = document.createElement('div');
    statusHost.className = 'status-host';
    statusHost.dataset.region = 'status';

    const mapHost = document.createElement('div');
    mapHost.className = 'map-host';
    mapHost.dataset.region = 'map';

    const resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.className = 'reset-button';
    resetButton.dataset.action = 'reset';
    resetButton.textContent = 'Reset';

    const logHost = document.createElement('div');
    logHost.className = 'log-host';
    logHost.dataset.region = 'log';
    logHost.setAttribute('aria-live', 'polite');

    board.appendChild(statusHost);
    board.appendChild(mapHost);
    board.appendChild(createEvolveElement());
    board.appendChild(resetButton);
    board.appendChild(logHost);
    return board;
  }

  /**
   * 進化ボタンの並び。EVOLUTIONS の1行がボタン1つになる。
   * 価格は title に残し、見た目の文言は label のままにする。
   * @returns {HTMLElement}
   */
  function createEvolveElement() {
    const actions = document.createElement('div');
    actions.className = 'evolve-actions';
    actions.dataset.region = 'evolve';

    EVOLUTIONS.forEach(function (offer) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'evolve-button';
      button.dataset.action = 'evolve';
      button.dataset.templateId = offer.templateId;
      button.textContent = offer.label;
      button.title = offer.cost + ' Gold';
      actions.appendChild(button);
    });

    return actions;
  }

  /**
   * マップ領域だけを描き直す。派遣後にマスの表示を変えるときもここを呼ぶ。
   * @param {HTMLElement} root #app など、board を含む要素
   * @param {Array<Array<object>>} map
   */
  function renderMap(root, map) {
    const mapHost = root.querySelector('[data-region="map"]');
    if (!mapHost) {
      throw new Error('マップの描画先がありません');
    }
    mapHost.replaceChildren(createMapElement(map));
  }

  /**
   * 所持ゴールドと、いま派遣できるカードを出す。
   * 名前は formatUnitName、出すユニットは getDispatchUnit に任せる。
   * 戦闘力は、派遣カードが1枚ならその power。配列なら合計。
   * 例: 派遣: オーク (Power 20)　所持ゴールド 70
   *
   * @param {HTMLElement} root
   * @param {{ gold: number, cards: object[], formation?: object[] }} player
   */
  function renderStatus(root, player) {
    const statusHost = root.querySelector('[data-region="status"]');
    if (!statusHost) {
      throw new Error('ステータスの描画先がありません');
    }

    const unit = getDispatchUnit(player);
    const cards = Array.isArray(unit) ? unit : [unit];
    const power = cards.reduce(function (sum, card) {
      return sum + card.power;
    }, 0);

    statusHost.textContent =
      '派遣: ' + formatUnitName(unit) + ' (Power ' + power + ')　所持ゴールド ' + player.gold;
  }

  /**
   * 所持ゴールドで買える進化だけ押せるようにする。
   * 足りないボタンは disabled。クリック自体も evolveCard 側で無視する。
   *
   * @param {HTMLElement} root
   * @param {{ gold: number }} player
   */
  function renderEvolve(root, player) {
    const buttons = root.querySelectorAll('[data-action="evolve"]');
    buttons.forEach(function (button) {
      const offer = findEvolution(button.dataset.templateId);
      button.disabled = !offer || player.gold < offer.cost;
    });
  }

  /**
   * ゴールドを払ってカードを1枚追加する。
   * 価格未満、またはメニューに無い id では何も変えない。
   * 同じカードは、ゴールドがある限り何度でも追加できる。
   *
   * @param {{ gold: number, cards: object[] }} player
   * @param {string} templateId
   * @returns {object|null} 追加したカード。買えなければ null
   */
  function evolveCard(player, templateId) {
    const offer = findEvolution(templateId);
    if (!offer || player.gold < offer.cost) {
      return null;
    }
    player.gold -= offer.cost;
    const card = globalThis.ConquestData.createCard(offer.templateId);
    player.cards.push(card);
    return card;
  }

  /**
   * ステータスと進化ボタンを、今の所持に合わせる。
   * 戦闘・進化・リセットのあとで呼ぶ。
   *
   * @param {HTMLElement} root
   * @param {object} player
   */
  function refreshPlayer(root, player) {
    renderStatus(root, player);
    renderEvolve(root, player);
  }

  /**
   * 戦闘結果などの一文をログ領域へ出す。空文字なら領域を空に戻す。
   * result は 'win' か 'lose'。色分けにだけ使う。
   *
   * @param {HTMLElement} root
   * @param {string} message
   * @param {'win'|'lose'} [result]
   */
  function renderLog(root, message, result) {
    const logHost = root.querySelector('[data-region="log"]');
    if (!logHost) {
      throw new Error('ログの描画先がありません');
    }
    logHost.textContent = message || '';
    if (result) {
      logHost.dataset.result = result;
    } else {
      delete logHost.dataset.result;
    }
  }

  /**
   * 1マスへ派遣して戦闘する。
   * 探索済みなら何も変えず null を返す。敗北でもマスはそのままなので、再クリックできる。
   * 勝利時だけ isRevealed を立て、獲得ゴールドを財布へ足す。
   * rewardGold にはマスのゴールドが既に含まれている。ここで cell.gold は足さない。
   *
   * @param {{ player: object, map: object[][] }} state
   * @param {number} row
   * @param {number} col
   * @returns {null|{ unit: object|object[], enemy: object, battle: object, cell: object }}
   */
  function dispatchToCell(state, row, col) {
    const line = state.map[row];
    const cell = line && line[col];
    if (!cell || cell.isRevealed) {
      return null;
    }

    const unit = getDispatchUnit(state.player);
    const enemy = globalThis.ConquestData.createRandomEnemy();
    const battle = globalThis.ConquestData.resolveBattle(unit, enemy, {
      cellGold: cell.gold,
    });

    if (battle.result === 'win') {
      cell.enemy = enemy;
      cell.isRevealed = true;
      state.player.gold += battle.rewardGold;
    }

    return {
      unit: unit,
      enemy: enemy,
      battle: battle,
      cell: cell,
    };
  }

  /**
   * 初期 state を作り、#app にマップを出す。
   * dispatch(row, col) が戦闘、再描画、ログ更新まで行う。
   * evolve(templateId) はゴールドでカードを1枚追加する。
   * reset() は createInitialState で盤面を作り直し、表示を初期状態へ戻す。
   *
   * state は戻り値のプロパティとして持ち、各操作はそこを読む。
   * reset でオブジェクトを差し替えても、dispatch は新しい盤面を使う。
   *
   * @param {HTMLElement} root
   * @returns {{
   *   state: { player: object, map: object[][] },
   *   renderMap: () => void,
   *   renderLog: (message: string, result?: string) => void,
   *   dispatch: (row: number, col: number) => object|null,
   *   evolve: (templateId: string) => object|null,
   *   reset: () => void
   * }}
   */
  function start(root) {
    if (!root) {
      throw new Error('描画先の要素がありません');
    }
    if (!globalThis.ConquestData) {
      throw new Error('ConquestData が読み込まれていません');
    }

    const game = {
      state: globalThis.ConquestData.createInitialState(),
      renderMap: function () {
        renderMap(root, game.state.map);
      },
      renderLog: function (message, result) {
        renderLog(root, message, result);
      },
      dispatch: function (row, col) {
        const outcome = dispatchToCell(game.state, row, col);
        if (!outcome) {
          return null;
        }
        renderMap(root, game.state.map);
        refreshPlayer(root, game.state.player);
        renderLog(root, formatBattleLog(outcome, game.state.player), outcome.battle.result);
        return outcome;
      },
      /**
       * メニューにあるカードを1枚買う。
       * 成功したら所持ゴールド、派遣カード、ボタンの押せる状態を描き直す。
       *
       * @param {string} templateId
       * @returns {object|null}
       */
      evolve: function (templateId) {
        const card = evolveCard(game.state.player, templateId);
        if (!card) {
          return null;
        }
        refreshPlayer(root, game.state.player);
        return card;
      },
      /**
       * 探索状況、所持ゴールド、追加したカード、戦闘ログを捨てて最初からにする。
       * カードの初期所持も createInitialState の定義に従う。
       */
      reset: function () {
        game.state = globalThis.ConquestData.createInitialState();
        refreshPlayer(root, game.state.player);
        renderMap(root, game.state.map);
        renderLog(root, '');
      },
    };

    root.replaceChildren(createBoardElement());
    refreshPlayer(root, game.state.player);
    renderMap(root, game.state.map);
    return game;
  }

  globalThis.ConquestGame = {
    start: start,
    formatCellLabel: formatCellLabel,
  };
})();
