'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  let filePath = req.url.split('?')[0];
  if (filePath === '/' || filePath === '') filePath = '/index.html';
  const safe = path.normalize(filePath).replace(/^([.][.][/\\])+/, '');
  const abs = path.join(PUBLIC_DIR, safe);
  if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(abs, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(abs).toLowerCase();
    const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, {'Content-Type': type}); res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();

// 進行停止監視。タイマーが不発になった場合でも、待機状態を定期的に拾って進める。
setInterval(()=>{
  for(const room of rooms.values()){
    try { ensureRoomProgress(room); } catch(e) { console.error('progress watchdog error', e); }
  }
}, 1000);


const suits = ['♠','♥','♦','♣'];
const ranks = ['1','2','3','4','5','6','7','8','9','10','11','12','13'];
let deckSerial = 0; // 第2ラウンド補充時もカードIDが重複しないようにする。
const value = Object.fromEntries(ranks.map(r=>[r, Number(r)]));

function code(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s=''; for(let i=0;i<4;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return rooms.has(s) ? code() : s;
}
function uid(){ return crypto.randomBytes(8).toString('hex'); }
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function makeDeck(){
  let deck=[]; let id=0;
  const serial = deckSerial++;
  for(const s of suits) for(const r of ranks) deck.push({id:`D${serial}-${s}${r}-${id++}`,faceKey:`${s}${r}`,suit:s,rank:r,val:value[r],joker:false});
  deck.push({id:`D${serial}-JOKER-${id++}`,faceKey:'JOKER',suit:null,rank:'JOKER',val:0,joker:true});
  return deck;
}

function cardFaceKey(card){
  if(!card) return 'NULL';
  if(card.faceKey) return card.faceKey;
  if(card.joker) return 'JOKER';
  return `${card.suit}${card.rank}`;
}

function isMadPig(card){
  return !!card && !card.joker && card.suit==='♠' && card.rank==='11';
}

function cloneCardWithFreshId(card){
  if(!card) return null;
  if(card.joker) return {...card, faceKey:'JOKER', id:`D${deckSerial++}-JOKER-${Date.now()}-${Math.random().toString(16).slice(2)}`};
  return {...card, faceKey:`${card.suit}${card.rank}`, id:`D${deckSerial++}-${card.suit}${card.rank}-${Date.now()}-${Math.random().toString(16).slice(2)}`};
}



function collectActiveFaceKeys(room){
  const keys = new Set();
  if(!room || !room.players) return keys;

  // 次ラウンド補充の重複防止対象は、現在プレイ領域に残っているカード。
  // 得点パイル・ペア浄化済みカードは「得点/履歴」として保持し、補充山の重複制限からは外す。
  // ピック結果やペア候補は既に誰かの手札に含まれているため、ここでは重複登録しない。
  for(const p of room.players){
    for(const c of p.hand || []) keys.add(cardFaceKey(c));
  }
  for(const t of room.trick || []) keys.add(cardFaceKey(t.card));
  for(const c of room.stock || []) keys.add(cardFaceKey(c));

  return keys;
}





function assertUniqueActiveCards(room, context=''){
  const seen = new Map();
  const duplicates = [];
  function check(card, place){
    const key = cardFaceKey(card);
    if(key === 'NULL') return;
    if(seen.has(key)) duplicates.push(`${key}: ${seen.get(key)} / ${place}`);
    else seen.set(key, place);
  }

  if(room && room.players){
    for(const p of room.players){
      for(const c of p.hand || []) check(c, `${p.name}の手札`);
    }
  }
  for(const t of room?.trick || []) check(t.card, `場のカード:${t.pid}`);
  for(const c of room?.stock || []) check(c, '補充山');

  // 得点パイル・ペア浄化済みカードは得点/履歴として保持するため、
  // 次ラウンド補充カードとの同じ数字/スート重複はエラー扱いしない。
  // また、pendingPick.result / pairChoice は手札内カードへの参照なので二重チェックしない。
  if(duplicates.length){
    log(room, `⚠️ カード重複を検知しました${context ? '（'+context+'）' : ''}: ${duplicates.join(' / ')}`);
    return false;
  }
  return true;
}



function buildUniqueNormalRefillDeck(room){
  const active = collectActiveFaceKeys(room);
  const deck = [];
  for(const suit of suits){
    for(const rank of ranks){
      const base = {id:'', faceKey:`${suit}${rank}`, suit, rank, val:value[rank], joker:false};
      if(!active.has(cardFaceKey(base))) deck.push(cloneCardWithFreshId(base));
    }
  }
  shuffle(deck);
  return deck;
}

function cardText(c){ return c.joker ? '🃏ババブタ' : `${c.rank}${c.suit}`; }
function sortHand(h){
  h.sort((a,b)=>{
    if(a.joker) return 1; if(b.joker) return -1;
    const so = suits.indexOf(a.suit)-suits.indexOf(b.suit);
    if(so) return so;
    return b.val-a.val;
  });
}
function log(room, text){ room.log.unshift({time:new Date().toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit'}), text}); room.log = room.log.slice(0,80); }

function say(room, pid, text){
  const p = room.players[pid]; if(!p || !text) return;
  const ch = cpuCharacter(p);
  const item = {
    pid,
    name:p.name,
    text,
    cpuKey: ch?.key || null,
    avatar: cpuAvatar(p),
    avatarImage: ch?.imagePath || null,
    expiresAt: Date.now()+9000
  };
  p.lastComment = item;
  room.commentary = room.commentary || [];
  room.commentary.unshift(item);
  room.commentary = room.commentary.slice(0,8);
  log(room, `💬 ${p.name}「${text}」`);
}



function isEmptyHand(p){
  return !!p && Array.isArray(p.hand) && p.hand.length === 0;
}
function isJokerOnlyHand(p){
  return !!p && Array.isArray(p.hand) && p.hand.length === 1 && p.hand[0] && p.hand[0].joker;
}
function isRoundEndHand(p){
  return isEmptyHand(p) || isJokerOnlyHand(p);
}

function activePlayerCount(room){
  return room.players ? room.players.length : 0;
}
function safeBroadcast(room){
  try { broadcast(room); } catch(e) { console.error('safeBroadcast error', e); }
}


function safeFinishBecauseNoPlayable(room, pid){
  const p = room.players[pid];
  if(!p) return false;

  if(isJokerOnlyHand(p)){
    log(room, `🏁 ${p.name} の手番開始時、ババブタ1枚だけだったため、ラウンド終了処理へ進みます。`);
    room.pendingPick = null;
    room.trickReview = null;
    checkRoundEnd(room, pid);
    broadcast(room);
    return true;
  }

  if(isEmptyHand(p)){
    if(activeTrickInProgress(room)){
      rememberEndAfterTrick(room, pid);
      const alreadyPlayed = room.trick && room.trick.some(x=>x.pid===pid);
      if(alreadyPlayed){
        room.current = (pid + 1) % room.players.length;
        broadcast(room);
        return true;
      }
      log(room, `⚠️ ${p.name} がトリック中に出せるカードを持たないため、ラウンド終了処理へ進みます。`);
    } else {
      log(room, `🏁 ${p.name} の手札がなくなったため、ラウンド終了処理へ進みます。`);
    }
    room.pendingPick = null;
    room.trickReview = null;
    checkRoundEnd(room, pid);
    broadcast(room);
    return true;
  }
  return false;
}




const CPU_CHARACTERS = [
  {
    key:'kamomodoki',
    name:'かももどき',
    avatar:'🦆', imagePath:'/cpu_characters/kamomodoki.jpg',
    gender:'female',
    style:'attack',
    catchphrase:'マストフォローは祝福です♡',
    motto:['人の不幸は蜜の味','下家のデスロード']
  },
  {
    key:'wakumodoki',
    name:'ワクもどき',
    avatar:'✊🏻', imagePath:'/cpu_characters/wakumodoki.jpg',
    gender:'female',
    style:'bold',
    catchphrase:'やるぞぉ〜✊🏻',
    motto:['できるぞぉ〜✊🏻','あたしゃ、魔神だよ…']
  },
  {
    key:'rikumodoki',
    name:'リクもどき',
    avatar:'📋', imagePath:'/cpu_characters/rikumodoki.png',
    gender:'male',
    style:'steady',
    catchphrase:'進捗確認します。',
    motto:['締切厳守','計画通りに進めましょう']
  }
];

function cpuCharacterByName(name){
  return CPU_CHARACTERS.find(c=>c.name===name) || null;
}
function cpuCharacter(player){
  if(!player || !player.cpu) return null;
  return player.cpuCharacter || cpuCharacterByName(player.name) || null;
}
function cpuAvatar(player){
  return cpuCharacter(player)?.avatar || '🐷';
}

function cpuIsMadPigCard(room, card){
  return !!(room && room.madPigEnabled !== false && card && !card.joker && card.suit==='♠' && card.rank==='11');
}
function cpuShootPotential(room, player){
  return !!(shootThePigEnabled(room) && playerHasJoker(player) && playerHasMadPig(room, player));
}
function cpuCardHandRisk(room, card){
  if(!card) return 0;
  if(card.joker) return room?.jokerPenalty ?? 20;
  const mode = normalizePenaltyMode(room?.penaltyMode);
  if(cpuIsMadPigCard(room, card)){
    return mode === 'faceValue' ? 40 : 13;
  }
  if(mode === 'faceValue') return Number(card.val || card.rank || 0);
  if(mode === 'spadeSuit') return card.suit === '♠' ? 3 : 1;
  return 3;
}
function cpuHandRisk(room, player){
  return (player?.hand || []).reduce((sum,c)=>sum + cpuCardHandRisk(room, c), 0);
}
function cpuSuitCounts(player){
  const counts = {'♠':0,'♥':0,'♦':0,'♣':0};
  for(const c of player?.hand || []){
    if(c && !c.joker && counts[c.suit] !== undefined) counts[c.suit]++;
  }
  return counts;
}
function cpuCurrentLeadHigh(room){
  if(!room?.leadSuit) return 0;
  return (room.trick || []).filter(x=>x.card?.suit===room.leadSuit).reduce((m,x)=>Math.max(m, Number(x.card.val || 0)), 0);
}
function cpuWouldWinCurrentTrick(room, card){
  if(!room || !card || card.joker) return false;
  if(!room.leadSuit) return true;
  if(card.suit !== room.leadSuit) return false;
  return Number(card.val || 0) > cpuCurrentLeadHigh(room);
}
function cpuPersonalityWeights(player){
  const ch = cpuCharacter(player);
  if(ch?.key === 'kamomodoki') return {win:1.28, dump:1.08, risk:0.82, chaos:.22, shoot:1.02};
  if(ch?.key === 'wakumodoki') return {win:1.08, dump:.92, risk:0.55, chaos:.62, shoot:1.34};
  if(ch?.key === 'rikumodoki') return {win:.72, dump:1.22, risk:1.34, chaos:.04, shoot:.78};
  return {win:1, dump:1, risk:1, chaos:.18, shoot:1};
}
function cpuCardPlayScore(room, pid, card){
  const player = room.players[pid];
  const ch = cpuCharacter(player);
  const w = cpuPersonalityWeights(player);
  const mode = normalizePenaltyMode(room.penaltyMode);
  const risk = cpuCardHandRisk(room, card);
  const isMad = cpuIsMadPigCard(room, card);
  const shoot = cpuShootPotential(room, player);
  const counts = cpuSuitCounts(player);
  const suitCount = counts[card.suit] || 0;
  const lowCard = 14 - Number(card.val || 0);
  const highCard = Number(card.val || 0);
  const leadSuit = room.leadSuit;
  let score = Math.random() * (8 + w.chaos * 22);

  // シュート・ザ・ピッグを狙える状態では、ババブタとマッド・ピッグのセット維持を優先。
  // ただしマッドを勝ってごちそう山に置ける見込みがある時だけ、少しだけ許容する。
  if(shoot && isMad){
    score -= 420 * w.shoot;
  }

  if(!leadSuit){
    // リード時：キャラごとの基本方針。
    if(ch?.key === 'kamomodoki'){
      score += highCard * 9 * w.win;
      score += (suitCount <= 2 ? 22 : 0); // 短いスートを切って将来フォロー不能を作りやすくする。
      score += risk * (mode === 'faceValue' ? 1.0 : .45);
    } else if(ch?.key === 'wakumodoki'){
      score += (Math.random() < .55 ? highCard * 8 : lowCard * 6);
      score += shoot && !isMad ? 28 : 0;
      score += risk * .35;
    } else {
      score += lowCard * 9;
      score += (suitCount <= 2 ? 16 : 0);
      score -= risk * 3.5 * w.risk;
      // ただし手札リスクが高い時は少し整理に動く。
      if(cpuHandRisk(room, player) >= 34) score += risk * 2.2;
    }
    if(isMad && !shoot) score -= 140; // リードでマッドを奪われる事故を避ける。
    return score;
  }

  const follow = card.suit === leadSuit;
  const canWin = cpuWouldWinCurrentTrick(room, card);

  if(!follow){
    // フォロー不能時：危険札整理の最大チャンス。
    score += risk * 18 * w.dump;
    score += highCard * .7;
    if(mode === 'spadeSuit' && card.suit === '♠') score += 18;
    if(isMad && !shoot) score += 260;
    if(shoot && isMad) score -= 780; // シュート狙い中はマッドを渡さない。
    return score;
  }

  if(canWin){
    // 勝つと自分のごちそう山に入る。危険札で勝つのは基本避ける。
    const over = Number(card.val || 0) - cpuCurrentLeadHigh(room);
    score += (80 - over * 7) * w.win;
    score -= risk * 8 * w.risk;
    if(ch?.key === 'kamomodoki') score += 40;
    if(ch?.key === 'wakumodoki') score += 24 + Math.random()*26;
    if(ch?.key === 'rikumodoki' && over <= 2) score += 42;
    if(isMad && shoot) score += 260;     // 勝って山に置けるならシュート条件を維持できる。
    if(isMad && !shoot) score -= 360;    // シュートなしでマッドを自分の山へ入れるのは危険。
    return score;
  }

  // フォローして負ける：手札リスクを逃がせるので、危険札や高札を切る価値が高い。
  score += risk * 11 * w.dump;
  score += highCard * 2.2;
  score += lowCard * .6;
  if(isMad && !shoot) score += 240;
  if(shoot && isMad) score -= 620;
  return score;
}
function chooseCpuPairCardForDiscard(room, player, drawn, candidates){
  if(!Array.isArray(candidates) || !candidates.length) return null;
  return candidates.slice()
    .map(c=>({card:c, score:cpuCardHandRisk(room, c) + (cpuIsMadPigCard(room, c) ? 100 : 0) + Math.random()}))
    .sort((a,b)=>b.score-a.score)[0].card;
}

function chooseCpuPickIndex(room, pp, candidates){
  // ピック画面は裏向きカードなので、CPUもカードの中身を見ない。
  // 以前は候補カードの中身を評価してババブタやマッド・ピッグを避けていたため、
  // 右側にババブタがある時に左側ばかり選ぶように見える問題があった。
  // 候補の配置順は ensurePickOrder() / shuffleIds() でランダム化済み。
  // CPUはそのランダム配置上の位置を、公平にランダム選択する。
  const n = Array.isArray(candidates) ? candidates.length : 0;
  if(n <= 0) return 0;
  return Math.floor(Math.random() * n);
}

function cpuStrategyLineFor(room, pid, type, ctx={}){
  const p = room.players[pid];
  const ch = cpuCharacter(p);
  if(!ch) return null;
  const card = ctx.card ? cardText(ctx.card) : '';
  const target = ctx.target || '相手';
  const mode = roomPenaltyLabel(room);

  if(ch.key === 'kamomodoki'){
    if(type==='shootThreat') return sample([
      '月が赤いですね♡ ババブタとマッド、揃うと地獄が反転します♡',
      'シュートの匂い…他人の不幸が10点ずつ増える音がします♡',
      'ウホッ♡ 危険札コンボ、赤く育てておきます♡'
    ]);
    if(type==='dumpDanger') return sample([
      `${card}を投下♡ その失点、誰かの山で咲いてください♡`,
      '危険物処理です♡ もちろん相手側で爆発希望です♡',
      '下家のデスロードに燃料を置きます♡'
    ]);
    if(type==='spadePenalty') return sample([
      `♠は重いですからね♡ ${card}で圧を撒きます♡`,
      'スペード失点、誰かの心に刺され♡',
      '黒い札は黒い未来の味がします♡'
    ]);
    if(type==='targetSelectSmart') return sample([
      '候補は2枚。甘く見せて、ちゃんと毒を混ぜます♡',
      'ババブタを渡すか、シュートを温存するか…蜜の味です♡',
      '一番嫌な候補セット、完成です♡'
    ]);
  }

  if(ch.key === 'wakumodoki'){
    if(type==='shootThreat') return sample([
      'シュート・ザ・ピッグ、狙える気がする！できるぞぉ〜✊🏻',
      'ババとマッド？ 逆にチャンスじゃん！やるぞぉ〜✊🏻',
      'あたしゃ、魔神だよ…月まで撃ち抜く！'
    ]);
    if(type==='dumpDanger') return sample([
      `${card}、ここで放流！私なら流れを変えられる！`,
      '危ない札も勢いで処理！できるぞぉ〜✊🏻',
      '直感でいく！この失点、今ここで手放す！'
    ]);
    if(type==='spadePenalty') return sample([
      `♠は重い！だからこそ今切る！${card}！`,
      'スペードの重さ？ 私なら持ち上げられる！たぶん！',
      '黒い札でも盛り上げ札！やるぞぉ〜✊🏻'
    ]);
    if(type==='targetSelectSmart') return sample([
      '候補2枚、私の直感で選ぶぞぉ〜✊🏻',
      'ここは魔神セレクト！どっち引いてもドラマ！',
      'できるぞぉ〜✊🏻 たぶん一番いい候補！'
    ]);
  }

  if(ch.key === 'rikumodoki'){
    if(type==='shootThreat') return sample([
      'シュート・ザ・ピッグ条件を確認。保持して最終影響を狙います。',
      'ババブタとマッド・ピッグの組み合わせ、リスクではなく計画に組み込みます。',
      '危険札コンボを管理対象にします。慌てず進行します。'
    ]);
    if(type==='dumpDanger') return sample([
      `${card}をリスク処理します。手札負債を減らします。`,
      '危険札を棚卸しします。不要資産は早めに外します。',
      'ここで失点リスクを圧縮します。'
    ]);
    if(type==='spadePenalty') return sample([
      `♠スートは失点が重いです。${card}を処理します。`,
      'スペードリスクを確認。早めに切ります。',
      '黒い札は管理コスト高めです。処理します。'
    ]);
    if(type==='targetSelectSmart') return sample([
      '候補2枚をリスク順に選定します。',
      'ババブタ、マッド、スート失点を考慮して候補を絞ります。',
      '対象範囲を2枚に圧縮。進捗良好です。'
    ]);
  }
  return null;
}

function cpuLineFor(room, pid, type, ctx={}){
  const p = room.players[pid];
  const ch = cpuCharacter(p);
  if(!ch) return null;
  const target = ctx.target || '相手';
  const cardTextShort = ctx.card ? cardText(ctx.card) : '';
  const drawnText = ctx.drawn ? cardText(ctx.drawn) : '';
  const round = room.round || 1;

  if(ch.key==='kamomodoki'){
    // 赤背景ドットゴリラ風。攻撃的で圧が強いが、豚語は使わない。
    if(type==='playLeadHigh') return sample([
      `赤信号、点灯です♡ ${cardTextShort}で下家のデスロード開通♡`,
      'マストフォローは祝福です♡ さあ、逃げ道を塞ぎます♡',
      'ウホッウホッ！高火力で殴ります♡'
    ]);
    if(type==='playLeadLow') return sample([
      'まずは小さな不幸を仕込みます♡',
      'この一歩が下家のデスロードになります♡',
      '人の不幸は蜜の味…まだ前菜です♡'
    ]);
    if(type==='followWin') return sample([
      `勝ち筋、いただきます♡ ${cardTextShort}で圧をかけます♡`,
      'マストフォローは祝福です♡ 祝福という名の強制です♡',
      'そこ、逃げ道ありませんよ♡ ウホッ♡'
    ]);
    if(type==='followLow') return sample([
      'ここは低く耐えて、次の誰かを地獄へ送ります♡',
      '最弱回避です♡ 人の不幸を待つ時間も甘い♡',
      'ウホッ、しゃがんでから殴るタイプです♡'
    ]);
    if(type==='offSuit') return sample([
      'フォロー不能？ では自由に呪いを置きます♡',
      '下家のデスロード、舗装しておきますね♡',
      'ウホッウホッ、別スートで嫌がらせです♡'
    ]);
    if(type==='pickWin') return sample([
      `${target}の袋、裏向きでも赤く光って見えますね♡ 勘で処刑です♡`,
      'ピックは処刑です♡ マストフォローより甘い罰です♡',
      'ウホッ…中身は見えないのに、失点の気配だけします♡'
    ]);
    if(type==='pickWatch') return sample([
      'そのピック、誰かの不幸になりますように♡',
      '人の不幸は蜜の味…開封の儀です♡',
      '赤背景のゴリラも見守っています。ウホッ♡'
    ]);
    if(type==='targetSelect') return sample([
      '候補を絞る？ では一番嫌な袋にします♡',
      '危険札を混ぜたい…混ぜたいですね♡',
      '下家のデスロード候補、厳選します♡'
    ]);
    if(type==='resultJoker') return sample([
      `出ました♡ ${drawnText || '危険札'}、最高の赤信号です♡`,
      'ウホッ！直撃、蜜の味です♡',
      '事故は美しい♡ その失点、輝いてます♡'
    ]);
    if(type==='resultPair') return sample([
      '浄化ですか…でもデスロードはまだ続きます♡',
      'ペア浄化、逃げ足が速いですね♡',
      'ウホッ、消しても圧は残ります♡'
    ]);
    if(type==='roundEnd') return sample([
      `第${round}ラウンド、誰かの不幸で締まりましたね♡`,
      '終了です♡ 次のデスロードを準備しましょう♡',
      'マストフォローは祝福でした♡'
    ]);
    return sample(['マストフォローは祝福です♡','人の不幸は蜜の味♡','ウホッウホッ♡']);
  }

  if(ch.key==='wakumodoki'){
    // 赤帽子・丸メガネの明るい自信家。大胆だが豚語は使わない。
    if(type==='playLeadHigh') return sample([
      `やるぞぉ〜✊🏻 ${cardTextShort}で主役を取りに行く！`,
      'できるぞぉ〜✊🏻 ここはドーンといく！',
      'あたしゃ、魔神だよ…この一手で空気を変える！'
    ]);
    if(type==='playLeadLow') return sample([
      'やるぞぉ〜✊🏻 これは未来への布石！',
      'この低さも私なら活かせる！できるぞぉ〜✊🏻',
      '赤帽子の直感、信じます！'
    ]);
    if(type==='followWin') return sample([
      '勝てる！私ならできるぞぉ〜✊🏻',
      'ここで取ったら盛り上がるよね？ 取ります！',
      'あたしゃ、魔神だよ…勝ちに行く！'
    ]);
    if(type==='followLow') return sample([
      'これも計算通り！たぶん！',
      '丸メガネは見えてます。未来が！',
      'やるぞぉ〜✊🏻 低くても気持ちは高い！'
    ]);
    if(type==='offSuit') return sample([
      '自由なら大胆にいくぞぉ〜✊🏻',
      'フォロー不能？ むしろ見せ場！',
      'できるぞぉ〜✊🏻 なんとかなる！'
    ]);
    if(type==='pickWin') return sample([
      `${target}から引くぞぉ〜✊🏻 私なら当たりを引ける！`,
      '裏向きでも乗りこなす！できるぞぉ〜✊🏻',
      'あたしゃ、魔神だよ…見えない袋も開けます。'
    ]);
    if(type==='pickWatch') return sample([
      'そのピック、めちゃくちゃ盛り上がる気がする！',
      'やるぞぉ〜✊🏻 見届けるぞぉ〜✊🏻',
      '大丈夫、たぶん全部うまくいく！'
    ]);
    if(type==='targetSelect') return sample([
      '候補を選ぶぞぉ〜✊🏻 私の直感を信じて！',
      'この中ならいける！できるぞぉ〜✊🏻',
      '魔神候補セレクション、始めます。'
    ]);
    if(type==='resultJoker') return sample([
      'えっ、でも私ならできるぞぉ〜✊🏻',
      '危険札？ 私なら扱える！たぶん！',
      'あたしゃ、魔神だよ…いや、今ちょっと人間かも…'
    ]);
    if(type==='resultPair') return sample([
      'ペア浄化！できるぞぉ〜✊🏻',
      'やるぞぉ〜✊🏻 手札が整った！',
      '私、やっぱり天才かも！'
    ]);
    if(type==='roundEnd') return sample([
      `第${round}ラウンド完了！次もやるぞぉ〜✊🏻`,
      'できるぞぉ〜✊🏻 まだまだ勝てるぞぉ〜✊🏻',
      'あたしゃ、魔神だよ…次ラウンドも任せて。'
    ]);
    return sample(['やるぞぉ〜✊🏻','できるぞぉ〜✊🏻','あたしゃ、魔神だよ…']);
  }

  if(ch.key==='rikumodoki'){
    // 白い犬の堅実PM。進捗・締切・リスク管理で話す。豚語は使わない。
    if(type==='playLeadHigh') return sample([
      `進捗上、${cardTextShort}で主導権を取ります。`,
      'リスクはありますが、ここは取得が妥当です。',
      '白犬PM判断です。前倒しで処理します。'
    ]);
    if(type==='playLeadLow') return sample([
      'まずは安全に進めます。進捗確認から入ります。',
      '低コストで様子を見ます。締切厳守です。',
      '計画通り、無理のない着手です。'
    ]);
    if(type==='followWin') return sample([
      '勝てる見込みがあります。実行します。',
      'ここは取得が妥当です。議事録に残します。',
      '計画を前倒しします。'
    ]);
    if(type==='followLow') return sample([
      '最弱回避を優先します。',
      'ここは堅実に処理します。無理はしません。',
      '締切を守るため、低リスクで進めます。'
    ]);
    if(type==='offSuit') return sample([
      'フォロー不能です。想定外ですが処理します。',
      'スコープ外です。別スートで対応します。',
      '予定変更です。落ち着いて進めます。'
    ]);
    if(type==='pickWin') return sample([
      `${target}の手札から1枚確認します。ピック工程に入ります。`,
      '中身は見えません。確率で処理します。締切厳守です。',
      'ピック担当になりました。進捗を止めません。'
    ]);
    if(type==='pickWatch') return sample([
      'ピックの進捗を確認します。',
      'この工程、リスクがありますね。',
      '予定外の事故が起きないことを祈ります。'
    ]);
    if(type==='targetSelect') return sample([
      '候補選定に入ります。リスク順に確認します。',
      '対象範囲を絞ります。締切内に決めます。',
      '想定外を避けるため、候補を管理します。'
    ]);
    if(type==='resultJoker') return sample([
      '想定外です。リカバリープランを立てます。',
      '危険札ですか…進捗に影響があります。',
      '計画が崩れました。いったん落ち着きます。'
    ]);
    if(type==='resultPair') return sample([
      'ペア処理完了。進捗良好です。',
      '手札整理、完了しました。',
      '計画通りです。'
    ]);
    if(type==='roundEnd') return sample([
      `第${round}ラウンド完了。振り返りを行いましょう。`,
      'ラウンド終了です。次工程へ進みます。',
      '締切通りです。進捗良好。'
    ]);
    return sample(['進捗確認します。','締切厳守です。','計画通りに進めましょう。']);
  }

  return null;
}

function sample(arr){ return arr[Math.floor(Math.random()*arr.length)]; }


function cpuPlayLine(room, pid, card){
  const p = room.players[pid];
  const hand = p.hand;
  const leadSuit = room.leadSuit;
  const jokerInHand = hand.some(c=>c.joker);
  const isMad = cpuIsMadPigCard(room, card);
  const shoot = cpuShootPotential(room, p);
  const mode = normalizePenaltyMode(room.penaltyMode);
  const risk = cpuCardHandRisk(room, card);

  if(shoot && (isMad || jokerInHand)){
    const line = cpuStrategyLineFor(room, pid, 'shootThreat', {card});
    if(line) return line;
  }

  if(isMad && !shoot){
    const line = cpuStrategyLineFor(room, pid, 'dumpDanger', {card});
    if(line) return line;
  }

  if(mode === 'spadeSuit' && card.suit === '♠' && !isMad){
    const line = cpuStrategyLineFor(room, pid, 'spadePenalty', {card});
    if(line) return line;
  }

  if(leadSuit && card.suit !== leadSuit && risk >= 10){
    const line = cpuStrategyLineFor(room, pid, 'dumpDanger', {card});
    if(line) return line;
  }

  if(!leadSuit){
    const t = card.val >= 11 ? 'playLeadHigh' : 'playLeadLow';
    return cpuLineFor(room, pid, t, {card}) || sample(['まずは様子見でいく。','小さく入って様子を見る。','ここは安全運転。']);
  }

  if(card.suit !== leadSuit){
    return cpuLineFor(room, pid, 'offSuit', {card}) || (jokerInHand
      ? sample(['スートがない！ババブタを隠して逃げる…','ここは別スートでかわす。ババブタだけは出せない！'])
      : sample(['そのスート持ってない！','自由に出せるならこれでいく。']));
  }

  const currentHigh = room.trick.filter(x=>x.card.suit===leadSuit).reduce((m,x)=>Math.max(m,x.card.val),0);
  if(card.val > currentHigh && card.val >= 10) return cpuLineFor(room, pid, 'followWin', {card}) || sample(['ここでそれを出す！ごちそう狙い！','勝てるなら勝つしかない！']);
  if(card.val <= 5) return cpuLineFor(room, pid, 'followLow', {card}) || sample(['低めで耐える…','これで最弱にならないといい…']);
  return cpuLineFor(room, pid, 'normal', {card}) || sample(['マストフォロー、了解。','このカードでついていく。']);
}



function cpuPickLine(room, winnerPid, weakestPid){
  const wp=room.players[winnerPid], lp=room.players[weakestPid];
  if(wp.cpu) return cpuLineFor(room, winnerPid, 'pickWin', {target:lp.name}) || sample([`さて、${lp.name}の袋から裏向きで選ぶ…`,`中身は見えない。ババブタだけは勘弁…`,`左か右か、これは本当に運です。`]);
  const cpu = room.players.find((p,i)=>p.cpu && i!==winnerPid);
  if(cpu){ const idx = room.players.indexOf(cpu); say(room, idx, cpuLineFor(room, idx, 'pickWatch', {winner:wp.name,target:lp.name}) || sample(['このピック、空気が重い…','ババブタの気配がする…'])); }
  return null;
}



function resultLine(drawn, paired, room=null, pid=null){
  if(room && pid != null){
    if(drawn.joker) return cpuLineFor(room, pid, 'resultJoker', {drawn, paired}) || sample(['危険札を引きました。これは痛い展開です。','最悪の1枚です。空気が変わりました。']);
    if(paired) return cpuLineFor(room, pid, 'resultPair', {drawn, paired}) || sample(['おそろいペア！これはうまい。','ナイス浄化。手札が軽くなりました。']);
  }
  if(drawn.joker) return sample(['危険札を引きました。これは痛い展開です。','最悪の1枚です。空気が変わりました。','完全に事故です。']);
  if(paired) return sample(['おそろいペア！これはうまい。','ナイス浄化。手札が軽くなりました。','そのペアは気持ちいい展開です。']);
  if(drawn.val >= 11) return sample(['強いカードを拾いました。これは効きそうです。','高いカード、後半で存在感が出そうです。']);
  return sample(['まずまずの1枚です。','とりあえず手札に入れておきます。','危険札ではないだけ助かりました。']);
}


function publicState(room, viewerId){
  const viewerIndex = room.players.findIndex(p=>p.id===viewerId);
  return {
    code: room.code,
    hostId: room.hostId,
    you: viewerId,
    yourIndex: viewerIndex,
    phase: room.phase,
    round: room.round,
    totalRounds: room.totalRounds || 3,
    madPigEnabled: room.madPigEnabled !== false,
    jokerPenalty: room.jokerPenalty ?? 20,
    jokerPenaltyTiming: normalizeJokerPenaltyTiming(room.jokerPenaltyTiming),
    shootThePigEnabled: shootThePigEnabled(room),
    shootPigEvent: room.shootPigEvent && room.shootPigEvent.expiresAt > Date.now() ? room.shootPigEvent : null,
    initialPairDiscardEnabled: room.initialPairDiscardEnabled === true,
    passThreeEnabled: room.passThreeEnabled === true,
    penaltyMode: normalizePenaltyMode(room.penaltyMode),
    pickTargetCount: normalizePickTargetCount(room.pickTargetCount),
    passDone: room.passDone || [],
    passTargetPid: viewerIndex >= 0 ? passTargetPid(viewerIndex) : null,
    passSourcePid: viewerIndex >= 0 ? passSourcePid(viewerIndex) : null,
    passableCardIds: viewerIndex >= 0 && room.phase === 'passing' ? passableCardIds(room.players[viewerIndex]) : [],
    initialPairDone: room.initialPairDone || [],
    initialPairCandidateIds: viewerIndex >= 0 && room.phase === 'initialPair' ? initialPairCandidateIds(room.players[viewerIndex]) : [],
    roundStart: room.roundStart && room.roundStart.expiresAt > Date.now() ? room.roundStart : null,
    roundEndSummary: room.roundEndSummary || null,
    roundEndDeferred: room.roundEndDeferred || null,
    lead: room.lead,
    current: room.current,
    leadSuit: room.leadSuit,
    message: room.message,
    removedCard: room.removedCard ? (room.phase==='finished' ? room.removedCard : null) : null,
    trick: room.trick,
    pendingPick: room.pendingPick ? {
      winnerPid: room.pendingPick.winnerPid,
      weakestPid: room.pendingPick.weakestPid,
      readyAt: room.pendingPick.readyAt,
      // クライアントのPC時計差に依存しないため、サーバー基準の状態も送る。
      ready: Date.now() >= room.pendingPick.readyAt,
      readyInMs: Math.max(0, room.pendingPick.readyAt - Date.now()),
      targetCount: room.pendingPick.targetCount || pickCandidateLimit(room, room.players[room.pendingPick.weakestPid]),
      targetSelectionRequired: room.pendingPick.targetSelectionRequired === true,
      targetSelectionDone: room.pendingPick.targetSelectionDone !== false,
      targetCandidateCount: pickCandidateCards(room, room.pendingPick).length || pickCandidateLimit(room, room.players[room.pendingPick.weakestPid]),
      targetSelectableCardIds: (viewerIndex === room.pendingPick.weakestPid && room.pendingPick.targetSelectionRequired && !room.pendingPick.targetSelectionDone) ? room.players[room.pendingPick.weakestPid].hand.map(c=>c.id) : [],
      result: room.pendingPick.result || null,
      pairChoice: room.pendingPick.pairChoice ? {
        drawn: room.pendingPick.pairChoice.drawn,
        candidates: viewerIndex === room.pendingPick.winnerPid ? room.pendingPick.pairChoice.candidates : null,
        candidateCount: room.pendingPick.pairChoice.candidates.length
      } : null
    } : null,
    players: room.players.map((p,i)=>({
      id:p.id, name:p.name, seat:i, cpu: !!p.cpu, cpuKey: cpuCharacter(p)?.key || null, avatar: cpuAvatar(p), avatarImage: cpuCharacter(p)?.imagePath || null, connected: p.cpu || (p.ws && p.ws.readyState===WebSocket.OPEN),
      handCount:p.hand.length,
      hand: p.id===viewerId || room.phase==='finished' ? p.hand : null,
      scorePileCount:p.scorePile.length,
      pairsCount:p.pairs.length,
      out:p.out || false,
      final:p.final || null,
      lastComment: p.lastComment && p.lastComment.expiresAt > Date.now() ? p.lastComment : null,
    })),
    // クライアント側の判定ズレを防ぐため、出せるカードはサーバーで確定して送る。
    playableCardIds: viewerIndex >= 0 ? [...playableIds(room, viewerIndex)] : [],
    isYourTurn: viewerIndex >= 0 && room.current === viewerIndex && room.phase === 'playing' && !room.pendingPick && !room.trickReview,
    commentary: (room.commentary || []).filter(x=>x.expiresAt > Date.now()).slice(0,4),
    lastTrick: room.lastTrick && room.lastTrick.expiresAt > Date.now() ? room.lastTrick : null,
    trickReview: room.trickReview && room.trickReview.until > Date.now() ? room.trickReview : null,
    log: room.log,
  };
}
function send(ws, type, payload){
  if(!ws || ws.readyState!==WebSocket.OPEN) return;
  try { ws.send(JSON.stringify({type, ...payload})); }
  catch(e){ console.error('send failed', e); }
}
function broadcast(room){
  if(!room || !room.players) return;
  for(const p of room.players){
    if(p.ws && p.ws.readyState===WebSocket.OPEN){
      send(p.ws,'state',{state: publicState(room,p.id)});
    }
  }
  scheduleCpu(room);
}

function normalizeRoundCount(n){
  const x = Number(n);
  if(!Number.isInteger(x)) return 3;
  return Math.max(1, Math.min(6, x));
}



function normalizePenaltyMode(v){
  if(v === 'faceValue') return 'faceValue';
  if(v === 'spadeSuit') return 'spadeSuit';
  return 'flat3';
}



function handPenaltyForRoom(room, player){
  const mode = normalizePenaltyMode(room.penaltyMode);
  const useMadPig = room.madPigEnabled !== false;
  let total = 0;
  for(const c of player.hand || []){
    if(!c || c.joker) continue;
    const isMad = c.suit==='♠' && c.rank==='11';

    // 数字分失点モードかつマッド・ピッグONの場合、スペード11は通常の11点ではなく40点として扱う。
    if(mode === 'faceValue' && useMadPig && isMad){
      total += 40;
    } else if(mode === 'faceValue'){
      total += Number(c.val || c.rank || 0);

    // ♠-3/他-1モードでは、通常カードは1点、♠スートだけ3点。
    // ただしマッド・ピッグON時の♠11は、スート失点ではなくマッド・ピッグ失点を優先する。
    } else if(mode === 'spadeSuit'){
      if(useMadPig && isMad) continue;
      total += c.suit === '♠' ? 3 : 1;

    } else {
      total += 3;
    }
  }
  return total;
}



function madPigPenaltyForRoom(room, player){
  const useMadPig = room.madPigEnabled !== false;
  if(!useMadPig) return 0;
  const mode = normalizePenaltyMode(room.penaltyMode);
  const cards = [...(player.hand || []), ...(player.scorePile || [])];
  const madPigs = cards.filter(c=>c && !c.joker && c.suit==='♠' && c.rank==='11');

  if(mode === 'faceValue'){
    // 手札にあるマッド・ピッグは handPenaltyForRoom 側で40点として計算済み。
    // ごちそう山にあるマッド・ピッグは +1点を得たうえで、ここで40点失点。
    return madPigs.filter(c => (player.scorePile || []).some(p=>p.id===c.id)).length * 40;
  }

  // 1枚-3点モード、および♠-3/他-1モードでは、手札・ごちそう山のどちらでもマッド・ピッグ失点-13点。
  // ♠-3/他-1モードの手札内♠11は、通常の♠失点-3ではなく、この-13点を優先する。
  return madPigs.length * 13;
}


function normalizePassThreeEnabled(v){
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
}

function normalizeInitialPairDiscardEnabled(v){
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
}


function normalizeJokerPenalty(v){
  const n = Number(v);
  if(!Number.isFinite(n)) return 20;
  const abs = Math.abs(Math.trunc(n));
  return Math.max(0, Math.min(999, abs));
}
function normalizeJokerPenaltyTiming(v){
  return v === 'gameEnd' ? 'gameEnd' : 'perRound';
}
function jokerPenaltyTimingLabel(room){
  return normalizeJokerPenaltyTiming(room?.jokerPenaltyTiming) === 'gameEnd' ? 'ゲーム最後' : 'ラウンド毎';
}
function normalizeShootThePigEnabled(v){
  return v === true || v === 'true';
}
function shootThePigEnabled(room){
  return room && room.madPigEnabled !== false && normalizeShootThePigEnabled(room.shootThePigEnabled);
}
function shootThePigLabel(room){
  if(room?.madPigEnabled === false) return '不可';
  return shootThePigEnabled(room) ? 'あり' : 'なし';
}
function playerHasMadPig(room, player){
  if(!room || room.madPigEnabled === false || !player) return false;
  return [...(player.hand || []), ...(player.scorePile || [])].some(c=>c && !c.joker && c.suit==='♠' && c.rank==='11');
}
function playerHasJoker(player){
  return !!(player && (player.hand || []).some(c=>c && c.joker));
}
function shouldCheckShootThePigThisRound(room){
  if(!shootThePigEnabled(room)) return false;
  const timing = normalizeJokerPenaltyTiming(room.jokerPenaltyTiming);
  if(timing === 'gameEnd') return (room.round || 1) >= (room.totalRounds || 3);
  return true;
}


function adjustHandPenaltyForShootThePig(room, player, basePenalty, active=false){
  // シュート・ザ・ピッグ発動時、手札内マッド・ピッグを手札失点側で処理しているモードだけ戻す。
  // 数字分失点：handPenaltyForRoom() 側で40点として数えるため、その分を0に戻す。
  // ♠-3/他-1：マッドON時の♠11は最初から手札失点に含めず、マッド失点側で処理するため戻し不要。
  if(!active) return basePenalty;
  if(normalizePenaltyMode(room.penaltyMode) !== 'faceValue') return basePenalty;
  const madPigHand = (player.hand || []).filter(c=>c && !c.joker && c.suit==='♠' && c.rank==='11').length;
  return Math.max(0, basePenalty - madPigHand * 40);
}



function applyShootThePigForRound(room){
  if(!room || !shouldCheckShootThePigThisRound(room)) return null;
  const roundKey = String(room.round || 1);
  room.shootPigRoundResults = room.shootPigRoundResults || {};
  if(Object.prototype.hasOwnProperty.call(room.shootPigRoundResults, roundKey)){
    return room.shootPigRoundResults[roundKey];
  }

  const shooterPid = room.players.findIndex(p=>playerHasJoker(p) && playerHasMadPig(room, p));
  if(shooterPid < 0){
    room.shootPigRoundResults[roundKey] = null;
    return null;
  }

  const timing = normalizeJokerPenaltyTiming(room.jokerPenaltyTiming);
  const isFinalRound = (room.round || 1) >= (room.totalRounds || 3);
  const result = {
    round: room.round || 1,
    shooterPid,
    shooterName: room.players[shooterPid]?.name || '',
    penaltyToOthers: 10,
    timing,
    isFinalRound,
  };

  for(const [i,p] of room.players.entries()){
    p.shootPigPenaltyBank = p.shootPigPenaltyBank || 0;
    p.shootPigActivatedRounds = p.shootPigActivatedRounds || [];
    if(i === shooterPid){
      p.shootPigActivatedRounds.push(result.round);
      // ラウンド結果ではローカルにマッド失点を0表示する。
      // 最終得点でマッド失点を0にするのは、最終ラウンドで発動した場合だけ。
      if(isFinalRound) p.shootPigFinalMadPigWaived = true;
      if(timing === 'gameEnd' && isFinalRound) p.shootPigGameEndJokerWaived = true;
    } else {
      p.shootPigPenaltyBank += result.penaltyToOthers;
    }
  }

  room.shootPigRoundResults[roundKey] = result;
  room.shootPigEvent = {
    ...result,
    id:`shoot-${result.round}-${result.shooterPid}-${Date.now()}`,
    expiresAt:Date.now()+9000
  };
  log(room, `🐷🌕 シュート・ザ・ピッグ発動！ ${result.shooterName} のこのラウンドのババブタ/マッド・ピッグ失点は0。他の全員に-10点。`);
  return result;
}



function normalizeMadPigEnabled(v){
  if(v === false || v === 'false' || v === 0 || v === '0' || v === 'off') return false;
  return true;
}


function roomByWs(ws){ return rooms.get(ws.roomCode); }

function isOpenWs(ws){
  return ws && ws.readyState === WebSocket.OPEN;
}

function findReconnectCandidate(room, playerId, name){
  if(!room) return null;
  const clean = cleanName(name);
  // 最優先：保存されたplayerIdで復帰。
  let idx = room.players.findIndex(p=>!p.cpu && p.id === playerId);
  if(idx >= 0) return {player:room.players[idx], idx, reason:'id'};

  // 次点：同名で現在切断中のプレイヤーへ復帰。
  idx = room.players.findIndex(p=>!p.cpu && p.name === clean && !isOpenWs(p.ws));
  if(idx >= 0) return {player:room.players[idx], idx, reason:'name'};

  return null;
}

function reconnectRoom(ws, c, playerId, name){
  c = String(c||'').toUpperCase().trim();
  const room = rooms.get(c);
  if(!room) return send(ws,'errorMsg',{message:'復帰する部屋が見つかりません。'});
  const found = findReconnectCandidate(room, playerId, name);
  if(!found) return send(ws,'errorMsg',{message:'復帰できる席が見つかりません。同じ部屋コードと名前で入り直してください。'});

  const {player, idx} = found;
  if(player.ws && player.ws !== ws && isOpenWs(player.ws)){
    try { player.ws.close(4000, 'reconnected elsewhere'); } catch(e){}
  }
  player.ws = ws;
  ws.roomCode = c;
  ws.playerId = player.id;
  log(room, `${player.name} が再接続しました。`);
  send(ws,'reconnected',{code:c, playerId:player.id, name:player.name});
  broadcast(room);
}



function normalizePickTargetCount(v){
  const n = Number(v);
  if(!Number.isFinite(n) || n <= 0) return 0; // 0 = 絞らない
  return Math.max(1, Math.min(13, Math.floor(n)));
}

function pickTargetLabel(room){
  const n = normalizePickTargetCount(room.pickTargetCount);
  return n > 0 ? `候補${n}枚` : '絞らない';
}

function pickCandidateLimit(room, weakestPlayer){
  const n = normalizePickTargetCount(room.pickTargetCount);
  const handCount = weakestPlayer && Array.isArray(weakestPlayer.hand) ? weakestPlayer.hand.length : 0;
  return n > 0 ? Math.min(n, handCount) : handCount;
}


function shuffleIds(ids){
  return shuffle((ids || []).map(String).slice());
}
function ensurePickOrder(room, pp){
  if(!room || !pp) return [];
  const lp = room.players[pp.weakestPid];
  if(!lp || !Array.isArray(lp.hand)) return [];

  const sourceIds = Array.isArray(pp.targetCandidateIds) && pp.targetCandidateIds.length
    ? pp.targetCandidateIds.map(String)
    : lp.hand.map(c=>c.id);
  const live = new Set(lp.hand.map(c=>c.id));
  const validCurrent = Array.isArray(pp.pickOrderIds)
    && pp.pickOrderIds.length === sourceIds.length
    && pp.pickOrderIds.every(id=>sourceIds.includes(id) && live.has(id));
  if(!validCurrent){
    pp.pickOrderIds = shuffleIds(sourceIds.filter(id=>live.has(id)));
  }
  return pp.pickOrderIds;
}

function cpuUnwantedValue(room, player, card){
  if(!card) return -999999;
  const mode = normalizePenaltyMode(room.penaltyMode);
  const shoot = cpuShootPotential(room, player);
  const mad = cpuIsMadPigCard(room, card);

  // シュート・ザ・ピッグが見えている時は、ババブタとマッド・ピッグをむやみに候補へ出さない。
  // ただし他に候補がなければ選ばれる。
  if(shoot && card.joker) return -250000;
  if(shoot && mad) return -180000;

  if(card.joker) return 1000000;
  if(mad) return mode === 'faceValue' ? 900000 : 720000;

  let value = cpuCardHandRisk(room, card) * 120;

  // 数字分失点では高数字ほど危険。♠-3/他-1では♠をやや強く嫌う。
  if(mode === 'faceValue') value += Number(card.val || 0) * 42;
  if(mode === 'spadeSuit' && card.suit === '♠') value += 180;

  // 同じ数字のペアがあるカードは後で浄化できる可能性があるため、候補優先度を下げる。
  const sameRank = (player?.hand || []).filter(c=>!c.joker && c.rank===card.rank).length;
  if(sameRank >= 2) value -= 140;

  // 終盤は高札を残す価値が下がる。
  if((player?.hand || []).length <= 4) value += Number(card.val || 0) * 12;

  // 低いカードはトリックで逃げやすい。
  if(Number(card.val || 0) <= 3) value -= 70;
  return value;
}



function pickCandidateCards(room, pp){
  if(!room || !pp) return [];
  const lp = room.players[pp.weakestPid];
  if(!lp || !Array.isArray(lp.hand)) return [];
  const orderIds = ensurePickOrder(room, pp);
  if(orderIds.length){
    return orderIds.map(id=>lp.hand.find(c=>c && c.id===id)).filter(Boolean);
  }
  return shuffle(lp.hand.slice());
}


function pickRiskValue(room, card){
  if(!card) return -999;
  if(card.joker) return 10000;
  if(room.madPigEnabled !== false && card.suit==='♠' && card.rank==='11'){
    return normalizePenaltyMode(room.penaltyMode)==='faceValue' ? 4000 : 1300;
  }
  return Number(card.val || 0);
}


function chooseCpuPickTargetIds(room, weakestPid, count){
  const p = room.players[weakestPid];
  if(!p || !Array.isArray(p.hand)) return [];
  const need = Math.max(0, count);
  return p.hand.slice()
    .map(c=>({card:c, value:cpuUnwantedValue(room, p, c), tie:Math.random()}))
    .sort((a,b)=>b.value-a.value || a.tie-b.tie)
    .slice(0, need)
    .map(x=>x.card.id);
}


function autoResolveCpuPickTargets(room, pp){
  if(!room || !pp || !pp.targetSelectionRequired || pp.targetSelectionDone) return;
  const weakest = room.players[pp.weakestPid];
  if(!weakest || !weakest.cpu) return;
  setTimeout(()=>{
    if(room.phase !== 'playing') return;
    if(room.pendingPick !== pp || pp.result || pp.targetSelectionDone) return;
    const ids = chooseCpuPickTargetIds(room, pp.weakestPid, pp.targetCount);
    say(room, pp.weakestPid, cpuStrategyLineFor(room, pp.weakestPid, 'targetSelectSmart', {target:room.players[pp.winnerPid]?.name}) || cpuLineFor(room, pp.weakestPid, 'targetSelect', {target:room.players[pp.winnerPid]?.name}) || '候補を選びます。');
    submitPickTargets(room, weakest.id, ids, true);
  }, 700);
}


function roomPenaltyLabel(room){
  const mode = normalizePenaltyMode(room.penaltyMode);
  if(mode === 'faceValue') return '数字分失点';
  if(mode === 'spadeSuit') return '♠-3/他-1';
  return '1枚-3点';
}

function roomMadPigLabel(room){
  if(room.madPigEnabled === false) return 'なし';
  return normalizePenaltyMode(room.penaltyMode)==='faceValue' ? '-40' : '-13';
}


function roomOptionSummary(room){
  return `全${room.totalRounds || 3}R / 失点:${roomPenaltyLabel(room)} / ババ:-${room.jokerPenalty ?? 20}(${jokerPenaltyTimingLabel(room)}) / マッド:${roomMadPigLabel(room)} / シュート:${shootThePigLabel(room)} / ピック:${pickTargetLabel(room)} / 3枚パス:${room.passThreeEnabled ? 'あり' : 'なし'} / 開始ペア:${room.initialPairDiscardEnabled ? 'あり' : 'なし'}`;
}



function createRoom(ws, name, totalRounds=3, madPigEnabled=true, jokerPenalty=-20, initialPairDiscardEnabled=false, passThreeEnabled=false, penaltyMode='flat3', pickTargetCount=2, jokerPenaltyTiming='perRound', shootThePigEnabled=false){
  const c = code();
  const id = uid();
  const room = {code:c, hostId:id, players:[], phase:'lobby', round:1, totalRounds: normalizeRoundCount(totalRounds), madPigEnabled: normalizeMadPigEnabled(madPigEnabled), jokerPenalty: normalizeJokerPenalty(jokerPenalty), jokerPenaltyTiming: normalizeJokerPenaltyTiming(jokerPenaltyTiming), shootThePigEnabled: normalizeMadPigEnabled(madPigEnabled) && normalizeShootThePigEnabled(shootThePigEnabled), initialPairDiscardEnabled: normalizeInitialPairDiscardEnabled(initialPairDiscardEnabled), passThreeEnabled: normalizePassThreeEnabled(passThreeEnabled), penaltyMode: normalizePenaltyMode(penaltyMode), pickTargetCount: normalizePickTargetCount(pickTargetCount), initialPairDone:[], passDone:[], passSelections:{}, lead:0, current:0, leadSuit:null, trick:[], stock:[], log:[], message:'4人そろったら開始できます。人が足りない場合はCPUを追加できます。', pendingPick:null, commentary:[], lastTrick:null};
  const player = {id, name: cleanName(name), ws, cpu:false, hand:[], scorePile:[], pairs:[], jokerPenaltyBank:0, shootPigPenaltyBank:0, shootPigFinalMadPigWaived:false, shootPigGameEndJokerWaived:false, shootPigActivatedRounds:[], out:false};
  room.players.push(player); rooms.set(c, room); ws.roomCode=c; ws.playerId=id;
  log(room, `${player.name} が部屋を作りました。${roomOptionSummary(room)}`); send(ws,'created',{code:c, playerId:id}); broadcast(room);
}
function cleanName(n){ return String(n || '').trim().slice(0,12) || '子ブタ'; }
function joinRoom(ws, c, name, playerId=null){
  c = String(c||'').toUpperCase().trim(); const room = rooms.get(c);
  if(!room) return send(ws,'errorMsg',{message:'部屋が見つかりません。'});
  if(room.phase !== 'lobby'){
    const found = findReconnectCandidate(room, playerId, name);
    if(found) return reconnectRoom(ws, c, found.player.id, found.player.name);
    return send(ws,'errorMsg',{message:'この部屋は開始済みです。切断復帰の場合は同じ名前で再接続してください。'});
  }
  if(room.players.length >= 4) {
    const found = findReconnectCandidate(room, playerId, name);
    if(found) return reconnectRoom(ws, c, found.player.id, found.player.name);
    return send(ws,'errorMsg',{message:'この部屋は満員です。'});
  }
  const id = uid(); const player = {id, name:cleanName(name), ws, cpu:false, hand:[], scorePile:[], pairs:[], jokerPenaltyBank:0, shootPigPenaltyBank:0, shootPigFinalMadPigWaived:false, shootPigGameEndJokerWaived:false, shootPigActivatedRounds:[], out:false};
  room.players.push(player); ws.roomCode=c; ws.playerId=id;
  log(room, `${player.name} が参加しました。`); send(ws,'joined',{code:c, playerId:id}); broadcast(room);
}


function addCpu(room, requesterId){
  if(room.hostId !== requesterId) return;
  if(room.phase !== 'lobby') return;
  if(room.players.length >= 4) { room.message='この部屋は満員です。'; broadcast(room); return; }
  const used = new Set(room.players.filter(p=>p.cpu).map(p=>p.cpuCharacter?.key || cpuCharacterByName(p.name)?.key));
  const ch = CPU_CHARACTERS.find(c=>!used.has(c.key)) || {key:`cpu-${uid()}`, name:`CPU${room.players.length}`, avatar:'🐷'};
  const player = {id:`CPU-${uid()}`, name:ch.name, ws:null, cpu:true, cpuCharacter:ch, hand:[], scorePile:[], pairs:[], jokerPenaltyBank:0, shootPigPenaltyBank:0, shootPigFinalMadPigWaived:false, shootPigGameEndJokerWaived:false, shootPigActivatedRounds:[], out:false};
  room.players.push(player);
  log(room, `${player.name} を追加しました。`);
  say(room, room.players.length-1, ch.catchphrase || 'よろしくお願いします。');
  room.message='CPUを追加しました。4人そろったら開始できます。';
  broadcast(room);
}

function removeCpu(room, requesterId){
  if(room.hostId !== requesterId) return;
  if(room.phase !== 'lobby') return;
  const i = room.players.map(p=>p.cpu).lastIndexOf(true);
  if(i<0) { room.message='削除できるCPUがいません。'; broadcast(room); return; }
  const [p] = room.players.splice(i,1);
  log(room, `${p.name} を外しました。`);
  room.message='CPUを外しました。';
  broadcast(room);
}


function clearPickFinishTimer(room){
  if(room.pickFinishTimer){
    clearTimeout(room.pickFinishTimer);
    room.pickFinishTimer = null;
  }
  if(room.pickFinishFailSafeTimer){
    clearTimeout(room.pickFinishFailSafeTimer);
    room.pickFinishFailSafeTimer = null;
  }
}
function clearReviewTimer(room){
  if(room.reviewTimer){
    clearTimeout(room.reviewTimer);
    room.reviewTimer = null;
  }
  if(room.reviewFailSafeTimer){
    clearTimeout(room.reviewFailSafeTimer);
    room.reviewFailSafeTimer = null;
  }
  if(room.reviewWatchTimer){
    clearInterval(room.reviewWatchTimer);
    room.reviewWatchTimer = null;
  }
}
function clearAllProgressTimers(room){
  clearReviewTimer(room);
  clearPickFinishTimer(room);
  if(room.cpuTimer){ clearTimeout(room.cpuTimer); room.cpuTimer=null; }
  if(room.cpuPickTimer){ clearTimeout(room.cpuPickTimer); room.cpuPickTimer=null; }
  if(room.cpuPickFailSafeTimer){ clearTimeout(room.cpuPickFailSafeTimer); room.cpuPickFailSafeTimer=null; }
  if(room.recoverTimer){ clearTimeout(room.recoverTimer); room.recoverTimer=null; }
}
function ensurePickFinish(room, pp, winnerPid, delay=2600){
  clearPickFinishTimer(room);
  const token = pp && pp.token ? pp.token : `${Date.now()}-${Math.random()}`;
  if(pp) pp.token = token;

  room.pickFinishTimer = setTimeout(()=>{
    room.pickFinishTimer = null;
    if(room.phase !== 'playing') return;
    if(!room.pendingPick || room.pendingPick.token !== token) return;
    finishAfterPick(room, winnerPid);
  }, delay);

  // 結果表示後に何らかのタイマー不発・状態ズレがあっても止まらないための保険。
  room.pickFinishFailSafeTimer = setTimeout(()=>{
    if(room.phase !== 'playing') return;
    if(!room.pendingPick || room.pendingPick.token !== token) return;
    log(room, '⚠️ ピック結果後の進行が遅延したため、自動復旧しました。');
    finishAfterPick(room, winnerPid);
  }, delay + 4500);
}
function ensureReviewToPick(room, reviewToken, winnerPid, weakestPid){
  // レビュー→ピック遷移は、この関数で必ず予約する。
  // 既存タイマーが残っていても一旦消し、reviewTokenで現在のレビューだけを進める。
  clearReviewTimer(room);

  const delay = Math.max(0, reviewToken - Date.now());
  room.reviewTimer = setTimeout(()=>{
    room.reviewTimer = null;
    advanceReviewToPick(room, reviewToken, winnerPid, weakestPid);
  }, delay);

  // 保険1：通常タイマーが実行されなかった場合でも進める。
  room.reviewFailSafeTimer = setTimeout(()=>{
    if(room.phase !== 'playing') return;
    if(!room.trickReview || room.trickReview.until !== reviewToken) return;
    log(room, '⚠️ トリック結果確認からピックへの遷移が遅延したため、自動復旧しました。');
    advanceReviewToPick(room, reviewToken, winnerPid, weakestPid);
  }, delay + 3500);

  // 保険2：Renderなどでタイマーが遅延しても、短い監視でレビュー期限切れを拾う。
  if(room.reviewWatchTimer) clearInterval(room.reviewWatchTimer);
  room.reviewWatchTimer = setInterval(()=>{
    if(room.phase !== 'playing' || !room.trickReview || room.trickReview.until !== reviewToken){
      clearInterval(room.reviewWatchTimer); room.reviewWatchTimer=null; return;
    }
    if(Date.now() >= reviewToken){
      clearInterval(room.reviewWatchTimer); room.reviewWatchTimer=null;
      advanceReviewToPick(room, reviewToken, winnerPid, weakestPid);
    }
  }, 500);
}


function advanceReviewToPick(room, reviewToken, winnerPid, weakestPid){
  if(room.phase !== 'playing') return;

  // 現在のレビューと違う古いタイマーなら無視。
  if(!room.trickReview || room.trickReview.until !== reviewToken) return;

  const wp = room.players[winnerPid];
  const lp = room.players[weakestPid];
  if(!wp || !lp){
    log(room, '⚠️ ピック遷移対象のプレイヤーが見つからないため、進行を復旧しました。');
    room.trickReview = null;
    room.trick = [];
    room.leadSuit = null;
    room.current = room.lead ?? 0;
    broadcast(room);
    return;
  }

  clearReviewTimer(room);
  room.trickReview = null;

  if(endCandidatePid(room) >= 0){
    room.pendingPick = null;
    checkRoundEnd(room);
    broadcast(room);
    return;
  }

  if(lp.hand.length > 0){
    const targetCount = pickCandidateLimit(room, lp);
    const targetSelectionRequired = normalizePickTargetCount(room.pickTargetCount) > 0 && targetCount < lp.hand.length;
    const readyAt = Date.now() + (targetSelectionRequired ? 999999999 : 1800);
    room.pendingPick = {
      winnerPid,
      weakestPid,
      readyAt,
      result:null,
      token:`pick-${Date.now()}-${Math.random()}`,
      targetCount,
      targetSelectionRequired,
      targetSelectionDone: !targetSelectionRequired,
      targetCandidateIds: targetSelectionRequired ? [] : null,
      pickOrderIds: targetSelectionRequired ? [] : shuffleIds(lp.hand.map(c=>c.id))
    };

    if(targetSelectionRequired){
      room.message = `🐽 ${lp.name} がピック候補を${targetCount}枚に絞ります。`;
      log(room, `🎯 ピック候補選択：${lp.name} が ${targetCount}枚を選びます。`);
      autoResolveCpuPickTargets(room, room.pendingPick);
      broadcast(room);
    } else {
      room.message = `🐽 ババ抜きピック！ ${wp.name} が ${lp.name} の袋から1枚選びます。`;
      const line = cpuPickLine(room, winnerPid, weakestPid); if(line) say(room, winnerPid, line);
      ensureCpuPick(room);
      broadcast(room);
      // readyAtを過ぎた状態を全員に再送する。Edge/PCのローカル時計差対策。
      setTimeout(()=>broadcast(room), 1850);
      setTimeout(()=>broadcast(room), 2300);
    }
  } else {
    finishAfterPick(room, winnerPid);
  }
}


function ensureRoomProgress(room){
  if(!room) return;
  // 開始時ペア捨てフェイズの進行確認。CPU処理と全員完了判定だけ行う。
  if(room.phase === 'passing'){
    // 3枚パスフェイズの進行確認。CPU処理と全員完了判定だけ行う。
    maybeFinishPassPhase(room);
    return;
  }
  if(room.phase === 'initialPair'){
    maybeFinishInitialPairPhase(room);
    return;
  }
  if(room.phase !== 'playing') return;
  if(!room.players || room.players.length !== 4) return;

  // 手札0枚は進行不能なので終了候補。
  // ババブタ1枚だけは「そのプレイヤーの手番開始時」にだけ終了候補。
  // そのため、カードを出した直後にババブタ1枚だけになってもピックまでは進める。
  if(!room.pendingPick && !room.trickReview){
    const emptyPid = room.players.findIndex(isEmptyHand);
    if(emptyPid >= 0){
      if(activeTrickInProgress(room)){
        rememberEndAfterTrick(room, emptyPid);
        broadcast(room);
      } else {
        log(room, '🏁 手札0枚を検知したため、ラウンド終了処理へ進みます。');
        checkRoundEnd(room, emptyPid);
        broadcast(room);
        return;
      }
    }

    if(Number.isInteger(room.current) && isJokerOnlyHand(room.players[room.current])){
      log(room, '🏁 手番開始時にババブタ1枚だけだったため、ラウンド終了処理へ進みます。');
      checkRoundEnd(room, room.current);
      broadcast(room);
      return;
    }
  }

  // 4枚出揃っているのにレビューにもピックにも進んでいない場合は、トリック解決をやり直す。
  if(!room.pendingPick && !room.trickReview && room.trick && room.trick.length===4){
    log(room, '⚠️ トリック解決待ちで停止を検知したため、自動復旧しました。');
    resolveTrick(room);
    broadcast(room);
    return;
  }

  // トリックが5枚以上など不正状態になった場合は、先頭4枚で解決する。
  if(!room.pendingPick && !room.trickReview && room.trick && room.trick.length>4){
    log(room, '⚠️ 場のカード枚数が不正だったため、先頭4枚で復旧しました。');
    room.trick = room.trick.slice(0,4);
    resolveTrick(room);
    broadcast(room);
    return;
  }

  // 通常進行中なのにcurrentがnullで、レビュー・ピック待ちでもない場合は復旧。
  if(room.current == null && !room.pendingPick && !room.trickReview){
    if(room.trick && room.trick.length>0 && room.trick.length<4){
      const lastPid = room.trick[room.trick.length-1].pid;
      room.current = (lastPid + 1) % room.players.length;
      log(room, '⚠️ 手番表示が停止したため、次プレイヤーへ自動復旧しました。');
      broadcast(room);
      return;
    }
    if(!room.trick || room.trick.length===0){
      room.current = Number.isInteger(room.lead) ? room.lead : 0;
      log(room, '⚠️ 手番が未設定だったため、リードプレイヤーへ自動復旧しました。');
      broadcast(room);
      return;
    }
  }

  // currentが範囲外の場合は補正。
  if(room.current != null && (!Number.isInteger(room.current) || room.current < 0 || room.current >= room.players.length)){
    room.current = ((Number(room.current)||0) % room.players.length + room.players.length) % room.players.length;
    log(room, '⚠️ 手番番号が不正だったため、自動補正しました。');
    broadcast(room);
    return;
  }

  // 現在プレイヤーに出せるカードがない場合、終了条件なら終了。そうでなければ状態再送。
  if(!room.pendingPick && !room.trickReview && room.current != null){
    const ids = playableIds(room, room.current);
    if(ids.size === 0){
      if(safeFinishBecauseNoPlayable(room, room.current)) return;
      const now = Date.now();
      if(!room.lastNoPlayableRebroadcastAt || now - room.lastNoPlayableRebroadcastAt > 2500){
        room.lastNoPlayableRebroadcastAt = now;
        log(room, '⚠️ 出せるカードがない状態を検知したため、状態を再送しました。');
        broadcast(room);
        return;
      }
    }
  }

  // ピック候補選択中は最弱プレイヤーの選択待ち。CPUなら自動解決し、人間なら状態を再送する。
  if(room.pendingPick && room.pendingPick.targetSelectionRequired && !room.pendingPick.targetSelectionDone && !room.pendingPick.result){
    autoResolveCpuPickTargets(room, room.pendingPick);
    const now = Date.now();
    if(!room.lastPickTargetRebroadcastAt || now - room.lastPickTargetRebroadcastAt > 4000){
      room.lastPickTargetRebroadcastAt = now;
      log(room, 'ピック候補選択待ちです。最弱プレイヤーは候補カードを選んでください。');
      broadcast(room);
      return;
    }
  }

  // ペア選択中は結果確定前なので自動で進めない。人間の選択待ちとして状態だけ再送する。
  if(room.pendingPick && room.pendingPick.pairChoice && !room.pendingPick.result){
    const now = Date.now();
    if(!room.lastPairChoiceRebroadcastAt || now - room.lastPairChoiceRebroadcastAt > 4000){
      room.lastPairChoiceRebroadcastAt = now;
      log(room, 'ペア選択待ちです。ペアにするカードを選ぶか、スキップしてください。');
      broadcast(room);
      return;
    }
  }

  // ピック結果が出ているのにpendingPickが残り続けている場合は進める.
  if(room.pendingPick && room.pendingPick.result){
    const age = Date.now() - (room.pendingPick.resultAt || Date.now());
    if(age > 3800){
      log(room, '⚠️ ピック結果表示後に停止を検知したため、自動復旧しました。');
      finishAfterPick(room, room.pendingPick.winnerPid);
      return;
    }
  }

  // 人間の通常手番でUI側が取りこぼした場合に備えて、出せるカードがある状態を定期再送する。
  if(!room.pendingPick && !room.trickReview && room.current != null && !room.players[room.current]?.cpu){
    const ids = playableIds(room, room.current);
    if(ids.size > 0){
      const now = Date.now();
      if(!room.lastHumanTurnRebroadcastAt || now - room.lastHumanTurnRebroadcastAt > 2500){
        room.lastHumanTurnRebroadcastAt = now;
        broadcast(room);
        return;
      }
    }
  }

  // CPU通常手番でタイマーが外れた場合は再予約。
  if(!room.pendingPick && !room.trickReview && isCpuTurn(room) && !room.cpuTimer){
    scheduleCpu(room);
    return;
  }

  // CPUピック待ちで止まっている場合は再予約。
  if(room.pendingPick && !room.pendingPick.result && room.players[room.pendingPick.winnerPid]?.cpu){
    ensureCpuPick(room);
    return;
  }

  // 人間のピック待ちでreadyAtを過ぎても画面が確認中のままにならないよう、状態を再送する。
  if(room.pendingPick && !room.pendingPick.result && !room.players[room.pendingPick.winnerPid]?.cpu){
    if(Date.now() >= room.pendingPick.readyAt && !room.pendingPick.readyBroadcasted){
      room.pendingPick.readyBroadcasted = true;
      broadcast(room);
      return;
    }
    // クリック待ちが長すぎる場合はゲーム停止ではなく、再送だけする。
    if(Date.now() >= room.pendingPick.readyAt + 12000){
      room.pendingPick.readyBroadcasted = false;
      broadcast(room);
      return;
    }
  }

  // レビュー画面で止まっている/タイマーが外れている場合は復旧。
  if(room.trickReview){
    if(room.trickReview.until <= Date.now()){
      advanceReviewToPick(room, room.trickReview.until, room.trickReview.winnerPid, room.trickReview.weakestPid);
      return;
    }
    if(!room.reviewTimer && !room.reviewWatchTimer){
      log(room, '⚠️ トリック確認タイマーが外れていたため、再予約しました。');
      ensureReviewToPick(room, room.trickReview.until, room.trickReview.winnerPid, room.trickReview.weakestPid);
      return;
    }
  }
}

function clearCpuPickTimer(room){
  if(room.cpuPickTimer){
    clearTimeout(room.cpuPickTimer);
    room.cpuPickTimer = null;
  }
}

function ensureCpuPick(room){
  const pp = room.pendingPick;
  if(!pp || pp.result) return;
  if(pp.targetSelectionRequired && !pp.targetSelectionDone) return;
  const winner = room.players[pp.winnerPid];
  const weakest = room.players[pp.weakestPid];
  const candidates = pickCandidateCards(room, pp);
  if(!winner || !winner.cpu || !weakest || !candidates.length) return;
  if(room.cpuPickTimer) return;

  // CPUがピック担当になったら、broadcast依存ではなく専用タイマーで必ず進行させる。
  const delay = Math.max(500, pp.readyAt - Date.now() + 450);
  const token = pp.readyAt;
  room.cpuPickTimer = setTimeout(()=>{
    room.cpuPickTimer = null;
    if(room.phase !== 'playing') return;
    if(!room.pendingPick || room.pendingPick.result) return;
    if(room.pendingPick.readyAt !== token) return;
    if(room.pendingPick.targetSelectionRequired && !room.pendingPick.targetSelectionDone) return;
    const currentWinner = room.players[room.pendingPick.winnerPid];
    const currentCandidates = pickCandidateCards(room, room.pendingPick);
    if(!currentWinner || !currentWinner.cpu || !currentCandidates.length) return;
    doPick(room, currentWinner.id, chooseCpuPickIndex(room, room.pendingPick, currentCandidates));
  }, delay);

  // 念のためのフェイルセーフ。何らかの理由で上のタイマーが外れても、数秒後に自動復旧。
  if(room.cpuPickFailSafeTimer) clearTimeout(room.cpuPickFailSafeTimer);
  room.cpuPickFailSafeTimer = setTimeout(()=>{
    if(room.phase !== 'playing') return;
    if(!room.pendingPick || room.pendingPick.result) return;
    if(room.pendingPick.targetSelectionRequired && !room.pendingPick.targetSelectionDone) return;
    const currentWinner = room.players[room.pendingPick.winnerPid];
    const currentCandidates = pickCandidateCards(room, room.pendingPick);
    if(!currentWinner || !currentWinner.cpu || !currentCandidates.length) return;
    log(room, '⚠️ CPUピックが遅延したため、自動復旧しました。');
    doPick(room, currentWinner.id, chooseCpuPickIndex(room, room.pendingPick, currentCandidates));
  }, Math.max(3500, delay + 3500));
}


function isCpuTurn(room){ return room.phase==='playing' && room.current!=null && room.players[room.current]?.cpu && !room.pendingPick; }


function chooseCpuCard(room, pid){
  const allowed = [...playableIds(room, pid)];
  const player = room.players[pid];
  const hand = player.hand;
  const cards = allowed.map(id=>hand.find(c=>c.id===id)).filter(Boolean);
  if(!cards.length) return null;

  // 追加ルール込みの評価関数でカードを選ぶ。
  // かももどき=攻撃、ワクもどき=大胆、リクもどき=リスク管理。
  const scored = cards
    .map(card=>({card, score:cpuCardPlayScore(room, pid, card)}))
    .sort((a,b)=>b.score-a.score || a.card.val-b.card.val);

  return scored[0].card;
}



function scheduleCpu(room){
  if(room.cpuTimer) return;
  if(room.phase !== 'playing') return;
  if(room.trickReview && room.trickReview.until > Date.now()) return;
  const pp = room.pendingPick;
  if(pp && !pp.result){
    if(pp.targetSelectionRequired && !pp.targetSelectionDone){
      autoResolveCpuPickTargets(room, pp);
      return;
    }
    if(room.players[pp.winnerPid]?.cpu){
      ensureCpuPick(room);
      return;
    }
  }
  if(isCpuTurn(room)){
    room.cpuTimer = setTimeout(()=>{ room.cpuTimer=null; doCpuPlay(room); }, 900);
  }
}

function doCpuPlay(room){
  if(!isCpuTurn(room)) return;
  const pid = room.current;
  const card = chooseCpuCard(room, pid);
  if(card){
    say(room, pid, cpuPlayLine(room, pid, card));
    playCard(room, room.players[pid].id, card.id);
  } else {
    if(!safeFinishBecauseNoPlayable(room, pid)){
      log(room, `⚠️ ${room.players[pid].name} が出せるカードを持っていないため、状態を再送しました。`);
      broadcast(room);
    }
  }
}

function doCpuPick(room){
  const pp = room.pendingPick;
  if(!pp || pp.result || pp.pairChoice || !room.players[pp.winnerPid]?.cpu) return;
  if(pp.targetSelectionRequired && !pp.targetSelectionDone) return;
  const candidates = pickCandidateCards(room, pp);
  if(!candidates.length) return;
  doPick(room, room.players[pp.winnerPid].id, Math.floor(Math.random() * candidates.length));
}




function startGame(room, requesterId){
  if(room.hostId !== requesterId) return;
  if(room.players.length !== 4) { room.message='4人そろうと開始できます。足りない席はCPUを追加してください。'; broadcast(room); return; }
  clearAllProgressTimers(room);
  room.phase='playing'; room.round=1; room.lead=Math.floor(Math.random()*4); room.current=room.lead; room.trick=[]; room.leadSuit=null; room.pendingPick=null; room.trickReview=null; room.stock=[];
  room.roundEndSummary=null; room.finalRoundSummary=null; room.roundEndOutPid=null; room.roundEndDeferred=null; room.initialPairDone=[]; room.passDone=[]; room.passSelections={};
  room.roundStart = null; room.shootPigRoundResults={}; room.shootPigEvent=null;
  room.lastHumanTurnRebroadcastAt = 0; room.lastNoPlayableRebroadcastAt = 0;
  for(const p of room.players){ p.hand=[]; p.scorePile=[]; p.pairs=[]; p.jokerPenaltyBank=0; p.shootPigPenaltyBank=0; p.shootPigFinalMadPigWaived=false; p.shootPigGameEndJokerWaived=false; p.shootPigActivatedRounds=[]; p.out=false; p.final=null; }
  dealInitial(room);
  log(room, `収穫祭スタート！${roomOptionSummary(room)}。通常カードを1枚抜き、全員13枚で開始します。`);

  if(room.passThreeEnabled){
    room.phase='passing';
    room.current=null;
    room.message='3枚パス：ババブタ以外から3枚選んでください。';
    log(room, '3枚パスあり。各プレイヤーは次の手番の人へ通常カードを3枚渡します。ババブタは渡せません。');
    autoResolveCpuPasses(room);
    maybeFinishPassPhase(room);
    return;
  }

  if(room.initialPairDiscardEnabled){
    room.phase='initialPair';
    room.current=null;
    room.message='開始時ペア捨て：ペアを捨てるかスキップしてください。';
    log(room, '開始時ペア捨てあり。各プレイヤーは任意で手札の同じ数字ペアを捨てられます。');
    autoResolveCpuInitialPairs(room);
    maybeFinishInitialPairPhase(room);
    return;
  }

  beginPlayingAfterSetup(room);
}


function dealInitial(room){
  let deck = makeDeck();
  const normals = deck.map((c,i)=>c.joker?-1:i).filter(i=>i>=0);
  const idx = normals[Math.floor(Math.random()*normals.length)];
  room.removedCard = deck.splice(idx,1)[0];
  shuffle(deck);
  for(let i=0;i<13;i++) for(let p=0;p<4;p++) room.players[p].hand.push(deck.pop());
  room.stock = deck;
  room.players.forEach(p=>sortHand(p.hand));
  log(room, `均一配札のため ${cardText(room.removedCard)} を箱に戻しました。`);
}


function passTargetPid(pid){
  return (Number(pid) + 1) % 4;
}

function passSourcePid(pid){
  return (Number(pid) + 3) % 4;
}

function passableCardIds(player){
  return (player.hand || []).filter(c=>c && !c.joker).map(c=>c.id);
}

function autoResolveCpuPasses(room){
  if(!room || room.phase !== 'passing') return;
  for(let i=0;i<room.players.length;i++){
    const p = room.players[i];
    if(!p.cpu) continue;
    if((room.passDone || []).includes(i)) continue;
    const chosen = (p.hand || []).filter(c=>c && !c.joker).slice(0,3).map(c=>c.id);
    submitPassThree(room, p.id, chosen, true);
  }
}

function allPassDone(room){
  return room.players.every((p,i)=>p.cpu || (room.passDone || []).includes(i));
}

function finishPassThreePhase(room){
  if(!room || room.phase !== 'passing') return;
  const transfers = [];
  for(let i=0;i<room.players.length;i++){
    const p = room.players[i];
    const ids = (room.passSelections && room.passSelections[i]) || [];
    if(ids.length !== 3){
      room.message = '3枚パスの選択が足りないプレイヤーがいます。';
      broadcast(room);
      return;
    }
    const cards = [];
    for(const id of ids){
      const idx = p.hand.findIndex(c=>c && c.id === id);
      if(idx < 0){
        room.message = 'パスするカードが手札に見つからないため、状態を再送しました。';
        broadcast(room);
        return;
      }
      const card = p.hand[idx];
      if(card.joker){
        room.message = 'ババブタはパスできません。';
        broadcast(room);
        return;
      }
      cards.push(card);
    }
    transfers.push({from:i, to:passTargetPid(i), ids:[...ids]});
  }

  // 先に全員の手札から抜く。これで同時パス扱いになる。
  const moved = transfers.map(t=>{
    const fromP = room.players[t.from];
    const cards = [];
    for(const id of t.ids){
      const idx = fromP.hand.findIndex(c=>c && c.id === id);
      cards.push(fromP.hand.splice(idx,1)[0]);
    }
    return {...t, cards};
  });

  // 次の手番の人へ渡す。
  for(const t of moved){
    room.players[t.to].hand.push(...t.cards);
  }
  room.players.forEach(p=>sortHand(p.hand));
  room.passSelections = {};
  room.passDone = [];
  assertUniqueActiveCards(room, '3枚パス完了後');

  log(room, '🔁 全員が次の手番の人へ3枚パスしました！ 手札がぐるっと動きました！');

  if(room.initialPairDiscardEnabled){
    room.phase='initialPair';
    room.current=null;
    room.message='3枚パス完了。開始時ペア捨てへ進みます。';
    log(room, '開始時ペア捨てあり。各プレイヤーは任意で手札の同じ数字ペアを捨てられます。');
    autoResolveCpuInitialPairs(room);
    maybeFinishInitialPairPhase(room);
    return;
  }

  beginPlayingAfterSetup(room);
}

function maybeFinishPassPhase(room){
  if(!room || room.phase !== 'passing') return;
  autoResolveCpuPasses(room);
  if(allPassDone(room)) finishPassThreePhase(room);
  else broadcast(room);
}

function submitPassThree(room, playerId, cardIds, silent=false){
  if(!room || room.phase !== 'passing') return;
  const pid = room.players.findIndex(p=>p.id === playerId);
  if(pid < 0) return;
  if((room.passDone || []).includes(pid)) return;

  const ids = Array.isArray(cardIds) ? cardIds.map(String) : [];
  const unique = [...new Set(ids)];
  if(unique.length !== 3){
    if(!silent){ room.message='パスするカードを3枚選んでください。'; broadcast(room); }
    return;
  }

  const p = room.players[pid];
  const allowed = new Set(passableCardIds(p));
  for(const id of unique){
    if(!allowed.has(id)){
      if(!silent){ room.message='ババブタは渡せません。通常カードから3枚選んでください。'; broadcast(room); }
      return;
    }
  }

  if(!room.passSelections) room.passSelections = {};
  if(!room.passDone) room.passDone = [];
  room.passSelections[pid] = unique;
  room.passDone.push(pid);
  if(!silent){
    room.message = `${p.name} が3枚パスするカードを選びました。`;
    log(room, `🔁 ${p.name} が3枚パスを確定しました。`);
  }
  maybeFinishPassPhase(room);
}

function beginPlayingAfterSetup(room){
  if(!room) return;
  room.phase='playing';
  room.current=room.lead;
  room.roundStart = {round:1, text:`第1ラウンド開始！全${room.totalRounds || 3}ラウンド。3枚パス${room.passThreeEnabled ? 'あり' : 'なし'}。開始時ペア捨て${room.initialPairDiscardEnabled ? 'あり' : 'なし'}。`, expiresAt:Date.now()+6500};
  room.message=`第1ラウンド開始。${room.players[room.current].name} からリード。`;
  log(room, '🎬 第1ラウンドを開始します。勝負スタート！');
  if(checkRoundEnd(room)) { broadcast(room); return; }
  broadcast(room);
}


function hasInitialPairCandidate(player){
  const counts = new Map();
  for(const c of player.hand || []){
    if(!c || c.joker) continue;
    counts.set(c.rank, (counts.get(c.rank)||0)+1);
    if(counts.get(c.rank) >= 2) return true;
  }
  return false;
}

function initialPairCandidatesFor(player, cardId){
  const card = (player.hand || []).find(c=>c && c.id === cardId);
  if(!card || card.joker) return [];
  return player.hand.filter(c=>c && !c.joker && c.rank === card.rank && c.id !== card.id);
}

function initialPairCandidateIds(player){
  const ids = new Set();
  const byRank = new Map();
  for(const c of player.hand || []){
    if(!c || c.joker) continue;
    if(!byRank.has(c.rank)) byRank.set(c.rank, []);
    byRank.get(c.rank).push(c);
  }
  for(const group of byRank.values()){
    if(group.length >= 2) group.forEach(c=>ids.add(c.id));
  }
  return [...ids];
}

function markInitialPairDone(room, pid){
  if(!room.initialPairDone) room.initialPairDone = [];
  if(!room.initialPairDone.includes(pid)) room.initialPairDone.push(pid);
}

function allInitialPairDone(room){
  return room.players.every((p,i)=>p.cpu || (room.initialPairDone || []).includes(i) || !hasInitialPairCandidate(p));
}

function autoResolveCpuInitialPairs(room){
  if(!room || room.phase !== 'initialPair') return;
  for(let i=0;i<room.players.length;i++){
    const p = room.players[i];
    if(!p.cpu) continue;
    // CPUは進行停止防止のため、開始時ペアを可能な限り自動で捨てる。
    let safety = 30;
    while(hasInitialPairCandidate(p) && safety-- > 0){
      const ids = initialPairCandidateIds(p);
      const first = p.hand.find(c=>ids.includes(c.id));
      const second = first ? initialPairCandidatesFor(p, first.id)[0] : null;
      if(!first || !second) break;
      discardInitialPair(room, p.id, first.id, second.id, true);
    }
    markInitialPairDone(room, i);
  }
}


function beginPlayingAfterInitialPairs(room){
  if(!room || room.phase !== 'initialPair') return;
  beginPlayingAfterSetup(room);
}


function maybeFinishInitialPairPhase(room){
  if(!room || room.phase !== 'initialPair') return;
  autoResolveCpuInitialPairs(room);
  if(allInitialPairDone(room)) beginPlayingAfterInitialPairs(room);
  else broadcast(room);
}

function discardInitialPair(room, playerId, cardAId, cardBId, silent=false){
  if(!room || room.phase !== 'initialPair') return;
  const pid = room.players.findIndex(p=>p.id === playerId);
  if(pid < 0) return;
  if((room.initialPairDone || []).includes(pid)) return;

  const p = room.players[pid];
  const ia = p.hand.findIndex(c=>c && c.id === cardAId);
  const ib = p.hand.findIndex(c=>c && c.id === cardBId);
  if(ia < 0 || ib < 0 || ia === ib){
    if(!silent){ room.message='ペアにするカードを選べませんでした。'; broadcast(room); }
    return;
  }
  const a = p.hand[ia], b = p.hand[ib];
  if(a.joker || b.joker || a.rank !== b.rank){
    if(!silent){ room.message='同じ数字の通常カードだけペアで捨てられます。'; broadcast(room); }
    return;
  }

  const hi = Math.max(ia, ib), lo = Math.min(ia, ib);
  const c1 = p.hand.splice(hi,1)[0];
  const c2 = p.hand.splice(lo,1)[0];
  p.pairs.push(c1, c2);
  sortHand(p.hand);
  assertUniqueActiveCards(room, '開始時ペア捨て後');

  if(!silent){
    room.message = `${p.name} が開始時ペアとして ${a.rank} を捨てました。`;
    log(room, `🧹 ${room.message}`);
  }
  if(!hasInitialPairCandidate(p)) markInitialPairDone(room, pid);
  maybeFinishInitialPairPhase(room);
}

function skipInitialPairs(room, playerId){
  if(!room || room.phase !== 'initialPair') return;
  const pid = room.players.findIndex(p=>p.id === playerId);
  if(pid < 0) return;
  markInitialPairDone(room, pid);
  room.message = `${room.players[pid].name} は開始時ペア捨てをスキップしました。`;
  log(room, `⏭️ ${room.message}`);
  maybeFinishInitialPairPhase(room);
}


function playableIds(room, pid){
  pid = Number(pid);
  const p = room.players[pid]; if(!p) return new Set();
  if(room.phase !== 'playing' || room.pendingPick || room.trickReview) return new Set();
  if(Number(room.current) !== pid) return new Set();

  // ババブタは場に出せない。通常カードがない場合は出せるカードなし。
  const nonJoker = p.hand.filter(c=>c && !c.joker);
  if(!nonJoker.length) return new Set();

  // リードスート未設定＝トリック先頭。通常カードなら何でも出せる。
  if(!room.leadSuit) return new Set(nonJoker.map(c=>c.id));

  // マストフォロー。
  const follow = p.hand.filter(c=>c && !c.joker && c.suit===room.leadSuit);
  return new Set((follow.length ? follow : nonJoker).map(c=>c.id));
}
function playCard(room, playerId, cardId){
  const pid = room.players.findIndex(p=>p.id===playerId);
  const allowed = playableIds(room, pid);
  if(!allowed.has(cardId)) { room.message='そのカードは出せません。マストフォロー、またはババブタ不可を確認！'; broadcast(room); return; }
  const p = room.players[pid];
  const idx = p.hand.findIndex(c=>c && c.id===cardId);
  if(idx < 0){
    room.message='そのカードは手札に見つかりません。画面を更新します。';
    log(room, `⚠️ ${p.name} が存在しないカードを出そうとしたため、状態を再送しました。`);
    broadcast(room);
    return;
  }
  const card = p.hand.splice(idx,1)[0];
  room.lastHumanTurnRebroadcastAt = 0;
  if(!room.leadSuit) room.leadSuit = card.suit;
  room.trick.push({pid, card, order:room.trick.length});
  assertUniqueActiveCards(room, 'カードプレイ後');
  room.message = `${p.name} が ${cardText(card)} を出しました。`;
  log(room, room.message);
  // ババブタ1枚だけになった場合は即終了候補にしない。次にその人の手番が来るまではピックまで進める。
  if(isEmptyHand(p) && room.trick.length < 4) rememberEndAfterTrick(room, pid);
  if(room.trick.length===4) resolveTrick(room); else room.current=(pid+1)%4;
  broadcast(room);
}

function judgeWeakestCard(room, leadSuit){
  if(!room.trick || !room.trick.length) return null;

  // 最弱判定では、リードスートを非リードスートより強い扱いにする。
  // 非リードスートが1枚でも出ていれば、非リードスートの中で一番低い数字が最弱。
  // 全員がフォローしている場合は、場の4枚の中で一番低い数字が最弱。
  // 同じ数字なら、後に出したカードが最弱。
  const offSuit = room.trick.filter(x=>x.card && x.card.suit !== leadSuit);
  const candidates = offSuit.length ? offSuit : room.trick;

  return candidates.slice().sort((a,b)=>{
    if(a.card.val !== b.card.val) return a.card.val - b.card.val;
    return b.order - a.order;
  })[0];
}


function resolveTrick(room){
  if(!room.trick || room.trick.length < 4){
    log(room, '⚠️ トリック解決に必要な4枚が揃っていないため、処理を中断しました。');
    return;
  }
  if(room.trick.length > 4) room.trick = room.trick.slice(0,4);
  const leadSuit = room.leadSuit || room.trick[0]?.card?.suit;
  room.leadSuit = leadSuit;
  const winner = room.trick.filter(x=>x.card.suit===leadSuit).sort((a,b)=>b.card.val-a.card.val)[0];
  if(!winner){
    log(room, '⚠️ 勝者を判定できなかったため、リードプレイヤーを勝者として復旧しました。');
    return;
  }
  let weakest = judgeWeakestCard(room, leadSuit);
  if(!weakest){
    log(room, '⚠️ 最弱を判定できなかったため、リードカードを最弱として復旧しました。');
    weakest = room.trick[0];
  }
  const wp = room.players[winner.pid], lp = room.players[weakest.pid];

  // トリックの最終盤面を見せるため、ここではまだピック画面に遷移しない。
  const reviewUntil = Date.now() + 5000;
  room.current = null;
  room.trickReview = {winnerPid:winner.pid, weakestPid:weakest.pid, until:reviewUntil};
  room.lastTrick = {
    winnerPid:winner.pid,
    weakestPid:weakest.pid,
    winnerName:wp.name,
    weakestName:lp.name,
    winnerCard:cardText(winner.card),
    weakestCard:cardText(weakest.card),
    expiresAt:reviewUntil + 5000
  };

  if(wp.cpu) say(room, winner.pid, sample(['よし、ごちそう山ゲットだ！','勝ったけど、このあとが怖い…','取った！でもピックが本番。']));
  if(lp.cpu && lp.hand.length>0) say(room, weakest.pid, sample(['えっ、最弱！？やめて〜！','うわっ、きついな〜。袋を見ないで！','最弱になった…嫌な予感しかしない。']));
  wp.scorePile.push(...room.trick.map(x=>x.card));
  log(room, `👑 ${wp.name} が勝利。場の4枚をごちそう山へ。`);
  log(room, `💀 最弱は ${lp.name}（${cardText(weakest.card)}）。`);
  room.message = `トリック終了！ 👑勝者は ${wp.name}、💀最弱は ${lp.name}。5秒後にババ抜きピックへ進みます。`;

  const reviewToken = reviewUntil;
  ensureReviewToPick(room, reviewToken, winner.pid, weakest.pid);
}


function findPairCandidates(player, drawn){
  if(!player || !drawn || drawn.joker) return [];
  return (player.hand || []).filter(c=>c && !c.joker && c.rank === drawn.rank && c.id !== drawn.id);
}

function completePickWithoutPair(room, pp, drawn){
  const wp = room.players[pp.winnerPid];
  const text = drawn.joker
    ? `${wp.name} はババブタを引いた！`
    : `${wp.name} は ${cardText(drawn)} を手札に加えた。`;
  pp.pairChoice = null;
  pp.result = {drawn, paired:false, skipped:true, text};
  pp.resultAt = Date.now();
  log(room, `🐽 ${text}`);
  if(wp.cpu) say(room, pp.winnerPid, resultLine(drawn, false, room, pp.winnerPid));
  room.message = text;
  broadcast(room);
  ensurePickFinish(room, pp, pp.winnerPid, drawn.joker ? 4300 : 2600);
}

function completePickWithPair(room, pp, drawn, pairCard){
  const wp = room.players[pp.winnerPid];
  const drawnIdx = wp.hand.findIndex(c=>c && c.id===drawn.id);
  const pairIdx = wp.hand.findIndex(c=>c && c.id===pairCard.id);
  if(drawnIdx < 0 || pairIdx < 0 || drawnIdx === pairIdx) return false;

  const first = wp.hand.splice(Math.max(drawnIdx, pairIdx),1)[0];
  const second = wp.hand.splice(Math.min(drawnIdx, pairIdx),1)[0];
  const pairedCards = [first, second];
  wp.pairs.push(...pairedCards);
  sortHand(wp.hand);

  const text = `${wp.name} は ${drawn.rank} のおそろいペアを選んで浄化！`;
  pp.pairChoice = null;
  pp.result = {drawn, paired:true, skipped:false, pairCard, text};
  pp.resultAt = Date.now();
  log(room, `🐽 ${text}`);
  if(wp.cpu) say(room, pp.winnerPid, resultLine(drawn, true, room, pp.winnerPid));
  else {
    const cpu = room.players.find((p,i)=>p.cpu && i!==pp.winnerPid);
    if(cpu){ const ci=room.players.indexOf(cpu); say(room, ci, resultLine(drawn, true, room, ci)); }
  }
  room.message = text;
  assertUniqueActiveCards(room, 'ペア選択後');
  broadcast(room);
  ensurePickFinish(room, pp, pp.winnerPid, 2600);
  return true;
}

function resolvePairChoice(room, playerId, selectedCardId, skip=false){
  const pp = room.pendingPick;
  if(!pp || pp.result || !pp.pairChoice) return;
  const chooserPid = room.players.findIndex(p=>p.id===playerId);
  if(chooserPid !== pp.winnerPid) return;

  const wp = room.players[pp.winnerPid];
  const drawn = pp.pairChoice.drawn;
  if(!wp || !drawn) return;

  if(skip){
    completePickWithoutPair(room, pp, drawn);
    return;
  }

  const pairCard = pp.pairChoice.candidates.find(c=>c && c.id === selectedCardId);
  if(!pairCard){
    room.message='ペアにするカードを選べませんでした。もう一度選んでください。';
    broadcast(room);
    return;
  }
  if(pairCard.rank !== drawn.rank || pairCard.joker){
    room.message='同じ数字の通常カードだけペアにできます。';
    broadcast(room);
    return;
  }
  completePickWithPair(room, pp, drawn, pairCard);
}



function submitPickTargets(room, playerId, cardIds, silent=false){
  const pp = room.pendingPick;
  if(!pp || pp.result || pp.pairChoice) return;
  if(!pp.targetSelectionRequired || pp.targetSelectionDone) return;

  const weakestPid = room.players.findIndex(p=>p.id===playerId);
  if(weakestPid !== pp.weakestPid) return;

  const lp = room.players[pp.weakestPid];
  const wp = room.players[pp.winnerPid];
  if(!lp || !wp) return;

  const ids = Array.isArray(cardIds) ? [...new Set(cardIds.map(String))] : [];
  const needed = Math.min(pp.targetCount || 0, lp.hand.length);

  if(ids.length !== needed){
    room.message = `ピック候補を${needed}枚選んでください。`;
    broadcast(room);
    return;
  }

  const handIds = new Set(lp.hand.map(c=>c.id));
  if(!ids.every(id=>handIds.has(id))){
    room.message = 'ピック候補にできないカードが含まれています。';
    broadcast(room);
    return;
  }

  pp.targetCandidateIds = shuffleIds(ids);
  pp.pickOrderIds = pp.targetCandidateIds.slice();
  pp.targetSelectionDone = true;
  pp.readyAt = Date.now() + 900;
  room.message = `${lp.name} がピック候補を${ids.length}枚に絞りました。${wp.name} が選びます。`;
  log(room, `🎯 ${lp.name} がピック候補を${ids.length}枚に絞りました。`);
  if(!silent && lp.cpu) say(room, pp.weakestPid, 'この中から選ぶ…！');
  const line = cpuPickLine(room, pp.winnerPid, pp.weakestPid); if(line) say(room, pp.winnerPid, line);
  ensureCpuPick(room);
  broadcast(room);
  setTimeout(()=>broadcast(room), 950);
  setTimeout(()=>broadcast(room), 1300);
}


function doPick(room, playerId, targetIndex){
  const pp = room.pendingPick; if(!pp || pp.result || pp.pairChoice) return;
  const chooserPid = room.players.findIndex(p=>p.id===playerId);
  if(chooserPid !== pp.winnerPid) return;
  if(pp.targetSelectionRequired && !pp.targetSelectionDone) return;
  if(Date.now() < pp.readyAt) return;
  const wp = room.players[pp.winnerPid], lp = room.players[pp.weakestPid];
  if(!wp || !lp){
    log(room, '⚠️ ピック対象のプレイヤー情報が不正だったため、ピックを終了します。');
    finishAfterPick(room, pp.winnerPid);
    return;
  }
  if(lp.hand.length<=0){
    log(room, '⚠️ 最弱プレイヤーの手札が空だったため、ピックなしで進行します。');
    finishAfterPick(room, pp.winnerPid);
    return;
  }

  const candidates = pickCandidateCards(room, pp);
  if(!candidates.length){
    log(room, '⚠️ ピック候補が空だったため、全手札から復旧してピックします。');
    pp.targetCandidateIds = null;
  }
  const actualCandidates = pickCandidateCards(room, pp);
  if(!actualCandidates.length){
    finishAfterPick(room, pp.winnerPid);
    return;
  }

  if(targetIndex < 0 || targetIndex >= actualCandidates.length || Number.isNaN(targetIndex)) targetIndex = Math.floor(Math.random()*actualCandidates.length);
  const chosen = actualCandidates[targetIndex];
  const handIndex = lp.hand.findIndex(c=>c && c.id === chosen.id);
  if(handIndex < 0){
    log(room, '⚠️ ピック候補カードが手札に見つからないため、ピックなしで進行します。');
    finishAfterPick(room, pp.winnerPid);
    return;
  }
  const drawn = lp.hand.splice(handIndex,1)[0];
  if(!drawn){
    log(room, '⚠️ ピックカード取得に失敗したため、ピックなしで進行します。');
    finishAfterPick(room, pp.winnerPid);
    return;
  }

  // まず引いたカードを手札に加える。その後、同じ数字のカードがあればペアにするかスキップするかを選ぶ。
  wp.hand.push(drawn);
  sortHand(wp.hand); sortHand(lp.hand);
  assertUniqueActiveCards(room, 'ピック直後');

  const candidatesForPair = findPairCandidates(wp, drawn);

  if(!drawn.joker && candidatesForPair.length){
    pp.pairChoice = {drawn, candidates:candidatesForPair};
    pp.resultAt = null;
    const text = `${wp.name} は ${cardText(drawn)} を引いた。ペアにするカードを選べます。`;
    log(room, `🐽 ${text}`);
    room.message = text;

    // CPUは停止しないよう、同じ数字があれば先頭候補で自動ペア浄化する。
    if(wp.cpu){
      setTimeout(()=>{
        if(room.phase === 'playing' && room.pendingPick === pp && pp.pairChoice && !pp.result){
          completePickWithPair(room, pp, drawn, chooseCpuPairCardForDiscard(room, wp, drawn, candidatesForPair) || candidatesForPair[0]);
        }
      }, 900);
    }

    broadcast(room);
    return;
  }

  completePickWithoutPair(room, pp, drawn);
}


function finishAfterPick(room, winnerPid){
  clearReviewTimer(room);
  clearPickFinishTimer(room);
  clearCpuPickTimer(room);
  if(room.cpuPickFailSafeTimer){ clearTimeout(room.cpuPickFailSafeTimer); room.cpuPickFailSafeTimer=null; }
  if(!room.pendingPick && !room.trick.length) return;
  room.pendingPick=null;
  if(checkRoundEnd(room)) { broadcast(room); return; }
  room.trick=[]; room.leadSuit=null;
  if(!Number.isInteger(winnerPid) || winnerPid < 0 || winnerPid >= room.players.length) winnerPid = room.lead ?? 0;
  room.lead=winnerPid; room.current=winnerPid;
  room.message = `${room.players[winnerPid].name} が次のリードです。`;
  broadcast(room);
}








function makeRoundSnapshot(room, reasonPid, reasonText){
  const useMadPig = room.madPigEnabled !== false;
  const jokerPenaltyValue = room.jokerPenalty ?? 20;
  const jokerPenaltyTiming = normalizeJokerPenaltyTiming(room.jokerPenaltyTiming);
  const shootPigResult = applyShootThePigForRound(room);
  const penaltyMode = normalizePenaltyMode(room.penaltyMode);
  const rows = room.players.map((p,i)=>{
    const pile = p.scorePile.length;
    const normalHand = p.hand.filter(c=>c && !c.joker).length;
    const hasJoker = playerHasJoker(p);
    const hasMadPigForShoot = playerHasMadPig(room, p);
    const madPigHand = useMadPig ? p.hand.filter(c=>c && !c.joker && c.suit==='♠' && c.rank==='11').length : 0;
    const madPigPile = useMadPig ? p.scorePile.filter(c=>c && !c.joker && c.suit==='♠' && c.rank==='11').length : 0;
    const madPig = madPigHand + madPigPile;
    const shootThePig = !!(shootPigResult && shootPigResult.shooterPid === i);

    const roundJokerPenalty = (jokerPenaltyTiming === 'perRound' && hasJoker && !shootThePig) ? jokerPenaltyValue : 0;
    const pendingFinalJokerPenalty = (jokerPenaltyTiming === 'gameEnd' && hasJoker && !shootThePig) ? jokerPenaltyValue : 0;
    if(roundJokerPenalty){
      p.jokerPenaltyBank = (p.jokerPenaltyBank || 0) + roundJokerPenalty;
    }
    const jokerPenaltyTotal = jokerPenaltyTiming === 'perRound' ? (p.jokerPenaltyBank || 0) : 0;
    const jokerPenalty = jokerPenaltyTiming === 'perRound' ? roundJokerPenalty : 0;
    const rawMadPigPenalty = madPigPenaltyForRoom(room, p);
    const madPigPenalty = shootThePig ? 0 : rawMadPigPenalty;
    const rawHandPenalty = handPenaltyForRoom(room, p);
    const handPenalty = adjustHandPenaltyForShootThePig(room, p, rawHandPenalty, shootThePig);
    const shootPigPenalty = p.shootPigPenaltyBank || 0;
    const total = pile - handPenalty - madPigPenalty - jokerPenaltyTotal - shootPigPenalty;
    return {
      pid:i,
      name:p.name,
      handCount:p.hand.length,
      normalHand,
      hasJoker,
      hasMadPigForShoot,
      pile,
      pairs:Math.floor(p.pairs.length/2),
      madPig,
      madPigHand,
      madPigPile,
      pileScore:pile,
      handPenalty,
      rawHandPenalty,
      madPigPenalty,
      rawMadPigPenalty,
      jokerPenalty,
      jokerPenaltyTotal,
      pendingFinalJokerPenalty,
      shootThePig,
      shootPigPenalty,
      shootPigPenaltyTotal: shootPigPenalty,
      total
    };
  });
  return {
    round: room.round,
    reasonPid,
    reasonName: room.players[reasonPid]?.name || '',
    reasonText,
    madPigEnabled: useMadPig,
    shootThePigEnabled: shootThePigEnabled(room),
    shootPigResult,
    jokerPenaltyValue,
    jokerPenaltyTiming,
    penaltyMode,
    rows,
    createdAt: Date.now()
  };
}







function beginNextRound(room){
  if(!room || room.phase !== 'roundEnd') return;
  clearAllProgressTimers(room);

  const outPid = Number.isInteger(room.roundEndOutPid) ? room.roundEndOutPid : 0;
  const nextRound = Math.min((room.round || 1) + 1, room.totalRounds || 3);
  room.round = nextRound;
  room.phase = 'playing';
  room.trick = [];
  room.leadSuit = null;
  room.pendingPick = null;
  room.trickReview = null;
  room.roundEndSummary = null;
  room.roundEndOutPid = null;
  room.roundEndDeferred = null;
  room.lead = outPid;
  room.current = outPid;
  room.lastHumanTurnRebroadcastAt = 0;
  room.lastNoPlayableRebroadcastAt = 0;

  let refill = buildUniqueNormalRefillDeck(room);
  const drawRefill = () => {
    while(room.stock.length){
      const c = room.stock.pop();
      if(c && !collectActiveFaceKeys(room).has(cardFaceKey(c))) return c;
    }
    if(!refill.length) refill = buildUniqueNormalRefillDeck(room);
    return refill.pop();
  };

  const refillRows = [];
  for(const p of room.players){
    const before = p.hand.length;
    let added = 0;
    while(p.hand.length < 13){
      const card = drawRefill();
      if(card && !collectActiveFaceKeys(room).has(cardFaceKey(card))){
        p.hand.push(card);
        added++;
      } else {
        break;
      }
    }
    sortHand(p.hand);
    refillRows.push(`${p.name}:${before}→${p.hand.length}${added ? `(+${added})` : ''}`);
  }

  assertUniqueActiveCards(room, `第${nextRound}ラウンド補充後`);

  const allFull = room.players.every(p=>p.hand.length === 13);
  const refillText = allFull
    ? '全員の手札を13枚まで補充しました。'
    : '補充を行いましたが、一部の手札が13枚未満です。';

  room.roundStart = {
    round:nextRound,
    text:`第${nextRound}ラウンド開始！残り手札を持ち越し、${refillText}`,
    expiresAt:Date.now()+6500
  };

  room.message=`第${nextRound}ラウンド開始。${refillText} ${room.players[room.current].name} からリード。`;
  log(room, `${room.message} 補充結果：${refillRows.join(' / ')}`);
  broadcast(room);
}


function beginRound2(room){
  beginNextRound(room);
}



function activeTrickInProgress(room){
  return !!(room && room.phase === 'playing' && !room.pendingPick && !room.trickReview && room.trick && room.trick.length > 0 && room.trick.length < 4);
}


function endCandidatePid(room){
  if(!room || !room.players) return -1;

  // 手札0枚は進行不能なので、どのタイミングでも終了候補。
  const emptyPid = room.players.findIndex(isEmptyHand);
  if(emptyPid >= 0) return emptyPid;

  // ババブタ1枚だけは「そのプレイヤーの手番開始時」にだけ終了候補にする。
  // カードを出した直後にババブタ1枚だけになっても、トリック終了後のピックまでは行う。
  if(room.phase === 'playing' && !room.pendingPick && !room.trickReview && Number.isInteger(room.current)){
    const p = room.players[room.current];
    if(isJokerOnlyHand(p)) return room.current;
  }

  return -1;
}



function rememberEndAfterTrick(room, pid){
  if(!room || pid < 0) return false;
  if(!room.roundEndDeferred || room.roundEndDeferred.pid !== pid){
    room.roundEndDeferred = {pid, round:room.round, trickCount:room.trick ? room.trick.length : 0, createdAt:Date.now()};
    const p = room.players[pid];
    const onlyJoker = isJokerOnlyHand(p);
    room.message = onlyJoker
      ? `${p.name} はババブタ1枚だけです。次に手番が来たらラウンド終了します。`
      : `${p.name} の手札がなくなりました。このトリック終了後にラウンド終了します。`;
    log(room, `🏁 ${room.message}`);
  }
  return true;
}


function canCheckRoundEndNow(room){
  return !!(room && room.phase === 'playing' && !activeTrickInProgress(room));
}


function checkRoundEnd(room, preferredPid=null){
  let outPid = -1;
  if(Number.isInteger(preferredPid) && preferredPid >= 0 && preferredPid < room.players.length && isRoundEndHand(room.players[preferredPid])){
    outPid = preferredPid;
  } else {
    outPid = endCandidatePid(room);
  }
  if(outPid<0) return false;

  const out = room.players[outPid];
  const onlyJoker = isJokerOnlyHand(out);
  clearAllProgressTimers(room);
  room.pendingPick = null;
  room.trickReview = null;
  room.trick = [];
  room.leadSuit = null;

  const reasonText = onlyJoker
    ? `${out.name} の手番開始時、袋にババブタ1枚だけが残っていました。`
    : `${out.name} の手札がなくなりました。`;

  const snapshot = makeRoundSnapshot(room, outPid, reasonText);
  room.roundEndOutPid = outPid;
  room.roundEndDeferred = null;

  if((room.round || 1) < (room.totalRounds || 3)){
    room.roundEndSummary = snapshot;
    room.phase='roundEnd';
    room.current=null;
    room.message=`第${room.round}ラウンド終了！結果を確認してOKを押すと第${room.round+1}ラウンドへ進みます。`;
    const cpuSpeaker = room.players.find((p,i)=>p.cpu);
    if(cpuSpeaker){ const ci=room.players.indexOf(cpuSpeaker); say(room, ci, cpuLineFor(room, ci, 'roundEnd', {}) || 'ラウンド終了です。'); }
    log(room, room.message);
  } else {
    room.finalRoundSummary = snapshot;
    room.roundEndSummary = null;
    room.phase='finished';
    room.current=null;
    room.message = onlyJoker
      ? `${out.name} の手番開始時、袋にババブタ1枚だけが残っていました！ゲーム終了。`
      : `${out.name} が上がり！ゲーム終了。`;
    if(out.cpu) say(room, outPid, onlyJoker ? sample(['ババブタだけ残った…終わった…','袋の中がババブタだけ！？']) : sample(['上がり！ごちそう山を数える！','決着！点数計算だ！']));
    log(room, room.message);
    score(room);
  }
  return true;
}









function score(room){
  const useMadPig = room.madPigEnabled !== false;
  const jokerPenaltyValue = room.jokerPenalty ?? 20;
  const jokerPenaltyTiming = normalizeJokerPenaltyTiming(room.jokerPenaltyTiming);
  const penaltyMode = normalizePenaltyMode(room.penaltyMode);
  for(const p of room.players){
    const pile = p.scorePile.length;
    const normalHand = p.hand.filter(c=>c && !c.joker).length;
    const madPigHand = useMadPig ? p.hand.filter(c=>c && !c.joker && c.suit==='♠' && c.rank==='11').length : 0;
    const madPigPile = useMadPig ? p.scorePile.filter(c=>c && !c.joker && c.suit==='♠' && c.rank==='11').length : 0;
    const madPig = madPigHand + madPigPile;
    const joker = playerHasJoker(p) ? 1 : 0;
    const finalShootWaiver = !!p.shootPigFinalMadPigWaived;
    const rawHandPenalty = handPenaltyForRoom(room, p);
    const handPenalty = adjustHandPenaltyForShootThePig(room, p, rawHandPenalty, finalShootWaiver);
    const rawMadPigPenalty = madPigPenaltyForRoom(room, p);
    const madPigPenalty = finalShootWaiver ? 0 : rawMadPigPenalty;
    const jokerPenaltyFromRounds = jokerPenaltyTiming === 'perRound' ? (p.jokerPenaltyBank || 0) : 0;
    const jokerPenaltyAtGameEnd = (jokerPenaltyTiming === 'gameEnd' && joker && !p.shootPigGameEndJokerWaived) ? joker*jokerPenaltyValue : 0;
    const jokerPenalty = jokerPenaltyFromRounds + jokerPenaltyAtGameEnd;
    const shootPigPenalty = p.shootPigPenaltyBank || 0;
    const total = pile - handPenalty - madPigPenalty - jokerPenalty - shootPigPenalty;
    p.final = {pile, normalHand, handPenalty, rawHandPenalty, madPig, madPigHand, madPigPile, madPigPenalty, rawMadPigPenalty, joker, jokerPenaltyValue, jokerPenaltyTiming, jokerPenaltyFromRounds, jokerPenaltyAtGameEnd, jokerPenalty, shootPigPenalty, shootPigMadPigWaived:finalShootWaiver, shootPigGameEndJokerWaived:!!p.shootPigGameEndJokerWaived, shootPigActivatedRounds:p.shootPigActivatedRounds || [], penaltyMode, total};
  }
}







wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg; try { msg=JSON.parse(raw); } catch(e){ return; }
    if(msg.type==='create') return createRoom(ws, msg.name, msg.rounds, msg.madPigEnabled, msg.jokerPenalty, msg.initialPairDiscardEnabled, msg.passThreeEnabled, msg.penaltyMode, msg.pickTargetCount, msg.jokerPenaltyTiming, msg.shootThePigEnabled);
    if(msg.type==='join') return joinRoom(ws, msg.code, msg.name, msg.playerId);
    if(msg.type==='reconnect') return reconnectRoom(ws, msg.code, msg.playerId, msg.name);
    const room = roomByWs(ws); if(!room) return;
    if(msg.type==='start') startGame(room, ws.playerId);
    if(msg.type==='addCpu') addCpu(room, ws.playerId);
    if(msg.type==='removeCpu') removeCpu(room, ws.playerId);
    if(msg.type==='play') playCard(room, ws.playerId, msg.cardId);
    if(msg.type==='pick') doPick(room, ws.playerId, Number(msg.index));
    if(msg.type==='pickTargets') submitPickTargets(room, ws.playerId, msg.cardIds);
    if(msg.type==='pairChoice') resolvePairChoice(room, ws.playerId, msg.cardId, !!msg.skip);
    if(msg.type==='passThree') submitPassThree(room, ws.playerId, msg.cardIds);
    if(msg.type==='initialPairDiscard') discardInitialPair(room, ws.playerId, String(msg.cardAId||''), String(msg.cardBId||''));
    if(msg.type==='skipInitialPairs') skipInitialPairs(room, ws.playerId);
    if(msg.type==='continueRound') {
      if(room.phase === 'roundEnd'){
        log(room, `ラウンド結果確認OK。第${room.round+1}ラウンドへ進みます。`);
        beginNextRound(room);
      }
    }
  });
  ws.on('close', () => {
    const room = roomByWs(ws); if(!room) return;
    const p = room.players.find(x=>x.id===ws.playerId); if(p && p.ws === ws) {
      p.ws = null;
      log(room, `${p.name} が切断しました。再接続待ちです。`);
      broadcast(room);
    }
    if(room.players.every(p=>!p.ws || p.ws.readyState!==WebSocket.OPEN)) setTimeout(()=>{
      const r = rooms.get(room.code); if(r && r.players.every(p=>!p.ws || p.ws.readyState!==WebSocket.OPEN)) rooms.delete(room.code);
    }, 10*60*1000);
  });
});

server.listen(PORT, () => console.log(`【ピピトリ】ピッグ・ピック・トリック server listening on http://localhost:${PORT}`));

