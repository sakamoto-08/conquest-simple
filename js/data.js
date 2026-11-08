/**
 * data.js
 * キングダムコンクエスト風シミュレーションの「データ」と「戦闘判定」。
 *
 * 画面や派遣の進行は game.js に任せ、このファイルは次だけを持つ。
 *   - カードのマスタ（テンプレート）
 *   - プレイヤーの初期所持
 *   - 3×3 マップの生成
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

  /** マップの一辺。3 なら 3×3。 */
  const MAP_SIZE = 3;

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
   * 派遣時に出現する敵の抽選表。
   * weight の合計に対する比率が出現率になる。種類を足すときは行を足す。
   */
  const ENEMY_SPAWN_TABLE = [
    { templateId: 'goblin', weight: 55 },
    { templateId: 'orc', weight: 30 },
    { templateId: 'dragon', weight: 15 },
  ];

  /** インスタンスを一意に区別する連番。複数枚所持したときの識別子。 */
  let nextInstanceId = 1;

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
   * 抽選表から敵カードを1枚作る。
   * マップ生成時には呼ばない。派遣したタイミングでマスへ載せる。
   *
   * @param {() => number} [random]
   * @returns {Card}
   */
  function createRandomEnemy(random) {
    const roll = random || Math.random;
    const totalWeight = ENEMY_SPAWN_TABLE.reduce(function (sum, entry) {
      return sum + entry.weight;
    }, 0);

    let cursor = roll() * totalWeight;
    for (let i = 0; i < ENEMY_SPAWN_TABLE.length; i++) {
      cursor -= ENEMY_SPAWN_TABLE[i].weight;
      if (cursor < 0) {
        return createCard(ENEMY_SPAWN_TABLE[i].templateId);
      }
    }

    const last = ENEMY_SPAWN_TABLE[ENEMY_SPAWN_TABLE.length - 1];
    return createCard(last.templateId);
  }

  /**
   * 初期プレイヤー。所持はカード配列で、最初の1枚はゴブリン。
   * gold は財布。戦闘の rewardGold をあとからここへ足す。
   * 編成は未使用。派遣ユニットを増やすときは cards から選んで配列にする。
   *
   * @returns {Player}
   */
  function createPlayer() {
    return {
      gold: 0,
      cards: [createCard('goblin')],
    };
  }

  /**
   * 未探索のマスを1つ作る。敵は派遣まで null。
   * @param {() => number} [random]
   * @returns {Cell}
   */
  function createCell(random) {
    return {
      gold: randomInt(CELL_GOLD_MIN, CELL_GOLD_MAX, random),
      isRevealed: false,
      enemy: null,
    };
  }

  /**
   * 3×3 のマップ。map[row][col] でマスを取る。
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
    assert(state.player.cards[0].instanceId !== createCard('goblin').instanceId, 'インスタンスIDは重複しない');
    assert(state.map.length === MAP_SIZE, 'マップは3行');
    assert(state.map[0].length === MAP_SIZE, 'マップは3列');

    state.map.forEach(function (row) {
      row.forEach(function (cell) {
        assert(cell.gold >= CELL_GOLD_MIN && cell.gold <= CELL_GOLD_MAX, 'ゴールドは10〜50');
        assert(cell.isRevealed === false, '初期状態は未探索');
        assert(cell.enemy === null, '敵は派遣まで未配置');
      });
    });

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
    sampleCell.enemy = createRandomEnemy();
    const sample = resolveBattle(state.player.cards[0], sampleCell.enemy, {
      cellGold: sampleCell.gold,
    });
    console.log(
      '派遣例: ゴブリン(基準' + state.player.cards[0].power + ') vs ' +
      sampleCell.enemy.name + '(基準' + sampleCell.enemy.power + ')',
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
    ENEMY_SPAWN_TABLE: ENEMY_SPAWN_TABLE,
    createCard: createCard,
    createRandomEnemy: createRandomEnemy,
    createPlayer: createPlayer,
    createMap: createMap,
    createInitialState: createInitialState,
    resolveBattle: resolveBattle,
  };

  runSelfTest();
})();
