/**
 * game.js
 * マップの描画と、マスへの派遣。
 *
 * データは ConquestData、クリックの受け取りは main.js が担当する。
 * 派遣で state が変わったら renderMap() と renderLog() で画面を追従させる。
 *
 * 戦闘に出すユニットは getDispatchUnit() だけが決める。
 * 今は所持カードの先頭1枚。編成は player.formation にカード配列を入れれば、
 * 戦闘力の合計としてそのまま resolveBattle に渡せる。
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
   * 今回派遣するユニット。
   * formation に1枚以上あればそれを優先する。無ければ所持の先頭。
   * 戻り値はそのまま resolveBattle に渡せる。
   *
   * @param {{ cards: object[], formation?: object[] }} player
   * @returns {object|object[]}
   */
  function getDispatchUnit(player) {
    if (Array.isArray(player.formation) && player.formation.length > 0) {
      return player.formation;
    }
    const card = player.cards[0];
    if (!card) {
      throw new Error('派遣できるカードがありません');
    }
    return card;
  }

  /**
   * 戦闘ログの一文。勝敗、獲得ゴールド、その時点の所持を出す。
   * @param {{ unit: object|object[], enemy: { name: string }, battle: { result: string, rewardGold: number } }} outcome
   * @param {{ gold: number }} player
   * @returns {string}
   */
  function formatBattleLog(outcome, player) {
    const unitName = formatUnitName(outcome.unit);
    const enemyName = outcome.enemy.name;
    const held = '所持ゴールドは' + player.gold + '。';

    if (outcome.battle.result === 'win') {
      return unitName + 'が' + enemyName + 'に勝った。' +
        outcome.battle.rewardGold + 'ゴールドを獲得した。' + held;
    }
    return unitName + 'は' + enemyName + 'に敗れた。ゴールドは得られなかった。' + held;
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

    const logHost = document.createElement('div');
    logHost.className = 'log-host';
    logHost.dataset.region = 'log';
    logHost.setAttribute('aria-live', 'polite');

    board.appendChild(statusHost);
    board.appendChild(mapHost);
    board.appendChild(logHost);
    return board;
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
   * 所持ゴールドと、いま派遣できるカード名を出す。
   * @param {HTMLElement} root
   * @param {{ gold: number, cards: object[], formation?: object[] }} player
   */
  function renderStatus(root, player) {
    const statusHost = root.querySelector('[data-region="status"]');
    if (!statusHost) {
      throw new Error('ステータスの描画先がありません');
    }
    const unitName = formatUnitName(getDispatchUnit(player));
    statusHost.textContent = '派遣: ' + unitName + '　所持ゴールド ' + player.gold;
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
   *
   * @param {HTMLElement} root
   * @returns {{
   *   state: { player: object, map: object[][] },
   *   renderMap: () => void,
   *   renderLog: (message: string, result?: string) => void,
   *   dispatch: (row: number, col: number) => object|null
   * }}
   */
  function start(root) {
    if (!root) {
      throw new Error('描画先の要素がありません');
    }
    if (!globalThis.ConquestData) {
      throw new Error('ConquestData が読み込まれていません');
    }

    const state = globalThis.ConquestData.createInitialState();
    root.replaceChildren(createBoardElement());
    renderStatus(root, state.player);
    renderMap(root, state.map);

    return {
      state: state,
      renderMap: function () {
        renderMap(root, state.map);
      },
      renderLog: function (message, result) {
        renderLog(root, message, result);
      },
      dispatch: function (row, col) {
        const outcome = dispatchToCell(state, row, col);
        if (!outcome) {
          return null;
        }
        renderMap(root, state.map);
        renderStatus(root, state.player);
        renderLog(root, formatBattleLog(outcome, state.player), outcome.battle.result);
        return outcome;
      },
    };
  }

  globalThis.ConquestGame = {
    start: start,
    formatCellLabel: formatCellLabel,
  };
})();
