'use strict';
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');

// ── クラッシュ防止 ──
process.on('uncaughtException',  e => console.error('[uncaughtException]', e));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 25000,
  pingTimeout:  10000,
  transports: ['websocket', 'polling'],
});
app.use(express.json());
app.use(express.static(__dirname));
app.get('/health', (_q, r) => r.json({ ok: true, uptime: process.uptime() }));

// ══════════════════════════════════════════════
// PostgreSQL（DATABASE_URL があれば使う、なければJSON）
// ══════════════════════════════════════════════
let db = null;
async function initDB() {
  if (!process.env.DATABASE_URL) { console.log('📁 DB: JSONファイルモード'); return; }
  try {
    const { Pool } = require('pg');
    db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        streak_days INTEGER DEFAULT 0,
        total_streams INTEGER DEFAULT 0,
        avg_achieve NUMERIC(5,2) DEFAULT 0,
        total_payout INTEGER DEFAULT 0,
        point_balance INTEGER DEFAULT 0,
        -- ★ RPG要素
        level INTEGER DEFAULT 1,
        xp INTEGER DEFAULT 0,
        fatigue INTEGER DEFAULT 0,
        last_streamed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS streams (
        id UUID PRIMARY KEY,
        streamer_id UUID REFERENCES users(id),
        title TEXT, goal TEXT, category TEXT, emoji TEXT,
        status TEXT DEFAULT 'live',
        peak_viewers INTEGER DEFAULT 0,
        total_pushes BIGINT DEFAULT 0,
        gift_total INTEGER DEFAULT 0,
        boost_rate NUMERIC(4,2) DEFAULT 1.0,
        bomb_clears INTEGER DEFAULT 0,
        achieve_pct INTEGER,
        payout INTEGER,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        ended_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS gifts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        stream_id UUID, sender_id UUID, sender_name TEXT,
        amount INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        stream_id UUID, sender_name TEXT,
        trial TEXT, boost_pct INTEGER DEFAULT 5,
        status TEXT DEFAULT 'pending',
        vote_yes INTEGER DEFAULT 0, vote_no INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS archives (
        id UUID PRIMARY KEY,
        streamer_id UUID, streamer_name TEXT,
        title TEXT, goal TEXT, category TEXT, emoji TEXT,
        duration_sec INTEGER DEFAULT 0,
        gift_total INTEGER DEFAULT 0,
        boost_rate NUMERIC(4,2) DEFAULT 1.0,
        bomb_clears INTEGER DEFAULT 0,
        peak_viewers INTEGER DEFAULT 0,
        total_pushes BIGINT DEFAULT 0,
        achieve_pct INTEGER, payout INTEGER,
        recording_url TEXT,
        started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✅ PostgreSQL 接続完了');
  } catch(e) {
    console.error('❌ PostgreSQL 接続失敗 → JSONモードで動作:', e.message);
    db = null;
  }
}

// ══════════════════════════════════════════════
// JSONファイル永続化（PostgreSQLなし時のフォールバック）
// ══════════════════════════════════════════════
function resolveDataDir() {
  for (const d of [process.env.DATA_DIR, '/data', path.join(__dirname,'data'), __dirname].filter(Boolean)) {
    try {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      const t = path.join(d, '.wtest'); fs.writeFileSync(t,'ok'); fs.unlinkSync(t);
      console.log(`📁 データ保存先: ${d}`); return d;
    } catch(e) { console.warn(`⚠️ ${d} 書き込み不可`); }
  }
  return __dirname;
}
const DATA_DIR = resolveDataDir();
const USERS_FILE    = path.join(DATA_DIR, 'push_users.json');
const ARCHIVES_FILE = path.join(DATA_DIR, 'push_archives.json');

function loadJSON(f, fb) {
  try { if(fs.existsSync(f)) return JSON.parse(fs.readFileSync(f,'utf8')); } catch(e){}
  return fb;
}
function saveJSON(f, d) {
  try { fs.writeFileSync(f, JSON.stringify(d,null,2),'utf8'); } catch(e){ console.error('saveJSON:',e.message); }
}

// メモリ上のユーザー・セッション・アーカイブ
const userMap    = new Map(Object.entries(loadJSON(USERS_FILE, {})));
const sessions   = new Map(); // token → { userId, email, name }
const archiveMap = new Map(Object.entries(loadJSON(ARCHIVES_FILE, {})));
console.log(`📊 ユーザー${userMap.size}件 / アーカイブ${archiveMap.size}件`);

// ── ユーティリティ ──
const hashPw  = p  => crypto.createHash('sha256').update(p+'push_salt').digest('hex');
const mkToken = () => crypto.randomBytes(32).toString('hex');
const mkUUID  = () => crypto.randomUUID();

// ══════════════════════════════════════════════
// ライブ状態管理（メモリ）
// ══════════════════════════════════════════════
const liveStreams = new Map(); // streamId → stream
const clients    = new Map(); // socketId → client

// ★ PUSHボタン バッファ（バッチ書き込みで負荷97%削減）
const pushBuffer = new Map(); // streamId → count

// 3秒ごとにバッファをDBに書き込み
setInterval(async () => {
  for (const [streamId, count] of pushBuffer) {
    if (count <= 0) { pushBuffer.delete(streamId); continue; }
    pushBuffer.delete(streamId);
    const s = liveStreams.get(streamId);
    if (s) s.totalPushes = (s.totalPushes || 0) + count;
    if (db) {
      await db.query('UPDATE streams SET total_pushes = total_pushes + $1 WHERE id=$2', [count, streamId]).catch(()=>{});
    }
  }
}, 3000);

function getLV(streamId) {
  let n=0; for(const c of clients.values()) if(c.streamId===streamId) n++; return n;
}
function broadcastVC(streamId) {
  io.to(`s:${streamId}`).emit('viewer_count_update', { liveViewers: getLV(streamId) });
}
function publicStreams() {
  return Array.from(liveStreams.values()).map(s => ({
    streamId: s.streamId, streamerId: s.streamerId, streamerName: s.streamerName,
    title: s.title, goal: s.goal, category: s.category, emoji: s.emoji,
    startedAt: s.startedAt, giftTotal: s.giftTotal, boost: s.boost,
    totalPushes: s.totalPushes || 0, liveViewers: getLV(s.streamId),
    isNewcomer: s.isNewcomer || false,    // ★ 新人ブースト
    isPrivate:  s.isPrivate  || false,   // ★ 非公開モード
  }));
}

// ── 認証ヘルパー ──
function ensureAuth(socketId, data) {
  const c = clients.get(socketId);
  if (!c) return null;
  if (c.userId) return c;
  const tok = data?.token || c.token;
  if (!tok) return null;
  const s = sessions.get(tok);
  if (!s) return null;
  Object.assign(c, { userId: s.userId, name: s.name, token: tok });
  return c;
}

// ── ユーザー検索（DB or Map）──
async function findUserByEmail(email) {
  if (db) {
    const r = await db.query('SELECT * FROM users WHERE email=$1', [email]);
    return r.rows[0] || null;
  }
  return userMap.get(email) || null;
}
async function createUser(name, email, passwordHash) {
  const id = mkUUID();
  const now = new Date();
  if (db) {
    const r = await db.query(
      'INSERT INTO users(id,name,email,password_hash,level,xp,fatigue,created_at) VALUES($1,$2,$3,$4,1,0,0,$5) RETURNING *',
      [id, name, email, passwordHash, now]
    );
    return r.rows[0];
  }
  const u = { id, name, email, passwordHash, level:1, xp:0, fatigue:0, streakDays:0, totalStreams:0, createdAt: now };
  userMap.set(email, u);
  saveJSON(USERS_FILE, Object.fromEntries(userMap));
  return u;
}

// ── 新人ブースト判定（登録30日以内） ──
function isNewcomer(user) {
  if (!user) return false;
  const created = user.createdAt || user.created_at;
  if (!created) return false;
  const daysSince = (Date.now() - new Date(created).getTime()) / (1000 * 60 * 60 * 24);
  return daysSince <= 30;
}

// ── RPG: XP計算・レベルアップ ──
function xpForLevel(lv) { return lv * lv * 100; } // レベルnに必要な累計XP
function calcLevel(xp) {
  let lv = 1;
  while (xp >= xpForLevel(lv + 1)) lv++;
  return lv;
}
async function addXP(userId, email, amount) {
  try {
    if (db) {
      const r = await db.query('SELECT xp, level FROM users WHERE id=$1', [userId]);
      if (!r.rows[0]) return;
      const newXP  = (r.rows[0].xp || 0) + amount;
      const newLv  = calcLevel(newXP);
      await db.query('UPDATE users SET xp=$1, level=$2 WHERE id=$3', [newXP, newLv, userId]);
      return { xp: newXP, level: newLv, levelUp: newLv > r.rows[0].level };
    } else {
      const u = userMap.get(email);
      if (!u) return;
      u.xp  = (u.xp  || 0) + amount;
      u.level = calcLevel(u.xp);
      saveJSON(USERS_FILE, Object.fromEntries(userMap));
      return { xp: u.xp, level: u.level };
    }
  } catch(e) { console.error('addXP:', e.message); }
}

// ── RPG: 疲労度更新 ──
async function updateFatigue(userId, email, delta) {
  try {
    if (db) {
      await db.query('UPDATE users SET fatigue = GREATEST(0, LEAST(100, fatigue + $1)) WHERE id=$2', [delta, userId]);
    } else {
      const u = userMap.get(email);
      if (u) { u.fatigue = Math.max(0, Math.min(100, (u.fatigue||0) + delta)); saveJSON(USERS_FILE, Object.fromEntries(userMap)); }
    }
  } catch(e) {}
}

// ── RPGステータス取得 ──
async function getRPGStats(userId, email) {
  try {
    if (db) {
      const r = await db.query('SELECT level,xp,fatigue,streak_days,total_streams,avg_achieve FROM users WHERE id=$1', [userId]);
      return r.rows[0] || {};
    }
    const u = userMap.get(email);
    return u ? { level:u.level||1, xp:u.xp||0, fatigue:u.fatigue||0, streak_days:u.streakDays||0, total_streams:u.totalStreams||0, avg_achieve:u.avgAchieve||0 } : {};
  } catch(e) { return {}; }
}

// ── アーカイブ保存 ──
async function saveArchive(stream, extra={}) {
  const a = {
    id: stream.streamId, streamerId: stream.streamerId, streamerName: stream.streamerName,
    title: stream.title, goal: stream.goal, category: stream.category, emoji: stream.emoji,
    durationSec: stream.streamSec||0, giftTotal: stream.giftTotal||0,
    boostRate: stream.boost||1, bombClears: stream.bombClears||0,
    peakViewers: stream.peakViewers||0, totalPushes: stream.totalPushes||0,
    achievePct: extra.yesPct??null, payout: extra.payout??null,
    recordingUrl: extra.recordingUrl||null,
    startedAt: stream.startedAt, endedAt: new Date(),
  };
  if (db) {
    await db.query(`
      INSERT INTO archives(id,streamer_id,streamer_name,title,goal,category,emoji,
        duration_sec,gift_total,boost_rate,bomb_clears,peak_viewers,total_pushes,
        achieve_pct,payout,started_at,ended_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT(id) DO NOTHING
    `, [a.id,a.streamerId,a.streamerName,a.title,a.goal,a.category,a.emoji,
        a.durationSec,a.giftTotal,a.boostRate,a.bombClears,a.peakViewers,a.totalPushes,
        a.achievePct,a.payout,a.startedAt,a.endedAt]).catch(e=>console.error('saveArchive:',e.message));
  } else {
    archiveMap.set(stream.streamId, a);
    saveJSON(ARCHIVES_FILE, Object.fromEntries(archiveMap));
  }
  return a;
}

// ══════════════════════════════════════════════
// REST API — 認証
// ══════════════════════════════════════════════
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password } = req.body||{};
    if (!name||!email||!password) return res.status(400).json({ error: '全項目を入力してください' });
    if (password.length < 6) return res.status(400).json({ error: 'パスワードは6文字以上' });
    if (await findUserByEmail(email)) return res.status(400).json({ error: 'このメールは既に登録済みです' });
    const u   = await createUser(name, email, hashPw(password));
    const tok = mkToken();
    sessions.set(tok, { userId: u.id, email: u.email, name: u.name });
    console.log(`📝 新規登録: ${name}`);
    res.json({ token: tok, user: { id: u.id, name: u.name, email: u.email } });
  } catch(e) { console.error('register:', e); res.status(500).json({ error: 'サーバーエラー' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body||{};
    const u = await findUserByEmail(email);
    const ph = u?.passwordHash || u?.password_hash;
    if (!u || ph !== hashPw(password)) return res.status(401).json({ error: 'メールまたはパスワードが正しくありません' });
    const tok = mkToken();
    const name = u.name;
    sessions.set(tok, { userId: u.id, email: u.email, name });
    console.log(`🔑 ログイン: ${name}`);
    res.json({ token: tok, user: { id: u.id, name, email: u.email } });
  } catch(e) { console.error('login:', e); res.status(500).json({ error: 'サーバーエラー' }); }
});

