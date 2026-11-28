/**
 * game.js
 * マップの描画と、マスへの派遣。
 *
 * データは ConquestData、クリックの受け取りは main.js が担当する。
 * 派遣で state が変わったら renderMap() と renderLog() で画面を追従させる。
 * すべてのマスが Claimed になったらクリア。表示は renderClear()。
 * 進行は localStorage へ手動で保存し、次に開いたとき保存があれば読み込む。
 *
 * 戦闘に出すカードは getDispatchUnit() だけが決める。
 * 編成 formationIds に1枚以上あれば、その並びで戦う。
 * 戦闘力は formationPower() のボーナス後。1枚はそのまま、2枚は +10%、3枚は +20%。
 * 編成が空なら、所持一覧で選んだ1枚で戦う。1枚なのでボーナスは付かない。
 * 未選択のときだけ、power が一番高い1枚を選んでおく。
 * 選択は player.selectedIds、編成は player.formationIds。どちらも instanceId の配列。
 * 編成の添字が枠の位置。効果や並べ順のボーナスは、この並びを読めば足せる。
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
   * 編成に同時に入れられる枚数。
   * 枠を増やすときはこの数を変え、枚数ボーナスも FORMATION_POWER_BONUS に足す。
   */
  const FORMATION_SIZE = 3;

  /**
   * 編成枚数ごとの戦闘力倍率。合計Powerにこの倍率を掛ける。
   * 1枚は 1（ボーナスなし）。2枚は 1.1（+10%）。3枚は 1.2（+20%）。
   * 率を変えるとき、枠を増やしたときは、この表だけを直す。
   * 表に無い枚数は 1 として扱い、ボーナスは付かない。
   */
  const FORMATION_POWER_BONUS = {
    1: 1,
    2: 1.1,
    3: 1.2,
  };

  /**
   * ブラウザに残すセーブのキーと版。
   * 中身の形を変えたら SAVE_VERSION を上げ、古いデータは読み捨てる。
   */
  const SAVE_KEY = 'conquest-simple-save';
  const SAVE_VERSION = 1;

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
   * 所持一覧の1行。名前のうしろに戦闘力を付ける。
   * 例: ゴブリン (Power 10)
   * @param {{ name: string, power: number, level?: number }} card
   * @returns {string}
   */
  function formatOwnedCard(card) {
    return formatCardName(card) + ' (Power ' + card.power + ')';
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
   * 所持のうち power が最大の1枚。同じ値なら配列の先を残す。
   * 選択がまだ無いときの初期値に使う。
   *
   * @param {{ cards: object[] }} player
   * @returns {object}
   */
  function strongestCard(player) {
    return player.cards.reduce(function (strongest, card) {
      if (card.power > strongest.power) {
        return card;
      }
      return strongest;
    });
  }

  /**
   * instanceId で所持カードを1枚取る。無ければ null。
   * @param {{ cards: object[] }} player
   * @param {number} instanceId
   * @returns {object|null}
   */
  function findOwnedCard(player, instanceId) {
    for (let i = 0; i < player.cards.length; i++) {
      if (player.cards[i].instanceId === instanceId) {
        return player.cards[i];
      }
    }
    return null;
  }

  /**
   * 選択中の1枚が所持に残っているか確認し、空なら最強の1枚を選ぶ。
   * selectedIds はフォールバック用。編成が入っているあいだは戦闘に使わない。
   * 今の操作では1件だけ入る。
   *
   * @param {{ cards: object[], selectedIds?: number[] }} player
   */
  function ensureSelection(player) {
    if (!Array.isArray(player.selectedIds)) {
      player.selectedIds = [];
    }
    player.selectedIds = player.selectedIds.filter(function (id) {
      return findOwnedCard(player, id);
    });
    if (player.selectedIds.length === 0 && player.cards.length > 0) {
      player.selectedIds = [strongestCard(player).instanceId];
    }
  }

  /**
   * 編成枠を整える。
   * 所持に無い id と、同じ instanceId の重複を落とす。並び順は残す。
   * 枚数は FORMATION_SIZE まで。あふれた後ろは捨てる。
   *
   * @param {{ cards: object[], formationIds?: number[] }} player
   */
  function ensureFormation(player) {
    if (!Array.isArray(player.formationIds)) {
      player.formationIds = [];
    }
    const kept = [];
    player.formationIds.forEach(function (id) {
      if (kept.length >= FORMATION_SIZE) {
        return;
      }
      if (kept.indexOf(id) !== -1) {
        return;
      }
      if (!findOwnedCard(player, id)) {
        return;
      }
      kept.push(id);
    });
    player.formationIds = kept;
  }

  /**
   * 編成スロットのカードを、左の枠から順に返す。
   * 戦闘も表示もこの順を使う。効果を足すときは添字が枠番号になる。
   *
   * @param {{ cards: object[], formationIds?: number[] }} player
   * @returns {object[]}
   */
  function formationCards(player) {
    ensureFormation(player);
    const cards = [];
    player.formationIds.forEach(function (id) {
      const card = findOwnedCard(player, id);
      if (card) {
        cards.push(card);
      }
    });
    return cards;
  }

  /**
   * 編成の戦闘力。表示と戦闘が同じ値を使う。
   * 基準はカード power の合計。倍率は FORMATION_POWER_BONUS の枚数。
   * ボーナス後は四捨五入して整数にする。小数のまま戦闘へ渡さない。
   * 0枚や表に無い枚数は倍率 1。power は基準の合計のまま。
   *
   * @param {object[]} cards
   * @returns {{ count: number, basePower: number, power: number, rate: number, percent: number }}
   */
  function formationPower(cards) {
    const list = cards || [];
    const rate = Object.prototype.hasOwnProperty.call(FORMATION_POWER_BONUS, list.length)
      ? FORMATION_POWER_BONUS[list.length]
      : 1;
    const basePower = list.reduce(function (sum, card) {
      return sum + card.power;
    }, 0);
    return {
      count: list.length,
      basePower: basePower,
      power: Math.round(basePower * rate),
      rate: rate,
      percent: Math.round((rate - 1) * 100),
    };
  }

  /**
   * 編成欄の合計。ボーナスが無いときは「編成 Power: 10」。
   * 2枚以上で倍率が 1 を超えるときは「編成 Power: 70 → 84 (+20%)」。
   * 矢印の左が合計、右が戦闘に使う値。
   *
   * @param {{ basePower: number, power: number, percent: number }} summary
   * @returns {string}
   */
  function formatFormationPower(summary) {
    if (summary.percent > 0) {
      return '編成 Power: ' + summary.basePower + ' → ' + summary.power +
        ' (+' + summary.percent + '%)';
    }
    return '編成 Power: ' + summary.basePower;
  }

  /**
   * そのカードが、選択中の1枚か。
   * @param {{ selectedIds?: number[] }} player
   * @param {{ instanceId: number }} card
   * @returns {boolean}
   */
  function isDispatchSelected(player, card) {
    return Array.isArray(player.selectedIds) &&
      player.selectedIds.indexOf(card.instanceId) !== -1;
  }

  /**
   * 編成枠の位置。入っていなければ -1。0 が左端。
   * @param {{ formationIds?: number[] }} player
   * @param {{ instanceId: number }} card
   * @returns {number}
   */
  function formationSlotIndex(player, card) {
    if (!Array.isArray(player.formationIds)) {
      return -1;
    }
    return player.formationIds.indexOf(card.instanceId);
  }

  /**
   * 今回派遣するカード。
   * 編成が1枚以上ならその並び。1枚ならカードそのもの、2枚以上なら配列。
   * 編成が空なら、選択中の1枚。戻り値はそのまま resolveBattle に渡せる。
   *
   * @param {{ cards: object[], selectedIds?: number[], formationIds?: number[] }} player
   * @returns {object|object[]}
   */
  function getDispatchUnit(player) {
    ensureSelection(player);
    const formed = formationCards(player);
    if (formed.length === 1) {
      return formed[0];
    }
    if (formed.length > 1) {
      return formed;
    }

    const selected = player.cards.filter(function (card) {
      return isDispatchSelected(player, card);
    });
    if (selected.length === 0) {
      throw new Error('派遣できるカードがありません');
    }
    if (selected.length === 1) {
      return selected[0];
    }
    return selected;
  }

  /**
   * 編成が空のときに出す1枚を、指定した所持カードにする。
   * 所持に無い id では何も変えない。編成の中身は変えない。
   *
   * @param {{ cards: object[], selectedIds?: number[] }} player
   * @param {number} instanceId
   * @returns {object|null}
   */
  function selectDispatch(player, instanceId) {
    const card = findOwnedCard(player, instanceId);
    if (!card) {
      return null;
    }
    player.selectedIds = [card.instanceId];
    return card;
  }

  /**
   * 所持カードを編成へ入れる。すでに入っていれば外す。
   * 同じ instanceId は1枠まで。種類が同じ別カードは、別の instanceId なので入れられる。
   * 枠がいっぱいのとき、新しいカードは入れず null を返す。
   *
   * @param {{ cards: object[], formationIds?: number[] }} player
   * @param {number} instanceId
   * @returns {object|null}
   */
  function toggleFormation(player, instanceId) {
    const card = findOwnedCard(player, instanceId);
    if (!card) {
      return null;
    }
    ensureFormation(player);
    const index = player.formationIds.indexOf(card.instanceId);
    if (index !== -1) {
      player.formationIds.splice(index, 1);
      return card;
    }
    if (player.formationIds.length >= FORMATION_SIZE) {
      return null;
    }
    player.formationIds.push(card.instanceId);
    return card;
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
   * 2枚以上でボーナスがあるときは、名前のあとに「（編成 +10%）」を足す。
   * 敵が複数なら、名前を「ゴブリン・ゴブリン」のようにつなぐ。
   *
   * @param {{ unit: object|object[], enemy: object|object[], battle: { result: string, rewardGold: number }, formationBonus?: { percent: number } }} outcome
   * @param {{ gold: number }} player
   * @returns {string}
   */
  function formatBattleLog(outcome, player) {
    const bonus = outcome.formationBonus;
    const bonusNote = bonus && bonus.percent > 0 ? '（編成 +' + bonus.percent + '%）' : '';
    const unitName = formatUnitName(outcome.unit) + bonusNote;
    const enemyName = formatUnitName(outcome.enemy);
    const held = '（所持:\u00A0' + player.gold + '）';

    if (outcome.battle.result === 'win') {
      return 'Victory! ' + unitName + 'が' + enemyName + 'を倒した。+' +
        outcome.battle.rewardGold + '\u00A0Gold' + held;
    }
    return 'Defeated... ' + unitName + 'は' + enemyName + 'に敗れた。' + held;
  }

  /**
   * 地形 id と CSS クラスの対応。色そのものは style.css が持つ。
   * 地形を足すときは、ここへ1行足し、TERRAIN_ENGLISH にも同じ id を足す。
   */
  const TERRAIN_CLASS = {
    forest: 'terrain-forest',
    wasteland: 'terrain-wasteland',
    mountain: 'terrain-mountain',
  };

  /**
   * 凡例に出す英語名。日本語名は ConquestData.TERRAIN_TABLE を使う。
   * 地形を足すときは、TERRAIN_CLASS とここへ同じ id を足す。
   */
  const TERRAIN_ENGLISH = {
    forest: 'Forest',
    wasteland: 'Wasteland',
    mountain: 'Mountain',
  };

  /**
   * マップの上に置く地形の凡例。
   * 色見本はマスと同じクラスを付ける。色の値は style.css が1か所で持つ。
   * マップ本体は派遣のたびに作り直すが、凡例は静的なのでここだけで作る。
   * @returns {HTMLElement}
   */
  function createTerrainLegendElement() {
    const table = (globalThis.ConquestData && globalThis.ConquestData.TERRAIN_TABLE) || [
      { id: 'forest', name: '森' },
      { id: 'wasteland', name: '荒野' },
      { id: 'mountain', name: '山脈' },
    ];

    const legend = document.createElement('ul');
    legend.className = 'terrain-legend';
    legend.setAttribute('aria-label', '地形の凡例');

    table.forEach(function (entry) {
      const item = document.createElement('li');
      item.className = 'terrain-legend-item';

      const swatch = document.createElement('span');
      swatch.className = 'terrain-legend-swatch';
      if (TERRAIN_CLASS[entry.id]) {
        swatch.classList.add(TERRAIN_CLASS[entry.id]);
      }
      swatch.setAttribute('aria-hidden', 'true');

      const name = document.createElement('span');
      name.className = 'terrain-legend-name';
      name.textContent = entry.name + ' ' + (TERRAIN_ENGLISH[entry.id] || entry.id);

      item.appendChild(swatch);
      item.appendChild(name);
      legend.appendChild(item);
    });

    return legend;
  }

  /**
   * マス1つ分の要素。
   * 未探索は button で "Void"。探索済みは "Claimed" とし、disabled にして再クリックできないようにする。
   * 地形クラスは Void でも Claimed でも付けたままにする。
   * ボスは is-boss と "Boss" の印を足す。色と枠は CSS が担当する。
   * 未攻略を暗く、攻略済みを明るくする差は CSS が担当する。
   * 行と列は data-row / data-col。クリック位置の特定は main.js が行う。
   *
   * @param {{ gold: number, isRevealed: boolean, enemy: object|null, terrain?: string }} cell
   * @param {number} row
   * @param {number} col
   * @returns {HTMLButtonElement}
   */
  function createCellElement(cell, row, col) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'map-cell';
    element.classList.add(cell.isRevealed ? 'is-revealed' : 'is-hidden');
    if (TERRAIN_CLASS[cell.terrain]) {
      element.classList.add(TERRAIN_CLASS[cell.terrain]);
    }
    if (cell.encounter === 'boss') {
      element.classList.add('is-boss');
    }
    element.dataset.row = String(row);
    element.dataset.col = String(col);
    element.disabled = cell.isRevealed;

    if (cell.encounter === 'boss') {
      const badge = document.createElement('span');
      badge.className = 'map-cell-badge';
      badge.textContent = 'Boss';
      element.appendChild(badge);
    }

    const label = document.createElement('span');
    label.className = 'map-cell-label';
    label.textContent = formatCellLabel(cell);
    element.appendChild(label);

    return element;
  }

  /**
   * マップのグリッド。列数はマップの行数から決める。
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
   * [data-region="formation"] … 編成枠。最大 FORMATION_SIZE。中身だけ入れ替える。
   * [data-region="cards"] … 所持カードの一覧。中身だけ入れ替える。
   * .terrain-legend … 地形の色と名前。静的なので再描画しない。
   * [data-region="map"] … マップ。再描画で中身だけ入れ替える。
   * [data-region="clear"] … 全マス攻略時の Clear!。空のあいだは表示しない。
   * [data-action="evolve"] … ゴールドでカードを追加するボタン。押す処理は main.js。
   * [data-action="save"] … 進行を localStorage へ書く。押す処理は main.js。
   * [data-action="reset"] … 確認のあと初期状態へ戻し、保存も消す。押す処理は main.js。
   * [data-region="log"] … 戦闘結果。空のあいだは表示しない。
   * @returns {HTMLElement}
   */
  function createBoardElement() {
    const board = document.createElement('div');
    board.className = 'board';

    const statusHost = document.createElement('div');
    statusHost.className = 'status-host';
    statusHost.dataset.region = 'status';

    const cardsHost = document.createElement('section');
    cardsHost.className = 'cards-host';
    cardsHost.dataset.region = 'cards';

    const cardsHeading = document.createElement('h2');
    cardsHeading.className = 'cards-heading';
    cardsHeading.textContent = '所持カード';

    const cardsList = document.createElement('ul');
    cardsList.className = 'cards-list';

    cardsHost.appendChild(cardsHeading);
    cardsHost.appendChild(cardsList);

    const mapHost = document.createElement('div');
    mapHost.className = 'map-host';
    mapHost.dataset.region = 'map';

    const clearHost = document.createElement('div');
    clearHost.className = 'clear-banner';
    clearHost.dataset.region = 'clear';
    clearHost.setAttribute('role', 'status');
    clearHost.setAttribute('aria-live', 'polite');

    const sessionActions = document.createElement('div');
    sessionActions.className = 'session-actions';

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'save-button';
    saveButton.dataset.action = 'save';
    saveButton.textContent = 'Save';

    const resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.className = 'reset-button';
    resetButton.dataset.action = 'reset';
    resetButton.textContent = 'Reset';

    const saveNote = document.createElement('p');
    saveNote.className = 'save-note';
    saveNote.dataset.region = 'save-note';
    saveNote.setAttribute('aria-live', 'polite');

    sessionActions.appendChild(saveButton);
    sessionActions.appendChild(resetButton);

    const logHost = document.createElement('div');
    logHost.className = 'log-host';
    logHost.dataset.region = 'log';
    logHost.setAttribute('aria-live', 'polite');

    board.appendChild(statusHost);
    board.appendChild(createFormationElement());
    board.appendChild(cardsHost);
    board.appendChild(createTerrainLegendElement());
    board.appendChild(mapHost);
    board.appendChild(clearHost);
    board.appendChild(createEvolveElement());
    board.appendChild(sessionActions);
    board.appendChild(saveNote);
    board.appendChild(logHost);
    return board;
  }

  /**
   * 編成枠の置き場。中身と合計Powerは renderFormation が描き直す。
   * 枠は常に FORMATION_SIZE 個。空でも枠自体は残し、最大枚数が分かるようにする。
   * @returns {HTMLElement}
   */
  function createFormationElement() {
    const host = document.createElement('section');
    host.className = 'formation-host';
    host.dataset.region = 'formation';

    const headingRow = document.createElement('div');
    headingRow.className = 'formation-heading-row';

    const heading = document.createElement('h2');
    heading.className = 'formation-heading';
    heading.textContent = '編成';

    const power = document.createElement('p');
    power.className = 'formation-power';
    power.textContent = '編成 Power: 0';

    const slots = document.createElement('ol');
    slots.className = 'formation-slots';
    slots.setAttribute('aria-label', '編成枠。最大' + FORMATION_SIZE + '枚');

    headingRow.appendChild(heading);
    headingRow.appendChild(power);
    host.appendChild(headingRow);
    host.appendChild(slots);
    return host;
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
   * 戦闘力は formationPower のボーナス後。1枚ならその power。
   * 例: 派遣: オーク (Power 20)　所持ゴールド 70
   * 編成が2枚以上なら名前を「・」でつなぎ、ボーナスがあるときは +10% のように出す。
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
    const summary = formationPower(cards);
    const bonusNote = summary.percent > 0 ? ' +' + summary.percent + '%' : '';

    statusHost.textContent =
      '派遣: ' + formatUnitName(unit) + ' (Power ' + summary.power + bonusNote + ')　所持ゴールド ' + player.gold;
  }

  /**
   * 編成枠を左から FORMATION_SIZE 個描く。空きは「空」。
   * 入っている枠には名前と Power を出し、押すとそのカードを外す。
   * 合計は編成中の power だけ。未編成なら 0。選択中の1枚は含めない。
   * 2枚以上でボーナスがあるときは「70 → 84 (+20%)」と、戦闘に使う値も出す。
   * 入れ外しのあとは refreshPlayer からここが呼ばれ、枠と合計が同時に更新される。
   * 並びは formationIds の順。効果を足すときもこの順が枠の位置になる。
   *
   * @param {HTMLElement} root
   * @param {{ cards: object[], formationIds?: number[] }} player
   */
  function renderFormation(root, player) {
    const host = root.querySelector('[data-region="formation"]');
    const slots = host && host.querySelector('.formation-slots');
    const total = host && host.querySelector('.formation-power');
    if (!slots || !total) {
      throw new Error('編成の描画先がありません');
    }

    const formed = formationCards(player);
    total.textContent = formatFormationPower(formationPower(formed));

    slots.replaceChildren();
    for (let i = 0; i < FORMATION_SIZE; i++) {
      const card = formed[i] || null;
      const slotNumber = i + 1;
      const item = document.createElement('li');
      item.className = 'formation-slot';

      const index = document.createElement('span');
      index.className = 'formation-slot-index';
      index.textContent = String(slotNumber);

      if (!card) {
        item.classList.add('is-empty');
        const empty = document.createElement('span');
        empty.className = 'formation-slot-empty';
        empty.textContent = '空';
        item.setAttribute('aria-label', slotNumber + '枠目 空');
        item.appendChild(index);
        item.appendChild(empty);
        slots.appendChild(item);
        continue;
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'formation-slot-button';
      button.dataset.action = 'toggle-formation';
      button.dataset.instanceId = String(card.instanceId);
      button.title = '編成から外す';
      button.setAttribute('aria-label', slotNumber + '枠目 ' + formatCardName(card) + ' Power ' + card.power + ' を外す');

      const name = document.createElement('span');
      name.className = 'formation-slot-name';
      name.textContent = formatCardName(card);

      const power = document.createElement('span');
      power.className = 'formation-slot-power';
      power.textContent = 'Power ' + card.power;

      button.appendChild(index);
      button.appendChild(name);
      button.appendChild(power);
      item.appendChild(button);
      slots.appendChild(item);
    }
  }

  /**
   * 所持カードを上から順に出す。並びは player.cards の順。
   * 名前のボタンは選択中の1枚を切り替える。右のボタンで編成へ入れる／外す。
   * 選択中は色と「選択中」。編成中は枠番号。両方は同時に付けられる。
   * 進化で push したカードは末尾に足され、次の再描画で現れる。編成には自動で入らない。
   *
   * @param {HTMLElement} root
   * @param {{ cards: object[], selectedIds?: number[], formationIds?: number[] }} player
   */
  function renderCards(root, player) {
    const list = root.querySelector('[data-region="cards"] .cards-list');
    if (!list) {
      throw new Error('所持カードの描画先がありません');
    }

    ensureSelection(player);
    ensureFormation(player);
    const formationFull = player.formationIds.length >= FORMATION_SIZE;
    list.replaceChildren();
    player.cards.forEach(function (card) {
      const item = document.createElement('li');
      item.className = 'cards-row';
      const button = document.createElement('button');
      const selected = isDispatchSelected(player, card);
      const slotIndex = formationSlotIndex(player, card);

      button.type = 'button';
      button.className = 'cards-item';
      button.dataset.action = 'select-card';
      button.dataset.instanceId = String(card.instanceId);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
      if (selected) {
        button.classList.add('is-selected');
      }

      const name = document.createElement('span');
      name.className = 'cards-item-name';
      name.textContent = formatOwnedCard(card);
      button.appendChild(name);

      const marks = [];
      if (selected) {
        marks.push('選択中');
      }
      if (slotIndex !== -1) {
        marks.push('編成' + (slotIndex + 1));
      }
      if (marks.length > 0) {
        const mark = document.createElement('span');
        mark.className = 'cards-item-mark';
        mark.textContent = marks.join(' ');
        button.appendChild(mark);
      }

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'cards-formation-button';
      toggle.dataset.action = 'toggle-formation';
      toggle.dataset.instanceId = String(card.instanceId);
      if (slotIndex !== -1) {
        toggle.classList.add('is-in-formation');
        toggle.textContent = '外す';
        toggle.setAttribute('aria-label', '編成から外す');
        toggle.setAttribute('aria-pressed', 'true');
      } else {
        toggle.textContent = '編成に入れる';
        toggle.setAttribute('aria-label', '編成に入れる');
        toggle.setAttribute('aria-pressed', 'false');
        toggle.disabled = formationFull;
        if (formationFull) {
          toggle.title = '編成は' + FORMATION_SIZE + '枚まで';
        }
      }

      item.appendChild(button);
      item.appendChild(toggle);
      list.appendChild(item);
    });
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
   * ステータス、所持一覧、進化ボタンを、今の所持に合わせる。
   * 戦闘・進化・リセットのあとで呼ぶ。
   *
   * @param {HTMLElement} root
   * @param {object} player
   */
  function refreshPlayer(root, player) {
    ensureSelection(player);
    ensureFormation(player);
    renderStatus(root, player);
    renderFormation(root, player);
    renderCards(root, player);
    renderEvolve(root, player);
  }

  /**
   * マップ上のマスがすべて攻略済みか。
   * 1マスでも Void が残っていればクリアではない。空のマップはクリアにしない。
   *
   * @param {Array<Array<{ isRevealed: boolean }>>} map
   * @returns {boolean}
   */
  function isMapCleared(map) {
    if (!map || map.length === 0) {
      return false;
    }
    for (let row = 0; row < map.length; row++) {
      for (let col = 0; col < map[row].length; col++) {
        if (!map[row][col].isRevealed) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * クリア表示。cleared が false のときは中身を空にして隠す。
   * 戦闘ログとは別に出す。最後の勝敗はログに残し、ここは達成だけを知らせる。
   *
   * @param {HTMLElement} root
   * @param {boolean} cleared
   */
  function renderClear(root, cleared) {
    const banner = root.querySelector('[data-region="clear"]');
    if (!banner) {
      throw new Error('クリア表示の描画先がありません');
    }
    banner.replaceChildren();
    if (!cleared) {
      return;
    }

    const title = document.createElement('p');
    title.className = 'clear-banner-title';
    title.textContent = 'Clear!';

    const note = document.createElement('p');
    note.className = 'clear-banner-note';
    note.textContent = 'すべてのマスを攻略した';

    banner.appendChild(title);
    banner.appendChild(note);
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
   * 敵は terrain に応じた1〜3体の編成。ボスはその地形の BOSS_FORMATIONS を使う。
   * プレイヤーの戦闘力は formationPower のボーナス後。敵は合計のまま。
   * 数値は敵専用で、所持カードとは別。所持カードの power はここでは変えない。
   * ボスの goldBonus は、マスのゴールドへ足してから戦闘へ渡す。
   * 探索済みなら何も変えず null を返す。全マス攻略のあとにも戦闘は起こさない。
   * 敗北でもマスはそのままなので、再クリックできる。
   * 勝利時だけ isRevealed を立て、獲得ゴールドを財布へ足す。
   * rewardGold にはマスのゴールドが既に含まれている。ここで cell.gold は足さない。
   *
   * @param {{ player: object, map: object[][] }} state
   * @param {number} row
   * @param {number} col
   * @returns {null|{ unit: object|object[], enemy: object, battle: object, cell: object }}
   */
  function dispatchToCell(state, row, col) {
    if (isMapCleared(state.map)) {
      return null;
    }
    const line = state.map[row];
    const cell = line && line[col];
    if (!cell || cell.isRevealed) {
      return null;
    }

    const unit = getDispatchUnit(state.player);
    const dispatchCards = Array.isArray(unit) ? unit : [unit];
    const formationBonus = formationPower(dispatchCards);
    const bossTable = cell.encounter === 'boss'
      ? globalThis.ConquestData.BOSS_FORMATIONS[cell.terrain]
      : null;
    const enemy = globalThis.ConquestData.createEnemyFormation(
      cell.terrain,
      undefined,
      bossTable || undefined
    );
    const battle = globalThis.ConquestData.resolveBattle(unit, enemy, {
      cellGold: cell.gold + (cell.goldBonus || 0),
      playerPower: formationBonus.power,
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
      formationBonus: formationBonus,
    };
  }

  /**
   * localStorage の読み書き。使えない環境や容量不足では例外を外へ出さない。
   * @param {string} key
   * @returns {string|null}
   */
  function readStorage(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  /**
   * @param {string} key
   * @param {string} value
   * @returns {boolean}
   */
  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * @param {string} key
   * @returns {boolean}
   */
  function removeStorage(key) {
    try {
      window.localStorage.removeItem(key);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * 保存用に、カードからプレーンな項目だけを写す。
   * @param {object} card
   * @returns {object}
   */
  function copyCard(card) {
    const copy = {
      instanceId: card.instanceId,
      templateId: card.templateId,
      name: card.name,
      power: card.power,
      rewardGold: card.rewardGold,
      rank: card.rank,
    };
    if (card.level != null) {
      copy.level = card.level;
    }
    return copy;
  }

  /**
   * マスに残した敵を保存用に写す。1体の古いデータも、1〜3体の配列も受け取る。
   * @param {object|object[]|null} enemy
   * @returns {object|object[]|null}
   */
  function copyEnemyUnit(enemy) {
    if (!enemy) {
      return null;
    }
    if (Array.isArray(enemy)) {
      return enemy.map(copyCard);
    }
    return copyCard(enemy);
  }

  /**
   * 読み込んだオブジェクトがカードとして使えるなら、新しいオブジェクトにして返す。
   * 未知のテンプレートや壊れた数値は null。通った ID は次の採番へ知らせる。
   *
   * @param {object} raw
   * @returns {object|null}
   */
  function restoreCard(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return null;
    }
    const templates = globalThis.ConquestData.CARD_TEMPLATES;
    const template = templates[raw.templateId];
    const instanceId = Number(raw.instanceId);
    const power = Number(raw.power);
    const rewardGold = Number(raw.rewardGold);
    if (!template || !isFinite(instanceId) || !isFinite(power) || !isFinite(rewardGold)) {
      return null;
    }

    const card = {
      instanceId: instanceId,
      templateId: template.id,
      name: typeof raw.name === 'string' && raw.name ? raw.name : template.name,
      power: power,
      rewardGold: rewardGold,
      rank: isFinite(Number(raw.rank)) ? Number(raw.rank) : template.rank,
    };
    if (raw.level != null && isFinite(Number(raw.level))) {
      card.level = Number(raw.level);
    }
    globalThis.ConquestData.noteInstanceId(instanceId);
    return card;
  }

  /**
   * 保存されていた敵を戻す。配列なら編成、オブジェクトなら以前の1体。
   * 中身が壊れていれば null。呼び出し側はセーブ全体を読み捨てる。
   *
   * @param {object|object[]|null} raw
   * @returns {object|object[]|null}
   */
  function restoreEnemyUnit(raw) {
    if (raw == null) {
      return null;
    }
    if (Array.isArray(raw)) {
      if (raw.length < 1 || raw.length > 3) {
        return null;
      }
      const enemies = [];
      for (let i = 0; i < raw.length; i++) {
        const card = restoreCard(raw[i]);
        if (!card) {
          return null;
        }
        enemies.push(card);
      }
      return enemies;
    }
    return restoreCard(raw);
  }

  /**
   * 所持にある ID だけを、重複なく、上限まで残す。
   * @param {Array} raw
   * @param {object[]} cards
   * @param {number} [limit]
   * @returns {number[]}
   */
  function restoreIdList(raw, cards, limit) {
    if (!Array.isArray(raw)) {
      return [];
    }
    const owned = {};
    cards.forEach(function (card) {
      owned[card.instanceId] = true;
    });
    const ids = [];
    raw.forEach(function (id) {
      const numeric = Number(id);
      if (!owned[numeric] || ids.indexOf(numeric) !== -1) {
        return;
      }
      if (limit != null && ids.length >= limit) {
        return;
      }
      ids.push(numeric);
    });
    return ids;
  }

  /**
   * セーブ全体を検証して、ゲームが使う state にする。
   * 1か所でも壊れていれば null。呼び出し側は初期状態へ戻す。
   *
   * @param {object} raw
   * @returns {{ player: object, map: object[][] }|null}
   */
  function restoreState(raw) {
    if (!raw || raw.version !== SAVE_VERSION || !raw.player || !Array.isArray(raw.map)) {
      return null;
    }
    const size = globalThis.ConquestData.MAP_SIZE;
    if (raw.map.length !== size) {
      return null;
    }

    const cards = [];
    const seen = {};
    if (!Array.isArray(raw.player.cards) || raw.player.cards.length === 0) {
      return null;
    }
    for (let i = 0; i < raw.player.cards.length; i++) {
      const card = restoreCard(raw.player.cards[i]);
      if (!card || seen[card.instanceId]) {
        return null;
      }
      seen[card.instanceId] = true;
      cards.push(card);
    }

    const gold = Number(raw.player.gold);
    if (!isFinite(gold) || gold < 0) {
      return null;
    }

    const terrainIds = globalThis.ConquestData.TERRAIN_TABLE.map(function (entry) {
      return entry.id;
    });
    const map = [];
    for (let row = 0; row < raw.map.length; row++) {
      const line = raw.map[row];
      if (!Array.isArray(line) || line.length !== size) {
        return null;
      }
      const restored = [];
      for (let col = 0; col < line.length; col++) {
        const cell = line[col];
        const cellGold = cell && Number(cell.gold);
        if (!cell || terrainIds.indexOf(cell.terrain) === -1 || !isFinite(cellGold)) {
          return null;
        }
        if (typeof cell.isRevealed !== 'boolean') {
          return null;
        }
        const enemy = restoreEnemyUnit(cell.enemy);
        if (cell.enemy != null && !enemy) {
          return null;
        }
        const encounter = typeof cell.encounter === 'string' && cell.encounter
          ? cell.encounter
          : 'normal';
        let goldBonus = 0;
        if (cell.goldBonus != null) {
          goldBonus = Number(cell.goldBonus);
          if (!isFinite(goldBonus) || goldBonus < 0) {
            return null;
          }
        }
        restored.push({
          gold: cellGold,
          terrain: cell.terrain,
          isRevealed: cell.isRevealed,
          enemy: enemy,
          encounter: encounter,
          goldBonus: goldBonus,
        });
      }
      map.push(restored);
    }

    return {
      player: {
        gold: gold,
        cards: cards,
        formationIds: restoreIdList(raw.player.formationIds, cards, FORMATION_SIZE),
        selectedIds: restoreIdList(raw.player.selectedIds, cards),
      },
      map: map,
    };
  }

  /**
   * 保存があれば state を返す。無いか壊れていれば null。例外では止めない。
   * @returns {{ player: object, map: object[][] }|null}
   */
  function loadState() {
    try {
      const text = readStorage(SAVE_KEY);
      if (!text) {
        return null;
      }
      return restoreState(JSON.parse(text));
    } catch (error) {
      return null;
    }
  }

  /**
   * いまの進行を書く。所持ゴールド、所持カード、編成、選択、マップを含む。
   * 書けなかったときは false。ゲーム側の state は変えない。
   *
   * @param {{ player: object, map: object[][] }} state
   * @returns {boolean}
   */
  function saveState(state) {
    try {
      const payload = {
        version: SAVE_VERSION,
        player: {
          gold: state.player.gold,
          cards: state.player.cards.map(copyCard),
          formationIds: (state.player.formationIds || []).slice(),
          selectedIds: (state.player.selectedIds || []).slice(),
        },
        map: state.map.map(function (row) {
          return row.map(function (cell) {
            return {
              gold: cell.gold,
              terrain: cell.terrain,
              isRevealed: cell.isRevealed,
              enemy: copyEnemyUnit(cell.enemy),
              encounter: cell.encounter || 'normal',
              goldBonus: cell.goldBonus || 0,
            };
          });
        }),
      };
      return writeStorage(SAVE_KEY, JSON.stringify(payload));
    } catch (error) {
      return false;
    }
  }

  /**
   * 保存の成否を、ログとは別の短い一文で出す。空なら隠す。
   * @param {HTMLElement} root
   * @param {string} message
   */
  function renderSaveNote(root, message) {
    const note = root.querySelector('[data-region="save-note"]');
    if (!note) {
      return;
    }
    note.textContent = message || '';
  }

  /**
   * 初期 state を作り、#app にマップを出す。
   * 保存があれば、それを初期盤面の代わりに読む。読めなくても新規の盤面で始める。
   * dispatch(row, col) が戦闘、再描画、ログ更新まで行う。
   * evolve(templateId) はゴールドでカードを1枚追加する。
   * select(instanceId) は派遣するカードを切り替える。
   * save() はいまの進行を localStorage へ書く。
   * reset() は確認のあと、盤面と保存を消して最初からにする。
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
   *   select: (instanceId: number) => object|null,
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

    const loaded = loadState();
    const game = {
      state: loaded || globalThis.ConquestData.createInitialState(),
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
        if (isMapCleared(game.state.map)) {
          renderClear(root, true);
        }
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
       * 所持カードを編成へ入れる。入っていれば外す。
       * 枠が埋まっているときの追加は無視する。表示は入れ替え後の並びにする。
       *
       * @param {number} instanceId
       * @returns {object|null}
       */
      toggleFormation: function (instanceId) {
        const card = toggleFormation(game.state.player, instanceId);
        if (!card) {
          return null;
        }
        refreshPlayer(root, game.state.player);
        return card;
      },
      /**
       * 所持一覧で選んだ1枚を、編成が空のときの派遣対象にする。
       * 編成の中身は変えない。ステータスと一覧の「選択中」を描き直す。
       *
       * @param {number} instanceId
       * @returns {object|null}
       */
      select: function (instanceId) {
        const card = selectDispatch(game.state.player, instanceId);
        if (!card) {
          return null;
        }
        refreshPlayer(root, game.state.player);
        return card;
      },
      /**
       * いまの進行を localStorage へ書く。失敗しても盤面はそのまま。
       * @returns {boolean}
       */
      save: function () {
        const saved = saveState(game.state);
        renderSaveNote(root, saved ? '保存した' : '保存できませんでした');
        return saved;
      },
      /**
       * 確認のあと、探索状況、所持、編成、戦闘ログ、クリア表示、保存データを捨てる。
       * キャンセルしたときは何も変えない。
       * @returns {boolean}
       */
      reset: function () {
        let confirmed = false;
        try {
          confirmed = window.confirm('進行状況を消して、最初からやり直しますか？');
        } catch (error) {
          confirmed = false;
        }
        if (!confirmed) {
          return false;
        }
        removeStorage(SAVE_KEY);
        game.state = globalThis.ConquestData.createInitialState();
        refreshPlayer(root, game.state.player);
        renderMap(root, game.state.map);
        renderLog(root, '');
        renderClear(root, false);
        renderSaveNote(root, '');
        return true;
      },
    };

    root.replaceChildren(createBoardElement());
    refreshPlayer(root, game.state.player);
    renderMap(root, game.state.map);
    if (isMapCleared(game.state.map)) {
      renderClear(root, true);
    }
    return game;
  }

  globalThis.ConquestGame = {
    start: start,
    formatCellLabel: formatCellLabel,
  };
})();
