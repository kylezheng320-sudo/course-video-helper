// ==UserScript==
// @name         学习通视频助手：弹题逐项重试
// @namespace    local.chaoxing.video-helper
// @version      3.3.1
// @description  課程影片播放輔助：一鍵訂閱 GitHub 穩定版並持續更新，提供播放控制、剩餘時間估算與本機統計。
// @match        https://*.chaoxing.com/mycourse/studentstudy*
// @match        https://*.chaoxing.com/mooc-ans/mycourse/studentstudy*
// @match        https://*.chaoxing.com/ananas/modules/video/index*
// @match        https://hike.zhihuishu.com/aidedteaching/sourceLearning/sourceLearning*
// @match        https://studyvideoh5.zhihuishu.com/stuStudy*
// @match        https://stuonline.zhihuishu.com/stuonline/stuLearnReportNew/index*
// @grant        GM_listValues
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @require      https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js
// @homepageURL  https://github.com/kylezheng320-sudo/course-video-helper
// @supportURL   https://github.com/kylezheng320-sudo/course-video-helper/issues
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/kylezheng320-sudo/course-video-helper/main/video-helper.meta.js
// @downloadURL  https://raw.githubusercontent.com/kylezheng320-sudo/course-video-helper/main/video-helper.user.js
// ==/UserScript==

// Video adapter portions derived from 云上全平台 v5.3.54, author alv.
// Source: https://greasyfork.org/scripts/462689/code ; https://github.com/alv002/meto/
// Modified in 3.2.2: pause/select/confirm navigation adapter for completed videos still playing.
// Modified in 3.0.1: reference jQuery registration and event payload for video popups.
// See SOURCE-NOTES-3.0.1.md for the source comparison and modification record.