app.get('/api/me', async (req, res) => {
  try {
    const tok = (req.headers.authorization||'').replace('Bearer ','');
    const s   = sessions.get(tok);
    if (!s) return res.status(401).json({ error: '未ログイン' });
    const u = await findUserByEmail(s.email);
    if (!u) return res.status(401).json({ error: 'ユーザーが見つかりません' });
    res.json({ user: { id: u.id, name: u.name, email: u.email } });
  } catch(e) { res.status(500).json({ error: 'サーバーエラー' }); }
});

app.post('/api/logout', (req, res) => {
  const tok = (req.headers.authorization||'').replace('Bearer ','');
  sessions.delete(tok);
  res.json({ ok: true });
});

// ── 配信一覧 ──
app.get('/api/streams', (_q, res) => res.json({ streams: publicStreams() }));

// ── アーカイブ一覧 ──
app.get('/api/archives', async (_q, res) => {
  try {
    if (db) {
      const r = await db.query('SELECT * FROM archives ORDER BY ended_at DESC LIMIT 100');
      return res.json({ archives: r.rows });
    }
    const list = Array.from(archiveMap.values()).sort((a,b)=>new Date(b.endedAt)-new Date(a.endedAt));
    res.json({ archives: list });
  } catch(e) { res.status(500).json({ error: 'サーバーエラー' }); }
});

