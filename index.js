const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');
const { VK } = require('vk-io');
const { Upload } = require('vk-io');
const dotenv = require('dotenv');
const moment = require('moment');

dotenv.config();

const VK_TOKEN = process.env.VK_ACCESS_TOKEN;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!VK_TOKEN || !TELEGRAM_TOKEN) {
  console.error('ENV error: set VK_ACCESS_TOKEN and TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}

const PUBLISH_HOURS = [5, 8, 12, 15, 18, 21];

const groups = {
  220105154: "Хохотушка",
  223485522: "Огонек",
  216902902: "Ушастый юмор",
  222500248: "Веселая минутка",
  212003567: "Юморная лавка",
  222261980: "Шутки на завтрак",
  221411679: "Царство юмора",
  221299031: "Безумный ржач",
  222500244: "Люди с большим сердцем",
  222644116: "Юморная волна",
  223363247: "Институт улыбок",
  222874672: "Палата №404",
  222583263: "Улыбнуло",
  223204405: "Хорошего настроения!",
  220105188: "Капелька смеха"
};

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({
  selectedDate: null,
  videos: [],
  currentIndex: 0,
  groupIndex: 0
}, null, 2));

function loadDB() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const vk = new VK({ token: VK_TOKEN });
const upload = new Upload({ vk });

function sortByAreaDesc(arr) {
  return [...(arr || [])].sort((a, b) => {
    const aw = a?.width || 0, ah = a?.height || 0;
    const bw = b?.width || 0, bh = b?.height || 0;
    return (bw * bh) - (aw * ah);
  });
}

function extractUrlsSorted(arr) {
  if (!Array.isArray(arr)) return [];
  const sorted = sortByAreaDesc(arr);
  return sorted.map(x => x?.url).filter(Boolean);
}

function pickPreviewTriplet(previews) {
  const arr = Array.isArray(previews) ? [...previews] : [];
  if (arr.length === 0) return [];
  if (arr.length === 1) return [arr[0], arr[0], arr[0]];
  if (arr.length === 2) return [arr[0], arr[1], arr[1]];
  const idxs = new Set();
  while (idxs.size < 3) idxs.add(Math.floor(Math.random() * arr.length));
  return Array.from(idxs).map(i => arr[i]);
}

class PostScheduler {
  constructor() {
    this.awaitingCaption = false;
    this.currentVideoForCaption = null;
    this._pendingBatch = null;
  }

  resetAll() {
    const data = {
      selectedDate: null,
      videos: [],
      currentIndex: 0,
      groupIndex: 0
    };
    saveDB(data);
    this.awaitingCaption = false;
       this.currentVideoForCaption = null;
    this._pendingBatch = null;
  }

  setSelectedDate(date) {
    const db = loadDB();
    db.selectedDate = date;
    saveDB(db);
  }

  addVideos(urls) {
    const parsed = [];
    for (const url of urls) {
      const id = this.parseVideoIdFromUrl(url);
      if (id) parsed.push({ id, url, caption: null, previews: { image: [], firstFrame: [], best: [] } });
    }
    const db = loadDB();
    const map = new Map();
    for (const v of [...db.videos, ...parsed]) {
      const prev = map.get(v.id) || {};
      map.set(v.id, { ...prev, ...v });
    }
    db.videos = Array.from(map.values());
    saveDB(db);
    return db.videos.length;
  }

  // ВАЖНО: правильные регулярки со слешами и экранированием точек.
  parseVideoIdFromUrl(url) {
    if (typeof url !== 'string') return null;
    const mDirect = url.match(/vkvideo\.ru\/video-?(\d+)_([0-9]+)/i);
    if (mDirect) return `video-${mDirect[1]}_${mDirect[2]}`;
    const m = url.match(/video(-?\d+)_(\d+)/);
    if (m) return `video${m[1]}_${m[2]}`;
    return null;
  }

  async fetchPreviewsForAllVideos() {
    const db = loadDB();
    const idsToFetch = db.videos
      .filter(v => !v.previews || !Array.isArray(v.previews.best) || v.previews.best.length === 0)
      .map(v => v.id);
    if (idsToFetch.length === 0) return;
    const chunkSize = 200;
    for (let i = 0; i < idsToFetch.length; i += chunkSize) {
      const chunk = idsToFetch.slice(i, i + chunkSize);
      const byOwner = new Map();
      for (const vid of chunk) {
        const m = vid.match(/video(-?\d+)_(\d+)/);
        if (!m) continue;
        const owner = m[1];
        const id = m[2];
        if (!byOwner.has(owner)) byOwner.set(owner, []);
        byOwner.get(owner).push(id);
      }
      for (const [owner, ids] of byOwner.entries()) {
        try {
          const resp = await vk.api.video.get({
            owner_id: owner,
            videos: ids.map(id => `${owner}_${id}`).join(','),
            extended: 0
          });
          if (resp && Array.isArray(resp.items)) {
            for (const item of resp.items) {
              const vidKey = `video${item.owner_id}_${item.id}`;
              const imageUrls = extractUrlsSorted(item.image);
              const firstFrameUrls = extractUrlsSorted(item.first_frame);
              const best = Array.from(new Set([...imageUrls, ...firstFrameUrls]));
              const iDb = db.videos.findIndex(v =>
                v.id === vidKey ||
                v.id === vidKey.replace('video', 'video-')
              );
              if (iDb !== -1) {
                db.videos[iDb].previews = {
                  image: imageUrls,
                  firstFrame: firstFrameUrls,
                  best
                };
              }
            }
          }
        } catch (e) {
          console.error('Previews fetch error:', e?.message || e);
        }
      }
    }
    saveDB(db);
  }

  generateCalendar(year = null, month = null) {
    const now = moment();
    if (year === null) year = now.year();
    if (month === null) month = now.month() + 1;

    const keyboard = [];
    const monthNames = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
    const monthName = monthNames[month - 1];

    keyboard.push([Markup.button.callback(`${monthName} ${year}`, 'ignore')]);

    const days = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
    keyboard.push(days.map(day => Markup.button.callback(day, 'ignore')));

    const startOfMonth = moment(`${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}-01`, 'YYYY-MM-DD', true);
    const numDays = startOfMonth.daysInMonth();
    const firstDay = (startOfMonth.isoWeekday() + 6) % 7;

    let weeks = [];
    let week = Array(firstDay).fill(Markup.button.callback(' ', 'ignore'));

    for (let day = 1; day <= numDays; day++) {
      week.push(Markup.button.callback(`${day}`, `day_${year}_${month}_${day}`));
      if (week.length === 7) {
        weeks.push(week);
        week = [];
      }
    }

    if (week.length) {
      while (week.length < 7) week.push(Markup.button.callback(' ', 'ignore'));
      weeks.push(week);
    }

    keyboard.push(...weeks);

    const prevMonth = month > 1 ? month - 1 : 12;
    const prevYear = month > 1 ? year : year - 1;
    const nextMonth = month < 12 ? month + 1 : 1;
    const nextYear = month < 12 ? year : year + 1;

    keyboard.push([
      Markup.button.callback('←', `nav_${prevYear}_${prevMonth}`),
      Markup.button.callback('→', `nav_${nextYear}_${nextMonth}`)
    ]);

    return Markup.inlineKeyboard(keyboard);
  }

  async getLastClips(groupId, count = 2) {
    try {
      const resp = await vk.api.video.get({
        owner_id: `-${groupId}`,
        album_id: 'clip',
        count,
        extended: 0
      });
      const items = Array.isArray(resp.items) ? resp.items : [];
      return items.map(clip => ({
        id: `video${clip.owner_id}_${clip.id}`,
        caption: clip.description || ''
      }));
    } catch (e) {
      try {
        const resp2 = await vk.api.video.get({
          owner_id: `-${groupId}`,
          count,
          extended: 0
        });
        const items = Array.isArray(resp2.items) ? resp2.items.filter(i => i.type === 'short_video' || i.is_short_video) : [];
        return items.slice(0, count).map(clip => ({
          id: `video${clip.owner_id}_${clip.id}`,
          caption: clip.description || ''
        }));
      } catch (e2) {
        console.error(`Clips error ${groupId}:`, e2?.message || e2);
        return [];
      }
    }
  }

  generateOptimalSchedule(ads, baseSlots) {
    ads = (ads || []).sort((a, b) => a - b);
    const mandatoryPosts = ads.map(ad => new Date(ad.getTime() + 3600000));
    let yourPosts = [];
    for (const slot of [baseSlots[0], baseSlots[baseSlots.length - 1]]) {
      if (!ads.some(ad => 0 < (ad - slot) / 1000 && (ad - slot) / 1000 < 3600)) {
        yourPosts.push(slot);
      }
    }
    yourPosts = [...yourPosts, ...mandatoryPosts];
    for (const slot of baseSlots.slice(1, -1)) {
      if (!ads.some(ad => 0 < (ad - slot) / 1000 && (ad - slot) / 1000 < 3600) &&
        yourPosts.every(t => Math.abs((slot - t) / 1000) >= 3600)) {
        yourPosts.push(slot);
      }
    }
    return yourPosts.sort((a, b) => a - b).slice(0, 6);
  }

  async schedulePosts(groupId, posts, selectedDate) {
    try {
      const scheduled = await vk.api.wall.get({ owner_id: `-${groupId}`, filter: 'postponed' });
      const scheduledTimes = (scheduled.items || []).map(p => new Date(p.date * 1000)).sort((a, b) => a - b);
      const baseTimes = PUBLISH_HOURS.map(h => {
        const dt = moment(selectedDate).hour(h).minute(Math.floor(Math.random() * 60)).second(0).toDate();
        return dt;
      });
      const finalSchedule = this.generateOptimalSchedule(scheduledTimes, baseTimes);
      for (let i = 0; i < posts.length && i < finalSchedule.length; i++) {
        const p = posts[i];
        await vk.api.wall.post({
          owner_id: `-${groupId}`,
          message: p.message || '',
          attachments: p.attachments.join(','),
          publish_date: Math.floor(finalSchedule[i].getTime() / 1000)
        });
      }
    } catch (e) {
      console.error(`Schedule error ${groupId}:`, e?.message || e);
    }
  }

  async uploadPreviewImagesAsPhotos(groupId, previewUrls) {
    const out = [];
    for (const url of (previewUrls || [])) {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 20000);
        const r = await fetch(url, { signal: controller.signal });
        clearTimeout(t);
        if (!r.ok) continue;
        const arrBuf = await r.arrayBuffer();
        const buf = Buffer.from(arrBuf);
        const ph = await upload.wallPhoto({ groupId, source: { value: buf } });
        const phArr = Array.isArray(ph) ? ph : [ph];
        for (const p of phArr) {
          if (p && p.owner_id && p.id) out.push(`photo${p.owner_id}_${p.id}`);
        }
      } catch (e) {
        console.error('Photo upload error:', e?.message || e);
      }
    }
    return out;
  }

  async processGroupBatch(ctx) {
    const db = loadDB();
    const groupIds = Object.keys(groups);
    if (!db.selectedDate) {
      await ctx.reply('Сначала выберите дату через /start');
      return;
    }
    if (db.currentIndex >= db.videos.length) {
      await ctx.reply('Видео закончились. Все партии обработаны.');
      return;
    }
    const groupId = parseInt(groupIds[db.groupIndex % groupIds.length], 10);
    const groupName = groups[groupId];
    await ctx.reply(`Постинг: ${groupName}`);
    const batchVideos = [];
    let idx = db.currentIndex;
    while (idx < db.videos.length && batchVideos.length < 4) {
      const v = db.videos[idx];
      if (!v.previews || !Array.isArray(v.previews.best) || v.previews.best.length === 0) {
        await this.fetchPreviewsForAllVideos();
      }
      const updated = loadDB().videos.find(x => x.id === v.id);
      if (updated && updated.previews && Array.isArray(updated.previews.best) && updated.previews.best.length > 0) {
        batchVideos.push(updated);
      }
      idx++;
    }
    if (batchVideos.length === 0) {
      await ctx.reply('Нет видео с доступными превью. Попробуйте позже или пришлите другие ссылки.');
      return;
    }
    const newDb = loadDB();
    newDb.currentIndex = Math.min(idx, newDb.videos.length);
    saveDB(newDb);
    await this.askCaptionForNext(ctx, batchVideos, groupId);
  }

  async askCaptionForNext(ctx, batchVideos, groupId, collected = []) {
    if (batchVideos.length === 0) {
      const clips = await this.getLastClips(groupId, 2);
      const posts = [];
      for (const item of collected) {
        const three = pickPreviewTriplet(item.previews.best);
        const photos = await this.uploadPreviewImagesAsPhotos(groupId, three);
        const attachments = [item.id, ...photos];
        posts.push({ attachments, message: item.caption || '' });
      }
      for (const clip of clips) {
        posts.push({ attachments: [clip.id], message: clip.caption || '' });
      }
      const mixed = this.mixPosts(posts);
      const db = loadDB();
      await this.schedulePosts(groupId, mixed, db.selectedDate);
      const newDb = loadDB();
      newDb.groupIndex = (newDb.groupIndex + 1) % Object.keys(groups).length;
      saveDB(newDb);
      if (newDb.currentIndex < newDb.videos.length) {
        await this.processGroupBatch(ctx);
      } else {
        await ctx.reply('Все видео обработаны!');
      }
      return;
    }
    const current = batchVideos[0];
    this.currentVideoForCaption = current.id;
    this.awaitingCaption = true;
    await ctx.reply(`Видео: ${current.url}\nПришлите подпись к этому видео.`);
    this._pendingBatch = { batchVideos, groupId, collected };
  }

  mixPosts(posts) {
    const arr = [...posts];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  async onCaptionReceived(ctx, captionText) {
    if (!this.awaitingCaption || !this.currentVideoForCaption) return;
    const db = loadDB();
    const idx = db.videos.findIndex(v => v.id === this.currentVideoForCaption);
    if (idx !== -1) {
      db.videos[idx].caption = captionText;
      saveDB(db);
    }
    this.awaitingCaption = false;
    this.currentVideoForCaption = null;
    const batch = this._pendingBatch;
    if (!batch) return;
    const vObj = idx !== -1 ? loadDB().videos[idx] : null;
    const nextBatchList = batch.batchVideos.slice(1);
    const collected = [...batch.collected, vObj].filter(Boolean);
    await this.askCaptionForNext(ctx, nextBatchList, batch.groupId, collected);
  }
}

