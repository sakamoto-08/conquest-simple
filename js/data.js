/**
 * data.js
 * キングダムコンクエスト風シミュレーションの「データ」と「戦闘判定」。
 *
 * 画面や派遣の進行は game.js に任せ、このファイルは次だけを持つ。
 *   - カードのマスタ（テンプレート）
 *   - プレイヤーの初期所持
 *   - マップの生成（一辺は MAP_SIZE）
 *   - 戦闘力の比較と獲得ゴールドの計算
 *
 * カードは「テンプレート」と「インスタンス」を分けている。
 * テンプレートは種族ごとの不変データ。インスタンスはプレイヤーや敵が
 * 実際に所持する1枚で、将来レベルや装備を足してもマスタを汚さない。
 * 所持カードは配列なので、1枚のままにも複数枚にもできる。
 * 戦闘はカード1枚でも、カード配列（編成）でも同じ関数で判定できる。
 *
 * 読み込み方は <script src="js/data.js">。公開 API は globalThis.ConquestData。
 */
(function () {
  'use strict';

  /** マップの一辺。5 なら 5×5。 */
  const MAP_SIZE = 5;

  /** マスに隠すゴールドの範囲（両端を含む）。 */
  const CELL_GOLD_MIN = 10;
  const CELL_GOLD_MAX = 50;

  /**
   * 戦闘ロールのぶれ幅。0.1 なら戦闘力を 90%〜110% のあいだで振る。
   * 同格戦の勝敗を揺らし、格が離れすぎた相手は覆らない。
   */
  const DEFAULT_POWER_VARIANCE = 0.1;

  /**
   * カードテンプレート。
   * power      … 戦闘力の基準値
   * rewardGold … このカードを倒した側が受け取る報酬
   * rank       … 弱い順。編成画面で並べるとき用
   */
  const CARD_TEMPLATES = {
    goblin: {
      id: 'goblin',
      name: 'ゴブリン',
      power: 10,
      rewardGold: 8,
      rank: 1,
    },
    orc: {
      id: 'orc',
      name: 'オーク',
      power: 20,
      rewardGold: 20,
      rank: 2,
    },
    dragon: {
      id: 'dragon',
      name: 'ドラゴン',
      power: 40,
      rewardGold: 50,
      rank: 3,
    },
  };

  /**
   * マスの地形。weight の合計に対する比率が出現率になる。
   * いまは同率。偏らせるときは weight だけを変える。
   * enemyTemplateId は、その地形へ派遣したときに出る基本の敵。
   * enemyPower と enemyRewardGold は敵専用の数値で、CARD_TEMPLATES とは別に持つ。
   * mixTemplateId は、編成が混成のときに1体だけ混ぜる相手。数値はその種族の地形から取る。
   * プレイヤーが Evolve で得るカードの強さは、ここを変えても変わらない。
   * 色は game.js が id からクラスを付ける。
   */
  const TERRAIN_TABLE = [
    { id: 'forest', name: '森', weight: 1, enemyTemplateId: 'goblin', enemyPower: 9, enemyRewardGold: 10, mixTemplateId: 'orc' },
    { id: 'wasteland', name: '荒野', weight: 1, enemyTemplateId: 'orc', enemyPower: 20, enemyRewardGold: 22, mixTemplateId: 'goblin' },
    { id: 'mountain', name: '山脈', weight: 1, enemyTemplateId: 'dragon', enemyPower: 45, enemyRewardGold: 55, mixTemplateId: 'orc' },
  ];

  /**
   * 通常マスの敵編成。weight の合計に対する比率が出現率。
   * members の 'base' はその地形の基本敵、'mix' は mixTemplateId の敵を1枠にする。
   * 体数は 1〜3。出し方を変えるときは、この表の行と weight だけを変える。
   * ボスマスを足すときは、同じ形の別テーブルを createEnemyFormation の第3引数へ渡す。
   */
  const ENEMY_FORMATION_TABLE = [
    { id: 'solo', weight: 55, members: ['base'] },
    { id: 'pair', weight: 25, members: ['base', 'base'] },
    { id: 'trio', weight: 15, members: ['base', 'base', 'base'] },
    { id: 'mixed', weight: 5, members: ['base', 'mix'] },
  ];

  /**
   * ボスマスの数。マップ全体でこの範囲から1つ引く。
   * 数を変えるときは、この2つだけを変える。
   */
  const BOSS_COUNT_MIN = 2;
  const BOSS_COUNT_MAX = 4;

  /**
   * ボスを倒したとき、マスのゴールドへ上乗せする額。
   * 敵編成の報酬とは別に足す。0 にすれば上乗せなし。
   */
  const BOSS_GOLD_BONUS = 30;

  /**
   * 地形ごとのボス編成。通常表より強い並びだけを置く。
   * weight の合計に対する比率が、その地形のボスの出現率。
   * 種類を足すときは、地形 id をキーにして行を足す。
   * members の書き方は ENEMY_FORMATION_TABLE と同じ。
   */
  const BOSS_FORMATIONS = {
    forest: [
      { id: 'goblin-trio', weight: 1, members: ['base', 'base', 'base'] },
    ],
    wasteland: [
      { id: 'orc-pair', weight: 1, members: ['base', 'base'] },
    ],
    mountain: [
      { id: 'dragon-pair', weight: 1, members: ['base', 'base'] },
      { id: 'dragon-orc', weight: 1, members: ['base', 'mix'] },
    ],
  };

  /** インスタンスを一意に区別する連番。複数枚所持したときの識別子。 */
  let nextInstanceId = 1;

  /**
   * セーブデータなど、既に使われた instanceId を採番に知らせる。
   * 読み込んだカードより小さい番号は、次の createCard が再利用しない。
   * 今の連番より小さい値では、連番を戻さない。
   *
   * @param {number} id
   */
  function noteInstanceId(id) {
    const numeric = Number(id);
    if (!isFinite(numeric) || numeric < 0) {
      return;
    }
    const next = Math.floor(numeric) + 1;
    if (next > nextInstanceId) {
      nextInstanceId = next;
    }
  }

  /**
   * min 以上 max 以下の整数を返す。
   * @param {number} min
   * @param {number} max
   * @param {() => number} [random]
   * @returns {number}
   */
  function randomInt(min, max, random) {
    const roll = random || Math.random;
    return min + Math.floor(roll() * (max - min + 1));
  }

  /**
   * テンプレートからカードを1枚作る。
   * 戦闘に使う数値はインスタンス側にコピーする。
   * あとからレベルで power を変えても、他の同名カードやマスタは変わらない。
   *
   * @param {string} templateId CARD_TEMPLATES のキー
   * @returns {Card}
   */
  function createCard(templateId) {
    const template = CARD_TEMPLATES[templateId];
    if (!template) {
      throw new Error('未知のカードテンプレートです: ' + templateId);
    }

    return {
      instanceId: nextInstanceId++,
      templateId: template.id,
      name: template.name,
      power: template.power,
      rewardGold: template.rewardGold,
      rank: template.rank,
    };
  }

  /**
   * 地形 id から地形の行を取る。無ければ null。
   * @param {string} terrainId
   * @returns {object|null}
   */
  function findTerrainEntry(terrainId) {
    for (let i = 0; i < TERRAIN_TABLE.length; i++) {
      if (TERRAIN_TABLE[i].id === terrainId) {
        return TERRAIN_TABLE[i];
      }
    }
    return null;
  }

  /**
   * 基本敵のテンプレート id から、その数値を持つ地形の行を取る。
   * 混成の1体は、出た地形ではなく種族側の enemyPower を使う。
   * @param {string} templateId
   * @returns {object|null}
   */
  function findTerrainByEnemyTemplate(templateId) {
    for (let i = 0; i < TERRAIN_TABLE.length; i++) {
      if (TERRAIN_TABLE[i].enemyTemplateId === templateId) {
        return TERRAIN_TABLE[i];
      }
    }
    return null;
  }

  /**
   * 地形の行から敵カードを1枚作る。
   * 名前はテンプレート、戦闘力と報酬は敵専用の数値。所持カードのマスタは変えない。
   * @param {object} entry TERRAIN_TABLE の1行
   * @returns {Card}
   */
  function createEnemyFromEntry(entry) {
    const enemy = createCard(entry.enemyTemplateId);
    enemy.power = entry.enemyPower;
    enemy.rewardGold = entry.enemyRewardGold;
    return enemy;
  }

  /**
   * 地形に対応する敵カードを1枚作る。
   * 編成の各枠はここを通る。マップ生成時には呼ばない。
   *
   * @param {string} terrainId TERRAIN_TABLE の id
   * @returns {Card}
   */
  function createEnemyForTerrain(terrainId) {
    const entry = findTerrainEntry(terrainId);
    if (!entry || !entry.enemyTemplateId) {
      throw new Error('地形に対応する敵がありません: ' + terrainId);
    }
    return createEnemyFromEntry(entry);
  }

  /**
   * weight の合計に対する比率で、表から1行を引く。
   * 敵編成も地形の出現も、同じ引き方にする。
   *
   * @param {Array<{ weight: number }>} table
   * @param {() => number} [random]
   * @returns {object}
   */
  function pickWeighted(table, random) {
    const roll = random || Math.random;
    let totalWeight = 0;
    for (let i = 0; i < table.length; i++) {
      totalWeight += table[i].weight;
    }
    if (totalWeight <= 0) {
      throw new Error('抽選表の重みがありません');
    }

    let cursor = roll() * totalWeight;
    for (let i = 0; i < table.length; i++) {
      cursor -= table[i].weight;
      if (cursor < 0) {
        return table[i];
      }
    }
    return table[table.length - 1];
  }

  /**
   * 地形に対応する敵編成を作る。戻り値は1〜3体の配列。
   * 基本は ENEMY_FORMATION_TABLE。ボスマスは第3引数に別表を渡す。
   * 'base' はその地形の基本敵、'mix' は mixTemplateId の敵。混成先が無いときは基本敵に戻す。
   * マップ生成時には呼ばない。派遣したタイミングで game.js が呼ぶ。
   *
   * @param {string} terrainId
   * @param {() => number} [random]
   * @param {Array<{ id: string, weight: number, members: string[] }>} [table]
   * @returns {Card[]}
   */
  function createEnemyFormation(terrainId, random, table) {
    const entry = findTerrainEntry(terrainId);
    if (!entry || !entry.enemyTemplateId) {
      throw new Error('地形に対応する敵がありません: ' + terrainId);
    }

    const patterns = table || ENEMY_FORMATION_TABLE;
    const pattern = pickWeighted(patterns, random);
    if (!pattern.members || pattern.members.length < 1 || pattern.members.length > 3) {
      throw new Error('敵編成の体数が不正です: ' + pattern.id);
    }

    const formation = [];
    for (let i = 0; i < pattern.members.length; i++) {
      let source = entry;
      if (pattern.members[i] === 'mix' && entry.mixTemplateId) {
        source = findTerrainByEnemyTemplate(entry.mixTemplateId) || entry;
      }
      formation.push(createEnemyFromEntry(source));
    }
    return formation;
  }

  /**
   * 初期プレイヤー。所持はカード配列で、最初の1枚はゴブリン。
   * gold は財布。戦闘の rewardGold をあとからここへ足す。
   * formationIds は編成スロットの instanceId を左から順に並べたもの。
   * 中身は識別子だけ。効果や枠の意味は、この並びの位置を使ってあとから足せる。
   * 最大枚数と、空のときに選択中の1枚へ戻す処理は game.js が持つ。最初は空。
   *
   * @returns {Player}
   */
  function createPlayer() {
    return {
      gold: 0,
      cards: [createCard('goblin')],
      formationIds: [],
    };
  }

  /**
   * TERRAIN_TABLE から地形 id を1つ引く。
   * ゴールド用の乱数とは別に1回振る。
   *
   * @param {() => number} [random]
   * @returns {string}
   */
  function pickTerrain(random) {
    const roll = random || Math.random;
    const totalWeight = TERRAIN_TABLE.reduce(function (sum, entry) {
      return sum + entry.weight;
    }, 0);

    let cursor = roll() * totalWeight;
    for (let i = 0; i < TERRAIN_TABLE.length; i++) {
      cursor -= TERRAIN_TABLE[i].weight;
      if (cursor < 0) {
        return TERRAIN_TABLE[i].id;
      }
    }

    return TERRAIN_TABLE[TERRAIN_TABLE.length - 1].id;
  }

  /**
   * 未探索のマスを1つ作る。敵は派遣まで null。
   * terrain は見た目と、派遣時に出す敵の種類に使う。
   * encounter は 'normal'。ボスにするのは createMap が後から選ぶ。
   * goldBonus は倒したときにマスのゴールドへ足す額。通常は 0。
   *
   * @param {() => number} [random]
   * @returns {Cell}
   */
  function createCell(random) {
    return {
      gold: randomInt(CELL_GOLD_MIN, CELL_GOLD_MAX, random),
      terrain: pickTerrain(random),
      isRevealed: false,
      enemy: null,
      encounter: 'normal',
      goldBonus: 0,
    };
  }

  /**
   * マップから BOSS_COUNT_MIN〜MAX マスをボスにする。
   * 同じマスは二度選ばない。種類を増やすときは encounter の文字列を足す。
   *
   * @param {Cell[][]} map
   * @param {() => number} [random]
   */
  function placeBosses(map, random) {
    const cells = [];
    for (let row = 0; row < map.length; row++) {
      for (let col = 0; col < map[row].length; col++) {
        cells.push(map[row][col]);
      }
    }
    if (cells.length === 0) {
      return;
    }

    const count = Math.min(cells.length, randomInt(BOSS_COUNT_MIN, BOSS_COUNT_MAX, random));
    for (let i = 0; i < count; i++) {
      const swap = i + randomInt(0, cells.length - 1 - i, random);
      const chosen = cells[swap];
      cells[swap] = cells[i];
      cells[i] = chosen;
      chosen.encounter = 'boss';
      chosen.goldBonus = BOSS_GOLD_BONUS;
    }
  }

  /**
   * 一辺 MAP_SIZE のマップ。map[row][col] でマスを取る。
   * 生成のあと、一部をボスマスにする。
   * @param {number} [size]
   * @param {() => number} [random]
   * @returns {Cell[][]}
   */
  function createMap(size, random) {
    const length = size || MAP_SIZE;
    const map = [];

    for (let row = 0; row < length; row++) {
      const line = [];
      for (let col = 0; col < length; col++) {
        line.push(createCell(random));
      }
      map.push(line);
    }

    placeBosses(map, random);
    return map;
  }

  /**
   * ゲーム開始時のプレイヤーとマップ。
   * テスト用の状態とは別に、本編はここから作り直せる。
   * @returns {{ player: Player, map: Cell[][] }}
   */
  function createInitialState() {
    return {
      player: createPlayer(),
      map: createMap(),
    };
  }

  /**
   * 戦闘単位をカード配列にそろえる。
   * カード1枚ならその1枚、配列なら編成として合算する。
   * @param {Card|Card[]} unit
   * @returns {Card[]}
   */
  function toCardList(unit) {
    if (Array.isArray(unit)) {
      if (unit.length === 0) {
        throw new Error('編成が空です');
      }
      return unit;
    }
    if (!unit) {
      throw new Error('カードがありません');
    }
    return [unit];
  }

  /**
   * 編成の基準戦闘力。現在は単純な合計。
   * 陣形ボーナスを入れるときはこの関数だけを変える。
   * @param {Card[]} cards
   * @returns {number}
   */
  function sumPower(cards) {
    return cards.reduce(function (sum, card) {
      return sum + card.power;
    }, 0);
  }

  /**
   * 倒した相手から得られる報酬ゴールドの合計。
   * @param {Card[]} cards
   * @returns {number}
   */
  function sumRewardGold(cards) {
    return cards.reduce(function (sum, card) {
      return sum + card.rewardGold;
    }, 0);
  }

  /**
   * 基準戦闘力に ±variance の乱数を掛ける。
   * 戻り値は小数第2位まで。ログに出した値と勝敗がずれないようにするため。
   *
   * @param {number} basePower
   * @param {number} variance
   * @param {() => number} random
   * @returns {number}
   */
  function rollPower(basePower, variance, random) {
    const rate = (1 - variance) + random() * (variance * 2);
    return Math.round(basePower * rate * 100) / 100;
  }

  /**
   * 戦闘判定。
   *
   * プレイヤー側と敵側の戦闘力を、それぞれ ±10%（変更可）して比較する。
   * ロール値が同じときは派遣した側の勝ち。
   * 勝利時の獲得ゴールドは「敵の rewardGold ＋ マスのゴールド」。
   * 敗北時は 0。マスのゴールドは勝利するまで手に入らない。
   *
   * cellGold は第3引数のオプション。省略時は 0 で、敵報酬だけを返す。
   * unit はカード1枚でもカード配列でもよい。
   *
   * @param {Card|Card[]} playerUnit
   * @param {Card|Card[]} enemyUnit
   * @param {{ cellGold?: number, variance?: number, random?: () => number }} [options]
   * @returns {BattleResult}
   */
  function resolveBattle(playerUnit, enemyUnit, options) {
    const settings = options || {};
    const variance = settings.variance == null ? DEFAULT_POWER_VARIANCE : settings.variance;
    const cellGold = settings.cellGold || 0;
    const random = settings.random || Math.random;

    const playerCards = toCardList(playerUnit);
    const enemyCards = toCardList(enemyUnit);
    const playerPower = sumPower(playerCards);
    const enemyPower = sumPower(enemyCards);
    const playerRoll = rollPower(playerPower, variance, random);
    const enemyRoll = rollPower(enemyPower, variance, random);
    const isWin = playerRoll >= enemyRoll;
    const enemyRewardGold = isWin ? sumRewardGold(enemyCards) : 0;
    const gainedCellGold = isWin ? cellGold : 0;

    return {
      result: isWin ? 'win' : 'lose',
      rewardGold: enemyRewardGold + gainedCellGold,
      enemyRewardGold: enemyRewardGold,
      cellGold: gainedCellGold,
      playerPower: playerPower,
      enemyPower: enemyPower,
      playerRoll: playerRoll,
      enemyRoll: enemyRoll,
    };
  }

  /**
   * 起動時の動作確認。本編の進行はしない。
   * ゲーム画面を作る段階で、この呼び出しだけ外せばログは止まる。
   */
  function runSelfTest() {
    function assert(condition, message) {
      if (!condition) {
        throw new Error('data.js のテストに失敗: ' + message);
      }
    }

    const templateIds = Object.keys(CARD_TEMPLATES);
    assert(templateIds.length >= 3, 'カードが3種以上ある');
    assert(CARD_TEMPLATES.goblin.power < CARD_TEMPLATES.orc.power, 'ゴブリンはオークより弱い');
    assert(CARD_TEMPLATES.orc.power < CARD_TEMPLATES.dragon.power, 'オークはドラゴンより弱い');

    const state = createInitialState();
    assert(state.player.cards.length === 1, '初期所持は1枚');
    assert(state.player.cards[0].templateId === 'goblin', '初期カードはゴブリン');
    assert(Array.isArray(state.player.formationIds) && state.player.formationIds.length === 0, '初期編成は空');
    assert(state.player.cards[0].instanceId !== createCard('goblin').instanceId, 'インスタンスIDは重複しない');
    const notedFrom = createCard('goblin').instanceId;
    noteInstanceId(notedFrom + 10);
    assert(createCard('goblin').instanceId === notedFrom + 11, '読み込んだIDの次から採番する');
    noteInstanceId(1);
    assert(createCard('goblin').instanceId === notedFrom + 12, '小さいIDでは採番を戻さない');
    assert(state.map.length === MAP_SIZE, 'マップは' + MAP_SIZE + '行');
    assert(state.map[0].length === MAP_SIZE, 'マップは' + MAP_SIZE + '列');

    const terrainIds = TERRAIN_TABLE.map(function (entry) {
      return entry.id;
    });
    let bossCount = 0;
    state.map.forEach(function (row) {
      row.forEach(function (cell) {
        assert(cell.gold >= CELL_GOLD_MIN && cell.gold <= CELL_GOLD_MAX, 'ゴールドは10〜50');
        assert(terrainIds.indexOf(cell.terrain) !== -1, '地形は定義済みの種類');
        assert(cell.isRevealed === false, '初期状態は未探索');
        assert(cell.enemy === null, '敵は派遣まで未配置');
        if (cell.encounter === 'boss') {
          bossCount += 1;
          assert(cell.goldBonus === BOSS_GOLD_BONUS, 'ボスはゴールドの上乗せを持つ');
        } else {
          assert(cell.encounter === 'normal' && cell.goldBonus === 0, '通常マスに上乗せはない');
        }
      });
    });
    assert(bossCount >= BOSS_COUNT_MIN && bossCount <= BOSS_COUNT_MAX, 'ボスは2〜4マス');

    const forestCell = createCell(sequenceRandom([0, 0]));
    assert(forestCell.gold === CELL_GOLD_MIN, '乱数0ではゴールド下限');
    assert(forestCell.terrain === 'forest', '乱数0では表の先頭の地形');

    const forestEnemy = createEnemyForTerrain('forest');
    const wastelandEnemy = createEnemyForTerrain('wasteland');
    const mountainEnemy = createEnemyForTerrain('mountain');
    assert(forestEnemy.templateId === 'goblin' && forestEnemy.power === 9 && forestEnemy.rewardGold === 10, '森の敵はゴブリンで Power 9');
    assert(wastelandEnemy.templateId === 'orc' && wastelandEnemy.power === 20 && wastelandEnemy.rewardGold === 22, '荒野の敵はオークで Power 20');
    assert(mountainEnemy.templateId === 'dragon' && mountainEnemy.power === 45 && mountainEnemy.rewardGold === 55, '山脈の敵はドラゴンで Power 45');
    assert(CARD_TEMPLATES.goblin.power === 10 && CARD_TEMPLATES.goblin.rewardGold === 8, '所持ゴブリンのマスタは敵の数値で変わらない');
    assert(CARD_TEMPLATES.orc.power === 20 && CARD_TEMPLATES.orc.rewardGold === 20, '所持オークのマスタは敵の数値で変わらない');
    assert(CARD_TEMPLATES.dragon.power === 40 && CARD_TEMPLATES.dragon.rewardGold === 50, '所持ドラゴンのマスタは敵の数値で変わらない');

    const forestFight = resolveBattle(createCard('goblin'), forestEnemy, {
      variance: 0,
      cellGold: 10,
      random: Math.random,
    });
    assert(forestFight.result === 'win', 'ぶれなしでは所持ゴブリンが森の敵に勝つ');
    assert(forestFight.enemyPower === 9, '戦闘は敵専用の戦闘力を使う');
    assert(forestFight.rewardGold === 20, '森の敵報酬10にマスのゴールド10を足す');

    const solo = createEnemyFormation('forest', sequenceRandom([0]));
    assert(solo.length === 1 && solo[0].templateId === 'goblin' && solo[0].power === 9, '乱数0は表の先頭、森のゴブリン1体');
    const pair = createEnemyFormation('wasteland', sequenceRandom([0]), [
      { id: 'pair', weight: 1, members: ['base', 'base'] },
    ]);
    assert(pair.length === 2 && pair[0].templateId === 'orc' && pair[1].power === 20, '指定した表ならオーク2体');
    const trio = createEnemyFormation('mountain', sequenceRandom([0]), [
      { id: 'trio', weight: 1, members: ['base', 'base', 'base'] },
    ]);
    assert(trio.length === 3 && trio.every(function (enemy) {
      return enemy.templateId === 'dragon' && enemy.power === 45;
    }), '山脈の3体はドラゴンの敵専用数値');
    const mixed = createEnemyFormation('forest', sequenceRandom([0]), [
      { id: 'mixed', weight: 1, members: ['base', 'mix'] },
    ]);
    assert(mixed[0].templateId === 'goblin' && mixed[1].templateId === 'orc', '森の混成はゴブリンとオーク');
    assert(mixed[1].power === 20 && mixed[1].rewardGold === 22, '混成のオークはオークの敵専用数値');
    const pairFight = resolveBattle(createCard('goblin'), pair, {
      variance: 0,
      cellGold: 0,
      random: Math.random,
    });
    assert(pairFight.enemyPower === 40, '敵編成の戦闘力は合計');

    const forestBoss = createEnemyFormation('forest', sequenceRandom([0]), BOSS_FORMATIONS.forest);
    assert(forestBoss.length === 3 && forestBoss.every(function (enemy) {
      return enemy.templateId === 'goblin';
    }), '森のボスはゴブリン3体');
    const wastelandBoss = createEnemyFormation('wasteland', sequenceRandom([0]), BOSS_FORMATIONS.wasteland);
    assert(wastelandBoss.length === 2 && wastelandBoss.every(function (enemy) {
      return enemy.templateId === 'orc';
    }), '荒野のボスはオーク2体');
    const dragonPair = createEnemyFormation('mountain', sequenceRandom([0]), BOSS_FORMATIONS.mountain);
    assert(dragonPair.length === 2 && dragonPair.every(function (enemy) {
      return enemy.templateId === 'dragon';
    }), '乱数0の山脈ボスはドラゴン2体');
    const dragonOrc = createEnemyFormation('mountain', sequenceRandom([0.6]), BOSS_FORMATIONS.mountain);
    assert(dragonOrc[0].templateId === 'dragon' && dragonOrc[1].templateId === 'orc', 'もう一方の山脈ボスはドラゴンとオーク');

    const goblin = createCard('goblin');
    const dragon = createCard('dragon');

    const upset = resolveBattle(goblin, goblin, {
      variance: DEFAULT_POWER_VARIANCE,
      cellGold: 25,
      random: sequenceRandom([1, 0]),
    });
    assert(upset.result === 'win', '上振れした同格戦は勝ち');
    assert(upset.playerRoll === 11, '戦闘力10の最大ロールは11');
    assert(upset.enemyRoll === 9, '戦闘力10の最小ロールは9');
    assert(upset.rewardGold === goblin.rewardGold + 25, '勝利時は敵報酬＋マスのゴールド');

    const beaten = resolveBattle(goblin, goblin, {
      variance: DEFAULT_POWER_VARIANCE,
      cellGold: 25,
      random: sequenceRandom([0, 1]),
    });
    assert(beaten.result === 'lose', '下振れした同格戦は負け');
    assert(beaten.rewardGold === 0, '敗北時の獲得ゴールドは0');

    const hopeless = resolveBattle(goblin, dragon, {
      variance: DEFAULT_POWER_VARIANCE,
      cellGold: 50,
      random: sequenceRandom([1, 0]),
    });
    assert(hopeless.result === 'lose', '±10%ではゴブリンはドラゴンに勝てない');
    assert(hopeless.rewardGold === 0, '格上に負けたときゴールドは入らない');

    const formation = resolveBattle([dragon, goblin], dragon, {
      variance: 0,
      cellGold: 10,
      random: Math.random,
    });
    assert(formation.playerPower === 50, '編成の戦闘力は合計');
    assert(formation.result === 'win', '編成が基準戦闘力で上回れば勝利');
    assert(formation.rewardGold === dragon.rewardGold + 10, '編成戦でも報酬の式は同じ');

    console.log('--- ConquestData セルフテスト: 成功 ---');
    console.log('テンプレート', CARD_TEMPLATES);
    console.log('初期所持', state.player.cards[0]);
    console.log('マップ（gold / revealed / enemy）');
    console.table(state.map.map(function (row) {
      return row.map(function (cell) {
        return cell.gold + (cell.isRevealed ? ' 探索済' : ' 未探索');
      });
    }));

    const sampleCell = state.map[1][1];
    sampleCell.enemy = createEnemyFormation(sampleCell.terrain);
    const sampleEnemies = Array.isArray(sampleCell.enemy) ? sampleCell.enemy : [sampleCell.enemy];
    const sample = resolveBattle(state.player.cards[0], sampleCell.enemy, {
      cellGold: sampleCell.gold,
    });
    console.log(
      '派遣例: ゴブリン(基準' + state.player.cards[0].power + ') vs ' +
      sampleEnemies.map(function (enemy) { return enemy.name; }).join('・') +
      '(合計' + sample.enemyPower + ')',
      sample
    );
    console.log('マスの隠されたゴールド', sampleCell.gold, '/ この戦闘の獲得', sample.rewardGold);
  }

  /**
   * テスト用。呼ぶたびに並べた値を順に返す乱数。
   * @param {number[]} values
   * @returns {() => number}
   */
  function sequenceRandom(values) {
    let index = 0;
    return function () {
      const value = values[index];
      index += 1;
      return value;
    };
  }

  globalThis.ConquestData = {
    MAP_SIZE: MAP_SIZE,
    CARD_TEMPLATES: CARD_TEMPLATES,
    TERRAIN_TABLE: TERRAIN_TABLE,
    ENEMY_FORMATION_TABLE: ENEMY_FORMATION_TABLE,
    BOSS_FORMATIONS: BOSS_FORMATIONS,
    BOSS_COUNT_MIN: BOSS_COUNT_MIN,
    BOSS_COUNT_MAX: BOSS_COUNT_MAX,
    BOSS_GOLD_BONUS: BOSS_GOLD_BONUS,
    createCard: createCard,
    noteInstanceId: noteInstanceId,
    createEnemyForTerrain: createEnemyForTerrain,
    createEnemyFormation: createEnemyFormation,
    createPlayer: createPlayer,
    createMap: createMap,
    createInitialState: createInitialState,
    resolveBattle: resolveBattle,
  };

  runSelfTest();
})();