// ── 自分のアーカイブ ──
app.get('/api/archives/mine', async (req, res) => {
  try {
    const tok = (req.headers.authorization||'').replace('Bearer ','');
    const s   = sessions.get(tok);
    if (!s) return res.status(401).json({ error: '未ログイン' });
    if (db) {
      const r = await db.query('SELECT * FROM archives WHERE streamer_id=$1 ORDER BY ended_at DESC', [s.userId]);
      return res.json({ archives: r.rows });
    }
    const list = Array.from(archiveMap.values()).filter(a=>a.streamerId===s.userId)
      .sort((a,b)=>new Date(b.endedAt)-new Date(a.endedAt));
    res.json({ archives: list });
  } catch(e) { res.status(500).json({ error: 'サーバーエラー' }); }
});

// ── インサイト ──
app.get('/api/insights', async (req, res) => {
  try {
    const tok = (req.headers.authorization||'').replace('Bearer ','');
    const s   = sessions.get(tok);
    if (!s) return res.status(401).json({ error: '未ログイン' });
    let rows;
    if (db) {
      const r = await db.query('SELECT * FROM archives WHERE streamer_id=$1', [s.userId]);
      rows = r.rows;
    } else {
      rows = Array.from(archiveMap.values()).filter(a=>a.streamerId===s.userId);
    }
    res.json({ insights: {
      totalStreams:    rows.length,
      totalGift:       rows.reduce((a,r)=>a+(r.giftTotal||r.gift_total||0),0),
      totalViewers:    rows.reduce((a,r)=>a+(r.peakViewers||r.peak_viewers||0),0),
      totalPushes:     rows.reduce((a,r)=>a+(Number(r.totalPushes||r.total_pushes)||0),0),
      avgAchievement:  rows.length ? Math.round(rows.reduce((a,r)=>a+(r.achievePct||r.achieve_pct||0),0)/rows.length) : 0,
      totalPayout:     rows.reduce((a,r)=>a+(r.payout||0),0),
    }});
  } catch(e) { res.status(500).json({ error: 'サーバーエラー' }); }
});

