/**
 * game.js
 * マップの描画。
 *
 * データは ConquestData、起動は main.js が担当する。
 * このファイルは state を画面へ反映するだけにする。
 * 派遣や戦闘で state が変わったら renderMap() を呼べば、同じ手順で描き直せる。
 *
 * 公開 API は globalThis.ConquestGame。
 */
(function () {
  'use strict';

  /**
   * 未探索マスの出し方。
   * true  … 隠したゴールドの数値をそのまま出す（今の確認用）。
   * false … 未探索は「？」。探索済み（isRevealed）のマスだけ数値を出す。
   */
  const SHOW_HIDDEN_GOLD = true;

  /**
   * マスに出す文字列。
   * 表示の切り替えはここだけに閉じる。DOM 側は返ってきた文字を載せる。
   *
   * @param {{ gold: number, isRevealed: boolean }} cell
   * @returns {string}
   */
  function formatCellLabel(cell) {
    if (!cell.isRevealed && !SHOW_HIDDEN_GOLD) {
      return '？';
    }
    return String(cell.gold);
  }

  /**
   * マス1つ分の要素。
   * クリックはまだ付けない。行と列は data-row / data-col に残してあるので、
   * 派遣を足すときはこの要素へ listener を付けるだけでマスを特定できる。
   *
   * @param {{ gold: number, isRevealed: boolean, enemy: object|null }} cell
   * @param {number} row
   * @param {number} col
   * @returns {HTMLElement}
   */
  function createCellElement(cell, row, col) {
    const element = document.createElement('div');
    element.className = 'map-cell';
    element.classList.add(cell.isRevealed ? 'is-revealed' : 'is-hidden');
    element.dataset.row = String(row);
    element.dataset.col = String(col);
    element.setAttribute('role', 'gridcell');

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
    grid.setAttribute('role', 'grid');
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
   * [data-region="map"] … マップ。再描画で中身だけ入れ替える。
   * [data-region="log"] … 戦闘結果などをあとから出す場所。空のあいだは表示しない。
   * @returns {HTMLElement}
   */
  function createBoardElement() {
    const board = document.createElement('div');
    board.className = 'board';

    const mapHost = document.createElement('div');
    mapHost.className = 'map-host';
    mapHost.dataset.region = 'map';

    const logHost = document.createElement('div');
    logHost.className = 'log-host';
    logHost.dataset.region = 'log';
    logHost.setAttribute('aria-live', 'polite');

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
   * 戦闘結果などの一文をログ領域へ出す。空文字なら領域を空に戻す。
   * @param {HTMLElement} root
   * @param {string} message
   */
  function renderLog(root, message) {
    const logHost = root.querySelector('[data-region="log"]');
    if (!logHost) {
      throw new Error('ログの描画先がありません');
    }
    logHost.textContent = message || '';
  }

  /**
   * 初期 state を作り、#app にマップを出す。
   * 戻り値の state を更新したあと renderMap() / renderLog() を呼ぶと画面が追従する。
   *
   * @param {HTMLElement} root
   * @returns {{
   *   state: { player: object, map: object[][] },
   *   renderMap: () => void,
   *   renderLog: (message: string) => void
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
    renderMap(root, state.map);

    return {
      state: state,
      renderMap: function () {
        renderMap(root, state.map);
      },
      renderLog: function (message) {
        renderLog(root, message);
      },
    };
  }

  globalThis.ConquestGame = {
    start: start,
    formatCellLabel: formatCellLabel,
  };
})();