(() => {
  'use strict';
  function createViewingTime(options = {}) {
    const BASE = 'local-chaoxing-video-helper-v1-time-v1';
    const doc = options.document || document;
    const href = options.href || location.href;
    const wall = options.wall || (() => Date.now());
    const mono = options.mono || (() => performance.now());
    const owner = Math.random().toString(36).slice(2) + '-' + wall();
    const memory = new Map();
    let persistent = true, previous = null, lastFlush = 0, lastRead = -Infinity, leaseSince = -Infinity;
    let snapshot = null, ledger = null, context = {}, uncertain = false, owns = false, accumulatedElsewhere = 0;
    let course = '', playerKey = '', reportUrl = '', boundSample = '', stopped = false, faultReported = false;
    let directoryTotal = 0, directoryBaseline = null;
    const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const tuple = row => JSON.stringify([clean(row.chapter), clean(row.title)]);
    function get(key, fallback = null) {
      try {
        const value = options.get ? options.get(key, fallback) : GM_getValue(key, fallback);
        return copy(value);
      } catch { persistent = false; return copy(memory.has(key) ? memory.get(key) : fallback); }
    }
    function set(key, value) {
      memory.set(key, copy(value));
      try { if (options.set) options.set(key, value); else GM_setValue(key, value); }
      catch { persistent = false; }
    }
    function keys() {
      try { return options.list ? options.list() : typeof GM_listValues === 'function' ? GM_listValues() : [...memory.keys()]; }
      catch { persistent = false; return [...memory.keys()]; }
    }
    function duration(value) {
      const text = clean(value);
      let m = text.match(/^(?:(\d+)小时)?(?:(\d+)分)?(\d+)秒$/);
      if (m) return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3]);
      if (!/^\d{1,4}:\d{2}(?::\d{2})?$/.test(text)) return null;
      const parts = text.split(':').map(Number);
      if (parts.slice(1).some(n => n >= 60)) return null;
      return parts.reduce((sum, n) => sum * 60 + n, 0);
    }
    function reportIdentity(url) {
      try {
        const u = new URL(url, href), recruit = u.searchParams.get('recruitId'), id = u.searchParams.get('courseId');
        if (u.protocol !== 'https:' || u.hostname !== 'stuonline.zhihuishu.com' ||
            !/^\/stuonline\/stuLearnReportNew\/index\/?$/.test(u.pathname) || !/^\d+$/.test(recruit || '') || !/^\d+$/.test(id || '')) return null;
        return { course: 'zhidao-shared:' + recruit + ':' + id, url: u.href };
      } catch { return null; }
    }
    function learningKey(url) {
      try {
        const u = new URL(url, href), key = u.searchParams.get('recruitAndCourseId');
        return u.protocol === 'https:' && u.hostname === 'studyvideoh5.zhihuishu.com' && /^\/stuStudy\/?$/.test(u.pathname) &&
          /^[a-zA-Z0-9_-]{1,300}$/.test(key || '') ? key : '';
      } catch { return ''; }
    }
    function linkToReport() {
      for (const a of doc.querySelectorAll('a[href]')) {
        const info = reportIdentity(a.getAttribute('href'));
        if (info && /成绩分析/.test(a.textContent)) return info;
      }
      return null;
    }
    function freshLedger(value) {
      return value?.schema === 1 && value.course === course && finite(value.totalMs) && finite(value.since) && value.entries && typeof value.entries === 'object' ? value :
        { schema: 1, course, since: wall(), entries: {}, totalMs: 0 };
    }
    function loadCourse() {
      const info = linkToReport(), alias = playerKey && get(BASE + '-link:' + playerKey);
      const candidate = info?.course || alias?.course || options.course || 'local:' + new URL(href).origin + new URL(href).pathname + ':' + (new URL(href).searchParams.get('courseId') || new URL(href).searchParams.get('courseid') || '');
      if (candidate !== course) {
        flush(); release(); course = candidate; ledger = freshLedger(get(BASE + '-ledger:' + course)); previous = null;
        directoryBaseline = null; directoryTotal = 0;
      }
      reportUrl = info?.url || (reportIdentity(alias?.reportUrl)?.course === course ? alias.reportUrl : '');
    }
    function validSnapshot(value) {
      return value?.schema === 1 && value.course === course && value.playerKey === playerKey &&
        finite(value.capturedAt) && value.capturedAt <= wall() + 5000 && typeof value.id === 'string' &&
        Array.isArray(value.rows) && value.rows.length > 0 && value.rows.length <= 5000 &&
        value.rows.every(row => typeof row.id === 'string' && typeof row.title === 'string' &&
          typeof row.chapter === 'string' && (row.seconds === null || finite(row.seconds)) &&
          ['complete', 'partial', 'unwatched', 'unknown'].includes(row.state));
    }
    function readSnapshot() {
      const value = playerKey && get(BASE + '-report:' + playerKey);
      if (!validSnapshot(value)) { snapshot = null; return; }
      let binding = '';
      try { binding = doc.defaultView.sessionStorage.getItem(BASE + '-binding:' + playerKey) || ''; } catch {}
      // No account identity is exposed on these pages. Only a fresh report can bind a new tab.
      if (binding !== course && wall() - value.capturedAt > 120000) { snapshot = null; return; }
      if (binding !== course) {
        try { doc.defaultView.sessionStorage.setItem(BASE + '-binding:' + playerKey, course); } catch {}
      }
      if (boundSample !== value.id) { boundSample = value.id; uncertain = false; }
      snapshot = value;
    }
    function refresh() {
      loadCourse(); readSnapshot();
      if (!owns) ledger = freshLedger(get(BASE + '-ledger:' + course));
      if (options.directory) {
        const remembered = get(BASE + '-catalog-count:' + course, 0);
        const count = Math.max(context.rows?.length || 0, finite(remembered) ? remembered : 0, snapshot?.rows.length || 0);
        directoryTotal = count;
        if (count > (finite(remembered) ? remembered : 0)) set(BASE + '-catalog-count:' + course, count);
        if (!directoryBaseline) directoryBaseline = Object.fromEntries(Object.entries(ledger?.entries || {}).map(([key, value]) => [key, finite(value.ms) ? value.ms : 0]));
      }
      accumulatedElsewhere = 0;
      for (const key of keys().filter(key => key.startsWith(BASE + '-ledger:') && key !== BASE + '-ledger:' + course)) {
        const other = get(key);
        if (other?.schema === 1 && finite(other.totalMs)) accumulatedElsewhere += other.totalMs;
      }
    }
    function release() {
      if (course && owns && get(BASE + '-lease:' + course)?.owner === owner) set(BASE + '-lease:' + course, { owner, until: 0 });
      owns = false; leaseSince = -Infinity;
    }
    function lease() {
      const key = BASE + '-lease:' + course, current = get(key), now = wall();
      if (current && current.owner !== owner && current.until > now && current.until <= now + 10000) { owns = false; ledger = freshLedger(get(BASE + '-ledger:' + course)); return false; }
      if (!owns || current?.owner !== owner) {
        ledger = freshLedger(get(BASE + '-ledger:' + course)); owns = true; leaseSince = mono();
        set(key, { owner, until: now + 5000 }); return false;
      }
      set(key, { owner, until: now + 5000 });
      return mono() - leaseSince >= 500 && get(key)?.owner === owner;
    }
    function flush() {
      if (ledger && owns && get(BASE + '-lease:' + course)?.owner === owner) { ledger.updatedAt = wall(); set(BASE + '-ledger:' + course, ledger); lastFlush = mono(); }
    }
    function matchRows(rows, report) {
      const mapping = new Map(), used = new Set();
      for (const row of rows) {
        const candidates = report.filter(r => row.videoId ? r.id === row.videoId : tuple(r) === tuple(row) &&
          finite(row.seconds) && finite(r.seconds) && Math.abs(row.seconds - r.seconds) <= 1);
        if (candidates.length === 1 && !used.has(candidates[0].id) && rows.filter(n => tuple(n) === tuple(row)).length === 1) {
          mapping.set(tuple(row), candidates[0]); used.add(candidates[0].id);
        }
      }
      return mapping;
    }
    function sample() {
      if (stopped) return;
      try {
        context = options.context ? options.context() || {} : {};
        if (mono() - lastRead > 1500) { refresh(); lastRead = mono(); }
        const media = context.media, currentRow = context.current;
        const active = !!(context.enabled && !context.blocked && media && !media.paused && !media.ended &&
          !media.seeking && media.readyState >= 3 && Number.isFinite(media.currentTime) && media.playbackRate > 0);
        const key = currentRow ? tuple(currentRow) : media ? 'media:' + clean(media.currentSrc || media.getAttribute('src') || media.id) : '';
        const prior = previous;
        previous = { media, key, at: mono(), position: media?.currentTime, rate: media?.playbackRate, active };
        if (!active || !key) { flush(); release(); return; }
        if (!lease()) { previous.active = false; return; }
        if (!prior?.active || prior.media !== media || prior.key !== key) return;
        const seconds = (previous.at - prior.at) / 1000, advance = previous.position - prior.position;
        if (seconds <= 0 || seconds > 5) { if (seconds > 5) uncertain = true; return; }
        if (prior.rate !== previous.rate || advance <= 0 || advance > seconds * prior.rate + Math.max(.25, seconds * prior.rate * .2)) return;
        const increment = Math.min(seconds, advance / prior.rate) * 1000;
        const entry = ledger.entries[key] || { ms: 0 };
        entry.ms = (finite(entry.ms) ? entry.ms : 0) + increment;
        ledger.entries[key] = entry; ledger.totalMs = (finite(ledger.totalMs) ? ledger.totalMs : 0) + increment;
        if (mono() - lastFlush >= 4000) flush();
      } catch (error) {
        previous = null; uncertain = true;
        if (!faultReported) { console.warn('[视频助手：时间统计]', error); faultReported = true; }
      }
    }
    function estimate() {
      const rows = Array.isArray(context.rows) ? context.rows : [];
      const ratio = get(BASE + '-ratio:' + course, .8);
      const q = [.8, .9, 1].includes(ratio) ? ratio : .8;
      const result = { min: 0, max: 0, unknown: 0, complete: 0, known: 0, total: 0, q,
        synced: !!snapshot, playing: !!previous?.active && owns, observable: !!context.media, uncertain, persistent,
        courseMs: ledger?.totalMs || 0, allMs: accumulatedElsewhere + (ledger?.totalMs || 0),
        capturedAt: snapshot?.capturedAt, reportUrl, since: ledger?.since, provisional: false };
      if (options.directory) return estimateDirectory(rows, result);
      if (!snapshot || !rows.length) { result.unknown = rows.length; return result; }
      const mapping = matchRows(rows, snapshot.rows);
      result.total = Math.max(rows.length, snapshot.rows.length);
      for (const row of rows) {
        const r = mapping.get(tuple(row));
        if (!r) continue;
        if (!finite(r.seconds) || r.seconds <= 0 || r.state === 'unknown') continue;
        result.known++;
        if (row.complete || r.state === 'complete') { result.complete++; continue; }
        const target = Math.ceil(r.seconds * q), key = tuple(row);
        const baseline = snapshot.ledgerAtCapture?.[key];
        const credit = Math.max(0, (ledger?.entries[key]?.ms || 0) - (finite(baseline) ? baseline : 0)) / 1000;
        let low = r.state === 'partial' ? 0 : target, high = target;
        // This adapter has status icons, not a measurable watched percentage.
        result.min += Math.max(0, low - credit); result.max += Math.max(0, high - credit);
        if (credit > .5) result.provisional = true;
      }
      result.unknown = Math.max(0, result.total - result.known);
      return result;
    }
    function estimateDirectory(rows, result) {
      result.directory = true; result.ready = !!rows.length; result.historyUnknown = false; result.refined = false;
      result.total = Math.max(rows.length, directoryTotal);
      const mapping = snapshot ? matchRows(rows, snapshot.rows) : new Map();
      for (const row of rows) {
        const key = tuple(row);
        if (!clean(row.chapter) || !clean(row.title) || rows.filter(n => tuple(n) === key).length !== 1) continue;
        const report = mapping.get(key);
        const hasProgress = finite(row.progress) && row.progress > 0 && row.progress <= 100;
        // Positive completion is authoritative. A visible incomplete percentage overrides an older report.
        if (row.complete || report?.state === 'complete' && !hasProgress) {
          result.known++; result.complete++; continue;
        }
        if (!finite(row.seconds) || row.seconds <= 0) continue;
        result.known++;
        const target = Math.ceil(row.seconds * result.q);
        let low = 0, high = target;
        if (report?.state === 'unwatched' && !hasProgress || row.progress === 0) low = target;
        else result.historyUnknown = true;
        if (report && ['unwatched', 'partial'].includes(report.state)) result.refined = true;
        const baseline = report ? snapshot.ledgerAtCapture?.[key] : directoryBaseline?.[key];
        const credit = Math.max(0, (ledger?.entries[key]?.ms || 0) - (finite(baseline) ? baseline : 0)) / 1000;
        result.min += Math.max(0, low - credit); result.max += Math.max(0, high - credit);
        if (credit > .5) result.provisional = true;
      }
      result.unknown = Math.max(0, result.total - result.known);
      result.upperBound = result.historyUnknown && result.min <= .5 && result.max > .5;
      return result;
    }
    function directoryProgress(row) {
      const values = [];
      for (const marker of row.querySelectorAll('.progress-num,[role="progressbar"]')) {
        let shown = true;
        for (let node = marker; node && node !== row; node = node.parentElement) {
          const style = node.ownerDocument.defaultView.getComputedStyle(node);
          if (node.hidden || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) { shown = false; break; }
        }
        if (!shown) continue;
        const match = clean(marker.textContent).match(/^(\d+(?:\.\d+)?)\s*%$/);
        const raw = marker.getAttribute('aria-valuenow'), max = Number(marker.getAttribute('aria-valuemax') || 100), min = Number(marker.getAttribute('aria-valuemin') || 0);
        const n = match ? Number(match[1]) : raw !== null && max > min ? (Number(raw) - min) / (max - min) * 100 : NaN;
        if (Number.isFinite(n) && n >= 0 && n <= 100) values.push(n);
      }
      // .time_ico_half is present even on unstarted videos; its class is not a watched percentage.
      return values.length ? Math.min(...values) : null;
    }
    function minutes(seconds, short = false) {
      const n = Math.max(0, Math.ceil(seconds / 60));
      const h = Math.floor(n / 60), m = n % 60;
      return short ? h ? h + '时' + (m ? m + '分' : '') : n + '分' :
        h ? h + '小时' + (m ? m + '分' : '') : n + '分钟';
    }
    function clock(ms) {
      const n = Math.max(0, Math.floor(ms / 1000));
      return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60].map(n => String(n).padStart(2, '0')).join(':');
    }
    function view() {
      const r = estimate(), sampled = r.capturedAt ? new Date(r.capturedAt).toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit',hour12:false}) : '';
      let value = '待同步', compact = '待同步', detail = playerKey ? '打开成绩分析，同步视频时长与观看状态。' : '此页面暂不支持剩余估算；可查看累计播放。';
      if (r.synced && !context.rows?.length) detail = '成绩已同步，等待学习目录加载。';
      if (r.synced && context.rows?.length && !r.known) detail = '已读取成绩页，但时长、状态或目录匹配不足；请更新成绩分析。';
      if (r.directory) detail = r.ready ? '正在读取目录中的视频时长，缺失项将标为待加载。' : '等待章节目录加载，无需先打开成绩分析。';
      if (r.directory && !r.known) { value = '目录加载中'; compact = '待加载'; }
      if ((r.synced || r.directory) && r.known) {
        if (r.complete === r.total && !r.unknown) { value = r.directory ? '当前目录视频已完成' : '视频任务已完成'; compact = r.directory ? '目录已完成' : '已完成'; }
        else if (r.max <= .5 && !r.unknown) { value = '等待平台确认'; compact = '待确认'; }
        else {
          const range = Math.ceil(r.min / 60) !== Math.ceil(r.max / 60);
          value = (r.unknown ? '已知约 ' : '约 ') + minutes(r.min) + (range ? '～' + minutes(r.max) : '');
          compact = r.unknown ? '部分待同步' : range ? '约≤' + minutes(r.max, true) : '约' + minutes(r.max, true);
          if (r.upperBound) { value = (r.unknown ? '已知最多约 ' : '最多约 ') + minutes(r.max); compact = r.unknown ? '部分待加载' : '约≤' + minutes(r.max, true); }
        }
        detail = '按 ' + Math.round(r.q * 100) + '% 估算 · 采集于 ' + sampled + ' · ' + r.known + '/' + r.total + ' 项匹配';
        if (r.directory) detail = '目录实时 · ' + r.known + '/' + r.total + ' 项 · 已完成 ' + r.complete + ' 项 · 按 ' + Math.round(r.q * 100) + '% 估算' + (r.refined ? ' · 成绩页辅助校准' : '');
        if (r.upperBound) detail += ' · 历史观看量未知，显示上限';
        if (r.unknown) { detail += ' · ' + r.unknown + (r.directory ? ' 项待加载' : ' 项待同步'); if (r.directory) compact = '部分待加载'; }
        if (!r.playing && r.complete !== r.total) detail += ' · 递减已暂停';
        if (r.provisional) detail += ' · 本地估算，待平台确认';
        if (r.uncertain) detail += ' · 观测有间隔，建议更新';
      }
      if (!persistent) detail += ' · 存储不可用，仅当前页面记录';
      return { ...r, value, compact, detail, courseTime: clock(r.courseMs), allTime: clock(r.allMs) };
    }
    function setRatio(value) {
      const q = Number(value);
      if ([.8, .9, 1].includes(q) && course) set(BASE + '-ratio:' + course, q);
    }
    function parseReport() {
      const info = reportIdentity(href), table = doc.querySelector('#LRStuCourse_Table');
      if (!info || !table) return null;
      const anchor = [...doc.querySelectorAll('a[href]')].map(a => ({key:learningKey(a.getAttribute('href')), href:a.href})).find(a=>a.key);
      if (!anchor) return null;
      const records = [], ids = new Set();
      for (const tr of table.querySelectorAll('tr')) {
        const cells = [...tr.querySelectorAll('td')], size = cells[2]?.querySelector('[id^="videoSize_"]');
        if (!size) continue;
        const id = size.id.match(/^videoSize_(\d+_\d+)$/)?.[1];
        if (!id || ids.has(id)) return null;
        ids.add(id);
        const seconds = duration(size.textContent), cell = cells[3];
        const state = cell?.querySelector('.alreadySight') ? 'complete' : cell?.querySelector('.halfSight') ? 'partial' : cell?.querySelector('.notSight') ? 'unwatched' : 'unknown';
        records.push({ id, chapter:clean(cells[0].textContent), title:clean(cells[1].textContent), seconds: seconds > 0 ? seconds : null, state });
      }
      return records.length ? { schema:1, course:info.course, reportUrl:info.url, playerKey:anchor.key, learningUrl:anchor.href, rows:records } : null;
    }
    function startReport() {
      if (doc.getElementById('local-video-time-report-instance')) return;
      const marker = doc.createElement('meta'); marker.id = 'local-video-time-report-instance';
      (doc.head || doc.documentElement).appendChild(marker);
      let timer, observer, candidate = '', stableAt = 0, published = '', destroyed = false;
      function poll() {
        if (destroyed) return;
        const data = parseReport(), signature = data && JSON.stringify(data);
        if (!data) { candidate = ''; return; }
        if (candidate !== signature) { candidate = signature; stableAt = mono(); timer = setTimeout(poll, 1200); return; }
        if (mono() - stableAt < 1100) { timer = setTimeout(poll, 1200); return; }
        if (published === signature) return;
        const old = get(BASE + '-report:' + data.playerKey);
        // A reduced table may still be loading. Never silently replace a larger valid snapshot.
        if (old?.course === data.course && old?.rows?.length > data.rows.length) { notify('检测到表格尚不完整，保留上次快照。'); return; }
        const counts = get(BASE + '-ledger:' + data.course), watermark = {};
        for (const [key, entry] of Object.entries(counts?.entries || {})) if (finite(entry.ms)) watermark[key] = entry.ms;
        data.capturedAt = wall(); data.id = owner + ':' + data.capturedAt; data.ledgerAtCapture = watermark;
        set(BASE + '-report:' + data.playerKey, data);
        set(BASE + '-link:' + data.playerKey, { course:data.course, reportUrl:data.reportUrl });
        published = signature;
        notify((persistent ? '已同步 ' : '仅本页读取到 ') + data.rows.length + ' 个视频的时长与观看状态。' + (persistent ? '返回学习页即可查看估算。' : '存储不可用，无法同步到学习页。'));
      }
      function notify(message) {
        let node = doc.getElementById('local-video-time-report-status');
        if (!node) { node = doc.createElement('div'); node.id = 'local-video-time-report-status'; node.setAttribute('role','status'); node.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:2147483000;max-width:min(460px,calc(100vw - 40px));padding:12px 16px;border:1px solid #d4d4d4;border-radius:6px;background:#fff;color:#222;font:14px/1.6 "Microsoft YaHei",sans-serif'; doc.body.appendChild(node); }
        node.textContent = message;
      }
      function start() {
        observer = new MutationObserver(records => {
          if (!records.some(r=> (r.target.nodeType === 1 ? r.target : r.target.parentElement)?.closest?.('#LRStuCourse_Table') || [...r.addedNodes].some(n=>n.nodeType===1 && (n.id==='LRStuCourse_Table'||n.querySelector?.('#LRStuCourse_Table'))))) return;
          clearTimeout(timer); timer = setTimeout(poll, 250);
        });
        observer.observe(doc.body, { childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class'] });
        poll();
      }
      if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, {once:true}); else start();
      doc.defaultView.addEventListener('pagehide',()=>{destroyed=true;clearTimeout(timer);observer?.disconnect();},{once:true});
    }
    function stop() { if (stopped) return; flush(); release(); stopped = true; previous = null; }
    playerKey = learningKey(href);
    return { sample, view, setRatio, stop, flush, refresh, parseReport, startReport, duration, tuple, directoryProgress, reportIdentity, learningKey, matchRows, BASE };
  }


  const referenceJQuery = typeof jQuery === 'function' && jQuery.fn?.jquery === '3.6.0' && typeof jQuery.noConflict === 'function' ? jQuery.noConflict(true) : null;
  if (location.hostname === 'stuonline.zhihuishu.com' && /^\/stuonline\/stuLearnReportNew\/index\/?$/.test(location.pathname)) { createViewingTime().startReport(); return; }
  const VERSION = '3.3.1';
  const TICK_MS = 600;
  const SELECT_DELAY = 600;
  const RETRY_AFTER = 3000;
  const RESPONSE_TIMEOUT = 20000;
  const ADVANCE_DELAY = 4000;
  const BLANK_CONTENT_DELAY = 15000;
  const MARKER_TIMEOUT = 30000;
  const REPLAY_GRACE = 8000;
  const KEY = 'local-chaoxing-video-helper-v1';
  const UI_KEY = KEY + '-ui';
  const SHARED_KEY = KEY + '-shared-playback';
  const CHANNEL = 'local-chaoxing-video-helper-status-v1';
  const SESSION_KEY = KEY + '-navigation-session';
  const REFRESH_GUARD_KEY = KEY + '-shared-refresh-guard:';
  const PLATFORM_STOP_KEY = KEY + '-platform-stop:';
  const PLATFORM_STOP_MESSAGE = '平台提示异常脚本，本页助手已停止。请停用相关脚本，从学堂重新进入课程。';
  const REMEMBERED_STOP_MESSAGE = '助手记录了上次的异常提示；当前未发现可见的平台警告。点击“检查页面”确认后，再手动开始助手。';
  const QUIZ_ATTRIBUTE = 'data-local-vh-quiz';
  const isZhidaoShared = location.hostname === 'studyvideoh5.zhihuishu.com' && /^\/stuStudy\/?$/.test(location.pathname);
  const isZhidao = isZhidaoShared || location.hostname === 'hike.zhihuishu.com' && /^\/aidedteaching\/sourceLearning\/sourceLearning\/?$/.test(location.pathname);
  const platformLabel = isZhidaoShared ? '知到共享课' : isZhidao ? '知到' : '学习通';
  const isStudy = isZhidao || /\/(?:mooc-ans\/)?mycourse\/studentstudy/.test(location.pathname);
  const isPlayer = /\/ananas\/modules\/video\/index/.test(location.pathname);
  if (!isStudy && !isPlayer) return;

  // DOM 标记跨篡改猴脚本沙箱共享；每个 document 独立，不阻挡视频 iframe。
  // 兼容旧版先加载的情况，但不修改或强行停止旧版；旧版需在管理器停用后刷新。
  const INSTANCE_ID = 'local-chaoxing-video-helper-instance';
  if (document.getElementById(INSTANCE_ID) || document.getElementById('local-chaoxing-video-helper-panel')) {
    console.warn('[视频助手] 本页已有助手实例，跳过重复加载；请在篡改猴中仅保留一份启用。');
    return;
  }
  const instanceMarker = document.createElement('meta');
  instanceMarker.id = INSTANCE_ID;
  instanceMarker.content = VERSION;
  (document.head || document.documentElement).appendChild(instanceMarker);

  const FEEDBACK = '#spanHas,#spanNot,#spanNotBack,#spanNotBackPoint,' +
    '#videoquiz-error,#videoquiz-success,#videoquiz-result,#videoquiz-feedback,#videoquiz-tip,' +
    '.ans-videoquiz-error,.ans-videoquiz-tip,.ans-videoquiz-result,.ans-videoquiz-feedback,' +
    '.videoquiz-error,.videoquiz-success,.videoquiz-result,.videoquiz-feedback,.videoquiz-tip,[data-videoquiz-feedback]';
  const WORK_FRAME = 'iframe.ans-insertwork,iframe[src*="/work/"],iframe[data-task-type="work"]';
  const CHAPTER_QUIZ = /章节(?:测验|检验|测试|检测)|随堂测验/;
  const TASK_TAB_LABEL = /^\d+\s*(?:视频|章节测验|章节检验|章节测试|章节检测|随堂测验)$/;
  const states = new Map();
  const startedMedia = new WeakSet();
  const playback = new WeakMap();
  const activationClicks = new WeakMap();
  const watchedMedia = new WeakSet();
  const videoQuizPanels = new Map();
  const sourceQuizStates = new WeakMap();
  const activeSourceQuizzes = new Set();
  const sourceQuizWatched = new WeakSet();
  let quizPresentationStyle = null;
  const instance = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  let workerConfig = null;
  let session = { started: false, running: false, elapsed: 0, runSince: 0 };
  let platformStopped = false;
  let platformAlertActive = false;
  let stopInspectionMessage = '';
  let current = null;
  let feedbackRevision = 0;
  let resetVersion = null;
  let lastMessage = '';
  let pausedAt = 0;
  let panel = null;
  let controls = null;
  let panelMessage = '点击“开始助手”后自动播放当前视频。';
  const workers = new Map();
  let activeWorker = null;
  let granted = window === window.top;
  let grantUntil = 0;
  let lastPing = 0;
  let navigation = { key: '', since: 0, completeSince: 0, waitingSince: 0,
    pending: false, halted: false, sawVideo: false, playedWorker: null };
  const watchedFrames = new WeakSet();
  const contentIds = new WeakMap();
  const contentFrameLoads = new WeakMap();
  let nextContentId = 1;
  const loadedHref = location.href;
  const loadedCourse = courseSessionId();
  let sharedRefreshReady = false;
  let sharedRefreshPending = null;
  let sharedResumeTarget = null;
  let sharedSourceBackend = null;

  function courseSessionId() {
    const url = new URL(location.href);
    return url.origin + url.pathname + ':' + (url.searchParams.get('courseId') || url.searchParams.get('courseid') ||
      url.searchParams.get('recruitAndCourseId') || '');
  }
  function clearSessionTransfer() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch {}
  }
  if (window === window.top) {
    try {
      const carried = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
      const reloaded = performance.getEntriesByType('navigation')[0]?.type === 'reload';
      const allowSharedTransfer = !isZhidaoShared || carried?.mode === 'shared-auto' && (GM_getValue(SHARED_KEY, {}) || {}).autoPlay !== false;
      const intendedReload = isZhidaoShared && carried?.schema === 2 && carried.resumeOnReload === true &&
        ['shared-refresh', 'shared-navigation'].includes(carried.reason) &&
        (!carried.resumeHref || carried.resumeHref === location.href) && carried.session?.running === true;
      if (allowSharedTransfer && (!reloaded || intendedReload) && (!isZhidaoShared || carried?.schema !== 2 || intendedReload) &&
          carried?.course === courseSessionId() && carried.expires > Date.now() &&
          carried.session?.started === true && typeof carried.session.running === 'boolean' &&
          Number.isFinite(carried.session.elapsed) && carried.session.elapsed >= 0 &&
          Number.isFinite(carried.session.runSince) && carried.session.runSince >= 0) {
        session = carried.session;
        if (isZhidaoShared) {
          sharedRefreshReady = true;
          if (typeof carried.targetKey === 'string' && carried.targetKey) sharedResumeTarget = { key: carried.targetKey, since: Date.now() };
        }
      }
    } catch {}
    clearSessionTransfer();
    if (isZhidao) {
      try { platformStopped = sessionStorage.getItem(PLATFORM_STOP_KEY + courseSessionId()) === '1'; } catch {}
      if (platformStopped && session.running) { session.elapsed = elapsedTime(); session.running = false; session.runSince = 0; }
    }
  }
  function elapsedTime(now = Date.now()) {
    return Math.max(0, session.elapsed + (session.running ? Math.max(0, now - session.runSince) : 0));
  }
  function formattedTime() {
    const seconds = Math.floor(elapsedTime() / 1000);
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map(value => String(value).padStart(2, '0')).join(':');
  }
  function transferSession(extra = {}) {
    if (!session.started || window !== window.top) return false;
    const config = settings();
    const sharedNavigation = isZhidaoShared && config.enabled && !config.manual && navigation.pending;
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ course: courseSessionId(), expires: Date.now() + 30000,
        mode: isZhidaoShared ? config.manual ? 'shared-manual' : 'shared-auto' : 'auto', session,
        ...(sharedNavigation ? { schema: 2, reason: 'shared-navigation', resumeOnReload: true, targetKey: navigation.targetKey } : {}), ...extra }));
      return true;
    } catch { return false; }
  }
  function refreshSharedPage() {
    const config = settings();
    if (!isZhidaoShared || window !== window.top || !config.enabled || config.manual || platformStopped ||
        platformScriptAlert() || zhidaoBlocker() || courseSessionId() !== loadedCourse) return false;
    try {
      const now = Date.now(), key = REFRESH_GUARD_KEY + loadedCourse;
      const saved = JSON.parse(sessionStorage.getItem(key) || '[]');
      const recent = Array.isArray(saved) ? saved.filter(value => Number.isFinite(value) && now - value >= 0 && now - value < 30000) : [];
      if (recent.length >= 2) {
        navigation.halted = true; clearSessionTransfer();
        say('学习页短时间内反复要求刷新，已停止自动刷新，请检查课程页面。'); return true;
      }
      const targetKey = navigation.pending ? navigation.targetKey : zhidaoUniqueKey(zhidaoCurrent());
      if (!transferSession({ schema: 2, reason: 'shared-refresh', resumeOnReload: true, resumeHref: location.href, targetKey })) {
        sharedRefreshReady = true;
        say('无法保存刷新前的运行状态，改用当前页面继续播放与切节。'); return false;
      }
      sessionStorage.setItem(key, JSON.stringify([...recent, now]));
      sharedRefreshPending = { since: now };
      say('正在刷新学习页，刷新后自动恢复播放与本次计时。');
      location.reload();
      return true;
    } catch {
      sharedRefreshPending = null; sharedRefreshReady = true; clearSessionTransfer();
      say('刷新初始化未完成，改用当前页面继续播放与切节。'); return false;
    }
  }
  function coordinateSharedRefresh(now, config) {
    if (!isZhidaoShared || window !== window.top || !config.enabled || config.manual) return false;
    if (sharedRefreshPending) {
      if (now - sharedRefreshPending.since > RESPONSE_TIMEOUT) {
        sharedRefreshPending = null; navigation.halted = true; clearSessionTransfer();
        say('学习页刷新未完成，已停止自动重试，请手动检查。');
      }
      return true;
    }
    if (courseSessionId() !== loadedCourse) {
      navigation.halted = true; clearSessionTransfer();
      say('已进入另一门课程，请刷新后重新开始助手。'); return true;
    }
    if (sharedResumeTarget) {
      if (zhidaoUniqueKey(zhidaoCurrent()) === sharedResumeTarget.key) sharedResumeTarget = null;
      else {
        if (now - sharedResumeTarget.since > RESPONSE_TIMEOUT) {
          navigation.halted = true; clearSessionTransfer();
          say('刷新后未进入所选视频，已停止自动播放，请在目录中确认任务点。');
        } else say('刷新后正在等待所选视频加载。');
        return true;
      }
    }
    if (navigation.halted || config.nativeRefresh === false || !config.continuous || !config.autoNext) return false;
    // Upstream initializes auto paging by reloading, then reloads on URL changes.
    // The resume ticket is consumed once and is limited to this tab and course.
    if (!sharedRefreshReady || location.href !== loadedHref) return refreshSharedPage();
    return false;
  }
  function toggleSession(event) {
    if (platformStopped) { inspectStoppedPage(event); return; }
    if (isZhidao && platformScriptAlert()) { stopForPlatformAlert(); return; }
    const now = Date.now();
    const config = settings();
    if (session.running) {
      session.elapsed = elapsedTime(now);
      session.running = false;
      session.runSince = 0;
      clearSessionTransfer();
      sharedRefreshPending = null; sharedResumeTarget = null;
      say(config.manual ? '计时已暂停；视频播放由你手动控制。' : '助手已暂停。');
    } else {
      sharedResumeTarget = null;
      session.started = true;
      session.running = true;
      session.runSince = now;
      navigation.halted = false;
      lastMessage = '';
      if (!config.manual) for (const doc of courseDocuments()) for (const media of doc.querySelectorAll('video')) playback.delete(media);
      say(config.manual ? '计时已开始；请使用播放器或下方按钮手动控制视频。' : '助手已开始，正在启动当前视频。');
    }
    renderPanel();
    tick();
  }

  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  const text = element => normalize(element?.textContent);
  function settings() {
    const saved = GM_getValue(KEY, {}) || {};
    const shared = isZhidaoShared ? GM_getValue(SHARED_KEY, {}) || {} : {};
    const manual = isZhidaoShared && shared.autoPlay === false;
    const runtime = window === window.top ? { enabled: session.running, started: session.started } :
      { enabled: workerConfig?.enabled === true, started: workerConfig?.started === true };
    return { ...runtime, enabled: runtime.enabled && !platformStopped, manual, autoPlay: !manual,
      autoQuiz: isZhidaoShared && shared.nativeAutoQuiz !== false,
      nativeRefresh: isZhidaoShared && shared.nativeRefresh !== false,
      hideQuiz: isZhidaoShared && shared.nativeHideQuiz === true,
      reset: Number(isZhidaoShared ? shared.reset : workerConfig?.reset ?? saved.reset) || 0,
      muted: manual ? !!zhidaoMedia()?.muted : isZhidaoShared ? shared.muted !== false : (workerConfig?.muted ?? saved.muted) !== false,
      continuous: isZhidaoShared ? !manual && shared.continuous !== false : (workerConfig?.continuous ?? saved.continuous) !== false,
      autoNext: isZhidaoShared ? !manual && shared.autoNext === true : (workerConfig?.autoNext ?? saved.autoNext) !== false };
  }
  function saveSharedPreference(key, value) { GM_setValue(SHARED_KEY, { ...(GM_getValue(SHARED_KEY, {}) || {}), [key]: value }); }
  function savePreferences(config) {
    GM_setValue(KEY, { muted: config.muted, continuous: config.continuous, autoNext: config.autoNext, reset: config.reset });
  }
  function visible(element) {
    if (!element?.isConnected || element.hidden) return false;
    const view = element.ownerDocument.defaultView;
    for (let node = element; node?.nodeType === 1; node = node.parentElement) {
      const style = view.getComputedStyle(node);
      if (node.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return element.getClientRects().length > 0;
  }
  function enabled(element) {
    return !!element && !element.matches(':disabled') &&
      element.getAttribute('aria-disabled') !== 'true';
  }
  function clickable(element) { return enabled(element) && visible(element); }
  function chaoxingOrigin(origin) {
    try { return /(^|\.)chaoxing\.com$/.test(new URL(origin).hostname); } catch { return false; }
  }
  function locateFrame(source, doc = document) {
    for (const frame of doc.querySelectorAll('iframe')) {
      if (frame.contentWindow === source) return frame;
      try { const found = locateFrame(source, frame.contentDocument); if (found) return found; } catch {}
    }
    return null;
  }
  function frameFinished(frame) {
    for (let node = frame; node;) {
      if (node.closest('.ans-job-finished')) return true;
      try { node = node.ownerDocument.defaultView.frameElement; } catch { node = null; }
    }
    return false;
  }
  function frameDisplayed(frame) {
    if (!frame) return false;
    for (let node = frame; node;) {
      if (!visible(node)) return false;
      try { node = node.ownerDocument.defaultView.frameElement; } catch { node = null; }
    }
    return true;
  }
  function eligibleFrame(frame) { return frameDisplayed(frame) && !frameFinished(frame); }
  function courseDocuments(doc = document, result = []) {
    if (!doc || result.includes(doc)) return result;
    result.push(doc);
    for (const frame of doc.querySelectorAll('iframe')) {
      try { courseDocuments(frame.contentDocument, result); } catch {}
    }
    return result;
  }
  function videoSnapshot() {
    const videos = [], blockers = [];
    for (const doc of courseDocuments()) {
      for (const frame of doc.querySelectorAll('iframe.ans-insertvideo-online,iframe[src*="/ananas/modules/video/index"]')) {
        if (!frameDisplayed(frame)) continue;
        if (!watchedFrames.has(frame)) {
          watchedFrames.add(frame);
          frame.addEventListener('load', () => {
            workers.delete(frame.contentWindow);
            navigation.completeSince = 0;
            navigation.since = Date.now();
          });
        }
        const info = workers.get(frame.contentWindow);
        const fresh = info && info.frameSrc === frame.src && Date.now() - info.seen < 6500;
        const wrapper = frame.closest('.ans-attach-ct');
        const finished = frameFinished(frame);
        const ended = !!fresh && info.ended && !info.quiz;
        const requiresMarker = !!wrapper?.querySelector('.ans-job-icon');
        videos.push({ frame, finished: finished && !(fresh && info.quiz), ended,
          markerPending: ended && requiresMarker && !finished,
          complete: !(fresh && info.quiz) && (finished || ended && !requiresMarker) });
      }
      for (const task of doc.querySelectorAll('.ans-attach-ct')) {
        if (!frameDisplayed(task) || task.classList.contains('ans-job-finished') || !task.querySelector('.ans-job-icon')) continue;
        if (!task.querySelector('iframe.ans-insertvideo-online,iframe[src*="/ananas/modules/video/index"],video')) blockers.push(task);
      }
    }
    const media = document.querySelector('#video_html5_api,#video video');
    if (media && visible(media)) {
      const finished = !!media.closest('.ans-job-finished');
      const quiz = findQuiz(media);
      const ended = media.ended && !quiz;
      const requiresMarker = !!media.closest('.ans-attach-ct')?.querySelector('.ans-job-icon');
      videos.push({ frame: null, finished: finished && !quiz, ended,
        markerPending: ended && requiresMarker && !finished,
        complete: !quiz && (finished || ended && !requiresMarker) });
    }
    return { videos, blockers };
  }
  function chapterNodes() {
    const modern = [...document.querySelectorAll('.posCatalog_select:not(.firstLayer)')];
    if (modern.length) return modern;
    return [...document.querySelectorAll('.ncells h4[id^="cur"],.ncells h5[id^="cur"]')];
  }
  function taskTabs() {
    for (const group of document.querySelectorAll('.prev_ul,.tabtags,[role="tablist"]')) {
      if (!frameDisplayed(group)) continue;
      const nodes = [...group.querySelectorAll('li,[role="tab"],.prev_white')];
      const tabs = nodes.filter(node => !nodes.some(other => other !== node && other.contains(node)));
      if (tabs.length) return tabs;
    }
    // 新版圆角页签不一定使用 li；只识别同一容器中的编号视频/章节测验入口。
    const candidates = [...document.querySelectorAll('a,button,li,span,div')]
      .filter(node => frameDisplayed(node) && TASK_TAB_LABEL.test(text(node)));
    const roots = candidates.filter(node => !candidates.some(other => other !== node && other.contains(node)));
    for (const node of roots) {
      const siblings = roots.filter(other => other.parentElement === node.parentElement);
      if (siblings.length >= 2 && siblings.some(tab => /视频/.test(text(tab))) && siblings.some(tab => CHAPTER_QUIZ.test(text(tab)))) return siblings;
    }
    return [];
  }
  function activeTaskTab(tabs = taskTabs()) {
    const selected = '[aria-selected="true"],[data-active="true"],.active,.currents,.current,.selected,.on,.tab-active';
    return tabs.find(node => node.matches(selected) || node.querySelector(selected)) || null;
  }
  function taskKey() {
    const chapters = chapterNodes();
    const chapter = chapters.find(node => node.matches('.posCatalog_active,.currents'));
    const step = activeTaskTab();
    const frame = document.getElementById('iframe');
    return JSON.stringify([location.href, chapter?.id || text(chapter),
      step ? [...step.parentElement.children].indexOf(step) : -1, text(step),
      text(document.querySelector('.prev_title')), frame?.src || '']);
  }
  const OUTSIDE_CONTENT = 'aside,nav,[role="navigation"],#coursetree,.posCatalog_select,.ncells,.catalog,.discussion,.discuss,.notes,#note,' +
    '[id*="discuss" i],[id*="comment" i],[data-section="discussion"],[data-section="notes"]';
  const EMPTY_CONTENT = /^(?:(?:本|当前|當前|该|該)章[节節]|本章|本[节節])?(?:暂无|暫無)(?:学习|學習|课程|課程|章节|章節)?(?:内容|內容)[。！!]?$/;
  function chapterContentDocuments() {
    return courseDocuments().filter(doc => {
      if (doc === document) return true;
      const frame = doc.defaultView?.frameElement;
      return frameDisplayed(frame) && (frame.id === 'iframe' || frame.matches('iframe[data-course-content]') || /\/knowledge\/cards/.test(frame.src));
    });
  }
  function emptyChapter() {
    const docs = chapterContentDocuments();
    // 尚未展開尺寸的播放器與載入容器也屬於內容，不能把它們當成空頁。
    const inContent = node => {
      if (!node?.isConnected || node.closest(OUTSIDE_CONTENT)) return false;
      const doc = node.ownerDocument, view = doc.defaultView;
      if (!view) return false;
      for (let current = node; current; current = current.parentElement) {
        const style = view.getComputedStyle(current);
        if (current.hidden || style.display === 'none' || /^(hidden|collapse)$/.test(style.visibility)) return false;
      }
      const frame = view.frameElement;
      return !frame || frameDisplayed(frame);
    };
    const labels = 'p,span,div,section,article,font,em,strong';
    const excluded = 'button,a,form,[role="button"],[role="dialog"],.ans-videoquiz,script,style,template,noscript';
    const emptyLabel = value => {
      const label = String(value || '').replace(/\s+/g, '');
      return EMPTY_CONTENT.test(label) ? label : '';
    };
    const textNodes = doc => doc.createTreeWalker(doc.body || doc.documentElement || doc, 4);
    const resources = 'video,audio,#video,.video-js,.ans-job-icon,.ans-videoquiz,' + WORK_FRAME +
      ',iframe.ans-insertvideo-online,iframe.ans-insertdoc,iframe[src*="/ananas/modules/video/"],iframe[src*="/ananas/modules/document/"],iframe[src*="/document/"],' +
      'input[type="radio"],input[type="checkbox"],.tkItem_title,[data-question-title]';
    const loading = '[aria-busy="true"],[data-loading="true"],.loading,.loader,.loading-mask,.loadingMask,.layui-layer-loading,.ant-spin-spinning';
    for (const doc of docs) {
      if (doc.readyState !== 'complete') return null;
      if ([...doc.querySelectorAll(resources + ',' + loading)].some(inContent)) return null;
      if ([...doc.querySelectorAll(labels)].some(node => inContent(node) && /^(正在加载|加载中|加载中\.\.\.|请稍候)[。…]*$/.test(text(node)))) return null;
      // 主內容框架尚未完成載入時，不採用外層殘留的空提示。
      for (const frame of doc.querySelectorAll('#iframe,iframe[data-course-content],iframe[src*="/knowledge/cards"]')) {
        if (!inContent(frame)) continue;
        try {
          const child = frame.contentDocument;
          if (!child || child.readyState !== 'complete') return null;
          if (child.URL === 'about:blank' && (frame.hasAttribute('srcdoc') ||
            frame.getAttribute('src') && !/^about:blank(?:#.*)?$/.test(frame.src))) return null;
        } catch { return null; }
      }
    }
    let marker = null;
    for (const doc of docs) {
      const matches = [...doc.querySelectorAll(labels)].filter(node => emptyLabel(text(node)));
      // 先定位最内层提示，再检查可见性；隐藏提示的父容器仍可能可见。
      const node = matches.find(node => !matches.some(other => other !== node && node.contains(other)) &&
        inContent(node) && frameDisplayed(node) && !node.closest(excluded));
      if (node) { marker = { node, doc, kind: 'label', label: emptyLabel(text(node)) }; break; }
      // 有些空狀態把提示與下一節按鈕放在同一容器，需讀取提示文字節點。
      const walker = textNodes(doc);
      for (let leaf; (leaf = walker.nextNode());) {
        const parent = leaf.parentElement, label = emptyLabel(leaf.nodeValue);
        if (label && parent && inContent(parent) && frameDisplayed(parent) && !parent.closest(excluded)) {
          marker = { node: parent, doc, kind: 'label', label }; break;
        }
      }
      if (marker) break;
      const alternative = [...doc.querySelectorAll('[alt],[aria-label]')].find(node =>
        emptyLabel(node.getAttribute('alt') || node.getAttribute('aria-label')) &&
        inContent(node) && frameDisplayed(node) && !node.closest(excluded));
      if (alternative) {
        marker = { node: alternative, doc, kind: 'label', label: emptyLabel(alternative.getAttribute('alt') || alternative.getAttribute('aria-label')) }; break;
      }
    }
    if (!marker) {
      // 只在已載入的主內容框架辨識完全空白；一般介紹頁和初始 about:blank 保持等待。
      for (const doc of docs) {
        if (doc === document || !doc.body || doc.readyState !== 'complete' || !doc.defaultView?.frameElement) continue;
        const frame = doc.defaultView.frameElement;
        if (!frame.hasAttribute('srcdoc') && (!frame.getAttribute('src') || /^about:blank(?:#.*)?$/.test(doc.URL))) continue;
        if (doc.URL === 'about:blank') continue;
        const walker = textNodes(doc);
        let hasText = false;
        for (let leaf; (leaf = walker.nextNode());) {
          const parent = leaf.parentElement;
          if (leaf.nodeValue.trim() && parent && inContent(parent) && !parent.closest('script,style,template,noscript')) { hasText = true; break; }
        }
        if (hasText || [...doc.body.querySelectorAll('img,svg,canvas,object,embed,iframe,form,button,a,input,select,textarea,video,audio,[role="dialog"],[contenteditable="true"]')].some(inContent)) continue;
        marker = { node: doc.body, doc, kind: 'blank', label: '' }; break;
      }
    }
    if (!marker) return null;
    const titles = '.prev_title,.chapter-title,.chapterTitle,[data-chapter-title],.content-title,h1,h2,h3';
    marker.title = docs.flatMap(doc => [...doc.querySelectorAll(titles)]).filter(inContent).map(text).join('|');
    if (!contentIds.has(marker.node)) contentIds.set(marker.node, nextContentId++);
    marker.signature = JSON.stringify([contentIds.get(marker.node), marker.kind, marker.label, marker.title]);
    return marker;
  }
  function contentKey(empty = emptyChapter()) {
    const id = node => {
      if (!contentIds.has(node)) contentIds.set(node, nextContentId++);
      return contentIds.get(node);
    };
    const loadVersion = frame => {
      let state = contentFrameLoads.get(frame);
      if (!state) {
        state = { version: 0 }; contentFrameLoads.set(frame, state);
        frame.addEventListener('load', () => { state.version++; });
      }
      return state.version;
    };
    return JSON.stringify(courseDocuments().map(doc => [id(doc),
      [...doc.querySelectorAll('#iframe,iframe.ans-insertvideo-online,iframe[src*="/ananas/modules/video/index"],' + WORK_FRAME)]
        .map(frame => [id(frame), frame.src, loadVersion(frame), workers.get(frame.contentWindow)?.instance || '', workers.get(frame.contentWindow)?.mediaKey || '']),
      [...doc.querySelectorAll('#video_html5_api,#video video')].map(media => [id(media), media.currentSrc || media.src])])
      .concat([['empty-chapter', empty?.signature || '']]));
  }
  function locked(node) {
    return !enabled(node) || node.matches('.locked,.disabled,.lock') ||
      node.getAttribute('data-locked') === 'true' || !!node.querySelector('.icon_lock,.icon-lock') ||
      /未开放|未解锁|暂未发布/.test(text(node));
  }
  function completedNode(node) {
    const markers = '.finished,.complete,.ans-job-finished,[data-completed="true"],[data-task-status="completed"]';
    return node.matches(markers) || !!node.querySelector('.icon_Completed,[title="已完成"],[aria-label="已完成"]');
  }
  function chapterQuizView() {
    const label = text(activeTaskTab()) || text(document.querySelector('.prev_title'));
    if (/作业|考试/.test(label) && !CHAPTER_QUIZ.test(label)) return false;
    return CHAPTER_QUIZ.test(label) || courseDocuments().some(doc =>
      [...doc.querySelectorAll(WORK_FRAME)].some(frameDisplayed));
  }
  function chapterQuizTask(task) {
    const label = text(activeTaskTab()) || text(document.querySelector('.prev_title'));
    if (/作业|考试/.test(label) && !CHAPTER_QUIZ.test(label)) return false;
    if ([...task.querySelectorAll(WORK_FRAME)].some(frameDisplayed)) return true;
    // 同源测验 iframe 内的任务标记也属于该测验，不改动它的完成状态。
    for (let node = task; node;) {
      if (node.matches(WORK_FRAME)) return true;
      try { node = node.ownerDocument.defaultView.frameElement; } catch { node = null; }
    }
    return CHAPTER_QUIZ.test(label) && !task.querySelector('iframe,video') &&
      !!task.querySelector('form,button,input[type="radio"],input[type="checkbox"]');
  }
  function nextTarget(chapterOnly = false) {
    const tabs = taskTabs();
    if (!chapterOnly && tabs.length) {
      const index = tabs.indexOf(activeTaskTab(tabs));
      if (index < 0) return { error: '无法确认当前任务页签，请手动检查。' };
      for (const next of tabs.slice(index + 1)) {
        if (completedNode(next) || CHAPTER_QUIZ.test(text(next))) continue;
        if (locked(next)) return { error: '下一个任务点尚未开放，请手动检查。' };
        return { element: next.querySelector('a,.prev_white') || next, label: text(next) || '下一任务点' };
      }
    }
    const nodes = chapterNodes();
    const index = nodes.findIndex(node => node.matches('.posCatalog_active,.currents'));
    if (index >= 0) {
      for (const next of nodes.slice(index + 1)) {
        if (completedNode(next) || CHAPTER_QUIZ.test(text(next))) continue;
        if (locked(next)) return { error: '下一个章节尚未开放，请手动检查。' };
        return { element: next.querySelector('.posCatalog_name,a') || next, label: text(next) || '下一章节' };
      }
      return { error: '目录中已没有后续可播放任务。' };
    }
    const docs = chapterContentDocuments();
    const known = docs.flatMap(doc => [...doc.querySelectorAll('.nextChapter,#prevNextFocusNext,#rightNextBtn,#right1,.jb_btn[jb-type="right"]')]);
    const labels = docs.flatMap(doc => [...doc.querySelectorAll('button,a,span,div,[role="button"],input[type="button"]')])
      .filter(node => /^(下一节|下一章|下一章节|下一个任务点|下一任务点)$/.test(text(node) || node.value));
    const labelled = labels.filter(node => !labels.some(other => other !== node && node.contains(other)));
    const button = [...known, ...labelled].find(node => frameDisplayed(node) && clickable(node) && !locked(node) &&
      !node.closest(OUTSIDE_CONTENT + ',#video,.video-js,.ans-videoquiz,form,[role="dialog"],button:disabled,[aria-disabled="true"],.locked,.disabled,.lock,[data-locked="true"]'));
    return button ? { element: button, label: text(button) || '下一任务点' } : { error: '没有识别到下一任务点入口，请手动切换。' };
  }
  function navigateTo(target, now, content) {
    navigation.pending = true;
    navigation.pendingContent = content;
    navigation.since = now;
    transferSession();
    // 单次点击后等待学习内容实际更新，防止连续跳过任务。
    assignWorker(now);
    say('正在切换到：' + target.label);
    target.element.click();
  }
  function coordinate(now, config) {
    const key = taskKey();
    const empty = emptyChapter();
    const content = contentKey(empty);
    const contentUpdated = navigation.pending && content !== navigation.pendingContent;
    if (navigation.key !== key && (!navigation.pending || contentUpdated) || contentUpdated) {
      navigation = { key, since: now, completeSince: 0, waitingSince: 0,
        pending: false, halted: false, sawVideo: false, playedWorker: null };
      clearSessionTransfer();
    }
    if (!config.enabled || !config.continuous || !config.autoNext) {
      navigation.completeSince = 0;
      return;
    }
    if (navigation.halted) return;
    if (navigation.pending) {
      if (now - navigation.since > RESPONSE_TIMEOUT) {
        navigation.halted = true;
        clearSessionTransfer();
        say('任务点切换后页面没有更新，已停止重复点击；请手动检查或点“重新检测”。');
      }
      return;
    }
    const snapshot = videoSnapshot();
    snapshot.blockers = snapshot.blockers.filter(task => !chapterQuizTask(task));
    if (!snapshot.videos.length) {
      const title = text(activeTaskTab()) || text(document.querySelector('.prev_title'));
      if (snapshot.blockers.length) {
        navigation.completeSince = 0;
        say('当前页面还有非视频任务点未完成，等待手动处理。');
      } else if (chapterQuizView()) {
        advanceCompleted(now, content, '跳过章节测验，准备进入下一个任务点；测验完成状态保持原样。');
      } else if (/作业|考试/.test(title)) {
        navigation.completeSince = 0;
        say('当前任务点为测验或作业，等待你手动完成。');
      } else if (empty) {
        if (navigation.emptyContent !== empty.signature) {
          navigation.emptyContent = empty.signature;
          navigation.completeSince = 0;
        }
        advanceCompleted(now, content, empty.kind === 'blank' ? '主內容持續空白，確認載入完成後進入下一節。' :
          '当前章节暂无内容，确认后自动进入下一节。', true, empty.kind === 'blank' ? BLANK_CONTENT_DELAY : ADVANCE_DELAY);
      } else if (/学习目标|章节导学|学习指南/.test(title) && now - navigation.since >= ADVANCE_DELAY) {
        navigation.completeSince = 0;
        const videoTab = taskTabs()
          .find(node => /^\d*\s*视频$/.test(text(node)) && !locked(node));
        if (videoTab) navigateTo({ element: videoTab, label: '视频任务点' }, now, content);
      } else navigation.completeSince = 0;
      return;
    }
    navigation.sawVideo = true;
    if (snapshot.blockers.length) {
      navigation.completeSince = 0;
      say('当前页面还有非视频任务点未完成，等待手动处理。'); return;
    }
    if (snapshot.videos.some(video => !video.finished && !video.ended)) {
      navigation.completeSince = 0;
      navigation.waitingSince = 0;
      return;
    }
    if (snapshot.videos.some(video => video.markerPending)) {
      navigation.completeSince = 0;
      if (!navigation.waitingSince) navigation.waitingSince = now;
      say('视频已结束，等待平台确认任务点完成。');
      if (now - navigation.waitingSince > MARKER_TIMEOUT) {
        navigation.halted = true;
        say('平台尚未确认视频任务点完成，自动切换已停止；请检查后点“重新检测”。');
      }
      return;
    }
    navigation.waitingSince = 0;
    if (snapshot.videos.some(video => !video.complete)) { navigation.completeSince = 0; return; }
    advanceCompleted(now, content);
  }
  function advanceCompleted(now, content, message = '', chapterOnly = false, delay = ADVANCE_DELAY) {
    if (!navigation.completeSince) navigation.completeSince = now;
    if (now - navigation.completeSince < delay || now - navigation.since < delay) {
      if (message) say(message);
      return;
    }
    const target = nextTarget(chapterOnly);
    if (target.error) { navigation.halted = true; say(target.error); return; }
    navigateTo(target, now, content);
  }

  function clickVideoControl(node) {
    if (!clickable(node) || locked(node)) return false;
    node.click();
    return true;
  }
  // Adapted from alv's true_click, for shared-course navigation only.
  // Reuse an existing handler first; an unavailable handler permits one simulated click.
  function sharedNavigationAction(target, active, files) {
    if (!isZhidaoShared) return null;
    const page = typeof unsafeWindow === 'object' && unsafeWindow ? unsafeWindow : window;
    const nextButtons = [...document.querySelectorAll('.nextButton')].filter(node => visibleZhidaoPrompt(node) && !locked(node));
    const candidates = nextButtons.length === 1 && target === files[files.indexOf(active) + 1] ? [nextButtons[0], target] : [target];
    for (const node of candidates) {
      if (!visibleZhidaoPrompt(node) || locked(node)) continue;
      let callback = null, jquery = false;
      for (const jq of [page.$, page.jQuery, page.y$]) {
        try {
          const clicks = jq?._data?.(node, 'events')?.click || jq?._data?.(node)?.events?.click;
          // Delegated handlers need an ancestor's dispatch machinery; do not call them as direct handlers.
          const direct = clicks?.filter(item => !item.selector && typeof item.handler === 'function');
          callback = direct?.[1]?.handler || direct?.[0]?.handler;
          if (callback) { jquery = true; break; }
        } catch {}
      }
      if (!callback && typeof node.onclick === 'function') callback = node.onclick;
      if (!callback) continue;
      return () => {
        if (!node.isConnected || !settings().enabled || settings().manual || platformStopped || platformScriptAlert() || zhidaoBlocker()) return false;
        const event = new MouseEvent('click', { view: window, bubbles: true, cancelable: true });
        const wrapped = new Proxy(event, { get(object, property) {
          if (property === 'isTrusted') return true;
          if (property === 'target' || property === 'currentTarget') return node;
          const value = Reflect.get(object, property, object);
          return typeof value === 'function' ? value.bind(object) : value;
        } });
        const input = { originalEvent: wrapped, isTrusted: true, type: 'click', target: node, currentTarget: node,
          preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation(),
          stopImmediatePropagation: () => event.stopImmediatePropagation(), isDefaultPrevented: () => event.defaultPrevented };
        try {
          const since = navigation.since, targetKey = navigation.targetKey;
          const result = callback.call(node, jquery ? input : wrapped);
          if (result && typeof result.then === 'function') Promise.resolve(result).catch(error => {
            if (navigation.pending && navigation.since === since && navigation.targetKey === targetKey && !platformStopped) {
              navigation.halted = true; clearSessionTransfer();
              say('页面切节处理器返回失败，请手动检查；不会补发点击。');
            }
            console.warn('[视频助手] 切节处理器异步失败。', error);
          });
        }
        catch (error) { console.warn('[视频助手] 切节处理器未完成，等待页面反馈；不会补发点击。', error); }
        return true;
      };
    }
    const simulatedTarget = candidates.find(node => visible(node) && !locked(node));
    if (!simulatedTarget) return null;
    const action = () => {
      const before = zhidaoSnapshot();
      const beforeSrc = before.media?.src;
      const result = simulateSharedClick(simulatedTarget.querySelector('.catalogue_title') || simulatedTarget,
        () => sharedInteractionBlocked(), () => {
          const after = zhidaoSnapshot();
          return before.media !== after.media || before.content !== after.content || beforeSrc !== after.media?.src;
        });
      action.failure = result.reason;
      return result.sent;
    };
    action.simulated = true;
    return action;
  }

  function sharedInteractionBlocked(quizRoot = null) {
    if (!settings().enabled || settings().manual || platformStopped) return true;
    if (platformScriptAlert()) { stopForPlatformAlert(); return true; }
    if (!quizRoot) return !!zhidaoBlocker();
    if (!quizRoot.isConnected || protectedQuizContent(quizRoot)) return true;
    if ([...document.querySelectorAll('#tcaptcha_transform_dy,#tcaptcha_iframe_dy')].some(visibleVerification)) return true;
    return [...document.querySelectorAll('.dialog-pop,.qa-dialog-pop,[role="dialog"],.el-dialog__wrapper,.el-message-box__wrapper')]
      .some(node => visibleZhidaoPrompt(node) && node !== quizRoot && !quizRoot.contains(node));
  }
  function simulateSharedClick(node, blocked, changed = () => false) {
    if (!node?.isConnected || !visible(node) || locked(node) || blocked()) return { sent: false, reason: '页面当前有阻挡操作的提示，等待手动处理。' };
    try { node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' }); } catch {}
    const rect = node.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    if (rect.width <= 0 || rect.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
      return { sent: false, reason: '目标控件尚未进入可见区域，请手动展开或滚动目录。' };
    }
    // The helper's own floating panel may overlap the directory. Other overlays still block.
    const hit = document.elementsFromPoint(x, y).find(element => element !== panel &&
      !panel?.contains(element) && !panel?.shadowRoot?.contains(element));
    if (!hit || hit !== node && !node.contains(hit)) return { sent: false, reason: '目标控件被其他内容遮挡，请手动检查。' };
    let sent = false;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      if (blocked() || !node.isConnected || !hit.isConnected || changed()) return { sent, reason: '页面状态已经变化。' };
      const down = /down$/.test(type);
      const init = { view: window, bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, button: 0, buttons: down ? 1 : 0,
        pointerId: 1, pointerType: 'mouse', isPrimary: true };
      const event = type.startsWith('pointer') && typeof PointerEvent === 'function' ?
        new PointerEvent(type, init) : new MouseEvent(type, init);
      sent = true;
      hit.dispatchEvent(event);
    }
    return { sent };
  }
  function videoOptionSelected(option) {
    return option.matches('[aria-checked="true"],.active,.selected,.is-selected,.checked') ||
      !!option.querySelector('input:checked,.topic-option-item.active,.item-topic.active') ||
      [...option.querySelectorAll('use')].some(node =>
        /#iconxuanzhong$/.test(node.getAttribute('href') || node.getAttribute('xlink:href') || ''));
  }

  // 知到两种学习页面共用导航时序，分别读取各自的播放器、当前项和目录入口。
  const SHARED_ROWS = '#app .el-scrollbar__view ul.list li.video';
  function zhidaoMedia() { return document.querySelector(isZhidaoShared ?
    '#vjs_container_html5_api,#vjs_container video' : '#vjs_mediaPlayer_html5_api,#vjs_mediaPlayer video'); }
  function zhidaoFiles() { return [...document.querySelectorAll(isZhidaoShared ? SHARED_ROWS : '#sourceTree .file-item[id^="file_"]')]; }
  function zhidaoCurrent() { return zhidaoFiles().find(node => node.classList.contains(isZhidaoShared ? 'current_play' : 'active')) || null; }
  function zhidaoFileKey(node) {
    if (!node) return '';
    if (!isZhidaoShared) return node.id || '';
    const number = text(node.querySelector('.hour')), title = text(node.querySelector('.catalogue_title'));
    return number && title ? 'shared:' + JSON.stringify([number, title]) : '';
  }
  function zhidaoUniqueKey(node) {
    const key = zhidaoFileKey(node);
    return key && zhidaoFiles().filter(row => zhidaoFileKey(row) === key).length === 1 ? key : '';
  }
  function zhidaoFileLabel(node) {
    return isZhidaoShared ? normalize(text(node.querySelector('.hour')) + ' ' + text(node.querySelector('.catalogue_title'))) : text(node.querySelector('.file-name'));
  }
  function visibleVerification(node) {
    if (!visible(node)) return false;
    const view = node.ownerDocument.defaultView;
    for (let parent = node; parent?.nodeType === 1; parent = parent.parentElement) {
      if (Number(view.getComputedStyle(parent).opacity) === 0) return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 20 && rect.height > 20 && rect.right > 0 && rect.bottom > 0 && rect.left < view.innerWidth && rect.top < view.innerHeight;
  }
  function protectedQuizContent(root) {
    return !!root.querySelector('iframe,[role="alert"],.dialog-aberrant,.vjs-error-display,#tcaptcha_transform_dy,#tcaptcha_iframe_dy') ||
      /检测到.{0,20}(?:异常|违规)脚本|请关闭插件|验证码|人机验证|滑块验证|安全验证/.test(text(root));
  }
  function visibleZhidaoPrompt(node) {
    if (!visible(node)) return false;
    const view = node.ownerDocument.defaultView;
    for (let parent = node; parent?.nodeType === 1; parent = parent.parentElement) {
      if (Number(view.getComputedStyle(parent).opacity) === 0) return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < view.innerWidth && rect.top < view.innerHeight;
  }
  function videoQuizRoots() {
    if (!isZhidaoShared) return [];
    const media = zhidaoMedia(), player = document.getElementById('vjs_container'), roots = new Set();
    if (!media || !player) return [];
    for (const marker of document.querySelectorAll('.topic-item,.question-body')) {
      // Element UI also puts the video quiz inside an el-scrollbar__view.
      // Exclude the actual directory list, not every scrollable component.
      if (!visible(marker) || marker.closest('#sourceTree,#app .el-scrollbar__view ul.list,.homework,.exam,.test-paper,[data-task-type="work"]')) continue;
      let root = marker.closest('.el-dialog__wrapper,.dialog-pop') || marker.closest('[role="dialog"],.video-quiz,.quiz-dialog,.topic-dialog');
      if (!root && player.contains(marker)) root = marker.closest('.topic-panel,.question-panel,.topic-box,.question-box') || marker.closest('.topic-list') || marker;
      if (!root || root === player || root.contains(media) || !visible(root) || protectedQuizContent(root)) continue;
      if (!videoQuizPanels.get(root)?.collapsed && !visibleVerification(root)) continue;
      const header = root.querySelector('.el-dialog__header');
      // The real video-dialog header also contains a help paragraph mentioning exams.
      // Classify the heading itself, not that paragraph or the question stem.
      const heading = header?.querySelector('.el-dialog__title,h1,h2,h3,h4,h5,h6,[role="heading"]') ||
        root.querySelector('.question-title,[role="heading"]') || header || root.querySelector('.topic-title');
      const title = text(heading);
      if (/章节(?:测验|测试|检验)|平时测试|作业|考试/.test(title)) continue;
      // .question-body 在正文也可能出现；播放器外须同时具有视频练习标题或 .topic-item。
      if (!player.contains(root) && !root.querySelector('.topic-item') &&
          !/随堂练习|课堂练习|视频弹题|视频题|弹题/.test(title)) continue;
      roots.add(root);
    }
    return [...roots].filter(root => ![...roots].some(other => other !== root && other.contains(root)));
  }
  function videoQuizKey(root) {
    const question = root.querySelector('[data-question-id]') || root.querySelector('.question-title,.topic-title,.question-stem,.topic-stem');
    const label = question ? question.getAttribute('data-question-id') || text(question) :
      [...root.querySelectorAll('.topic-item,.option,.question-body')].map(text).join('|');
    const media = zhidaoMedia();
    const stableLabel = normalize(label).replace(/^(?:回答正确|回答错误|正确|错误|答对了)\s*(?=【)/, '');
    return (media ? mediaKey(media) : '') + ':' + stableLabel.slice(0, 1600) + ':' +
      [...root.querySelectorAll('.topic-item,.option')].map(text).join('|').slice(0, 1600);
  }
  function restoreVideoQuiz(root, record) {
    if (!record.collapsed) return;
    if (root.getAttribute(QUIZ_ATTRIBUTE) === instance) {
      if (record.marker === null) root.removeAttribute(QUIZ_ATTRIBUTE);
      else root.setAttribute(QUIZ_ATTRIBUTE, record.marker);
    }
    if (root.getAttribute('aria-hidden') === 'true') {
      if (record.ariaHidden === null) root.removeAttribute('aria-hidden');
      else root.setAttribute('aria-hidden', record.ariaHidden);
    }
    if (root.getAttribute('inert') === '') {
      if (record.inert === null) root.removeAttribute('inert');
      else root.setAttribute('inert', record.inert);
    }
    record.collapsed = false;
  }
  function restoreVideoQuizzes(clear = false) {
    for (const [root, record] of videoQuizPanels) restoreVideoQuiz(root, record);
    if (clear) videoQuizPanels.clear();
  }
  function syncVideoQuizzes() {
    for (const root of activeSourceQuizzes) {
      if (!root.isConnected || !visibleZhidaoPrompt(root)) {
        sourceQuizStates.delete(root); activeSourceQuizzes.delete(root);
      }
    }
    for (const [root, record] of videoQuizPanels) {
      if (!root.isConnected || !visible(root) || protectedQuizContent(root) || record.key !== videoQuizKey(root) ||
          record.collapsed && record.presentation !== root.getAttribute('class') + '|' + root.getAttribute('style')) {
        restoreVideoQuiz(root, record); videoQuizPanels.delete(root);
      }
    }
  }
  function collapsedVideoQuiz() {
    return [...videoQuizPanels].find(([root, record]) => record.collapsed && root.isConnected && visible(root))?.[0] || null;
  }
  function handleVideoQuizPresentation(config) {
    if (!isZhidaoShared) return;
    if (!config.enabled || config.manual || config.autoQuiz || !config.hideQuiz || platformStopped) { restoreVideoQuizzes(true); return; }
    // 验证和普通提示共存时不操作任何弹题入口。
    if ([...document.querySelectorAll('#tcaptcha_transform_dy,#tcaptcha_iframe_dy')].some(visibleVerification)) {
      restoreVideoQuizzes(true); return;
    }
    const roots = videoQuizRoots();
    const otherDialog = [...document.querySelectorAll('.dialog-pop,.qa-dialog-pop,[role="dialog"],.el-dialog__wrapper,.el-message-box__wrapper')]
      .some(node => visibleZhidaoPrompt(node) && !roots.some(root => root === node || root.contains(node)));
    if (otherDialog) { restoreVideoQuizzes(true); return; }
    for (const root of roots) {
      let record = videoQuizPanels.get(root);
      if (!record) {
        record = { key: videoQuizKey(root), attempted: false, revealed: false, collapsed: false };
        videoQuizPanels.set(root, record);
      }
      if (record.revealed) continue;
      if (!record.attempted) {
        record.attempted = true;
        const requiresSelection = root.matches('#playTopic-dialog,.dialog-test') &&
          ![...root.querySelectorAll('.topic-item,.option')].some(videoOptionSelected);
        const skip = [...root.querySelectorAll('button,[role="button"],input[type="button"]')].find(node =>
          clickable(node) && !locked(node) && (!node.hasAttribute('href') || ['', '#'].includes(node.getAttribute('href'))) &&
          (!requiresSelection || !/^(?:关闭(?:题目)?|Close)$/i.test(
            normalize(node.getAttribute('aria-label') || node.getAttribute('title') || node.value || text(node)))) &&
          /^(?:跳过(?:此题|本题)?|暂不作答|稍后作答|关闭(?:题目)?|Close)$/i.test(
            normalize(node.getAttribute('aria-label') || node.getAttribute('title') || node.value || text(node))));
        // 每道可识别的弹题仅点击一次原生关闭/跳过，未关闭时收起并等待人工作答。
        if (skip) { skip.click(); syncVideoQuizzes(); }
        if (videoQuizPanels.get(root) !== record || !root.isConnected || !visible(root) || protectedQuizContent(root)) continue;
      }
      if (!record.collapsed) {
        if (!quizPresentationStyle?.isConnected) {
          quizPresentationStyle = document.createElement('style');
          quizPresentationStyle.textContent = '[' + QUIZ_ATTRIBUTE + '="' + instance + '"]{opacity:0!important;pointer-events:none!important}';
          (document.head || document.documentElement).appendChild(quizPresentationStyle);
        }
        record.marker = root.getAttribute(QUIZ_ATTRIBUTE);
        record.ariaHidden = root.getAttribute('aria-hidden'); record.inert = root.getAttribute('inert');
        record.presentation = root.getAttribute('class') + '|' + root.getAttribute('style');
        root.setAttribute(QUIZ_ATTRIBUTE, instance); root.setAttribute('aria-hidden', 'true'); root.setAttribute('inert', '');
        record.collapsed = true;
      }
    }
  }
  function zhidaoBlockerMessage() {
    return collapsedVideoQuiz() ? '视频弹题已收起；仍需作答，点击“显示弹题”后手动处理。' :
      '知到页面有题目、验证或其他提示，请手动处理后继续。';
  }
  function handleSourceVideoQuiz(now, config) {
    if (!isZhidaoShared || !config.enabled || config.manual || !config.autoQuiz) return null;
    const roots = videoQuizRoots(), root = roots[0];
    if (!root || [...document.querySelectorAll('#tcaptcha_transform_dy,#tcaptcha_iframe_dy')].some(visibleVerification) ||
        [...document.querySelectorAll('.dialog-pop,.qa-dialog-pop,[role="dialog"],.el-dialog__wrapper,.el-message-box__wrapper')]
          .some(node => visibleZhidaoPrompt(node) && !roots.some(quiz => quiz === node || quiz.contains(node)))) return null;
    const key = videoQuizKey(root);
    activeSourceQuizzes.add(root);
    let state = sourceQuizStates.get(root);
    if (!state || state.key !== key) {
      state = { key, phase: 'ready', chosen: false, since: now, closeClicked: false };
      sourceQuizStates.set(root, state);
    }
    if (!sourceQuizWatched.has(root)) {
      root.addEventListener('click', event => {
        const current = sourceQuizStates.get(root);
        if (event.isTrusted && event.target.closest?.('.topic-item,.option') && current && current.phase !== 'closing') {
          current.chosen = true; current.phase = 'chosen'; current.since = elapsedTime();
        }
      }, true);
      sourceQuizWatched.add(root);
    }
    const message = value => ({ message: value, allowPlayback: state.phase === 'closing' });
    const stop = value => { state.phase = 'blocked'; state.reason = value; return message(value); };
    if (state.phase === 'blocked') return message(state.reason);
    if (state.phase === 'closing') return now - state.since > RESPONSE_TIMEOUT ?
      stop('视频弹题关闭后页面没有变化，请手动处理。') : message('已点击视频弹题关闭入口，等待页面继续。');
    const busy = [...root.querySelectorAll('[aria-busy="true"],.is-loading,.submitting')].some(visible);
    if (busy) {
      if (!state.busySince) state.busySince = now;
      if (now - state.busySince > RESPONSE_TIMEOUT) return stop('视频弹题控件长时间未就绪，请手动处理。');
      state.since = now; return message('等待视频弹题控件就绪。');
    }
    state.busySince = 0;
    const all = [...root.querySelectorAll('.topic-item,.option')];
    const options = all.filter(node => visible(node) && !all.some(other => other !== node && other.contains(node)));
    const observable = options.some(node => node.matches('[aria-checked]') ||
      node.querySelector('input,.topic-option,.topic-option-item,.item-topic'));
    const selected = !!root.querySelector('input:checked') || options.some(videoOptionSelected) || state.chosen && !observable;
    const usable = node => node && visibleZhidaoPrompt(node) && !locked(node) &&
      !node.closest('[aria-disabled="true"],.disabled,.is-disabled') &&
      (!node.hasAttribute('href') || ['', '#'].includes(node.getAttribute('href'))) &&
      !(node.closest('form') && node.matches('button,input') && node.type === 'submit');
    const closeButtons = [...root.querySelectorAll('button,[role="button"],div.btn,.submits,.close-btn,.close-button')];
    const closeLabel = /^(?:关闭(?:题目|弹题|弹窗|窗口)?|继续(?:学习|播放)?|Close)$/i;
    let close = closeButtons.find(node => usable(node) && closeLabel.test(text(node).replace(/\s/g, '')));
    if (!close) close = closeButtons.find(node => usable(node) && closeLabel.test(
      normalize(node.getAttribute('aria-label') || node.getAttribute('title')).replace(/\s/g, '')));
    if (!close) close = [...root.querySelectorAll('.close-box svg,.close-box img,.el-dialog__headerbtn,[aria-label="关闭"],[aria-label="Close"],[title="关闭"]')]
      .map(node => node.closest('button,[role="button"],.close-box') || node).find(usable);
    if (selected || !options.length && close) {
      if (state.chosen && now - state.since < SELECT_DELAY) return message('已选择一个选项，等待关闭入口就绪。');
      if (close) {
        state.closeClicked = true; state.phase = 'closing'; state.since = now;
        clickVideoControl(close);
        if (!root.isConnected || !visibleZhidaoPrompt(root)) return null;
        return message('已点击视频弹题关闭入口，等待页面继续。');
      }
      return now - state.since > RESPONSE_TIMEOUT ? stop('已选择一个选项，但关闭入口尚未出现，请手动处理。') :
        message('已选择一个选项，等待关闭入口出现。');
    }
    if (state.chosen) return now - state.since > RESPONSE_TIMEOUT ?
      stop('点击选项后尚未确认选中，请手动选择；不会尝试关闭未作答题目。') : message('已点击选项，等待页面确认选中。');
    const option = options.find(node => clickable(node) && !locked(node) && !node.querySelector('input:disabled'));
    if (!option) return now - state.since > RESPONSE_TIMEOUT ? stop('视频弹题选项不可用，请手动处理。') : message('等待视频弹题选项可用。');
    state.chosen = true; state.phase = 'chosen'; state.since = now;
    const icon = option.querySelector('.topic-option');
    const target = [icon?.parentElement && icon.parentElement !== option ? icon.parentElement : icon,
      option.querySelector('input[type="radio"],input[type="checkbox"]'),
      option.querySelector('label,.topic-option-item,.item-topic'), option].find(node => node && clickable(node));
    const clicked = simulateSharedClick(target, () => sharedInteractionBlocked(root), () => videoOptionSelected(option));
    if (!clicked.sent) return stop(clicked.reason || '选项控件暂不可点击，请手动选择。');
    if (!root.isConnected || !visibleZhidaoPrompt(root)) return null;
    return message('已选择一个选项，等待关闭入口出现。');
  }
  function zhidaoBlocker() {
    const scope = isZhidaoShared ? '#vjs_container' : '#vjs_mediaPlayer';
    const dialog = [...document.querySelectorAll('.dialog-pop,.qa-dialog-pop,[role="dialog"],.el-dialog__wrapper,.el-message-box__wrapper,' +
      scope + ' .vjs-error-display,' + scope + ' input[type="radio"],' + scope + ' input[type="checkbox"]' +
      (isZhidaoShared ? ',.topic-item,.question-body' : ''))].find(visibleZhidaoPrompt);
    // 只暂停等待可见验证，不点击、不隐藏、不绕过。页面预载的透明屏外 iframe 不阻挡播放。
    return collapsedVideoQuiz() || dialog || [...document.querySelectorAll('#tcaptcha_transform_dy,#tcaptcha_iframe_dy')].find(visibleVerification) || null;
  }
  function platformScriptAlert() {
    if (!isZhidao) return null;
    return [...document.querySelectorAll('[role="dialog"],[role="alert"],.el-dialog__wrapper,.el-message-box__wrapper,.dialog-pop,.dialog-aberrant,p,span,div')]
      .find(node => {
        const label = text(node);
        if (label.length > 350 || !/检测到异常脚本|检测到.{0,20}(?:异常|违规)脚本|请关闭插件后/.test(label) || !visible(node)) return false;
        const dialog = node.closest('[role="dialog"],[role="alert"],.el-dialog__wrapper,.el-message-box__wrapper,.dialog-pop,.dialog-aberrant');
        if (!dialog && !/请关闭(?:插件|脚本)|回到学堂|重新进入视频/.test(label)) return false;
        const view = node.ownerDocument.defaultView;
        for (let parent = node; parent?.nodeType === 1; parent = parent.parentElement) {
          if (Number(view.getComputedStyle(parent).opacity) === 0) return false;
        }
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < view.innerWidth && rect.top < view.innerHeight;
      }) || null;
  }
  function stopForPlatformAlert() {
    sharedSourceBackend?.stop(true);
    restoreVideoQuizzes(true);
    platformAlertActive = true;
    stopInspectionMessage = '';
    if (!platformStopped) {
      platformStopped = true;
      try { sessionStorage.setItem(PLATFORM_STOP_KEY + courseSessionId(), '1'); } catch {}
      const media = zhidaoMedia();
      if (media && startedMedia.has(media)) media.pause();
    }
    if (session.running) { session.elapsed = elapsedTime(); session.running = false; session.runSince = 0; }
    navigation.pending = false; navigation.halted = true;
    clearSessionTransfer();
    say(PLATFORM_STOP_MESSAGE);
    renderPanel(PLATFORM_STOP_MESSAGE);
  }
  function inspectStoppedPage(event) {
    if (!event?.isTrusted) return;
    if (platformScriptAlert()) { stopForPlatformAlert(); return; }
    platformAlertActive = false;
    if (zhidaoBlocker()) {
      stopInspectionMessage = '当前页面仍有题目、验证或其他提示，请手动处理后再次检查。';
      renderPanel(); return;
    }
    // Only this helper's remembered lock is cleared; platform state and dialogs are untouched.
    try { sessionStorage.removeItem(PLATFORM_STOP_KEY + courseSessionId()); } catch {}
    platformStopped = false; stopInspectionMessage = '';
    session.running = false; session.runSince = 0;
    navigation.pending = false; navigation.halted = false; navigation.key = ''; navigation.completeSince = 0;
    clearSessionTransfer();
    for (const media of document.querySelectorAll('video')) playback.delete(media);
    lastMessage = '';
    say('检查完成，当前未发现平台异常警告。点击开始或继续按钮后再运行。');
    renderPanel();
  }
  function zhidaoRate(node) {
    if (node && (isZhidaoShared && completedNode(node) || zhidaoFinishedIcon(node))) return 100;
    const values = [...(node?.querySelectorAll(isZhidaoShared ? '.rate,.progress-num,[role="progressbar"]' : '.rate') || [])]
      .map(marker => {
        // A stale hidden percentage must not confirm completion.
        for (let parent = marker; parent && parent !== node; parent = parent.parentElement) {
          const style = parent.ownerDocument.defaultView.getComputedStyle(parent);
          if (parent.hidden || style.display === 'none' || style.visibility === 'hidden') return null;
        }
        const match = text(marker).match(/^(\d+(?:\.\d+)?)\s*%$/);
        if (match) return Number(match[1]);
        if (marker.getAttribute('role') !== 'progressbar') return null;
        const value = marker.getAttribute('aria-valuenow'), min = Number(marker.getAttribute('aria-valuemin') || 0),
          max = Number(marker.getAttribute('aria-valuemax') || 100);
        return value !== null && max > min ? (Number(value) - min) / (max - min) * 100 : null;
      }).filter(value => Number.isFinite(value) && value >= 0 && value <= 100);
    if (values.length) return Math.min(...values);
    // The native half-progress icon is explicitly incomplete even without a number.
    return isZhidaoShared && node && zhidaoFinishedIcon(node, '.time_ico_half') ? 0 : null;
  }
  function zhidaoFinishedIcon(row, selector = isZhidaoShared ? '.time_icofinish' : '.icon-finish') {
    // 仅参考公开页面的完成标记名称，独立读取 DOM；不改动平台事件或学习记录。
    return [...row.querySelectorAll(selector)].some(marker => {
      const view = marker.ownerDocument.defaultView;
      // 隐藏的旧图标不算完成；目录行因折叠而隐藏时仍可读取其实际标记。
      for (let node = marker; node && node !== row; node = node.parentElement) {
        const style = view.getComputedStyle(node);
        if (node.hidden || style.display === 'none' || style.visibility === 'hidden') return false;
      }
      return true;
    });
  }
  function zhidaoSnapshot() {
    const media = zhidaoMedia(), active = zhidaoCurrent();
    return { media, active, key: zhidaoUniqueKey(active), content: media ? mediaKey(media) : '' };
  }
  function resetZhidaoNavigation(snapshot, now) {
    navigation = { key: snapshot.key, content: snapshot.content, since: now, completeSince: 0, waitingSince: 0,
      pending: false, halted: false };
    clearSessionTransfer();
  }
  function waitZhidaoNavigation(target, now, snapshot = zhidaoSnapshot()) {
    navigation.pending = true;
    navigation.halted = false;
    navigation.pendingContent = snapshot.content;
    navigation.pendingMedia = snapshot.media;
    navigation.pendingKey = snapshot.key;
    navigation.targetKey = zhidaoUniqueKey(target);
    navigation.since = now;
    navigation.completeSince = 0;
    transferSession();
    say('正在切换到：' + (zhidaoFileLabel(target) || '下一个视频'));
  }
  function coordinateZhidao(now, config) {
    const snapshot = zhidaoSnapshot(), { media, active, key, content } = snapshot;
    if (navigation.pending) {
      const newMedia = media && (media !== navigation.pendingMedia ||
        content !== navigation.pendingContent && !!(media.currentSrc || media.src));
      if (key === navigation.targetKey && newMedia) resetZhidaoNavigation(snapshot, now);
      else {
        if (config.enabled && !navigation.halted && now - navigation.since > RESPONSE_TIMEOUT) {
          navigation.halted = true; clearSessionTransfer();
          say('任务点切换后视频内容没有更新，已停止重复点击；请手动检查或点“重新检测”。');
        }
        return;
      }
    } else if (navigation.key !== key) {
      // 平台自身连播也可能先改目录高亮、后换源；等待新视频再接管。
      if (navigation.key && key && media && content === navigation.content) {
        waitZhidaoNavigation(active, now, { ...snapshot, key: navigation.key }); return;
      }
      resetZhidaoNavigation(snapshot, now);
    } else if (navigation.content !== content) resetZhidaoNavigation(snapshot, now);
    if (!config.enabled) { navigation.completeSince = 0; return; }
    if (navigation.halted) return;
    if (zhidaoBlocker()) {
      navigation.completeSince = 0;
      say(zhidaoBlockerMessage()); return;
    }
    if (!media || !visible(media)) {
      navigation.completeSince = 0;
      say('当前资料不是可识别的视频，等待你打开视频资料。'); return;
    }
    if (!media.ended) {
      navigation.completeSince = 0; navigation.waitingSince = 0;
      if (navigation.replay?.starting && !media.paused) navigation.replay.starting = false;
      return;
    }
    if (!config.continuous) {
      navigation.completeSince = 0;
      say('当前视频已结束，自动连播已关闭。'); return;
    }
    if (!active || !key) {
      navigation.halted = true;
      say('无法确认知到目录中的当前视频，请手动检查或点“重新检测”。'); return;
    }
    const rate = zhidaoRate(active);
    if (isZhidaoShared && rate !== 100) {
      navigation.completeSince = 0;
      const clock = elapsedTime(now);
      const replay = navigation.replay || (navigation.replay = { count: 0, stale: 0, active: false, starting: false });
      if (replay.starting) {
        if (clock - replay.since > RESPONSE_TIMEOUT) {
          navigation.halted = true;
          say('当前视频重播未能启动，请点击播放器原有播放按钮后重新检测。');
        } else say('观看时长未达标，正在重新启动当前视频；浏览器要求操作时请点击播放。');
        return;
      }
      if (replay.active) {
        replay.active = false; replay.finished = true;
      }
      if (!navigation.waitingSince) navigation.waitingSince = clock;
      if (rate === null) {
        say('视频已结束，等待平台提供观看进度或完成标记。');
        if (clock - navigation.waitingSince > MARKER_TIMEOUT) {
          navigation.halted = true;
          say('无法读取平台的观看进度，已停止自动切节；请检查当前任务是否完成。');
        }
        return;
      }
      if (clock - navigation.waitingSince < REPLAY_GRACE) {
        say('视频已结束，平台观看进度为 ' + Math.floor(rate) + '%，等待进度更新。'); return;
      }
      if (replay.finished) {
        // Allow the platform time to report this round before checking progress.
        replay.stale = rate > replay.rateAtStart ? 0 : replay.stale + 1;
        replay.finished = false;
      }
      if (replay.stale >= 2) {
        navigation.halted = true;
        say('连续两次重播后平台观看进度仍未增加，已停止重播，请检查课程页面。'); return;
      }
      replay.count++; replay.active = true; replay.starting = true;
      replay.rateAtStart = rate; replay.since = clock;
      navigation.waitingSince = 0;
      if (media.muted !== config.muted) media.muted = config.muted;
      // HTMLMediaElement.play() at the end restarts normal playback from the start.
      // Do not seek, change speed, or write platform progress / watch-log requests.
      playMedia(media, now);
      return;
    }
    if (!config.autoNext) {
      navigation.completeSince = 0;
      say('当前视频已结束，自动下一任务点已关闭。'); return;
    }
    if (rate !== null && rate < 100) {
      navigation.completeSince = 0;
      if (!navigation.waitingSince) navigation.waitingSince = now;
      say('视频已结束，等待知到目录确认学习进度完成。');
      if (now - navigation.waitingSince > MARKER_TIMEOUT) {
        navigation.halted = true;
        say('知到目录尚未确认视频进度完成，自动切换已停止；请检查后点“重新检测”。');
      }
      return;
    }
    navigation.waitingSince = 0;
    if (!navigation.completeSince) navigation.completeSince = now;
    if (now - navigation.completeSince < ADVANCE_DELAY) { say('当前视频已结束，准备进入下一个视频。'); return; }
    const files = zhidaoFiles(), next = files.slice(files.indexOf(active) + 1)
      .find(node => (isZhidaoShared || node.querySelector('.icon-video')) && zhidaoRate(node) !== 100);
    if (!next) { navigation.halted = true; say('目录中已没有后续未完成的视频。'); return; }
    if (!zhidaoUniqueKey(next)) { navigation.halted = true; say('无法唯一识别下一个视频，请手动检查。'); return; }
    if (locked(next) || next.closest('[aria-disabled="true"],.locked,.disabled,.lock,[data-locked="true"]')) {
      navigation.halted = true; say('下一个视频尚未开放，请手动检查。'); return;
    }
    if (isZhidaoShared) {
      const action = sharedNavigationAction(next, active, files);
      if (action) {
        waitZhidaoNavigation(next, now, snapshot);
        if (action.simulated) say('正在模拟点击切换到：' + zhidaoFileLabel(next));
        if (!action()) { navigation.pending = false; navigation.halted = true; clearSessionTransfer(); say(action.failure || '切节条件已变化，请手动检查。'); }
        return;
      }
      if (visible(next)) {
        navigation.halted = true;
        say('下一任务入口暂不可操作，请手动检查。'); return;
      }
    }
    if (!visible(next)) {
      if (navigation.revealing) {
        if (visible(navigation.revealing.child)) navigation.revealing = null;
        else if (now - navigation.revealing.since > RESPONSE_TIMEOUT) {
          navigation.halted = true; say('目录展开后仍无法找到可用视频入口，请手动检查。');
        }
        if (navigation.revealing) return;
      }
      const entry = zhidaoRevealEntry(next);
      if (!entry) { navigation.halted = true; say('下一个视频入口不可见，请手动展开目录。'); return; }
      navigation.revealing = { child: entry.child, since: now };
      say('正在展开下一视频所在目录。');
      if (isZhidaoShared) {
        const result = simulateSharedClick(entry.toggle, () => sharedInteractionBlocked(), () => visible(entry.child));
        if (!result.sent) { navigation.halted = true; say(result.reason || '目录展开入口暂不可用，请手动检查。'); }
      } else entry.toggle.click();
      return;
    }
    navigation.revealing = null;
    waitZhidaoNavigation(next, now, snapshot);
    next.click();
  }
  function zhidaoRevealEntry(next) {
    const ancestors = [];
    for (let node = next.parentElement; node && node.id !== 'sourceTree' && !node.matches('.el-scrollbar__view'); node = node.parentElement) ancestors.unshift(node);
    return ancestors.map(parent => {
      const child = [...parent.children].find(node => node === next || node.contains(next));
      let toggle;
      if (isZhidaoShared) {
        if (parent.matches('ul.list')) toggle = parent.querySelector(':scope > li.chapter');
        else if (parent.matches('div') && child?.matches('ul')) toggle = parent.querySelector(':scope > li:not(.video):not(.chapter)');
      } else if (parent.matches('.folder-item')) toggle = parent.querySelector(':scope > .folder-box');
      return { child, toggle };
    }).find(item => item.child && !visible(item.child) && clickable(item.toggle));
  }
  function assignWorker(now) {
    const config = settings();
    const frames = videoSnapshot().videos.map(video => video.frame).filter(Boolean);
    const candidates = [...workers.entries()].filter(([source, info]) => {
      const frame = locateFrame(source);
      return now - info.seen < 6500 && (!info.ended || info.quiz) && frame?.src === info.frameSrc && eligibleFrame(frame);
    }).sort(([left], [right]) => frames.indexOf(locateFrame(left)) - frames.indexOf(locateFrame(right)));
    // 等待前面的播放器登记完毕，不能因为其 iframe 正在加载就先启动后面的视频。
    const firstPending = frames.find(frame => {
      if (!eligibleFrame(frame)) return false;
      const info = workers.get(frame.contentWindow);
      return !(info && now - info.seen < 6500 && info.frameSrc === frame.src && info.ended && !info.quiz);
    });
    const nextSource = firstPending?.contentWindow;
    activeWorker = candidates.some(([source]) => source === nextSource) &&
      (config.continuous || !navigation.playedWorker || nextSource === navigation.playedWorker) ? nextSource : null;
    if (!config.enabled || navigation.pending || navigation.halted) activeWorker = null;
    if (activeWorker) navigation.playedWorker = activeWorker;
    for (const [source, info] of workers) {
      source.postMessage({ channel: CHANNEL, kind: 'grant', allowed: source === activeWorker, config }, info.origin);
      if (now - info.seen >= 6500) workers.delete(source);
    }
  }
  // 课程页面协调播放器，同一时间只接管一个视频 iframe。
  window.addEventListener('message', event => {
    if (isZhidao || !chaoxingOrigin(event.origin) || event.data?.channel !== CHANNEL) return;
    if (window === window.top && isStudy && event.data.kind === 'worker') {
      if (!event.source || event.source === window || !locateFrame(event.source)) return;
      const frame = locateFrame(event.source);
      workers.set(event.source, { seen: Date.now(), ended: event.data.ended === true,
        quiz: event.data.quiz === true, origin: event.origin, frameSrc: frame.src,
        instance: String(event.data.instance || '').slice(0, 100), mediaKey: String(event.data.mediaKey || '').slice(0, 1000) });
      coordinate(Date.now(), settings());
      assignWorker(Date.now());
    } else if (window !== window.top && event.source === window.top && event.data.kind === 'grant') {
      const changed = granted !== (event.data.allowed === true) || JSON.stringify(workerConfig) !== JSON.stringify(event.data.config);
      workerConfig = event.data.config && typeof event.data.config === 'object' ? event.data.config : null;
      granted = event.data.allowed === true;
      grantUntil = Date.now() + 6500;
      if (changed) tick();
    }
  });
  function say(message) {
    if (message === lastMessage) return;
    lastMessage = message;
    console.info(isZhidao ? '[知到视频助手]' : '[学习通视频助手]', message);
    if (controls) renderPanel(message);
    if (window !== window.top) {
      window.top.postMessage({ channel: CHANNEL, message }, '*');
    }
  }

  // 只读取明确属于视频播放器的弹题层，不匹配作业或章节测验。
  function findQuiz(media) {
    return [...document.querySelectorAll('.ans-videoquiz')].find(root =>
      visible(root) && (root.closest('#video,.video-js') || isPlayer && media)
    ) || null;
  }
  function readQuiz(root, media) {
    const options = [...root.querySelectorAll('input[type="radio"]')].map((input, index) => {
      const label = [...(input.labels || [])].find(node => root.contains(node)) ||
        input.closest('label') || input.closest('.ans-videoquiz-opt,li') || input;
      const images = [...label.querySelectorAll('img')].map(image => image.getAttribute('src') || '').join('|');
      return { input, label, index, id: JSON.stringify([input.value, text(label), images]) };
    }).filter(option => visible(option.label) || visible(option.input));
    const titleNode = root.querySelector('.ans-videoquiz-des,.tkItem_title,[data-question-title]');
    const hint = text(root.querySelector('.tkTopic_title,[data-question-type]'));
    const unsupported = !!root.querySelector('input[type="checkbox"],textarea,input[type="text"]') ||
      /多选|填空|简答|问答|排序/.test(hint);
    const unique = new Set(options.map(option => option.id)).size === options.length;
    const singleGroup = new Set(options.map(option => option.input.name)).size <= 1;
    const key = JSON.stringify([media.currentSrc || media.src,
      root.getAttribute('data-question-id'), text(titleNode),
      [...(titleNode?.querySelectorAll('img') || [])].map(image => image.getAttribute('src')),
      options.map(option => option.id).sort()]);
    const submit = root.querySelector('#videoquiz-submit,.ans-videoquiz-submit,button[data-action="submit-videoquiz"]');
    return { root, key, options, submit, unsupported, unique, singleGroup };
  }
  function submitting(quiz) {
    return visible(quiz.root.querySelector('#videoquiz-submitting')) ||
      quiz.root.getAttribute('aria-busy') === 'true' || quiz.submit?.getAttribute('aria-busy') === 'true' ||
      quiz.submit?.getAttribute('data-loading') === 'true' ||
      /提交中|正在提交/.test(text(quiz.submit));
  }
  function ready(quiz) {
    return quiz.options.length >= 2 && quiz.options.every(option => enabled(option.input)) &&
      clickable(quiz.submit) && !submitting(quiz);
  }
  function feedbackText(node) {
    // innerText 排除同一结果容器中仍隐藏着的另一种反馈。
    return normalize(typeof node.innerText === 'string' ? node.innerText : node.textContent);
  }
  function feedbackKind(node) {
    const message = feedbackText(node);
    const visual = message || [...node.querySelectorAll('img,svg')].some(visible);
    if (visual && /^(spanNot|spanNotBack|spanNotBackPoint|videoquiz-error)$/.test(node.id)) return 'wrong';
    if (visual && node.matches('.ans-videoquiz-error,.videoquiz-error')) return 'wrong';
    if (visual && /^(spanHas|videoquiz-success)$/.test(node.id)) return 'right';
    if (node.matches(FEEDBACK)) {
      const result = node.getAttribute('data-videoquiz-feedback') || node.getAttribute('data-result') || node.getAttribute('data-status');
      if (/^(wrong|incorrect|error)$/i.test(result || '')) return 'wrong';
      if (/^(right|correct|success)$/i.test(result || '')) return 'right';
    }
    // 只识别答题结果用语，不把“请选择正确答案”等题干或一般播放器错误当作结果。
    if (/回答错误|回答不正确|答题错误|答题不正确|回答有误|回答不对|答案错误|答案不正确|选择错误|选项错误|选项不正确|答错(?:了)?/.test(message)) return 'wrong';
    if (/回答正确|答案正确|答题正确|答对(?:了)?|恭喜.{0,20}正确/.test(message)) return 'right';
    return '';
  }
  function genericFeedbackNode(node) {
    return !node.closest('button,a,.ans-videoquiz-opt,.ans-videoquiz-des,.tkItem_title,.tkTopic_title,.tkItem_ul,[data-question-title],.vjs-text-track-display,.vjs-control-bar') &&
      !node.querySelector('input,textarea,select,video,.ans-videoquiz-des,.tkItem_title,.tkTopic_title,[data-question-title]') &&
      feedbackText(node).length <= 160;
  }
  function feedbackNodes(root) {
    const scopes = [root, root.closest('#video,.video-js'), root.closest('.x-window,.vjs-modal-dialog')].filter(Boolean);
    const nodes = new Set();
    for (const scope of scopes) {
      for (const node of scope.querySelectorAll(FEEDBACK + ',div,span,p,[role="alert"],[role="status"],.tip,.tips,.feedback,.message,.result')) {
        if (node.matches(FEEDBACK) || genericFeedbackNode(node)) nodes.add(node);
      }
    }
    // 部分播放器把底部“回答错误”挂在弹题层和 video 容器外。
    if (isPlayer) {
      for (const node of document.querySelectorAll(FEEDBACK + ',div,span,p,[role="alert"],[role="status"]')) {
        if (node.matches(FEEDBACK) || genericFeedbackNode(node)) nodes.add(node);
      }
    }
    return [...nodes].filter(node => visible(node) && !node.closest('[aria-hidden="true"]') && feedbackKind(node));
  }
  function feedback(root) {
    const shown = feedbackNodes(root);
    const failure = shown.find(node => feedbackKind(node) === 'wrong');
    const success = shown.find(node => feedbackKind(node) === 'right');
    const kind = failure ? 'wrong' : success ? 'right' : '';
    return { kind, signature: JSON.stringify(shown.map(node => [node.id, feedbackKind(node), feedbackText(node)])), revision: feedbackRevision };
  }
  function retryButton(root) {
    return [...root.querySelectorAll('button,a,input[type="button"],.ans-videoquiz-retry,#videoquiz-retry,#videoquiz-reanswer,#videoquiz-continue')]
      .find(node => clickable(node) && (/重新作答|重新回答|重新答题|重新选择|返回答题|重试|再试一次/.test(text(node) || node.value) ||
        node.matches('.ans-videoquiz-retry,#videoquiz-retry,#videoquiz-reanswer'))) || null;
  }
  function block(state, message) {
    state.phase = 'blocked';
    state.message = message;
    say(message + '；请手动处理，或处理后点“重新检测”。');
  }
  function stateFor(quiz, now) {
    let state = states.get(quiz.key);
    if (!state) {
      state = { phase: 'ready', tried: new Set(), since: now, last: null };
      states.set(quiz.key, state);
      // 仅保存本次页面内的尝试记录。
      if (states.size > 100) states.delete(states.keys().next().value);
    }
    return state;
  }
  function handleQuiz(quiz, now) {
    const state = stateFor(quiz, now);
    current = state;
    if (state.phase === 'blocked') { say(state.message + '；请手动处理，或处理后点“重新检测”。'); return; }
    if (quiz.unsupported) { block(state, '这道视频弹题不是单选/判断题'); return; }
    if (!quiz.unique || !quiz.singleGroup) { block(state, '选项无法唯一识别，或同一弹窗有多道题'); return; }

    const result = feedback(quiz.root);
    if (state.phase === 'submitted') {
      const fresh = result.signature !== state.before.signature || result.revision > state.before.revision;
      if (result.kind && fresh && now - state.since >= SELECT_DELAY && !submitting(quiz)) {
        state.phase = result.kind === 'wrong' ? 'retry' : 'right';
        state.retryClicked = false;
        say(result.kind === 'wrong' ? '当前选项错误，准备尝试下一个。' : '平台反馈正确，等待继续播放。');
      } else if (now >= state.retryAt && !submitting(quiz)) {
        state.phase = 'retry';
        state.retryClicked = false;
        say('提交后 3 秒仍未继续播放，准备尝试下一个选项。');
      } else if (now - state.since > RESPONSE_TIMEOUT) {
        block(state, '提交控件一直处于忙碌状态');
      }
      if (state.phase !== 'retry') return;
    }
    if (state.phase === 'right' || state.phase === 'continuing') {
      const next = quiz.root.querySelector('#videoquiz-continue');
      if (state.phase === 'right' && clickable(next)) {
        state.phase = 'continuing';
        next.click();
        say('已点击平台的继续按钮。');
        return;
      }
      if (now >= state.retryAt && ready(quiz)) {
        state.phase = 'retry';
        state.retryClicked = false;
        say('提交后 3 秒仍未继续播放，准备尝试下一个选项。');
      } else if (now - state.since > RESPONSE_TIMEOUT) {
        block(state, '答题结果已显示，但弹题层仍未关闭');
      }
      if (state.phase !== 'retry') return;
    }
    if (state.phase === 'retry') {
      if (now < state.retryAt) return;
      if (!ready(quiz)) {
        const retry = retryButton(quiz.root);
        if (retry && !state.retryClicked && !submitting(quiz)) {
          state.retryClicked = true;
          state.since = now;
          retry.click();
          say('已点击重新作答，等待选项恢复。');
        } else if (now - state.since > RESPONSE_TIMEOUT) {
          block(state, '选错后没有恢复可重选的控件');
        }
        return;
      }
      state.phase = 'ready';
      state.since = now;
    }
    if (state.phase === 'selected') {
      if (now - state.since < SELECT_DELAY) return;
      if (!ready(quiz)) {
        if (now - state.since > RESPONSE_TIMEOUT) block(state, '选项已点击，但提交控件尚未就绪');
        return;
      }
      const selected = quiz.options.filter(option => option.input.checked);
      if (selected.length !== 1 || selected[0].id !== state.last) {
        block(state, '选中状态发生变化，停止自动提交'); return;
      }
      state.before = feedback(quiz.root);
      state.phase = 'submitted';
      state.since = now;
      state.retryAt = now + RETRY_AFTER;
      quiz.submit.click();
      say('已提交第 ' + state.tried.size + ' 个选项；3 秒未继续播放就换下一项。');
      return;
    }
    if (!ready(quiz)) {
      if (now - state.since > RESPONSE_TIMEOUT) block(state, '没有找到可用的单选题控件');
      return;
    }
    const choice = quiz.options.find(option => !state.tried.has(option.id));
    if (!choice) { block(state, '所有选项已经尝试过'); return; }
    state.tried.add(choice.id);
    state.last = choice.id;
    state.phase = 'selected';
    state.since = now;
    // 使用页面原有点击事件，保留平台的选择和提交逻辑。
    // 优先激活选项标签，兼容播放器在 label 上更新提交数据的事件。
    const target = choice.label.matches('label') && clickable(choice.label) ? choice.label : choice.input;
    target.click();
    say('选择第 ' + (choice.index + 1) + ' 项，准备提交。');
  }

  // 对反馈区域的变化计数，避免把上次残留的“回答错误”当作本次结果。
  function touchesFeedback(record) {
    const node = record.target.nodeType === 1 ? record.target : record.target.parentElement;
    if (node?.matches(FEEDBACK) || node?.closest(FEEDBACK)) return true;
    const inPlayer = node && (isPlayer || node.closest('#video,.video-js'));
    if (inPlayer && genericFeedbackNode(node) && feedbackKind(node)) return true;
    if (record.type === 'attributes' && node?.closest('.ans-videoquiz') && node.querySelector?.(FEEDBACK)) return true;
    return [...record.addedNodes, ...record.removedNodes].some(item => item.nodeType === 1 &&
      (item.matches(FEEDBACK) || item.querySelector(FEEDBACK) || inPlayer &&
        [item, ...item.querySelectorAll('div,span,p,[role="alert"],[role="status"]')].some(candidate => genericFeedbackNode(candidate) && feedbackKind(candidate))));
  }
  const observer = new MutationObserver(records => {
    if (records.some(touchesFeedback)) feedbackRevision++;
  });
  if (!isZhidaoShared) observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-hidden', 'data-result', 'data-status', 'data-videoquiz-feedback'] });

  function mediaKey(media) {
    if (!contentIds.has(media)) contentIds.set(media, nextContentId++);
    return contentIds.get(media) + '|' + (media.currentSrc || media.src || '');
  }
  function watchMedia(media) {
    if (watchedMedia.has(media)) return;
    watchedMedia.add(media);
    const wake = event => {
      if (event.type === 'emptied' && activationClicks.get(media)?.played) activationClicks.delete(media);
      const state = playback.get(media);
      if (!state?.pending && (!state?.manualRequired || state.source !== mediaKey(media))) playback.delete(media);
      lastPing = 0;
      tick();
    };
    for (const name of ['loadedmetadata', 'loadeddata', 'canplay', 'emptied', 'ended']) media.addEventListener(name, wake);
  }
  function activationFor(media) {
    const source = media.currentSrc || media.src || media.querySelector('source')?.src || '';
    let activation = activationClicks.get(media);
    if (!activation || activation.source && source && activation.source !== source) {
      activation = { source, clicked: false, played: false, clickedAt: 0 };
      activationClicks.set(media, activation);
    } else if (!activation.source && source) activation.source = source;
    return activation;
  }
  function clickToStart(media, state, now) {
    const activation = activationFor(media);
    if (activation.clicked || activation.played || !media.paused || media.ended || !visible(media) || findQuiz(media)) return false;
    const scope = media.closest('#video,.video-js') || media.parentElement;
    const button = [...(scope?.querySelectorAll('.vjs-big-play-button,.vjs-play-control.vjs-paused,button[aria-label="播放"],button[title="播放"]') || [])].find(clickable);
    const consume = () => { activation.clicked = true; activation.clickedAt = now; };
    if (button) {
      // 先记为已点击，防止点击同步触发加载事件后再次激活。
      consume(); state.usedButton = true;
      say('启动当前视频：点击播放器的播放按钮。');
      button.click();
      activation.played = !media.paused;
      return true;
    }
    const doc = media.ownerDocument, view = doc.defaultView;
    const bounds = media.getBoundingClientRect();
    if (bounds.width < 20 || bounds.height < 20) return false;
    const x = bounds.left + bounds.width / 2, y = bounds.top + bounds.height / 2;
    // 在播放器自己的文档中用实时 client 坐标找到视频中心，适配缩放和 iframe。
    const target = doc.elementFromPoint(x, y);
    if (!target || !scope?.contains(target) || target.closest('.ans-videoquiz,[role="dialog"],.vjs-control-bar,.vjs-menu,.vjs-error-display,.vjs-loading-spinner,button,a,input,textarea,select')) return false;
    consume();
    say('启动当前视频：按视频区域实际尺寸点击中心。');
    const event = type => new view.MouseEvent(type, { bubbles: true, cancelable: true, view,
      clientX: x, clientY: y, button: 0, buttons: type === 'mousedown' ? 1 : 0 });
    target.dispatchEvent(event('mousedown'));
    target.dispatchEvent(event('mouseup'));
    // mouseup 已启动时，不再发送可能将视频暂停的 click。
    if (media.paused && !media.ended && settings().enabled && !findQuiz(media)) target.dispatchEvent(event('click'));
    activation.played = !media.paused;
    return true;
  }
  function playMedia(media, now) {
    const source = mediaKey(media);
    let state = playback.get(media);
    if (!state || state.source !== source) {
      state = { source, lastAttempt: -Infinity, pending: false, failures: 0, usedButton: false };
      playback.set(media, state);
    }
    if (isZhidaoShared && state.manualRequired) { say('浏览器要求你点击播放器原有播放按钮；助手等待手动启动。'); return; }
    // 共享课直接调用普通媒体播放，不生成鼠标序列或读取页面内部播放器。
    if (!isZhidaoShared && clickToStart(media, state, now)) {
      startedMedia.add(media);
      if (!media.paused) say(settings().muted ? '视频静音播放中。' : '视频播放中。');
      return;
    }
    const activation = activationFor(media);
    if (activation.clicked && now - activation.clickedAt < SELECT_DELAY) return;
    if (media.readyState < 2 && !isZhidaoShared) { say('等待播放器加载，就绪后自动播放。'); return; }
    if (state.pending || now - state.lastAttempt < 1500) return;
    state.lastAttempt = now;
    startedMedia.add(media);
    if (!isZhidaoShared && state.failures && !state.usedButton) {
      const scope = media.closest('#video,.video-js') || media.parentElement;
      const button = [...(scope?.querySelectorAll('.vjs-big-play-button,.vjs-play-control.vjs-paused') || [])].find(clickable);
      if (button) { state.usedButton = true; button.click(); }
    }
    if (!media.paused) return;
    state.pending = true;
    say('正在启动视频播放。');
    const failed = error => {
      state.pending = false;
      if (isZhidaoShared && (state.cancelled || settings().manual || platformStopped)) return;
      state.failures++;
      if (isZhidaoShared && error?.name === 'NotAllowedError') state.manualRequired = true;
      if (!settings().enabled || playback.get(media) !== state || !media.isConnected) return;
      say(error?.name === 'NotAllowedError' ? '浏览器要求手动点击一次视频播放按钮。' : '视频暂未播放，等待播放器就绪后重试。');
    };
    try {
      Promise.resolve(media.play()).then(() => {
        state.pending = false;
        if (isZhidaoShared && (state.cancelled || settings().manual || !settings().enabled || platformStopped || zhidaoBlocker())) { media.pause(); return; }
        if (!settings().enabled || playback.get(media) !== state || !media.isConnected) return;
        if (!media.paused) {
          activationFor(media).played = true;
          if (isZhidaoShared && navigation.replay?.active) navigation.replay.starting = false;
          say(isZhidaoShared && navigation.replay?.active ? '正在第 ' + navigation.replay.count + ' 次重播当前视频，补足实际观看时长。' :
            settings().muted ? '视频静音播放中。' : '视频播放中。');
        }
      }, failed);
    } catch (error) { failed(error); }
  }
  // BEGIN SHARED SOURCE BACKEND 3.0.1
  // The playback loop below is extracted from zhihuishu_api.choice_function.
  function createSharedSourceBackend() {
    const page = typeof unsafeWindow === 'object' && unsafeWindow ? unsafeWindow : window;
    const proto = page.HTMLElement.prototype;
    const originalAdd = proto.addEventListener, originalRemove = proto.removeEventListener;
    const listeners = new WeakMap();
    const sourceJQuery = referenceJQuery;
    const popupRecords = new Set();
    let registeringPopup = false;
    const waits = new Set(), CANCEL = Symbol('source-loop-cancelled');
    let observing = true, installed = false, epoch = 0, job = null, pending = null;
    let fingerprint = '', fault = '', endedKey = '', replayKey = '', replays = 0, playPending = false, resetStamp;
    const tracked = node => node.matches?.('.topic-item,.btn,.nextButton,li.video') || !!node.closest?.('.topic-item');
    const loading = new Map();
    function watchLoading(media) {
      for (const [node, record] of loading) if (!node.isConnected) {
        for (const type of ['loadstart', 'emptied', 'loadedmetadata']) originalRemove.call(node, type, record.changed);
        loading.delete(node);
      }
      if (!media || loading.has(media)) return;
      const record = { version: 0, changed: () => record.version++ };
      for (const type of ['loadstart', 'emptied', 'loadedmetadata']) originalAdd.call(media, type, record.changed);
      loading.set(media, record);
    }
    const capture = options => typeof options === 'boolean' ? options : !!options?.capture;
    const jqueryProviders = () => [...new Set([sourceJQuery, page.$, page.jQuery, page.y$])].filter(jq => typeof jq === 'function' && typeof jq._data === 'function');
    const referencePopup = node => node.className === 'topic-item' || node.className === 'btn';
    function bindPopup(record) {
      if (!sourceJQuery || record.bound || !record.active) return;
      registeringPopup = true;
      try { sourceJQuery(record.node).on('click', record.wrapper); record.bound = true; }
      finally { registeringPopup = false; }
    }
    function unbindPopup(record) {
      if (record.bound) { sourceJQuery(record.node).off('click', record.wrapper); record.bound = false; }
    }
    function retire(record) {
      record.active = false; unbindPopup(record); popupRecords.delete(record);
      originalRemove.call(record.node, 'click', record.wrapper, record.capture);
    }
    function add(type, listener, options) {
      if (registeringPopup || !observing || type !== 'click' || !listener || !tracked(this)) return originalAdd.apply(this, arguments);
      // jQuery has already stored its handlers; do not register its dispatcher as another handler.
      if (jqueryProviders().some(jq => jq._data(this)?.handle === listener)) return originalAdd.apply(this, arguments);
      let records = listeners.get(this);
      if (!records) listeners.set(this, records = []);
      const prior = records.find(r => r.active && r.listener === listener && r.capture === capture(options));
      if (prior) return originalAdd.call(this, type, prior.wrapper, options);
      const node = this, record = { node: this, listener, capture: capture(options), once: !!options?.once, active: !options?.signal?.aborted, bound: false };
      record.wrapper = function(event) {
        if (!record.active) return;
        if (record.once) retire(record);
        return typeof listener === 'function' ? listener.call(this, event) : listener.handleEvent.call(listener, event);
      };
      records.push(record);
      if (referencePopup(node)) { popupRecords.add(record); bindPopup(record); }
      if (options?.signal) options.signal.addEventListener('abort', () => retire(record), { once: true });
      return originalAdd.call(node, type, record.wrapper, options);
    }
    function remove(type, listener, options) {
      const record = type === 'click' && listeners.get(this)?.find(r => r.active && r.listener === listener && r.capture === capture(options));
      if (record) { retire(record); return; }
      return originalRemove.apply(this, arguments);
    }
    function install() {
      observing = true;
      for (const record of popupRecords) if (record.active && record.node.isConnected) bindPopup(record);
      if (installed) {
        if (proto.addEventListener === originalAdd) proto.addEventListener = add;
        if (proto.removeEventListener === originalRemove) proto.removeEventListener = remove;
        return;
      }
      proto.addEventListener = add; proto.removeEventListener = remove; installed = true;
    }
    function restore() {
      observing = false;
      for (const record of popupRecords) unbindPopup(record);
      if (proto.addEventListener === add) proto.addEventListener = originalAdd;
      if (proto.removeEventListener === remove) proto.removeEventListener = originalRemove;
    }
    function pauseOwned() {
      const media = zhidaoMedia();
      if (media && startedMedia.has(media) && !media.paused) media.pause();
    }
    function stop(restoreHooks = false) {
      epoch++;
      for (const wait of waits) { clearTimeout(wait.id); wait.reject(CANCEL); }
      waits.clear(); job = null; playPending = false;
      if (restoreHooks) restore();
    }
    function fail(message, error) {
      fault = message; navigation.halted = true; navigation.pending = false;
      pending = null; clearSessionTransfer(); stop(); pauseOwned(); say(message);
      if (error) console.warn('[视频助手：参考执行核心]', error);
    }
    function quizRoot() { return settings().autoQuiz ? videoQuizRoots()[0] || null : null; }
    function canRun() {
      const config = settings();
      if (!config.enabled || config.manual || platformStopped || sharedRefreshPending || fault) return false;
      if (platformScriptAlert()) { stopForPlatformAlert(); return false; }
      const root = quizRoot();
      return !sharedInteractionBlocked(root);
    }
    function callbackFor(node) {
      for (const jq of [page.$, page.jQuery, page.y$]) {
        try {
          const events = jq?._data?.(node, 'events') || jq?._data?.(node)?.events;
          const click = events?.click?.filter(item => !item.selector && typeof item.handler === 'function');
          const item = click?.[1] || click?.[0];
          if (item) return { node, callback: item.handler };
        } catch {}
      }
      const click = listeners.get(node)?.filter(record => record.active && !record.capture) || [];
      const record = click[1] || click[0];
      if (record) return { node, callback: record.listener, listenerRecord: record };
      return typeof node.onclick === 'function' ? { node, callback: node.onclick } : null;
    }
    function markPending(targetKey = '', label = '') {
      const media = zhidaoMedia();
      watchLoading(media);
      pending = { media, content: media && mediaKey(media), key: zhidaoUniqueKey(zhidaoCurrent()), since: Date.now(), targetKey,
        loadVersion: loading.get(media)?.version || 0, sent: false, label };
      navigation.pending = true; navigation.halted = false; navigation.targetKey = targetKey;
      transferSession({ schema: 2, reason: 'shared-navigation', resumeOnReload: true, targetKey });
    }
    function resolve(selector) {
      if (!canRun()) throw CANCEL;
      let node, phase = '';
      if (selector === '.topic-item' || selector === 'div.btn') {
        const root = quizRoot();
        if (!root) return null;
        node = root.querySelector(selector); phase = selector === '.topic-item' ? 'selected' : 'closed';
        if (!node || locked(node)) throw new Error('参考脚本的弹题控件尚未就绪，请刷新页面后重新检测。');
        const provider = jqueryProviders().find(jq => jq._data(node)?.events?.click?.length);
        if (!provider) throw new Error('尚未登记参考脚本的弹题点击处理器，请刷新页面重新收集。');
        const click = provider._data(node)?.events?.click;
        // Same lookup order as the reference true_click: index 1, then index 0.
        const callback = click?.[1]?.handler || click?.[0]?.handler;
        if (typeof callback !== 'function') throw new Error('尚未登记参考脚本的弹题点击处理器，请刷新页面重新收集。');
        return { node, callback, phase, referencePopup: true };
      } else if (selector === '.nextButton') {
        if (pending || !settings().autoNext || !settings().continuous) return null;
        const rows = zhidaoFiles(), current = zhidaoCurrent(), index = rows.indexOf(current), target = rows[index + 1];
        if (index < 0) throw new Error('当前目录项尚未确定，请等待目录加载后重新检测。');
        if (!target) throw new Error('当前目录已到最后一个视频，无需继续切节。');
        if (locked(target) || target.closest('[aria-disabled="true"],.locked,.disabled,.lock,[data-locked="true"]')) throw new Error('下一视频尚未开放，请手动检查课程要求。');
        const targetKey = zhidaoUniqueKey(target);
        if (!targetKey) throw new Error('下一视频无法唯一识别，请手动检查目录。');
        const directory = callbackFor(target);
        if (directory) return { ...directory, phase: 'next', targetKey, label: zhidaoFileLabel(target), directory: true };
        node = document.querySelector(selector);
        if (!node) throw new Error('原脚本的下一节入口 .nextButton 不存在，请手动处理。');
        if (locked(node)) throw new Error('原页面控件尚未开放，请手动处理。');
        return { ...(callbackFor(node) || { node }), phase: 'next', targetKey, label: zhidaoFileLabel(target) };
      } else throw new Error('参考执行核心请求了未适配的控件。');
      if (!node || locked(node)) throw new Error('原页面控件尚未开放，请手动处理。');
      return { ...(callbackFor(node) || { node }), phase };
    }
    function invoke(action, input, core) {
      if (!canRun()) throw CANCEL;
      if (action.referencePopup && typeof action.callback !== 'function') throw new Error('弹题处理器未登记，等待刷新重新收集。');
      if (action.phase === 'next') {
        if (pending) return;
        markPending(action.targetKey, action.label);
        const request = pending, run = epoch;
        if (request.media && !request.media.paused) { startedMedia.add(request.media); request.media.pause(); }
        say('正在切换到：' + action.label + '。已暂停当前视频，等待页面切换。');
        // Allow the player's pause event/state to settle before selecting the next lesson.
        core.sleep(250).then(() => {
          if (pending !== request || run !== epoch || !canRun() || !settings().autoNext || !settings().continuous) return;
          if (zhidaoUniqueKey(zhidaoCurrent()) !== request.key) return;
          if (!action.node.isConnected || locked(action.node)) throw new Error('切节入口已经变化，请重新检测。');
          request.sent = true; request.since = Date.now();
          fire(action, input, core);
        }).catch(error => { if (error !== CANCEL && run === epoch && pending === request && settings().enabled && !platformStopped) fail(error?.message || '下一视频切换失败，请手动检查。', error); });
        return;
      }
      return fire(action, input, core);
    }
    function fire(action, input, core) {
      if (!canRun()) throw CANCEL;
      if (action.phase === 'selected') say('已选择一个选项，使用原脚本关闭弹题。');
      if (action.phase === 'closed') say('已点击视频弹题关闭入口，等待原页面继续。');
      const result = action.callback ? (() => {
        if (action.listenerRecord?.once) {
          action.listenerRecord.active = false;
          originalRemove.call(action.node, 'click', action.listenerRecord.wrapper, action.listenerRecord.capture);
        }
        return typeof action.callback === 'function' ? action.callback.call(action.node, input) : action.callback.handleEvent.call(action.callback, input);
      })() : core.dispatchClicks(action.node);
      const run = epoch;
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(error => { if (run === epoch && settings().enabled && !platformStopped) fail('原页面点击处理器返回失败，请手动检查。', error); });
      return result;
    }
    function collection(nodes, selector = '') {
      const list = [...nodes];
      list.find = child => {
        if (selector === '.current_play' && (pending || !settings().autoNext || !settings().continuous)) return collection([]);
        if (selector === '.current_play' && child === '.time_icofinish' && !list.some(row => zhidaoFinishedIcon(row))) return collection([]);
        return collection(list.flatMap(node => [...node.querySelectorAll(child)]));
      };
      return list;
    }
    function query(selector) {
      if (selector === 'video') return collection(zhidaoMedia() ? [zhidaoMedia()] : []);
      if (selector === '.current_play') return collection(zhidaoCurrent() ? [zhidaoCurrent()] : [], selector);
      if (selector === '.topic-item') {
        const root = !pending && quizRoot();
        return collection(root ? [...root.querySelectorAll(selector)].filter(visibleZhidaoPrompt) : []);
      }
      return collection(document.querySelectorAll(selector));
    }
    function coreFor(run) {
      const _this = page, $ = query;
      const GM_getValue = key => key === 'resource_farming_main_state' && run === epoch && settings().enabled && !settings().manual;
      const host = {
        resolve, invoke, config: settings,
        sleep(delay) {
          if (run !== epoch || !canRun()) return Promise.reject(CANCEL);
          return new Promise((resolve, reject) => {
            const wait = { reject, id: null };
            wait.id = setTimeout(() => { waits.delete(wait); run === epoch && canRun() ? resolve() : reject(CANCEL); }, delay);
            waits.add(wait);
          });
        }
      };
      const ablePlayerX = id => ({ play() {
        if (run !== epoch || !canRun()) throw CANCEL;
        if (pending || playPending) return;
        const media = zhidaoMedia(), config = settings();
        if (!media) return;
        const complete = !!zhidaoCurrent() && zhidaoFinishedIcon(zhidaoCurrent());
        if (media.ended && (!config.continuous || complete && !config.autoNext)) {
          endedKey = mediaKey(media); say(config.continuous ? '当前视频已结束，自动下一任务点已关闭。' : '当前视频已结束，自动连播已关闭。');
          throw CANCEL;
        }
        if (typeof page.ablePlayerX !== 'function') throw new Error('原脚本播放器 ablePlayerX 尚未就绪，请重新检测或刷新页面。');
        const player = page.ablePlayerX.call(page, id);
        if (typeof player?.play !== 'function') throw new Error('原脚本播放器未提供 play，请重新检测。');
        const atEnd = media.ended && !complete, playSource = mediaKey(media), playTaskKey = zhidaoUniqueKey(zhidaoCurrent()), request = {};
        startedMedia.add(media); playPending = request;
        const result = player.play.call(player);
        Promise.resolve(result).then(() => {
          if (playPending === request) playPending = false;
          if (run !== epoch || !settings().enabled || settings().manual || platformStopped) { if (media.isConnected && mediaKey(media) === playSource && !media.paused) media.pause(); return; }
          if (pending && (media === pending.media || mediaKey(media) === pending.content)) { if (!media.paused) media.pause(); return; }
          if (playTaskKey && zhidaoUniqueKey(zhidaoCurrent()) !== playTaskKey) return;
          if (media.paused) { say('原脚本已请求播放，等待播放器就绪。'); return; }
          if (atEnd) { replayKey = mediaKey(media); replays++; }
          say(replayKey === mediaKey(media) ? '正在第 ' + replays + ' 次重播当前视频，等待平台确认观看完成。' : config.muted ? '视频静音播放中。' : '视频播放中。');
        }, error => { if (playPending === request) playPending = false; if (run === epoch && !pending && zhidaoUniqueKey(zhidaoCurrent()) === playTaskKey) fail('原脚本播放入口未能启动，请点击原播放器后重新检测。', error); });
      } });

      class zhihuishu_api {
 sleep = delay => host.sleep(delay);
dispatchClicks = function (el){
            if(!el) return false;
            try{
                // 计算元素中心点坐标
                const r = el.getBoundingClientRect();
                const centerX = r.left + r.width/2;
                const centerY = r.top + r.height/2;

                // 模拟完整的鼠标事件序列
                const events = ['pointerdown','mousedown','click','mouseup'];
                for(const type of events){
                const evt = new MouseEvent(type, {
                    bubbles:true,
                    cancelable:true,
                    clientX:centerX,
                    clientY:centerY,
                    view:_this
                });
                el.dispatchEvent(evt);
                }
                return true;
            }catch(e){console.log(e) ;return false}
        }
        true_click=function(ele){
          const action = host.resolve(ele);
          if (!action) return;
          const dom = action.node;
          const event = new MouseEvent("click", { view: _this, bubbles: true, cancelable: true });
          const wrapevent = new Proxy(event, { get(target, property) {
            if (property === 'isTrusted') return true;
            if (!action.referencePopup && (property === 'target' || property === 'currentTarget')) return dom;
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          } });
          const c = _this.c;
          const inputevent = action.referencePopup ? { originalEvent: wrapevent, target: { value: { normalize: function(){ return "-"+c; } } } } :
            { originalEvent: wrapevent, target: dom, currentTarget: dom, isTrusted: true, type: 'click',
              preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation(),
              stopImmediatePropagation: () => event.stopImmediatePropagation() };
          return host.invoke(action, inputevent, this);
        }
async choice_function(){
            if(!GM_getValue("resource_farming_main_state")){
                return
            }
            for(let i=10;i;i--){
                await this.sleep(1000)
                if($("video").length&&$("video")[0].duration){
                    console.log("视频加载")
                    $("video")[0].muted = host.config().muted;
                    while(1){
                        if($(".current_play").find(".time_icofinish").length){
                            console.log("视频播放结束")
                            this.true_click(".nextButton")
                            return this.choice_function()
                            break;
                        }
                        if($(".topic-item").length){
                            console.log("检测到题目")
                            this.true_click(".topic-item")
                            this.true_click("div.btn")
                        }
                        ablePlayerX('container').play()
                        await this.sleep(1000)
                    }
                    break;
                }
            }
        }
        
}

      return new zhihuishu_api();
    }
    function pump() {
      for (const record of popupRecords) if (!record.node.isConnected) { unbindPopup(record); popupRecords.delete(record); }
      const media = zhidaoMedia(), config = settings();
      watchLoading(media);
      if (pending && (!config.enabled || config.manual || !config.autoNext || !config.continuous || !pending.sent && !canRun())) {
        pending = null; navigation.pending = false; navigation.targetKey = ''; clearSessionTransfer(); stop();
      }
      if (resetStamp !== undefined && resetStamp !== config.reset) { stop(); fault = ''; endedKey = ''; navigation.halted = false; }
      resetStamp = config.reset;
      if (navigation.halted && !fault) return;
      const nextFingerprint = (media ? mediaKey(media) : '') + '|' + config.reset + '|' + config.autoNext + '|' + config.continuous + '|' + config.autoQuiz;
      if (fingerprint !== nextFingerprint) {
        fingerprint = nextFingerprint; stop(); fault = ''; endedKey = ''; navigation.halted = false;
        if (replayKey && media && replayKey !== mediaKey(media)) { replayKey = ''; replays = 0; }
      }
      if (pending) {
        const key = zhidaoUniqueKey(zhidaoCurrent());
        const ready = media && media.readyState >= 2 && !!(media.currentSrc || media.src);
        const sourceChanged = media && (media !== pending.media || mediaKey(media) !== pending.content || (loading.get(media)?.version || 0) > pending.loadVersion);
        const changed = ready && sourceChanged && key !== pending.key;
        if (changed && (!pending.targetKey || pending.targetKey === key)) { pending = null; navigation.pending = false; clearSessionTransfer(); }
        else {
          if (media && !media.paused) media.pause();
          if (Date.now() - pending.since > RESPONSE_TIMEOUT) {
            const reason = key === pending.key ? '目录未切换，视频没有更新' : !sourceChanged ? '目录已切换，但视频没有更新' : '新视频尚未就绪';
            fail('切节未确认：' + reason + '。已停止重复点击，请手动检查。'); return;
          }
          say('正在切换到：' + (pending.label || '所选视频') + '。等待目录与新视频就绪。');
          return;
        }
      }
      if (!config.enabled || config.manual) { stop(); if (config.started && !config.manual) pauseOwned(); return; }
      if (fault) { say(fault); return; }
      if (!canRun()) { stop(); pauseOwned(); say(zhidaoBlockerMessage()); return; }
      if (media && media.muted !== config.muted) media.muted = config.muted;
      if (endedKey && media && endedKey === mediaKey(media) && media.ended) return;
      if (job) return;
      install(); const run = ++epoch, core = coreFor(run);
      say('原脚本执行核心正在等待视频加载。');
      const task = core.choice_function(); job = task;
      Promise.resolve(task).catch(error => {
        if (error !== CANCEL && run === epoch) fail(error?.message || '原脚本执行核心发生错误，请重新检测。', error);
      }).finally(() => { if (job === task) job = null; });
    }
    return { install, stop, pump, pauseOwned, directoryClick(target) { markPending(zhidaoUniqueKey(target), zhidaoFileLabel(target)); pending.sent = true; }, restore };
  }
  // END SHARED SOURCE BACKEND 3.0.1

  function tick() {
    const config = settings();
    const now = Date.now();
    if (isZhidaoShared) syncVideoQuizzes();
    if (isZhidao) {
      if (platformScriptAlert()) { stopForPlatformAlert(); return; }
      platformAlertActive = false;
      if (platformStopped) { renderPanel(); return; }
    }
    if (isZhidaoShared && window === window.top && config.enabled && courseSessionId() !== loadedCourse) {
      coordinateSharedRefresh(now, config);
      const media = zhidaoMedia();
      if (media && startedMedia.has(media) && !media.paused) media.pause();
      return;
    }
    if (isZhidaoShared && window === window.top) {
      handleVideoQuizPresentation(config);
      renderPanel(undefined, config);
      if (config.manual) { sharedSourceBackend.stop(); return; }
      if (coordinateSharedRefresh(now, config)) { sharedSourceBackend.stop(); if (navigation.halted) sharedSourceBackend.pauseOwned(); return; }
      sharedSourceBackend.pump();
      return;
    }
    handleVideoQuizPresentation(config);
    // 关闭共享课自动播放时仅更新面板、计时和提示。
    if (config.manual) { renderPanel(undefined, config); return; }
    if (resetVersion !== config.reset) {
      states.clear(); current = null; resetVersion = config.reset;
      if (isZhidaoShared) for (const media of document.querySelectorAll('video')) {
        if (playback.get(media)?.manualRequired) playback.delete(media);
      }
      for (const root of videoQuizRoots()) sourceQuizStates.delete(root);
      navigation.key = ''; navigation.pending = false; navigation.halted = false;
      lastMessage = '';
    }
    if (controls) renderPanel(undefined, config);
    if (coordinateSharedRefresh(now, config)) {
      if (navigation.halted) {
        const media = zhidaoMedia();
        if (media && startedMedia.has(media) && !media.paused) media.pause();
      }
      return;
    }
    const sourceQuizMessage = handleSourceVideoQuiz(elapsedTime(now), config);
    if (sourceQuizMessage) {
      const media = zhidaoMedia();
      if (media && startedMedia.has(media) && !media.paused && !sourceQuizMessage.allowPlayback) media.pause();
      say(sourceQuizMessage.message); return;
    }
    if (window === window.top && isStudy) {
      if (isZhidao) coordinateZhidao(now, config);
      else { coordinate(now, config); assignWorker(now); }
    }
    const media = isZhidao ? zhidaoMedia() : document.querySelector('#video_html5_api,#video video,video');
    if (!media || !isPlayer && !media.closest('#video,.video-js')) return;
    watchMedia(media);
    // 即使未启动，也登记新播放器；课程页会下发本页会话的启动状态。
    if (window !== window.top && now - lastPing >= 1800) {
      lastPing = now;
      window.top.postMessage({ channel: CHANNEL, kind: 'worker', instance, mediaKey: mediaKey(media),
        ended: media.ended, quiz: !!findQuiz(media) }, '*');
    }
    if (!config.enabled) {
      if (config.started && !media.paused && (!isZhidaoShared || startedMedia.has(media))) media.pause();
      if (config.started && !pausedAt) pausedAt = now;
      say(config.started ? '助手已暂停。' : '点击“开始助手”后自动播放当前视频。'); return;
    }
    if (isZhidao && zhidaoBlocker()) {
      if (startedMedia.has(media) && !media.paused) media.pause();
      say(zhidaoBlockerMessage()); return;
    }
    if (media.muted !== config.muted) media.muted = config.muted;
    if (pausedAt) {
      for (const state of states.values()) {
        state.since += now - pausedAt;
        if (state.retryAt) state.retryAt += now - pausedAt;
      }
      pausedAt = 0;
    }
    if (window !== window.top) {
      if (!granted || now > grantUntil) {
        if (startedMedia.has(media) && !media.paused) media.pause();
        return;
      }
    } else if (isStudy && (navigation.pending || navigation.halted)) {
      if (startedMedia.has(media) && !media.paused) media.pause();
      return;
    }
    const root = findQuiz(media);
    if (root) {
      const quiz = readQuiz(root, media);
      const state = states.get(quiz.key);
      // 播放器已经恢复时，不因弹题层移除稍有延迟而再次暂停或换选项。
      if (state && /^(submitted|retry|right|continuing|resumed)$/.test(state.phase) && !media.paused && !media.ended && media.readyState >= 2) {
        state.phase = 'resumed';
        say(config.muted ? '视频静音播放中。' : '视频播放中。');
        return;
      }
      if (state?.phase === 'resumed') {
        state.phase = 'submitted';
        state.since = now;
        state.retryAt = now + RETRY_AFTER;
      }
      if (!media.paused) media.pause();
      handleQuiz(quiz, now);
      return;
    }
    if (current) {
      // 平台关闭弹题后才恢复播放；若稍后又弹出同题，继续保留已试选项。
      if (current.phase !== 'blocked') { current.phase = 'ready'; current.since = now; }
      current = null;
      say('视频弹题已关闭。');
    }
    if (media.ended) {
      if (window !== window.top || !isStudy) say(config.continuous ? '当前视频已结束，等待连播或任务点切换。' : '当前视频已结束，自动连播已关闭。');
      return;
    }
    if (!visible(media)) return;
    if (!media.paused) {
      if (isZhidaoShared) startedMedia.add(media);
      activationFor(media).played = true;
      say(isZhidaoShared && navigation.replay?.active ? '正在第 ' + navigation.replay.count + ' 次重播当前视频，补足实际观看时长。' :
        config.muted ? '视频静音播放中。' : '视频播放中。'); return;
    }
    playMedia(media, now);
  }

  const icon = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const icons = {
    play: icon('<path d="m9 5 11 7-11 7Z"/>'),
    pause: icon('<path d="M8 5v14M16 5v14"/>'),
    volume: icon('<path d="m11 4-6 5H2v6h3l6 5Z"/><path d="m16 9 5 6m0-6-5 6"/>'),
    repeat: icon('<path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-1v2a3 3 0 0 1-3 3H3"/>'),
    next: icon('<path d="m4 5 10 7L4 19ZM19 5v14"/>'),
    reset: icon('<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/>'),
    moon: icon('<path d="M20.8 13A9 9 0 0 1 11 3.2 9 9 0 1 0 20.8 13Z"/>'),
    sun: icon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>'),
    minimize: icon('<path d="M5 12h14"/>'),
    expand: icon('<path d="m7 14 5-5 5 5"/>'),
    position: icon('<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><circle cx="12" cy="12" r="2"/>')
  };
  function panelState(message, config) {
    if (platformStopped) return { tone: 'attention', title: platformAlertActive ? '平台要求停用助手' : '上次运行已停止', badge: platformAlertActive ? '已停止' : '待检查' };
    if (config.manual && !config.started) return { tone: 'waiting', title: '共享课手动辅助', badge: '未计时' };
    if (config.manual && !config.enabled) return { tone: 'paused', title: '统计已暂停', badge: '已暂停' };
    if (config.manual) return { tone: 'waiting', title: '共享课手动辅助', badge: '计时中' };
    if (!config.started) return { tone: 'waiting', title: '准备开始', badge: '未启动' };
    if (!config.enabled) return { tone: 'paused', title: '助手已暂停', badge: '已暂停' };
    if (/当前目录已到最后一个视频/.test(message)) return { tone: 'waiting', title: '已到最后一个视频', badge: '无后续' };
    if (/视频弹题已收起/.test(message)) return { tone: 'attention', title: '视频弹题已收起', badge: '待作答' };
    if (/停止|未识别|没有识别|未登记|未能启动|不是单选|所有选项|无法|尚未开放|手动|非视频任务|测验或作业|发生变化|尚未确认/.test(message)) {
      return { tone: 'attention', title: '需要你处理', badge: '待处理' };
    }
    if (/切换到/.test(message)) return { tone: 'working', title: '切换任务点', badge: '切换中' };
    if (/正在刷新学习页/.test(message)) return { tone: 'working', title: '刷新学习页', badge: '初始化' };
    if (/刷新后正在等待/.test(message)) return { tone: 'working', title: '恢复任务点', badge: '恢复中' };
    if (/跳过章节测验/.test(message)) return { tone: 'working', title: '跳过章节测验', badge: '切换中' };
    if (/主內容持續空白/.test(message)) return { tone: 'waiting', title: '空白頁確認中', badge: '確認中' };
    if (/暂无内容/.test(message)) return { tone: 'waiting', title: '空章节确认中', badge: '确认中' };
    if (/选择第|已选择一个选项|已点击选项|已点击视频弹题关闭入口|等待视频弹题控件|等待视频弹题选项|已提交|当前选项错误|重新作答|平台反馈正确|继续按钮|3 秒/.test(message)) {
      return { tone: 'working', title: '处理视频弹题', badge: '弹题中' };
    }
    if (/正在第 \d+ 次重播/.test(message)) return { tone: 'playing', title: '补足观看时长', badge: '重播中' };
    if (/平台观看进度为/.test(message)) return { tone: 'waiting', title: '等待进度确认', badge: '确认中' };
    if (/播放中/.test(message)) return { tone: 'playing', title: '视频播放中', badge: '播放中' };
    if (/已结束/.test(message)) return { tone: 'waiting', title: '当前视频已结束', badge: '已结束' };
    return { tone: 'waiting', title: /检测/.test(message) ? '正在重新检测' : '等待当前视频', badge: '等待中' };
  }
  function renderPanel(message, config = settings()) {
    if (!controls) return;
    if (typeof message === 'string') panelMessage = message;
    const state = panelState(panelMessage, config);
    const previousTone = controls.card.dataset.tone;
    const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
    controls.card.dataset.tone = state.tone;
    controls.compact.dataset.tone = state.tone;
    if (state.tone === 'attention' && previousTone !== state.tone) controls.body.scrollTop = 0;
    setText(controls.statusTitle, state.title);
    setText(controls.badge, state.badge);
    setText(controls.compact, state.badge);
    setText(controls.status, platformStopped ? platformAlertActive ? PLATFORM_STOP_MESSAGE : stopInspectionMessage || REMEMBERED_STOP_MESSAGE : config.manual ?
      (config.started ? panelMessage.replace(/计时/g, '统计') : '共享课手动辅助；统计实际播放，视频由你操作。') :
      !config.started ? '点击“开始助手”，自动播放当前视频。' : config.enabled ? panelMessage : '自动操作已暂停，点击“继续助手”恢复。');
    const toggleLabel = platformStopped ? platformAlertActive ? '已停止' : '检查页面' : config.manual ?
      (config.enabled ? '暂停统计' : config.started ? '继续统计' : '开始统计') : config.enabled ? '暂停助手' : config.started ? '继续助手' : '开始助手';
    setText(controls.toggleText, toggleLabel);
    setText(controls.compactToggleText, toggleLabel);
    for (const button of [controls.toggle, controls.compactToggle]) { button.title = toggleLabel; button.disabled = platformStopped && platformAlertActive; }
    controls.reset.disabled = false;
    setText(controls.resetText, platformStopped ? '检查页面' : '重新检测');
    if (controls.showQuiz) {
      const hasCollapsedQuiz = !!collapsedVideoQuiz();
      controls.showQuiz.hidden = controls.compactShowQuiz.hidden = !hasCollapsedQuiz;
      controls.showQuiz.disabled = controls.compactShowQuiz.disabled = platformStopped;
    }
    if (controls.manualPlay) {
      const media = zhidaoMedia();
      controls.manualPlay.hidden = !config.manual;
      controls.manualPlay.disabled = platformStopped || !media;
      controls.locateNext.disabled = platformStopped;
      setText(controls.manualPlay, media && !media.paused ? '暂停当前视频' : '播放当前视频');
    }
    renderViewingTime();
    const mode = config.enabled ? 'pause' : 'play';
    if (controls.toggleIcon.dataset.mode !== mode) {
      controls.toggleIcon.dataset.mode = mode;
      controls.toggleIcon.innerHTML = icons[mode];
    }
    for (const key of isZhidaoShared ? ['autoPlay', 'muted', 'continuous', 'autoNext', 'autoQuiz', 'hideQuiz'] : ['muted', 'continuous', 'autoNext']) {
      controls[key].checked = config[key];
      controls[key].disabled = platformStopped || config.manual && key !== 'muted' && key !== 'autoPlay' || key === 'hideQuiz' && config.autoQuiz;
      const pending = key === 'autoNext' && config.autoNext && !config.continuous;
      setText(controls[key + 'State'], config.manual && key !== 'muted' && key !== 'autoPlay' ? '手动模式' :
        key === 'hideQuiz' && config.autoQuiz ? '自动优先' : pending ? '待连播' : '');
      controls[key + 'State'].dataset.pending = String(pending);
    }
    if (isZhidaoShared) {
      setText(controls.mutedHint, config.manual ? '点击开关调整当前视频声音' : '开始时静音，关闭后恢复声音');
      setText(controls.continuousHint, config.manual ? '手动模式下暂停自动连播' : '播放结束后继续后续视频');
      setText(controls.footerText, config.manual ? '手动辅助 · 偏好自动保存' : '偏好自动保存');
    }
    setText(controls.nextHint, config.manual ? '定位后，请在原生目录点击下一视频' : !config.continuous && config.autoNext ?
      '连播已关闭，此项暂不生效' : isZhidaoShared ? config.nativeRefresh ? '启用后刷新一次，之后自动切节' : '当前任务完成后进入下一节' : isZhidao ? '视频完成后进入目录中的下一视频' : '视频完成后继续，跳过章节测验');
  }
  function loadUIFonts() {
    if (typeof FontFace !== 'function' || !document.fonts) return;
    const files = [{"family":"Geist","data":"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"},{"family":"Geist Mono","data":"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"}];
    for (const file of files) {
      if ([...document.fonts].some(face => face.family.replaceAll('"', '') === file.family)) continue;
      try { const face = new FontFace(file.family, 'url(data:font/woff2;base64,' + file.data + ')', { weight: '100 900', style: 'normal' }); document.fonts.add(face); face.load().catch(() => {}); } catch {}
    }
  }
  function buildPanel() {
    const subscriptionURL = 'https://raw.githubusercontent.com/kylezheng320-sudo/course-video-helper/main/subscribe.user.js';
    const releaseNotesURL = 'https://github.com/kylezheng320-sudo/course-video-helper/blob/main/CHANGELOG.md';
    if (window !== window.top || !document.body) return;
    loadUIFonts();
    const saved = GM_getValue(UI_KEY, {}) || {};
    const ui = { theme: saved.theme === 'dark' ? 'dark' : 'light', collapsed: true,
      position: session.started && Number.isFinite(saved.position?.left) && Number.isFinite(saved.position?.top) ? saved.position : null };
    const saveUI = () => GM_setValue(UI_KEY, ui);
    panel = document.createElement('div');
    panel.id = 'local-chaoxing-video-helper-panel';
    panel.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;width:352px;max-width:calc(100vw - 24px)';
    const shadow = panel.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
:host{font:14px/1.5 "Geist","Microsoft YaHei",sans-serif;text-align:left;letter-spacing:0}
*{box-sizing:border-box}button,input{font:inherit}button{cursor:pointer}svg{width:18px;height:18px;display:block;flex-shrink:0}[hidden]{display:none!important}
.shell{--bg:#fff;--ink:#0a0a0a;--sub:#636363;--border:#e6e6e6;--soft:#f8f8f8;--control:#d4d4d4;--accent:#141414;--on-ink:#fff;--focus:#1d5fbf;--green:#276f45;--blue:#1d5fbf;--amber:#8f5b12;--amber-bg:#fffbeb;--off:#d4d4d4;--knob:#fff;
  font-family:"Geist","Microsoft YaHei",sans-serif;color:var(--ink);background:var(--bg);border:1px solid var(--border);border-radius:8px;max-height:calc(100vh - 24px);max-height:calc(100dvh - 24px);display:flex;flex-direction:column;overflow:hidden;color-scheme:light}
.shell[data-theme=dark]{--bg:#151515;--ink:#f2f2f2;--sub:#b0b0b0;--border:#303030;--soft:#202020;--control:#505050;--accent:#f0f0f0;--on-ink:#151515;--focus:#9cbbec;--green:#9ac8a9;--blue:#a8c5f4;--amber:#e9c082;--amber-bg:#2b2419;--off:#505050;--knob:#fff;color-scheme:dark}
.header{display:flex;align-items:center;gap:12px;min-height:64px;padding:14px 20px;border-bottom:1px solid var(--border);cursor:grab;touch-action:none;flex-shrink:0}
.header:active{cursor:grabbing}.header:focus-visible{outline:2px solid var(--focus);outline-offset:-3px}
.logo{display:grid;place-items:center;width:22px;height:24px;flex:none;color:var(--ink)}.logo svg{width:22px;height:22px}
.brand{flex:1;min-width:0}.brand h1{display:block;margin:0;font-size:16px;font-weight:500;line-height:22px;letter-spacing:0}.brand small{display:block;margin-top:1px;color:var(--sub);font-size:12px;line-height:18px;white-space:nowrap}
.tools{display:flex;gap:2px;flex:none}.icon-button{display:grid;place-items:center;width:30px;height:32px;border:0;border-radius:6px;background:transparent;color:var(--sub);padding:0;touch-action:manipulation}
.icon-button:hover{background:var(--soft);color:var(--ink)}button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}button:disabled{cursor:default;color:var(--sub);background:var(--soft);border-color:var(--control)}
.body{padding:20px;overflow-y:auto;overscroll-behavior:contain;min-height:0;scrollbar-width:thin;scrollbar-color:var(--control) transparent}
.status-card{padding:0;background:transparent}.status-heading{display:flex;align-items:center;gap:10px;min-height:28px}.status-heading strong{font-size:22px;font-weight:500;line-height:30px;flex:1;letter-spacing:-.025em}.dot{width:6px;height:6px;border-radius:50%;background:var(--sub);flex:none}.badge{display:none}
.status-card[data-tone=playing] .dot{background:var(--green)}.status-card[data-tone=working] .dot{background:var(--blue)}.status-card[data-tone=attention] .dot{background:var(--amber)}
#status{font-size:14px;line-height:22px;color:var(--sub);margin:6px 0 0;overflow-wrap:anywhere}.status-card[data-tone=attention] #status{color:var(--amber);background:var(--amber-bg);padding:12px;border-radius:6px;margin-top:10px}
.actions{display:flex;gap:8px;margin-top:12px}.action{min-height:40px;display:flex;align-items:center;justify-content:center;gap:7px;border:1px solid var(--control);border-radius:6px;padding:9px 12px;background:var(--bg);color:var(--ink);font-weight:500;font-size:14px;line-height:20px;touch-action:manipulation}.action svg{width:16px;height:16px}.action.primary{flex:1;border-color:var(--accent);background:var(--accent);color:var(--on-ink)}.action.primary:hover{background:var(--ink)}.action.secondary:hover{border-color:var(--ink)}.action.primary:disabled{background:var(--soft);border-color:var(--control);color:var(--sub)}
.group-title{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:22px 0 6px;font-size:14px;font-weight:500;line-height:20px}.group-title small{font-size:12px;font-weight:400;line-height:18px;color:var(--sub)}
.settings{border:0}.setting{position:relative;display:flex;align-items:center;min-height:56px;padding:8px 48px 8px 0;cursor:pointer}.setting+.setting{border-top:1px solid var(--border)}.setting-copy{min-width:0;flex:1}.setting-title{display:flex;align-items:baseline;gap:8px;font-size:14px;line-height:20px;font-weight:500}.setting-state{color:var(--sub);font-size:12px;font-weight:400;line-height:18px;white-space:nowrap}.setting-state:empty{display:none}.setting-state[data-pending=true]{color:var(--amber)}.setting-hint{display:block;margin-top:2px;font-size:12px;line-height:18px;color:var(--sub)}
.setting input{position:absolute;right:-3px;top:50%;margin:-22px 0 0;width:44px;height:44px;opacity:0;z-index:1;cursor:pointer}.switch{position:absolute;right:2px;top:50%;margin-top:-9px;width:32px;height:18px;background:var(--off);border-radius:999px;pointer-events:none;transition:background .12s}.switch:after{content:"";position:absolute;top:3px;left:3px;width:12px;height:12px;border-radius:50%;background:var(--knob);transition:transform .12s}.setting input:checked+.switch{background:var(--accent)}.setting input:checked+.switch:after{transform:translateX(14px);background:var(--bg)}.setting input:focus-visible+.switch{outline:2px solid var(--focus);outline-offset:4px}.setting input:disabled{cursor:default}.setting input:disabled+.switch{background:var(--soft);outline:1px solid var(--control)}.setting input:disabled+.switch:after{background:var(--sub)}
.footer{display:flex;align-items:center;gap:8px;margin-top:12px;color:var(--sub);font-size:12px;line-height:18px}.footer>span{flex:1}.footer .icon-button{width:28px;height:28px}.footer svg{width:16px;height:16px}.auxiliary-actions{margin-top:6px;justify-content:flex-end}.auxiliary-actions .action{flex:none;font-size:12px;min-height:28px;padding:4px 6px;border-color:transparent}.quiz-restore{width:100%;margin-top:12px}
.compact-controls{display:none}.shell[data-collapsed=true] .header{padding:10px 12px;min-height:56px;border-bottom:0;gap:10px}.shell[data-collapsed=true] .brand h1{font-size:14px;line-height:20px}.shell[data-collapsed=true] .brand small{font-size:12px;line-height:16px}.shell[data-collapsed=true] .logo{width:18px;height:22px}.shell[data-collapsed=true] .logo svg{width:20px;height:20px}.shell[data-collapsed=true] .tools{gap:0}.shell[data-collapsed=true] .icon-button{width:28px;height:30px}
.shell[data-collapsed=true] .compact-controls{display:grid;gap:8px;padding:0 12px 12px;flex-shrink:0}.compact-readout{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:20px}.compact-status{display:flex;align-items:center;gap:6px;color:var(--sub);font-size:12px;line-height:18px;font-weight:400;white-space:nowrap}.compact-status:before{content:"";width:5px;height:5px;border-radius:50%;background:var(--sub);flex:none}.compact-status[data-tone=playing]:before{background:var(--green)}.compact-status[data-tone=working]:before{background:var(--blue)}.compact-status[data-tone=attention]{color:var(--amber)}.compact-status[data-tone=attention]:before{background:var(--amber)}
.compact-time{display:flex;align-items:baseline;gap:7px;color:var(--sub);font-size:12px;line-height:18px}.compact-time #compactRemaining{font-family:"Geist Mono",monospace;font-size:14px;font-weight:400;line-height:20px;letter-spacing:-.04em;font-variant-numeric:tabular-nums;color:var(--ink)}.compact-controls .action{min-height:36px;padding:7px 12px;font-size:14px;line-height:20px}.compact-quiz{display:none}.shell[data-collapsed=true] .compact-quiz{display:block;margin:0 12px 12px;width:calc(100% - 24px)}
@media(max-width:380px){.body{padding:16px}.header{padding-left:16px;padding-right:16px}.setting{padding-right:44px}.setting-title{gap:6px}.status-heading strong{font-size:20px}.session-time time{font-size:22px}.actions{gap:6px}.action{padding-left:10px;padding-right:10px}}
@media(pointer:coarse){.icon-button,.shell[data-collapsed=true] .icon-button{width:36px;height:44px}.action,.compact-controls .action,.auxiliary-actions .action{min-height:44px}.header{min-height:68px}.shell[data-collapsed=true] .header{min-height:64px}}
@media(prefers-reduced-motion:reduce){.switch,.switch:after{transition:none}}
@media(forced-colors:active){.shell,.action{border:1px solid CanvasText}.switch{border:1px solid ButtonText}.setting input:checked+.switch{background:Highlight}.dot,.compact-status:before{background:CanvasText}}

.estimate{margin-top:16px}.estimate-label{font-size:12px;color:var(--sub)}.remaining-value{font-family:"Geist","Microsoft YaHei",sans-serif;font-size:20px;font-weight:500;line-height:28px;margin-top:4px;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.estimate-detail{margin:6px 0 0;font-size:12px;line-height:19px;color:var(--sub);overflow-wrap:anywhere}.estimate-tools{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px;font-size:12px;line-height:20px;color:var(--sub)}.estimate-tools label{display:flex;align-items:center;gap:6px}.estimate-tools select{font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--control);border-radius:4px;min-height:30px;padding:2px 4px}.estimate-tools select:focus-visible,.estimate-tools a:focus-visible,summary:focus-visible{outline:2px solid var(--focus);outline-offset:3px}.estimate-tools a{color:var(--ink);text-decoration:underline;text-underline-offset:3px;cursor:pointer}.playback-statistics{margin-top:22px;border-top:1px solid var(--border);padding-top:12px}.playback-statistics summary{font-size:14px;line-height:24px;cursor:pointer;color:var(--ink)}.playback-statistics dl{margin:12px 0 0;font-size:12px;line-height:24px}.playback-statistics dl>div{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.playback-statistics dt{color:var(--sub)}.playback-statistics dd{margin:0}.playback-statistics time{font-family:"Geist Mono",monospace;font-size:14px;font-variant-numeric:tabular-nums}.compact-time #compactRemaining{font-size:12px;letter-spacing:0}.estimate-tools select:disabled{color:var(--sub)}@media(pointer:coarse){.estimate-tools select,.estimate-tools a,.playback-statistics summary{min-height:44px;display:inline-flex;align-items:center}}


.brand .version-link{display:block;max-width:100%;margin:1px 0 0;padding:0;border:0;background:transparent;color:var(--sub);font:400 12px/18px "Geist","Microsoft YaHei",sans-serif;white-space:nowrap;text-align:left;touch-action:manipulation}.brand .version-link:hover{color:var(--ink);text-decoration:underline;text-underline-offset:3px}.brand .version-link:focus-visible{outline:2px solid var(--focus);outline-offset:3px;border-radius:2px}
.subscription-dialog{width:408px;max-width:calc(100vw - 32px);max-height:calc(100dvh - 32px);margin:auto;padding:24px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--ink);font:14px/1.6 "Geist","Microsoft YaHei",sans-serif;overflow:auto;box-shadow:0 16px 56px #0003}.subscription-dialog::backdrop{background:#0007}.subscription-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.subscription-heading h2{margin:0;font-size:22px;line-height:30px;font-weight:500;letter-spacing:-.02em}.subscription-close{border:0;background:transparent;color:var(--sub);font:inherit;min-height:36px;padding:4px 0 4px 8px}.subscription-close:hover{color:var(--ink)}.subscription-lead{margin:24px 0 8px;font-size:18px;line-height:28px;font-weight:500}.subscription-copy{margin:0;color:var(--sub);font-size:13px;line-height:22px}.subscription-facts{margin:20px 0;padding:12px 14px;background:var(--soft);border-radius:6px;font-size:13px;line-height:26px}.subscription-facts>div{display:flex;align-items:baseline;justify-content:space-between;gap:16px}.subscription-facts dt{color:var(--sub)}.subscription-facts dd{margin:0;font-variant-numeric:tabular-nums}.subscription-field-label{display:block;margin:0 0 8px;font-size:13px}.subscription-field{display:flex;width:100%;min-width:0;border:1px solid var(--control);border-radius:6px;overflow:hidden}.subscription-field input{display:block;flex:1;min-width:0;width:0;padding:9px 10px;border:0;background:var(--bg);color:var(--ink);font:12px/20px "Geist","Microsoft YaHei",sans-serif;text-overflow:ellipsis}.subscription-field button{flex:none;border:0;border-left:1px solid var(--control);padding:8px 12px;background:var(--soft);color:var(--ink);font-size:13px;line-height:22px}.subscription-field input:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}.subscription-feedback{margin:8px 0 18px;color:var(--sub);font-size:12px;line-height:20px;min-height:20px}.subscription-install{width:100%;text-decoration:none}.subscription-notes{display:block;width:fit-content;margin-top:14px;color:var(--ink);text-decoration:underline;text-underline-offset:4px;font-size:13px;line-height:24px}.subscription-notes:focus-visible{outline:2px solid var(--focus);outline-offset:3px}@media(pointer:coarse){.brand .version-link{min-height:28px}.subscription-close,.subscription-field button,.subscription-notes{min-height:44px}}@media(max-width:380px){.subscription-dialog{padding:20px}.subscription-heading h2{font-size:20px}.subscription-lead{font-size:16px}}
</style>
<section class="shell" id="shell" aria-label="${platformLabel}视频助手">
  <header class="header" id="dragHandle" tabindex="0" aria-label="面板位置，可拖动或用方向键移动" title="拖动面板，或聚焦后用方向键移动">
    <div class="tools"><button type="button" id="theme" class="icon-button theme-button"></button><button type="button" id="collapse" class="icon-button" aria-controls="panelBody"></button></div>
  </header>
  <div class="compact-controls" id="compactControls">
    <div class="compact-readout"><span id="compactStatus" class="compact-status"></span><span class="compact-time"><span>剩余</span><span id="compactRemaining">待同步</span></span></div>
    <button id="compactToggle" type="button" class="action primary"><span id="compactToggleText">开始助手</span></button>
  </div>
  ${isZhidaoShared ? '<button id="compactShowQuiz" type="button" class="action secondary compact-quiz" hidden>显示弹题</button>' : ''}
  <div class="body" id="panelBody">
    <div class="status-card" id="statusCard"><div class="status-heading"><span class="dot" aria-hidden="true"></span><strong id="statusTitle">准备开始</strong><span class="badge" id="statusBadge" aria-hidden="true"></span></div><p id="status" role="status" aria-live="polite" aria-atomic="true"></p></div>
    <section class="estimate" aria-label="剩余观看量估算"><span class="estimate-label">预计剩余观看时长</span><div id="remainingValue" class="remaining-value">待同步</div><p id="estimateDetail" class="estimate-detail">正在读取目录中的视频时长，无需先打开成绩分析。</p><div class="estimate-tools"><label for="estimateRatio">估算比例 <select id="estimateRatio"><option value="0.8">80%</option><option value="0.9">90%</option><option value="1">100%</option></select></label><a id="syncEstimate" target="_blank" rel="noopener noreferrer" hidden>打开成绩分析 ↗</a></div><p id="estimateExplain" class="estimate-detail" hidden>不含暂停、弹题和平台确认等待。</p></section>
    <div class="actions primary-actions"><button id="toggle" type="button" class="action primary"><span id="toggleIcon"></span><span id="toggleText"></span></button><button id="reset" type="button" class="action secondary" title="重新检查页面；当前仍有平台警告时保持停止">${icons.reset}<span id="resetText">重新检测</span></button></div>
    ${isZhidaoShared ? '<div class="actions auxiliary-actions"><button id="manualPlay" type="button" class="action secondary">播放当前视频</button><button id="locateNext" type="button" class="action secondary">定位下一节</button></div>' : ''}
    <h2 class="group-title">播放偏好<small>自动保存</small></h2>
    <div class="settings">
      ${isZhidaoShared ? `<label class="setting" for="autoPlay"><span class="setting-copy"><span class="setting-title">自动播放 <span class="setting-state" id="autoPlayState"></span></span><span class="setting-hint" id="autoPlayHint">开始后自动播放，换节后继续</span></span><input type="checkbox" role="switch" id="autoPlay" aria-label="自动播放" aria-describedby="autoPlayHint"><span class="switch" aria-hidden="true"></span></label>` : ''}
      <label class="setting" for="muted"><span class="setting-copy"><span class="setting-title">静音播放 <span class="setting-state" id="mutedState"></span></span><span class="setting-hint" id="mutedHint">关闭后恢复视频声音</span></span><input type="checkbox" role="switch" id="muted" aria-label="静音播放" aria-describedby="mutedHint"><span class="switch" aria-hidden="true"></span></label>
      <label class="setting" for="continuous"><span class="setting-copy"><span class="setting-title">自动连播 <span class="setting-state" id="continuousState"></span></span><span class="setting-hint" id="continuousHint">依次播放本页的多个视频</span></span><input type="checkbox" role="switch" id="continuous" aria-label="自动连播" aria-describedby="continuousHint"><span class="switch" aria-hidden="true"></span></label>
      <label class="setting" for="autoNext"><span class="setting-copy"><span class="setting-title">下一任务点 <span class="setting-state" id="autoNextState"></span></span><span class="setting-hint" id="nextHint">当前视频完成后进入下一节</span></span><input type="checkbox" role="switch" id="autoNext" aria-label="自动下一个任务点" aria-describedby="nextHint"><span class="switch" aria-hidden="true"></span></label>
    </div>
    ${isZhidaoShared ? `<h2 class="group-title">视频弹题</h2><div class="settings">
      <label class="setting" for="autoQuiz"><span class="setting-copy"><span class="setting-title">处理视频弹题 <span class="setting-state" id="autoQuizState"></span></span><span class="setting-hint" id="autoQuizHint">选择首项，再关闭视频弹题</span></span><input type="checkbox" role="switch" id="autoQuiz" aria-label="处理视频弹题" aria-describedby="autoQuizHint"><span class="switch" aria-hidden="true"></span></label>
      <label class="setting" for="hideQuiz"><span class="setting-copy"><span class="setting-title">收起视频弹题 <span class="setting-state" id="hideQuizState"></span></span><span class="setting-hint" id="hideQuizHint">仅收起显示，仍需你作答</span></span><input type="checkbox" role="switch" id="hideQuiz" aria-label="收起视频弹题" aria-describedby="hideQuizHint"><span class="switch" aria-hidden="true"></span></label>
    </div><button id="showQuiz" type="button" class="action secondary quiz-restore" hidden>显示弹题</button>` : ''}
    <details class="playback-statistics"><summary>播放统计</summary><dl><div><dt>本课程（本机）</dt><dd><time id="coursePlayed">00:00:00</time></dd></div><div><dt>本机累计</dt><dd><time id="allPlayed">00:00:00</time></dd></div></dl><p id="statisticsNote" class="estimate-detail">自启用统计起，含重播；本机记录，不代表平台学时。</p></details><div class="footer"><span id="footerText">偏好自动保存</span><button type="button" id="position" class="icon-button" aria-label="恢复默认面板位置" title="恢复默认面板位置">${icons.position}</button></div>
  </div>

  <dialog id="subscriptionDialog" class="subscription-dialog" aria-labelledby="subscriptionTitle" aria-describedby="subscriptionDescription">
    <div class="subscription-heading"><h2 id="subscriptionTitle">自動更新</h2><button type="button" id="subscriptionClose" class="subscription-close" autofocus>關閉</button></div>
    <p class="subscription-lead">安裝一次，接收後續更新。</p>
    <p id="subscriptionDescription" class="subscription-copy">訂閱 GitHub 穩定版，讓 Tampermonkey 依設定檢查更新。新版安裝後，重新整理課程頁面即可使用。</p>
    <dl class="subscription-facts"><div><dt>目前版本</dt><dd>v${VERSION}</dd></div><div><dt>更新來源</dt><dd>GitHub · 穩定版</dd></div></dl>
    <label class="subscription-field-label" for="subscriptionLink">訂閱連結</label>
    <div class="subscription-field"><input id="subscriptionLink" type="url" readonly spellcheck="false" value="${subscriptionURL}"><button type="button" id="copySubscription">複製</button></div>
    <p id="subscriptionFeedback" class="subscription-feedback" role="status" aria-live="polite">開啟連結即可安裝或更新。</p>
    <a class="action primary subscription-install" href="${subscriptionURL}" target="_blank" rel="noopener noreferrer">安裝並訂閱 ↗</a>
    <a class="subscription-notes" href="${releaseNotesURL}" target="_blank" rel="noopener noreferrer">查看更新紀錄 ↗</a>
  </dialog>
</section>
`;
    const get = id => shadow.getElementById(id);
    controls = { body: get('panelBody'), status: get('status'), statusTitle: get('statusTitle'), badge: get('statusBadge'), card: get('statusCard'),
      compact: get('compactStatus'), toggle: get('toggle'), toggleText: get('toggleText'), toggleIcon: get('toggleIcon'), nextHint: get('nextHint'),
      compactToggle: get('compactToggle'), compactToggleText: get('compactToggleText'),
      reset: get('reset'), resetText: get('resetText'),
      manualPlay: get('manualPlay'), locateNext: get('locateNext'), showQuiz: get('showQuiz'), compactShowQuiz: get('compactShowQuiz'),
      mutedHint: get('mutedHint'), continuousHint: get('continuousHint'), footerText: get('footerText') };
    const shell = get('shell'), header = get('dragHandle'), themeButton = get('theme'), collapseButton = get('collapse');
    // 标题身份由独立节点创建，避免模板中残留的旧 logo/brand 与新版并排出现。
    const headerLogo = document.createElement('span'), headerBrand = document.createElement('div');
    headerLogo.className = 'logo'; headerLogo.innerHTML = icon('<path d="M6 4H3v16h3M18 4h3v16h-3M10 8l6 4-6 4Z"/>');
    headerBrand.className = 'brand';
    const brandTitle = document.createElement('h1'), brandVersion = document.createElement('button');
    brandTitle.textContent = '影片助手';
    brandVersion.type = 'button';
    brandVersion.id = 'subscriptionInfo'; brandVersion.className = 'version-link';
    brandVersion.textContent = 'v' + VERSION + ' · 自動更新';
    brandVersion.setAttribute('aria-haspopup', 'dialog');
    brandVersion.setAttribute('aria-controls', 'subscriptionDialog');
    brandVersion.title = '查看版本與訂閱方式';
    const subscriptionDialog = get('subscriptionDialog');
    brandVersion.onclick = () => { if (!subscriptionDialog.open) subscriptionDialog.showModal(); };
    get('subscriptionClose').onclick = () => subscriptionDialog.close();
    subscriptionDialog.addEventListener('click', event => {
      if (event.target !== subscriptionDialog) return;
      const bounds = subscriptionDialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) subscriptionDialog.close();
    });
    get('copySubscription').onclick = async () => {
      const field = get('subscriptionLink'), feedback = get('subscriptionFeedback'), button = get('copySubscription');
      if (button.disabled) return;
      button.disabled = true;
      try {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(subscriptionURL);
        feedback.textContent = '訂閱連結已複製。';
      } catch {
        field.focus(); field.select();
        feedback.textContent = '連結已選取，請手動複製。';
      } finally { button.disabled = false; }
    };
    headerBrand.append(brandTitle, brandVersion);
    function repairHeaderBranding() {
      for (const node of header.querySelectorAll(':scope > .logo,:scope > .brand')) {
        if (node !== headerLogo && node !== headerBrand) node.remove();
      }
      if (header.firstElementChild !== headerLogo) header.prepend(headerLogo);
      if (headerLogo.nextElementSibling !== headerBrand) headerLogo.after(headerBrand);
    }
    repairHeaderBranding();
    const headerObserver = new MutationObserver(repairHeaderBranding);
    headerObserver.observe(header, { childList: true });
    function placePanel() {
      panel.style.width = ui.collapsed ? '288px' : '352px';
      if (!ui.position) {
        panel.style.left = ''; panel.style.top = ''; panel.style.right = '12px'; panel.style.bottom = '12px';
        return;
      }
      const bounds = panel.getBoundingClientRect();
      const clamp = (value, edge, size) => Math.max(12, Math.min(value, edge - size - 12));
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      panel.style.left = clamp(ui.position.left, window.innerWidth, bounds.width) + 'px';
      panel.style.top = clamp(ui.position.top, window.innerHeight, bounds.height) + 'px';
    }
    function applyAppearance() {
      shell.dataset.theme = ui.theme;
      shell.dataset.collapsed = String(ui.collapsed);
      get('panelBody').hidden = ui.collapsed;
      get('compactControls').hidden = !ui.collapsed;
      themeButton.innerHTML = ui.theme === 'light' ? icons.moon : icons.sun;
      themeButton.title = themeButton.ariaLabel = ui.theme === 'light' ? '切换为深色主题' : '切换为浅色主题';
      collapseButton.innerHTML = ui.collapsed ? icons.expand : icons.minimize;
      collapseButton.title = collapseButton.ariaLabel = ui.collapsed ? '展开面板' : '折叠面板';
      collapseButton.setAttribute('aria-expanded', String(!ui.collapsed));
      placePanel();
    }
    for (const key of isZhidaoShared ? ['autoPlay', 'muted', 'continuous', 'autoNext', 'autoQuiz', 'hideQuiz'] : ['muted', 'continuous', 'autoNext']) {
      controls[key] = get(key); controls[key + 'State'] = get(key + 'State');
      controls[key].onchange = () => {
        if (platformStopped) return;
        if (isZhidao && platformScriptAlert()) { stopForPlatformAlert(); return; }
        if (isZhidaoShared) {
          const value = controls[key].checked;
          saveSharedPreference(key === 'autoQuiz' ? 'nativeAutoQuiz' : key === 'hideQuiz' ? 'nativeHideQuiz' : key, value);
          if (key === 'autoPlay' && !value) {
            const media = zhidaoMedia(), state = media && playback.get(media);
            if (state) state.cancelled = true;
            if (media && (state?.pending || media.paused && startedMedia.has(media))) media.pause();
            navigation.pending = false; navigation.halted = false; navigation.completeSince = 0;
            sharedRefreshPending = null; sharedResumeTarget = null; sharedRefreshReady = false; clearSessionTransfer();
          } else if (key === 'autoPlay') {
            for (const media of document.querySelectorAll('video')) playback.delete(media);
            navigation.key = ''; navigation.pending = false; navigation.halted = false;
          }
          if (key === 'autoQuiz') {
            for (const root of videoQuizRoots()) sourceQuizStates.delete(root);
          }
          if (key === 'autoNext' && !value) {
            sharedRefreshReady = false;
            if (sharedRefreshPending) { sharedRefreshPending = null; clearSessionTransfer(); }
          }
          if (key === 'muted' && settings().manual) {
            const media = zhidaoMedia();
            if (media) { media.muted = controls.muted.checked; renderPanel(media.muted ? '当前视频已手动静音。' : '当前视频已恢复声音。'); }
            else renderPanel('未找到当前视频，请使用播放器原有控件。');
          } else renderPanel(key === 'autoPlay' ? value ? '自动播放已开启，点击开始助手后启动当前视频。' : '已切换手动辅助，后续视频由你操作。' : undefined);
          navigation.completeSince = 0;
          tick();
          return;
        }
        const config = settings(); config[key] = controls[key].checked;
        savePreferences(config); navigation.completeSince = 0; renderPanel(undefined, config); tick();
      };
    }
    controls.toggle.onclick = controls.compactToggle.onclick = toggleSession;
    get('reset').onclick = event => {
      if (platformStopped) { inspectStoppedPage(event); return; }
      if (isZhidao && platformScriptAlert()) { stopForPlatformAlert(); return; }
      if (settings().manual) { renderPanel('已重新读取页面状态；视频由你手动控制。'); tick(); return; }
      if (isZhidaoShared) { const config = settings(); sharedResumeTarget = null; saveSharedPreference('reset', config.reset + 1); renderPanel('正在重新检测视频与目录。'); tick(); return; }
      const config = settings(); config.reset++; savePreferences(config);
      renderPanel('已清空本页尝试记录，正在重新检测。', config); tick();
    };
    if (isZhidaoShared) {
      controls.showQuiz.onclick = controls.compactShowQuiz.onclick = () => {
        for (const [root, record] of videoQuizPanels) { restoreVideoQuiz(root, record); record.revealed = true; }
        renderPanel('视频弹题已显示，请在原页面作答；本题不会再次自动收起。');
      };
      controls.manualPlay.onclick = event => {
        if (!event.isTrusted || platformStopped) return;
        if (platformScriptAlert()) { stopForPlatformAlert(); return; }
        if (zhidaoBlocker()) { renderPanel('页面有题目、验证或提示，请先手动处理。'); return; }
        const media = zhidaoMedia();
        if (!media) { renderPanel('未找到当前视频，请使用播放器原有控件。'); return; }
        if (!media.paused) { media.pause(); renderPanel('当前视频已手动暂停。'); return; }
        startedMedia.add(media);
        const failed = () => { if (!platformStopped) renderPanel('播放未能启动，请点击播放器原有播放按钮。'); };
        try { Promise.resolve(media.play()).then(() => {
          if (platformStopped) { media.pause(); return; }
          renderPanel('已手动播放当前视频；不会自动续播或切节。');
        }, failed); } catch { failed(); }
      };
      controls.locateNext.onclick = event => {
        if (!event.isTrusted || platformStopped) return;
        if (platformScriptAlert()) { stopForPlatformAlert(); return; }
        if (zhidaoBlocker()) { renderPanel('页面有题目、验证或提示，请先手动处理。'); return; }
        const files = zhidaoFiles(), current = zhidaoCurrent(), index = files.indexOf(current);
        if (index < 0) { renderPanel('无法确认当前目录项，请在原生目录手动选择。'); return; }
        const next = files.slice(index + 1).find(node => zhidaoRate(node) !== 100);
        if (!next) { renderPanel('目录中已没有后续未完成的视频。'); return; }
        if (locked(next) || next.closest('[aria-disabled="true"],.locked,.disabled,.lock,[data-locked="true"]')) {
          renderPanel('下一视频尚未开放，请按平台要求完成前置任务。'); return;
        }
        if (!visible(next)) { renderPanel('下一视频所在目录已折叠，请先手动展开：' + zhidaoFileLabel(next)); return; }
        next.scrollIntoView({ block: 'center', behavior: 'smooth' });
        renderPanel('已定位：' + zhidaoFileLabel(next) + '。请在原生目录中点击播放。');
      };
    }
    themeButton.onclick = () => { ui.theme = ui.theme === 'light' ? 'dark' : 'light'; saveUI(); applyAppearance(); };
    collapseButton.onclick = () => { ui.collapsed = !ui.collapsed; saveUI(); applyAppearance(); };
    get('position').onclick = () => { ui.position = null; saveUI(); placePanel(); };
    let drag = null;
    header.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const bounds = panel.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top };
      header.setPointerCapture(event.pointerId); event.preventDefault();
    });
    header.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      ui.position = { left: drag.left + event.clientX - drag.x, top: drag.top + event.clientY - drag.y }; placePanel();
    });
    function finishDrag(event) {
      if (!drag || event.pointerId !== drag.id) return;
      if (ui.position) {
        const bounds = panel.getBoundingClientRect(); ui.position = { left: bounds.left, top: bounds.top }; saveUI();
      }
      drag = null;
      if (header.hasPointerCapture(event.pointerId)) header.releasePointerCapture(event.pointerId);
    }
    header.addEventListener('pointerup', finishDrag); header.addEventListener('pointercancel', finishDrag);
    header.addEventListener('keydown', event => {
      if (event.target !== header || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); const bounds = panel.getBoundingClientRect(), step = event.shiftKey ? 30 : 10;
      ui.position = { left: bounds.left + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
        top: bounds.top + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) };
      placePanel(); const moved = panel.getBoundingClientRect(); ui.position = { left: moved.left, top: moved.top }; saveUI();
    });
    get('estimateRatio').addEventListener('change', () => { viewingTime?.setRatio(get('estimateRatio').value); renderViewingTime(); });
    document.body.appendChild(panel); applyAppearance(); renderPanel();
    window.addEventListener('resize', placePanel);
    window.addEventListener('pagehide', () => { window.removeEventListener('resize', placePanel); headerObserver.disconnect(); }, { once: true });
    window.addEventListener('message', event => {
      if (isZhidao || !chaoxingOrigin(event.origin) || !event.source || event.source === window || !locateFrame(event.source) ||
        event.data?.channel !== CHANNEL || typeof event.data.message !== 'string') return;
      if (settings().enabled && (!activeWorker || event.source === activeWorker)) renderPanel(event.data.message.slice(0, 220));
    });
  }
  let viewingTime = null;
  function startViewingTime() {
    if (window !== window.top) return;
    viewingTime = createViewingTime({ directory: isZhidaoShared, course: loadedCourse, context: () => {
      const config = settings();
      const media = isZhidao ? zhidaoMedia() : courseDocuments().flatMap(doc => [...doc.querySelectorAll('video')]).find(visible);
      const rows = isZhidaoShared ? zhidaoFiles().map(node => ({
        chapter: text(node.querySelector('.hour')), title: text(node.querySelector('.catalogue_title')),
        seconds: viewingTime.duration(text(node.querySelector('.time'))),
        complete: zhidaoFinishedIcon(node), progress: viewingTime.directoryProgress(node), node
      })) : [];
      return { media, rows, current: rows.find(row => row.node === zhidaoCurrent()), enabled: config.enabled,
        blocked: platformStopped || navigation.pending || !!(isZhidao ? zhidaoBlocker() : media && findQuiz(media)) };
    }});
    viewingTime.sample();
    window.addEventListener('pagehide', () => viewingTime.stop(), {once:true});
    document.addEventListener('visibilitychange', () => viewingTime.flush());
  }
  function renderViewingTime() {
    if (!viewingTime || !panel?.shadowRoot) return;
    const root = panel.shadowRoot, get = id => root.getElementById(id), result = viewingTime.view();
    const setText = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };
    setText(get('remainingValue'), result.value);
    setText(get('compactRemaining'), result.compact);
    setText(get('estimateDetail'), result.detail);
    setText(get('coursePlayed'), result.courseTime);
    setText(get('allPlayed'), result.allTime);
    setText(get('statisticsNote'), (!result.persistent ? '存储不可用，当前数字仅在本页有效。' :
      !result.observable ? '未观察到当前播放器；累计为已有本机记录。' :
      result.uncertain ? '观测存在间隔，部分时间未计入；可更新估算。' : '自启用统计起，含重播；本机记录，不代表平台学时。'));
    const ratio = get('estimateRatio'), link = get('syncEstimate');
    ratio.value = String(result.q); ratio.disabled = !isZhidaoShared;
    link.hidden = !result.reportUrl;
    if (result.reportUrl) link.href = result.reportUrl;
    setText(link, result.directory ? '成绩分析校准 ↗' : '打开成绩分析 ↗');
    get('estimateExplain').hidden = !(result.synced || result.ready);
  }

  function startRuntime() {
    startViewingTime();
    buildPanel();
    if (window === window.top && isStudy) {
      document.addEventListener('click', event => {
        if (!event.isTrusted) return;
        if (platformStopped || settings().manual) return;
        if (isZhidao) {
          const target = event.target.closest?.(isZhidaoShared ? SHARED_ROWS : '#sourceTree .file-item[id^="file_"]');
          if (target && target !== zhidaoCurrent()) { sharedResumeTarget = null; if (isZhidaoShared) sharedSourceBackend.directoryClick(target); else waitZhidaoNavigation(target, Date.now()); }
          return;
        }
        const tab = taskTabs().find(node => node === event.target || node.contains(event.target));
        const target = event.target.closest?.('.posCatalog_select,.prev_ul li,.tabtags li,.ncells h4,.ncells h5') || tab;
        if (!target || target === activeTaskTab() || target.matches('.posCatalog_active,.active,.currents')) return;
        navigation.pending = true;
        navigation.pendingContent = contentKey();
        navigation.since = Date.now();
        navigation.completeSince = 0;
        navigation.halted = false;
        transferSession();
        say('正在切换到：' + (text(target) || '所选任务点'));
      }, true);
    }
    const timer = setInterval(() => {
      try { viewingTime?.sample(); tick(); } catch (error) {
        if (current) block(current, '页面结构变化，自动处理已停止');
        console.warn('[学习通视频助手]', error);
      }
    }, TICK_MS);
    window.addEventListener('pagehide', () => { sharedSourceBackend?.stop(true); clearInterval(timer); observer.disconnect(); restoreVideoQuizzes(true); }, { once: true });
    tick();
  }
  if (isZhidaoShared && window === window.top) { sharedSourceBackend = createSharedSourceBackend(); sharedSourceBackend.install(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startRuntime, { once: true });
  else startRuntime();
})();