app.get('/live/:id', (_q, res) => res.sendFile(path.join(__dirname,'index.html')));

// ══════════════════════════════════════════════
// Agora RTC トークン生成（純粋Node.js実装）
// ══════════════════════════════════════════════
const AGORA_APP_ID_ENV      = process.env.AGORA_APP_ID      || '367d4b9e93b74576b9d334696c6a17fc';
const AGORA_APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE || '';

// ── Agora AccessToken2（007形式）公式仕様準拠実装 ──
function generateAgoraToken(channelName, uid = 0, expireSeconds = 86400) {
  if (!AGORA_APP_CERTIFICATE) return null;
  const zlib = require('zlib');
  const now    = Math.floor(Date.now() / 1000);
  const expire = now + expireSeconds;
  const salt   = Math.floor(Math.random() * 0x7FFFFFFF) + 1;

  const pu16 = v => { const b=Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const pu32 = v => { const b=Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const pStr = s => { const sb=Buffer.from(s,'utf8'); return Buffer.concat([pu16(sb.length),sb]); };
  const pBuf = b => Buffer.concat([pu16(b.length),b]);

  // privileges: {1(joinChannel): expire}
  const privileges = Buffer.concat([pu16(1), pu16(1), pu32(expire)]);

  // service RTC data
  const uidStr = (uid === 0 || uid === '') ? '' : String(uid);
  const svcData = Buffer.concat([
    pu16(1),            // RTC service type = 1
    privileges,
    pStr(channelName),
    pStr(uidStr),
  ]);

  // content = packStr(appId) + u32(expire) + u32(salt) + u32(issueTs) + u16(1) + svcData
  const content = Buffer.concat([
    pStr(AGORA_APP_ID_ENV),
    pu32(expire),
    pu32(salt),
    pu32(now),
    pu16(1),
    svcData,
  ]);

  // signingKey = HMAC-SHA256(cert_utf8, issueTs_LE + salt_LE)
  const skData = Buffer.concat([pu32(now), pu32(salt)]);
  const signingKey = crypto.createHmac('sha256', Buffer.from(AGORA_APP_CERTIFICATE,'utf8'))
    .update(skData).digest();

  // sig = HMAC-SHA256(signingKey, content)
  const sig = crypto.createHmac('sha256', signingKey).update(content).digest();

  // final = "007" + base64(zlib(pBuf(sig) + content))
  const compressed = zlib.deflateSync(Buffer.concat([pBuf(sig), content]));
  return '007' + compressed.toString('base64');
}

// ── デバッグ：Agora設定確認 ──
app.get('/api/debug-agora', (req, res) => {
  const hasCert = !!AGORA_APP_CERTIFICATE;
  const certLen = AGORA_APP_CERTIFICATE.length;
  let testToken = null;
  try {
    if (hasCert) testToken = generateAgoraToken('push-test', 0, 3600);
  } catch(e) { testToken = 'ERROR: ' + e.message; }
  res.json({
    appId: AGORA_APP_ID_ENV,
    hasCertificate: hasCert,
    certificateLength: certLen,
    tokenGenerated: !!testToken && !testToken.startsWith('ERROR'),
    tokenPreview: testToken ? testToken.slice(0, 20) + '...' : null,
    tokenError: testToken?.startsWith('ERROR') ? testToken : null,
  });
});

// ── トークン生成API ──
app.post('/api/agora-token', (req, res) => {
  if (!AGORA_APP_CERTIFICATE) return res.json({ token: null });
  try {
    const { channelName, uid } = req.body || {};
    if (!channelName) return res.status(400).json({ error: 'channelNameが必要です' });
    const token = generateAgoraToken(channelName, uid || 0, 86400);
    console.log('🔑 AccessToken2生成:', channelName, token ? token.slice(0,12)+'...' : 'null');
    res.json({ token });
  } catch(e) {
    console.error('token gen error:', e.message);
    res.json({ token: null });
  }
});
const REC_DIR = path.join(DATA_DIR, 'recordings');
if (!fs.existsSync(REC_DIR)) { try{ fs.mkdirSync(REC_DIR,{recursive:true}); }catch(e){} }

// ── 録画アップロード ──
app.post('/api/upload-recording', async (req, res) => {
  try {
    const tok = (req.headers.authorization||'').replace('Bearer ','');
    const s   = sessions.get(tok);
    if (!s) return res.status(401).json({ error: '未ログイン' });

    const streamId = req.query.streamId || req.headers['x-stream-id'] || '';
    const chunks   = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        // multipart/form-dataを手動パース（外部ライブラリなし）
        const buf = Buffer.concat(chunks);
        const boundary = (req.headers['content-type']||'').split('boundary=')[1];
        if (!boundary) return res.status(400).json({ error: 'boundary not found' });

        // バイナリから動画ブロブを抽出
        const bnd = Buffer.from('--' + boundary);
        const parts = [];
        let pos = 0;
        while (pos < buf.length) {
          const idx = buf.indexOf(bnd, pos);
          if (idx === -1) break;
          pos = idx + bnd.length;
          const headerEnd = buf.indexOf(Buffer.from('\r\n\r\n'), pos);
          if (headerEnd === -1) break;
          const header = buf.slice(pos, headerEnd).toString();
          pos = headerEnd + 4;
          const nextBnd = buf.indexOf(bnd, pos);
          const end = nextBnd === -1 ? buf.length : nextBnd - 2;
          if (header.includes('filename')) {
            const fnMatch = header.match(/filename="([^"]+)"/);
            parts.push({ name: fnMatch?.[1]||'rec.webm', data: buf.slice(pos, end) });
          }
          pos = end;
        }

        if (!parts.length) return res.status(400).json({ error: 'no file found' });

        const fname = parts[0].name;
        const fpath = path.join(REC_DIR, fname);
        fs.writeFileSync(fpath, parts[0].data);
        const url = `/recordings/${fname}`;
        console.log(`📹 録画保存: ${fname} (${Math.round(parts[0].data.length/1024)}KB)`);

        // アーカイブにrecordingUrlを更新
        const sid = fname.replace(/rec_|_\d+\.(webm|mp4)/g,'');
        if (archiveMap.has(sid)) {
          archiveMap.get(sid).recordingUrl = url;
          saveArchives();
        }
        if (db) {
          await db.query('UPDATE archives SET recording_url=$1 WHERE id=$2', [url, sid]).catch(()=>{});
        }

        res.json({ ok:true, url });
      } catch(e) { console.error('upload parse:', e); res.status(500).json({ error: e.message }); }
    });
  } catch(e) { res.status(500).json({ error: 'サーバーエラー' }); }
});