const bot = new Telegraf(TELEGRAM_TOKEN);
const scheduler = new PostScheduler();

bot.start(async (ctx) => {
  scheduler.resetAll();
  await ctx.reply('Выберите дату публикации:', scheduler.generateCalendar());
});

bot.command('reset', async (ctx) => {
  scheduler.resetAll();
  await ctx.reply('Состояние сброшено');
});

bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data || '';
  if (data.startsWith('day_')) {
    const [, year, month, day] = data.split('_');
    const selectedDate = moment(
      `${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`,
      'YYYY-MM-DD',
      true
    ).toDate();
    scheduler.setSelectedDate(selectedDate);
    await ctx.editMessageText(`Выбрана дата: ${moment(selectedDate).format('DD.MM.YYYY')}\n\nОтправьте ссылки на видео (каждая с новой строки или в одном сообщении)`);
  } else if (data.startsWith('nav_')) {
    const [, year, month] = data.split('_');
    await ctx.editMessageText('Выберите дату публикации:', scheduler.generateCalendar(parseInt(year), parseInt(month)));
  }
  await ctx.answerCbQuery().catch(() => {});
});

bot.hears(/https?:\/\/vkvideo\.ru\/[^\s]+/i, async (ctx) => {
  const db = loadDB();
  if (!db.selectedDate) {
    await ctx.reply('Сначала выберите дату через /start');
    return;
  }
  const links = ctx.message.text.match(/https?:\/\/vkvideo\.ru\/[^\s]+/gi) || [];
  if (links.length === 0) {
    await ctx.reply('Не найдено ссылок на видео в формате vkvideo.ru');
    return;
  }
  const total = scheduler.addVideos(links);
  await scheduler.fetchPreviewsForAllVideos();
  await ctx.reply(`Сохранено видео: всего ${total}. Начинаю обработку партиями по 4 на группу.`);
  await scheduler.processGroupBatch(ctx);
});

bot.on('text', async (ctx) => {
  if (scheduler.awaitingCaption && scheduler.currentVideoForCaption) {
    const caption = (ctx.message.text || '').trim();
    await scheduler.onCaptionReceived(ctx, caption);
  }
});

bot.launch().then(() => console.log('Bot is running...')).catch(err => {
  console.error('Bot launch error:', err?.message || err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));