// ── 録画ファイル配信 ──
app.use('/recordings', (req, res, next) => {
  const fname = path.basename(req.path);
  const fpath = path.join(REC_DIR, fname);
  if (!fs.existsSync(fpath)) return res.status(404).send('Not found');
  const ext  = path.extname(fname).toLowerCase();
  const mime = ext==='.mp4' ? 'video/mp4' : 'video/webm';
  const stat  = fs.statSync(fpath);
  const range = req.headers.range;
  if (range) {
    const [s,e] = range.replace(/bytes=/,'').split('-');
    const start = parseInt(s);
    const end   = e ? parseInt(e) : stat.size - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': mime,
    });
    fs.createReadStream(fpath, {start, end}).pipe(res);
  } else {
    res.writeHead(200, {'Content-Length': stat.size, 'Content-Type': mime, 'Accept-Ranges': 'bytes'});
    fs.createReadStream(fpath).pipe(res);
  }
});

// ── RPGステータス取得 ──
app.get('/api/rpg', async (req, res) => {
  try {
    const tok = (req.headers.authorization||'').replace('Bearer ','');
    const s   = sessions.get(tok);
    if (!s) return res.status(401).json({ error: '未ログイン' });
    const stats = await getRPGStats(s.userId, s.email);
    const lv = stats.level || 1;
    const curXP = stats.xp || 0;
    const nextXP = xpForLevel(lv + 1);
    const prevXP = xpForLevel(lv);
    res.json({ rpg: {
      level: lv, xp: curXP,
      xpForNext: nextXP - curXP,
      xpProgress: Math.round(((curXP - prevXP) / (nextXP - prevXP)) * 100),
      fatigue: stats.fatigue || 0,
      streakDays: stats.streak_days || 0,
      totalStreams: stats.total_streams || 0,
      avgAchieve: stats.avg_achieve || 0,
    }});
  } catch(e) { res.status(500).json({ error: 'サーバーエラー' }); }
});

// ── 回復アイテム投げ（視聴者→配信者へ疲労回復） ──
app.post('/api/recover', async (req, res) => {
  try {
    const tok = (req.headers.authorization||'').replace('Bearer ','');
    const s   = sessions.get(tok);
    if (!s) return res.status(401).json({ error: '未ログイン' });
    const { targetUserId, targetEmail, amount } = req.body;
    await updateFatigue(targetUserId, targetEmail, -(amount||10));
    // 回復を配信中のストリームにブロードキャスト
    for (const [, stream] of liveStreams) {
      if (stream.streamerId === targetUserId) {
        io.to(`s:${stream.streamId}`).emit('recovery_item', { senderName: s.name, amount: amount||10 });
        break;
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'サーバーエラー' }); }
});

// ══════════════════════════════════════════════
// Socket.io
// ══════════════════════════════════════════════
io.on('connection', socket => {
  clients.set(socket.id, { userId:null, name:'名無し', streamId:null, token:null });

  socket.on('auth', data => {
    try {
      const s = sessions.get(data?.token);
      if (!s) { socket.emit('auth_error',{error:'認証エラー'}); return; }
      const c = clients.get(socket.id);
      if (!c) return;
      Object.assign(c, { userId:s.userId, name:s.name, token:data.token });
      socket.emit('auth_ok', { name:s.name });
    } catch(e) { console.error('auth:',e); }
  });

  // ── 配信開始 ──
  socket.on('start_stream', async data => {
    try {
      const c = ensureAuth(socket.id, data);
      if (!c) { socket.emit('error_msg','認証エラー。再読み込みしてください。'); return; }
      // 既存配信を終了
      for (const [sid, s] of liveStreams) {
        if (s.streamerId === c.userId) {
          clearInterval(s._timer);
          await saveArchive(s);
          liveStreams.delete(sid);
          io.emit('stream_ended', { streamId:sid });
        }
      }
      const streamId = data.streamId || mkUUID();
      // ★ 新人ブースト判定
      const streamerUser = userMap.get(c.email) || null;
      const newcomer = isNewcomer(streamerUser);

      const stream = {
        streamId, streamerId:c.userId, streamerName:c.name,
        title:data.title||'PUSH配信', goal:data.goal||'目標を達成する',
        category:data.category||'その他', emoji:data.emoji||'🎯',
        startedAt:new Date(), giftTotal:0, boost:newcomer?1.2:1.0, // ★ 新人は初期ブースト1.2x
        bombClears:0, bombFails:0, streamSec:0,
        peakViewers:0, totalPushes:0,
        bombActive:false, votingActive:false, voteYes:0, voteNo:0,
        tasks:{},
        isNewcomer: newcomer,            // ★ 新人フラグ
        isPrivate: data.isPrivate||false, // ★ 非公開モード
        giftPool: 0,                     // ★ 未達成時のギフトプール用
        viewerJoinTimes: {},             // ★ 投票重み付け用（視聴開始時刻）
      };
      liveStreams.set(streamId, stream);
      c.streamId = streamId;
      socket.join(`s:${streamId}`);

      // DBに配信を登録
      if (db) {
        await db.query(`INSERT INTO streams(id,streamer_id,title,goal,category,emoji)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [streamId, c.userId, stream.title, stream.goal, stream.category, stream.emoji]).catch(()=>{});
      }

      // タイマー（1秒）
      stream._timer = setInterval(() => {
        const s = liveStreams.get(streamId);
        if (!s) return;
        s.streamSec++;
        const lv = getLV(streamId);
        if (lv > s.peakViewers) s.peakViewers = lv;
        io.to(`s:${streamId}`).emit('stream_tick', { streamSec:s.streamSec });
      }, 1000);

      socket.emit('stream_started', { streamId, stream });
      io.emit('streams_updated', { streams:publicStreams() });
      console.log(`▶ 配信開始: ${c.name} [${streamId.slice(0,8)}]`);
    } catch(e) { console.error('start_stream:',e); }
  });

  // ── 配信終了 ──
  socket.on('end_stream', async data => {
    try {
      const s = liveStreams.get(data?.streamId);
      if (!s) return;
      clearInterval(s._timer);
      await saveArchive(s, { yesPct:data.yesPct, payout:data.payout });

      // ★ RPG: XP付与・疲労度更新
      const streamerSession = [...sessions.values()].find(se => se.userId === s.streamerId);
      if (streamerSession) {
        const durationMin = Math.floor((s.streamSec||0) / 60);
        const baseXP = Math.floor(durationMin * 2) + (data.yesPct >= 70 ? 100 : 0) + (s.bombClears||0) * 20;
        await addXP(s.streamerId, streamerSession.email, baseXP);
        // 疲労度: 配信時間×1（最大+30）。達成なら少し回復
        const fatigueDelta = Math.min(30, durationMin) - (data.yesPct >= 70 ? 10 : 0);
        await updateFatigue(s.streamerId, streamerSession.email, fatigueDelta);
        console.log(`⭐ XP+${baseXP} 疲労度${fatigueDelta>0?'+':''}${fatigueDelta}`);
      }

      liveStreams.delete(data.streamId);
      io.emit('stream_ended', { streamId:data.streamId });
      io.emit('streams_updated', { streams:publicStreams() });
      console.log(`■ 配信終了: ${s.streamerName} (達成率:${data.yesPct??'未'}%)`);
    } catch(e) { console.error('end_stream:',e); }
  });

  // ── 視聴開始 ──
  socket.on('join_stream', data => {
    try {
      const c = ensureAuth(socket.id, data) || clients.get(socket.id);
      if (!c) return;
      if (c.streamId) socket.leave(`s:${c.streamId}`);
      c.streamId = data.streamId;
      socket.join(`s:${data.streamId}`);
      broadcastVC(data.streamId);
      const s = liveStreams.get(data.streamId);
      if (s) {
        // ★ 視聴開始時刻を記録（投票重み付け用）
        if (!s.viewerJoinTimes) s.viewerJoinTimes = {};
        s.viewerJoinTimes[socket.id] = Date.now();
        socket.emit('stream_state', {
          giftTotal:s.giftTotal, boost:s.boost, bombClears:s.bombClears,
          streamSec:s.streamSec, liveViewers:getLV(data.streamId),
          totalPushes:s.totalPushes||0,
        });
        io.to(`s:${data.streamId}`).emit('chat_message',{
          user:'SYSTEM', text:`👋 ${c.name} さんが入室しました`, type:'sys',
        });
      }
    } catch(e) { console.error('join_stream:',e); }
  });

  socket.on('leave_stream', data => {
    try {
      const c = clients.get(socket.id);
      if (!c) return;
      socket.leave(`s:${data.streamId}`);
      c.streamId = null;
      broadcastVC(data.streamId);
    } catch(e) {}
  });

  // ── チャット ──
  socket.on('chat_message', data => {
    try {
      const c = clients.get(socket.id);
      io.to(`s:${data.streamId}`).emit('chat_message',{
        user:c?.name||data.user, text:data.text, type:data.type||'normal', color:data.color,
      });
    } catch(e) {}
  });

  // ★ PUSHギフト — バッチ処理
  socket.on('push_gift', data => {
    try {
      const s = liveStreams.get(data.streamId);
      if (!s) return;
      s.giftTotal += (data.amount||0);
      // ★ バッファに積む（即DBには書かない）
      pushBuffer.set(data.streamId, (pushBuffer.get(data.streamId)||0) + 1);
      // 演出はリアルタイムでブロードキャスト
      io.to(`s:${data.streamId}`).emit('gift_received',{
        amount:data.amount, senderName:data.senderName||'視聴者', giftTotal:s.giftTotal,
      });
      io.emit('streams_updated', { streams:publicStreams() });
    } catch(e) {}
  });

  // ★ PUSH連打バッチ（クライアントからのまとめ送信）
  socket.on('push_batch', data => {
    try {
      const s = liveStreams.get(data.streamId);
      if (!s || !data.count) return;
      pushBuffer.set(data.streamId, (pushBuffer.get(data.streamId)||0) + data.count);
      // 演出ブロードキャスト
      io.to(`s:${data.streamId}`).emit('push_effect',{ count:data.count, senderName:data.senderName });
    } catch(e) {}
  });

  // ── ボムタスク ──
  socket.on('send_bomb', data => {
    try {
      const c = ensureAuth(socket.id, data) || clients.get(socket.id);
      const s = liveStreams.get(data.streamId);
      if (!s) return;
      const taskId = mkUUID();
      const task = {
        taskId, trial:data.trial, boost:data.boost||5,
        sender:c?.name||'視聴者', status:'pending',
        voteYes:0, voteNo:0, createdAt:new Date(),
      };
      s.tasks[taskId] = task;
      io.to(`s:${data.streamId}`).emit('task_added',{ task, streamId:data.streamId });
    } catch(e) { console.error('send_bomb:',e); }
  });

  // ── タスク拒否（配信者） ──
  socket.on('reject_task', data => {
    try {
      const s = liveStreams.get(data.streamId);
      if (!s || !s.tasks) return;
      const task = s.tasks[data.taskId];
      if (!task || task.status !== 'pending') return;
      task.status = 'rejected';
      task.rejectReason = data.reason || '配信者が拒否しました';
      io.to(`s:${data.streamId}`).emit('task_status_update', {
        taskId: data.taskId, status: 'rejected',
        reason: task.rejectReason, streamId: data.streamId,
      });
    } catch(e) {}
  });

  // ── タスク条件変更（配信者） ──
  socket.on('modify_task', data => {
    try {
      const s = liveStreams.get(data.streamId);
      if (!s || !s.tasks) return;
      const task = s.tasks[data.taskId];
      if (!task || task.status !== 'pending') return;
      if (data.newTrial)  task.trial  = data.newTrial;
      if (data.newBoost)  task.boost  = data.newBoost;
      task.modified = true;
      io.to(`s:${data.streamId}`).emit('task_status_update', {
        taskId: data.taskId, status: 'modified', task, streamId: data.streamId,
      });
    } catch(e) {}
  });

  // ── タスク完了宣言（配信者）→ 投票開始 ──
  socket.on('complete_task', data => {
    try {
      const s = liveStreams.get(data.streamId);
      io.to(`s:${data.streamId}`).emit('task_vote_start',{ task, streamId:data.streamId });
      // 30秒後に集計
      setTimeout(() => {
        if (!s.tasks[data.taskId] || task.status !== 'voting') return;
        const approved = task.voteYes > task.voteNo;
        task.status = approved ? 'approved' : 'rejected';
        if (approved) {
          s.boost = parseFloat((s.boost + task.boost/100).toFixed(2));
          s.bombClears = (s.bombClears||0)+1;
          io.emit('streams_updated', { streams:publicStreams() });
        } else {
          s.bombFails = (s.bombFails||0)+1;
        }
        io.to(`s:${data.streamId}`).emit('task_vote_result',{
          taskId:data.taskId, approved, newBoost:s.boost, streamId:data.streamId,
        });
      }, 30000);
    } catch(e) { console.error('complete_task:',e); }
  });

  socket.on('cast_task_vote', data => {
    try {
      const s = liveStreams.get(data.streamId);
      if (!s || !s.tasks) return;
      const task = s.tasks[data.taskId];
      if (!task || task.status !== 'voting') return;
      if (data.vote === 'yes') task.voteYes++; else task.voteNo++;
      io.to(`s:${data.streamId}`).emit('task_vote_update',{
        taskId:data.taskId, yes:task.voteYes, no:task.voteNo, streamId:data.streamId,
      });
    } catch(e) {}
  });

  // ── 達成宣言 ──
  socket.on('declare_achieve', data => {
    try {
      const s = liveStreams.get(data.streamId);
      if (!s) return;
      s.votingActive=true; s.voteYes=0; s.voteNo=0;
      io.to(`s:${data.streamId}`).emit('voting_started',{
        giftTotal:s.giftTotal, liveViewers:getLV(data.streamId),
        boost:s.boost, streamId:data.streamId,
        totalPushes:s.totalPushes||0,
      });
    } catch(e) {}
  });

  socket.on('cast_vote', data => {
    try {
      const s = liveStreams.get(data.streamId);
      if (!s || !s.votingActive) return;
      // ★ 投票の重み付け（視聴時間に応じて0.5〜1.5）
      const joinTime = s.viewerJoinTimes?.[socket.id];
      const watchMin = joinTime ? (Date.now() - joinTime) / 60000 : 0;
      let weight = 0.5;
      if (watchMin >= 30) weight = 1.5;       // 30分以上：ヘビー視聴者
      else if (watchMin >= 10) weight = 1.2;  // 10分以上：通常視聴者
      else if (watchMin >= 3)  weight = 1.0;  // 3分以上：普通
      // 重み付き票を積算
      if (data.vote==='yes') s.voteYes += weight;
      else s.voteNo += weight;
      io.to(`s:${data.streamId}`).emit('vote_update',{
        yes: Math.round(s.voteYes), no: Math.round(s.voteNo), streamId:data.streamId
      });
    } catch(e) {}
  });

  socket.on('voting_end', data => {
    try {
      const s = liveStreams.get(data.streamId);
      if (!s) return;
      s.votingActive = false;
      const total  = s.voteYes + s.voteNo;
      const yesPct = total > 0 ? Math.round((s.voteYes/total)*100) : 0;
      const lv     = getLV(data.streamId);
      const vr     = Math.floor(lv * s.streamSec / 10);
      const payout = Math.round((s.giftTotal+vr) * s.boost * (yesPct/100));

      // ★ 未達成分はプールへ（返金しない — 賭博法回避）
      const unachieved = (s.giftTotal+vr) - payout;
      if (unachieved > 0) {
        s.giftPool = (s.giftPool||0) + unachieved;
        console.log(`💰 ギフトプール: ¥${unachieved} 追加（合計 ¥${s.giftPool}）`);
        // TODO: 実際の決済システム実装時はプールDBに書き込む
      }

      io.to(`s:${data.streamId}`).emit('voting_result',{
        yesPct, noPct:100-yesPct, payout,
        giftTotal:s.giftTotal, viewReward:vr, boost:s.boost,
        totalPushes:s.totalPushes||0, streamId:data.streamId,
        pooled: unachieved, // ★ プールされた金額を表示
      });
    } catch(e) {}
  });

  socket.on('disconnect', () => {
    try {
      const c = clients.get(socket.id);
      if (c?.streamId) broadcastVC(c.streamId);
      clients.delete(socket.id);
    } catch(e) {}
  });
});

// ── 起動 ──
const PORT = process.env.PORT || 3000;
(async () => {
  await initDB();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ PUSH サーバー起動 PORT:${PORT}`);
    console.log(`   DB: ${db ? 'PostgreSQL' : 'JSONファイル'}`);
  });
})();
