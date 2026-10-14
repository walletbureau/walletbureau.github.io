/*
 * Витрина: живой счётчик и демо-проверка адреса (specs/050-landing.md §4).
 *
 * Правила, из которых вырос этот файл:
 * — ни одной пользовательской строки в коде: всё через t() из window.__I18N__ (050 §3.3);
 * — данные API попадают в DOM только через textContent: reason приходит с сервера,
 *   innerHTML на нём — это XSS через собственный ответ;
 * — страница осмысленна без JS, поэтому виджеты спрятаны в разметке и открываются здесь.
 */
(function () {
  'use strict';

  var DICT = window.__I18N__ || {};
  var LANG = document.documentElement.lang || 'en';
  var ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
  var STATS_URL = '/v1/stats';
  var DEMO_URL = '/v1/demo/score/';
  var STATS_REFRESH_MS = 60000;
  var REQUEST_TIMEOUT_MS = 10000;
  var CACHE_KEY = 'wb.stats.v1';

  function t(key, params) {
    var value = DICT[key];
    if (value === undefined) return '';
    if (!params) return value;
    return value.replace(/\{(\w+)\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
    });
  }

  /**
   * Одна проверка на весь файл: и фон, и печать placeholder, и счётчики обязаны
   * замолкать по системной настройке, а не каждый по-своему.
   */
  function calmMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function num(value) {
    try {
      return new Intl.NumberFormat(LANG).format(value);
    } catch {
      return String(value);
    }
  }

  function money(value) {
    var parsed = Number(value);
    if (!isFinite(parsed)) return String(value);
    try {
      return new Intl.NumberFormat(LANG, { style: 'currency', currency: 'USD' }).format(parsed);
    } catch {
      return '$' + value;
    }
  }

  function day(iso) {
    if (!iso) return t('demo.result.empty');
    try {
      return new Intl.DateTimeFormat(LANG, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso));
    } catch {
      return String(iso).slice(0, 10);
    }
  }

  function minutesAgo(iso) {
    var diffMs = Date.now() - new Date(iso).getTime();
    var minutes = Math.max(0, Math.round(diffMs / 60000));
    try {
      return new Intl.RelativeTimeFormat(LANG, { numeric: 'auto' }).format(-minutes, 'minute');
    } catch {
      return String(minutes);
    }
  }

  function shorten(address) {
    return address.slice(0, 10) + '…' + address.slice(-4);
  }

  function fetchJson(url) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    return fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
      .then(function (res) {
        return res.json().then(
          function (body) {
            return { status: res.status, ok: res.ok, body: body };
          },
          function () {
            return { status: res.status, ok: false, body: null };
          },
        );
      })
      .finally(function () {
        clearTimeout(timer);
      });
  }

  // --- Живой счётчик (050 §4) ---------------------------------------------

  /*
   * Число не появляется готовым, а доезжает до значения. Три условия, без которых
   * этот эффект вредит, а не украшает:
   * — считаем от прошлого показанного числа, а не от нуля: обновление раз в минуту
   *   меняет счётчик на десяток, и перезапуск с нуля читался бы как сброс данных;
   * — старт по попаданию блока в экран, иначе анимация проходит мимо человека,
   *   который до неё ещё не долистал;
   * — при prefers-reduced-motion число просто ставится на место.
   */
  var COUNT_MS = 1100;
  var counted = {};          // ключ метрики -> последнее показанное число
  var statsSeen = false;     // блок уже появлялся в зоне видимости
  var countQueue = [];

  function countUp(node, from, to) {
    if (calmMotion() || from === to || !window.requestAnimationFrame) {
      node.textContent = num(to);
      return;
    }
    var started = 0;
    window.requestAnimationFrame(function frame(now) {
      if (!started) started = now;
      var progress = Math.min((now - started) / COUNT_MS, 1);
      var eased = 1 - Math.pow(1 - progress, 3);
      node.textContent = num(Math.round(from + (to - from) * eased));
      if (progress < 1) window.requestAnimationFrame(frame);
    });
  }

  function queueCount(node, from, to) {
    if (statsSeen) {
      countUp(node, from, to);
      return;
    }
    node.textContent = num(from);
    countQueue.push({ node: node, from: from, to: to });
  }

  function flushCounts() {
    var queued = countQueue;
    countQueue = [];
    queued.forEach(function (item) {
      // Узлы могли смениться следующим рендером — досчитывать нечего.
      if (item.node.isConnected) countUp(item.node, item.from, item.to);
    });
  }

  function watchStats(root) {
    if (!window.IntersectionObserver) {
      statsSeen = true;
      flushCounts();
      return;
    }
    var observer = new IntersectionObserver(function (entries) {
      if (!entries[0].isIntersecting) return;
      statsSeen = true;
      observer.disconnect();
      flushCounts();
    }, { threshold: 0.3 });
    observer.observe(root);
  }

  function renderStats(root, stats, fromCache) {
    var rows = [
      ['addresses_indexed', 'stats.addresses'],
      ['transfers_total_approx', 'stats.transfers'],
      ['transfers_confirmed', 'stats.confirmed'],
      ['scores_served', 'stats.scores'],
    ];
    var grid = el('div', 'stats');
    var pending = [];
    rows.forEach(function (row) {
      var cell = el('div', 'stat');
      var value = stats[row[0]];
      var node = el('p', 'stat__num');
      var from = typeof counted[row[0]] === 'number' ? counted[row[0]] : 0;
      counted[row[0]] = value;
      pending.push({ node: node, from: from, to: value });
      cell.appendChild(node);
      cell.appendChild(el('p', 'stat__label', t(row[1])));
      grid.appendChild(cell);
    });
    var foot = el('p', 'stats-foot');
    foot.appendChild(
      el('span', 'caption', t(fromCache ? 'stats.cached' : 'stats.updated', { time: minutesAgo(stats.updated_at) })),
    );
    clear(root);
    root.appendChild(grid);
    root.appendChild(foot);
    root.hidden = false;
    // Считать можно только после вставки в документ: до неё блока нет ни в экране,
    // ни для наблюдателя видимости.
    pending.forEach(function (item) { queueCount(item.node, item.from, item.to); });
  }

  function readCache() {
    try {
      var raw = window.localStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function writeCache(stats) {
    try {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(stats));
    } catch {
      /* приватный режим — просто живём без кэша */
    }
  }

  function initStats() {
    var root = document.querySelector('[data-stats]');
    if (!root) return;

    watchStats(root);

    // При недоступном API показываем последние известные числа, а не ноль и не пустоту.
    var cached = readCache();
    if (cached) renderStats(root, cached, true);

    var load = function () {
      fetchJson(STATS_URL)
        .then(function (res) {
          if (!res.ok || !res.body || typeof res.body.addresses_indexed !== 'number') return;
          writeCache(res.body);
          renderStats(root, res.body, false);
        })
        .catch(function () {
          /* сеть отвалилась — на экране остаётся кэш */
        });
    };
    load();
    setInterval(load, STATS_REFRESH_MS);
  }

  // --- Демо-проверка (050 §4) ---------------------------------------------

  function verdictOf(response) {
    var noHistory = response.flags.some(function (flag) {
      return flag.code === 'unknown_address';
    });
    if (noHistory) return { key: 'neutral', label: t('verdict.neutral') };
    return { key: response.verdict, label: t('verdict.' + response.verdict) };
  }

  function flagList(flags) {
    var list = el('ul', 'flags');
    flags.forEach(function (flag) {
      var item = el('li', 'flag');
      var body = el('div');
      body.appendChild(el('p', 'flag__code', flag.code));
      body.appendChild(el('p', 'flag__reason', flag.reason));
      var badge = el('span', null, t('severity.' + flag.severity) || flag.severity);
      badge.classList.add('sev');
      badge.classList.add('sev--' + flag.severity);
      item.appendChild(body);
      item.appendChild(badge);
      list.appendChild(item);
    });
    return list;
  }

  function emptyFlags(verdictKey) {
    var box = el('div', 'flags-empty');
    if (verdictKey === 'neutral') {
      box.appendChild(el('p', null, t('demo.result.noHistory')));
      return box;
    }
    var title = el('p');
    title.appendChild(el('strong', null, t('demo.result.noFlags.title')));
    box.appendChild(title);
    box.appendChild(el('p', 'caption', t('demo.result.noFlags.body')));
    return box;
  }

  function statsList(stats) {
    var rows = [
      ['demo.result.kv.firstSeen', day(stats.first_seen)],
      ['demo.result.kv.transfers', num(stats.tx_in) + ' / ' + num(stats.tx_out)],
      ['demo.result.kv.volume', money(stats.volume_in_usd) + ' / ' + money(stats.volume_out_usd)],
      ['demo.result.kv.payers', num(stats.distinct_payers)],
      ['demo.result.kv.confidence', stats.confidence_basis],
    ];
    var list = el('dl', 'kv');
    rows.forEach(function (row) {
      var pair = el('div');
      pair.appendChild(el('dt', null, t(row[0])));
      pair.appendChild(el('dd', null, row[1]));
      list.appendChild(pair);
    });
    return list;
  }

  function resultCard(response) {
    var verdict = verdictOf(response);
    var card = el('article', 'card');

    var bar = el('div', 'card__bar');
    bar.appendChild(el('span', 'eyebrow', t('demo.result.endpoint')));
    card.appendChild(bar);

    var head = el('div', 'card__body');
    head.classList.add('score--' + verdict.key);
    head.appendChild(el('p', 'addr', shorten(response.address)));

    var copy = el('button', 'btn-mini', t('demo.result.copy'));
    copy.type = 'button';
    copy.addEventListener('click', function () {
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(response.address).then(function () {
        copy.textContent = t('demo.result.copied');
        setTimeout(function () {
          copy.textContent = t('demo.result.copy');
        }, 2000);
      });
    });
    head.appendChild(copy);

    var row = el('div', 'score-row');
    row.appendChild(el('p', 'score', num(response.score)));
    var side = el('div');
    side.appendChild(el('p', 'eyebrow', t('demo.result.verdictLabel')));
    var word = el('p', null, verdict.label);
    word.classList.add('verdict');
    word.classList.add('verdict--' + verdict.key);
    side.appendChild(word);
    row.appendChild(side);
    head.appendChild(row);

    var track = el('div', 'track');
    var fill = el('span');
    fill.style.width = Math.max(0, Math.min(100, response.score)) + '%';
    track.appendChild(fill);
    head.appendChild(track);

    var scale = el('p', 'track-scale');
    scale.appendChild(el('span', null, num(0)));
    scale.appendChild(el('span', null, num(100)));
    head.appendChild(scale);
    card.appendChild(head);

    var visible = response.flags.filter(function (flag) {
      return flag.code !== 'unknown_address';
    });
    card.appendChild(visible.length ? flagList(visible) : emptyFlags(verdict.key));
    card.appendChild(statsList(response.stats));
    card.appendChild(el('p', 'card__foot', t('demo.result.foot')));
    return card;
  }

  function errorBox(messageKey, withApiLink, docsHref) {
    var box = el('div', 'notice');
    if (messageKey === 'demo.error.demo_limit_reached') box.classList.add('notice--error');
    box.setAttribute('role', 'alert');
    box.appendChild(el('p', null, t(messageKey)));
    if (withApiLink && docsHref) {
      var link = el('a', null, t('demo.apiLink'));
      link.href = docsHref;
      var wrap = el('p');
      wrap.appendChild(link);
      box.appendChild(wrap);
    }
    return box;
  }

  function initDemo() {
    var form = document.querySelector('[data-demo]');
    if (!form) return;
    var section = form.closest('[data-demo-section]') || form.parentNode;
    var input = form.querySelector('input');
    var button = form.querySelector('button[type="submit"]');
    var fieldError = form.querySelector('[data-demo-error]');
    var output = document.querySelector('[data-demo-output]');
    var docsHref = form.getAttribute('data-docs-href');
    var busy = false;

    section.hidden = false;

    function setFieldError(key) {
      clear(fieldError);
      if (!key) {
        fieldError.hidden = true;
        input.removeAttribute('aria-invalid');
        return;
      }
      fieldError.hidden = false;
      fieldError.textContent = t(key);
      input.setAttribute('aria-invalid', 'true');
    }

    function setBusy(state) {
      busy = state;
      button.disabled = state;
      clear(output);
      if (!state) return;
      var progress = el('div', 'progress');
      progress.setAttribute('aria-hidden', 'true');
      progress.appendChild(el('span'));
      output.appendChild(progress);
      output.appendChild(el('p', 'status-line', t('demo.checking')));
    }

    function show(node) {
      clear(output);
      output.appendChild(node);
    }

    function errorKeyFor(res) {
      var code = res.body && typeof res.body.error === 'string' ? res.body.error : '';
      var known = [
        'invalid_address',
        'demo_limit_reached',
        'rate_limited',
        'score_unavailable',
        'db_unavailable',
        'internal_error',
      ];
      return known.indexOf(code) >= 0 ? 'demo.error.' + code : 'demo.error.generic';
    }

    function check(address) {
      if (busy) return;
      setFieldError(null);
      if (!ADDRESS_RE.test(address)) {
        // Мусор отсекается здесь: запрос не уходит, бесплатная проверка не тратится.
        setFieldError('demo.error.invalid_address');
        clear(output);
        return;
      }
      setBusy(true);
      fetchJson(DEMO_URL + address)
        .then(function (res) {
          setBusy(false);
          if (res.ok && res.body && typeof res.body.score === 'number') {
            show(resultCard(res.body));
            return;
          }
          var key = errorKeyFor(res);
          show(errorBox(key, key === 'demo.error.demo_limit_reached', docsHref));
        })
        .catch(function () {
          setBusy(false);
          show(errorBox('demo.error.network', false, docsHref));
        });
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      check(input.value.trim());
    });

    // Результат шарится ссылкой (050 §4): /?address=0x… сразу запускает проверку.
    var shared = new URLSearchParams(window.location.search).get('address');
    if (shared) {
      input.value = shared.trim();
      check(shared.trim());
    }
  }

  /* ==================================================================== *
   * Колода вердиктов в герое
   *
   * Один тип проверки перетекает в другой: ok -> caution -> avoid. Все три
   * карточки уже лежат в разметке со своим текстом из словаря, JS переставляет
   * класс is-live и досчитывает число и полосу. Отсюда три следствия:
   * — без JS остаётся первая карточка, живая и осмысленная;
   * — ни одна строка не переезжает в код: числа читаются из DOM;
   * — колода стоит, когда её не смотрят: вкладка скрыта, блок вне экрана,
   *   курсор на карточке или человек попросил меньше движения.
   * ==================================================================== */

  function initSampleDeck() {
    var deck = document.querySelector('[data-sample-deck]');
    if (!deck) return;
    var cards = deck.querySelectorAll('[data-sample-card]');
    if (cards.length < 2) return;

    // Длительность кадра живёт в CSS, рядом с остальными параметрами колоды.
    var dwell = parseFloat(window.getComputedStyle(deck).getPropertyValue('--deck-dwell')) * 1000;
    if (!(dwell > 0)) dwell = 5000;

    var scores = [];
    var i;
    for (i = 0; i < cards.length; i++) {
      var node = cards[i].querySelector('.score');
      scores.push(node ? parseInt(node.textContent, 10) : 0);
    }

    var index = 0;
    var shown = 0;      // число, которое стоит на экране сейчас
    var timer = 0;
    var visible = false;

    function fill(card) {
      return card.querySelector('.track > span');
    }

    function paint(card, score, animate) {
      var bar = fill(card);
      if (!bar) return;
      if (!animate || calmMotion()) {
        bar.style.width = score + '%';
        return;
      }
      bar.style.width = '0%';
      bar.getBoundingClientRect();   // без reflow браузер склеит 0 и цель в один кадр
      bar.style.width = score + '%';
    }

    function show(next) {
      cards[index].classList.remove('is-live');
      index = next;
      var card = cards[index];
      card.classList.add('is-live');
      var score = scores[index];
      var numeral = card.querySelector('.score');
      if (numeral) countUp(numeral, shown, score);
      shown = score;
      paint(card, score, true);
    }

    function stop() {
      window.clearTimeout(timer);
      timer = 0;
    }

    function play() {
      stop();
      if (!visible || calmMotion() || document.hidden) return;
      timer = window.setTimeout(function () {
        show((index + 1) % cards.length);
        play();
      }, dwell);
    }

    function wake() {
      // Первый показ считается как смена кадра: число доезжает от нуля, полоса растёт.
      if (shown === 0) {
        var card = cards[index];
        var numeral = card.querySelector('.score');
        if (numeral) countUp(numeral, 0, scores[index]);
        shown = scores[index];
        paint(card, scores[index], true);
      }
      play();
    }

    if (window.IntersectionObserver) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible) wake(); else stop();
      }, { threshold: 0.35 }).observe(deck);
    } else {
      visible = true;
      wake();
    }

    // Курсор на карточке — человек читает: кадр не меняем. Отпустил — отсчёт с начала.
    deck.addEventListener('pointerenter', stop);
    deck.addEventListener('pointerleave', play);
    deck.addEventListener('focusin', stop);
    deck.addEventListener('focusout', play);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else play();
    });
  }

  /* ==================================================================== *
   * Поле адреса: placeholder печатается сам
   *
   * Правила, из которых вырос этот блок:
   * — статический placeholder из словаря остаётся единственной правдой: без JS,
   *   при prefers-reduced-motion и в фокусе поле показывает именно его;
   * — адреса тут машинные, а не текст, поэтому им место в коде рядом с ADDRESS_RE,
   *   а не в словаре: они одинаковы во всех локалях;
   * — анимация замолкает, как только поле трогают: подсказка, которая шевелится
   *   под курсором и переползает под набранным адресом, — это помеха, а не украшение.
   * ==================================================================== */

  var TYPE_SAMPLES = [
    '0xf3dc9edc50ff558f34f049e8b30a9b7965d6d74e',
    '0x76b174ca4e53526cbb4144d0e3c4d05cd5b576b0',
    '0x0cc9e9e484321250808e44a0eb35791ac58d075a',
    '0x78c7c7b4d1aea9377e7aeebf773392fa3c2f87d4',
  ];
  var TYPE_CHAR_MS = 32;      // базовая скорость печати
  var TYPE_JITTER_MS = 28;    // разброс поверх неё
  var TYPE_ERASE_MS = 15;     // стирание всегда быстрее печати
  var TYPE_HOLD_MS = 1700;    // сколько адрес стоит дописанным
  var TYPE_GAP_MS = 420;      // пауза перед следующим адресом
  var TYPE_CARET_MS = 460;    // полупериод мигания курсора
  var TYPE_CARET = '|';

  function initTypedPlaceholder() {
    var form = document.querySelector('[data-demo]');
    var input = form ? form.querySelector('input') : null;
    if (!input) return;

    var idle = input.getAttribute('placeholder') || '';
    var motion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    var timer = 0;
    var sample = 0;
    var pos = 0;
    var blinks = 0;
    var caret = true;

    function paused() {
      return document.hidden
        || !!(motion && motion.matches)
        || input === document.activeElement
        || input.value !== '';
    }

    function stop() {
      window.clearTimeout(timer);
      timer = 0;
      input.setAttribute('placeholder', idle);
    }

    function show(text, withCaret) {
      input.setAttribute('placeholder', withCaret ? text + TYPE_CARET : text);
    }

    function step(ms, next) {
      timer = window.setTimeout(next, ms);
    }

    function typing() {
      if (paused()) { stop(); return; }
      var text = TYPE_SAMPLES[sample];
      if (pos < text.length) {
        pos++;
        show(text.slice(0, pos), true);
        // Ровный ритм читается как машина, поэтому у каждого символа своя задержка.
        step(TYPE_CHAR_MS + Math.random() * TYPE_JITTER_MS, typing);
        return;
      }
      blinks = 0;
      caret = true;
      step(TYPE_CARET_MS, hold);
    }

    function hold() {
      if (paused()) { stop(); return; }
      blinks++;
      caret = !caret;
      show(TYPE_SAMPLES[sample], caret);
      if (blinks * TYPE_CARET_MS >= TYPE_HOLD_MS) { caret = true; step(TYPE_CARET_MS, erasing); return; }
      step(TYPE_CARET_MS, hold);
    }

    function erasing() {
      if (paused()) { stop(); return; }
      if (pos > 0) {
        pos--;
        show(TYPE_SAMPLES[sample].slice(0, pos), true);
        step(TYPE_ERASE_MS, erasing);
        return;
      }
      sample = (sample + 1) % TYPE_SAMPLES.length;
      step(TYPE_GAP_MS, typing);
    }

    function start() {
      if (timer || paused()) return;
      pos = 0;
      step(TYPE_GAP_MS, typing);
    }

    input.addEventListener('focus', stop);
    input.addEventListener('blur', start);
    input.addEventListener('input', function () {
      if (input.value !== '') stop();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else start();
    });
    if (motion && motion.addEventListener) {
      motion.addEventListener('change', function () {
        if (motion.matches) stop(); else start();
      });
    }

    start();
  }

  /* ==================================================================== *
   * Фон лендинга: сеть точек
   *
   * Правила, из которых вырос этот блок:
   * — украшение не должно ничего стоить, если его не видно: анимация встаёт на
   *   скрытой вкладке и не запускается вовсе при prefers-reduced-motion;
   * — цвета берутся из токенов styles.css через CSSOM, а не зашиты числами:
   *   тема переключается системно, и канвас обязан переключиться вместе с ней;
   * — слой aria-hidden и pointer-events: none, для скринридера и мыши его нет.
   * ==================================================================== */

  var NET_DENSITY = 1 / 26000;  // точек на CSS-пиксель площади
  var NET_MAX = 68;
  var NET_LINK = 132;           // px: дальше пары точек не соединяются
  var NET_POINTER = 205;        // px: радиус, в котором точки тянутся к курсору
  var NET_SPEED = 0.13;         // px за кадр при 60 fps

  function initBackdrop() {
    var host = document.querySelector('[data-bg-net]');
    if (!host || typeof window.requestAnimationFrame !== 'function') return;

    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext ? canvas.getContext('2d') : null;
    if (!ctx) return;
    host.appendChild(canvas);

    var motion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    var scheme = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    var calm = calmMotion;
    var dots = [];
    var width = 0;
    var height = 0;
    var dotColor = '';
    var lineColor = '';
    var pointer = { x: 0, y: 0, on: false };
    var frame = 0;
    var last = 0;
    var resizeTimer = 0;

    function readColors() {
      var css = window.getComputedStyle(document.documentElement);
      dotColor = css.getPropertyValue('--c-net-dot').trim() || '#5fc99a';
      lineColor = css.getPropertyValue('--c-net-line').trim() || '#5fc99a';
    }

    function seed() {
      var count = Math.min(NET_MAX, Math.round(width * height * NET_DENSITY));
      dots = [];
      for (var i = 0; i < count; i++) {
        dots.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * NET_SPEED,
          vy: (Math.random() - 0.5) * NET_SPEED,
          r: 0.7 + Math.random() * 1.5,
        });
      }
    }

    function resize() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var next = { w: host.clientWidth, h: host.clientHeight };
      // На телефоне адресная строка при скролле сама шлёт resize. Пересыпать точки
      // на каждый такой чих — значит моргать полем на ровном месте: рассыпаем заново
      // только когда экран действительно изменился.
      var reshuffle = !dots.length || next.w !== width || Math.abs(next.h - height) > 140;
      width = next.w;
      height = next.h;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (reshuffle) seed();
      draw(0);
    }

    function link(ax, ay, bx, by, dist, limit, strength) {
      ctx.globalAlpha = (1 - dist / limit) * strength;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }

    function draw(step) {
      var i, j, a, b, dx, dy, dist;

      for (i = 0; i < dots.length; i++) {
        a = dots[i];
        a.x += a.vx * step;
        a.y += a.vy * step;
        // Точка уходит за край и возвращается с противоположного: поле бесконечное.
        if (a.x < -20) a.x = width + 20; else if (a.x > width + 20) a.x = -20;
        if (a.y < -20) a.y = height + 20; else if (a.y > height + 20) a.y = -20;
      }

      ctx.clearRect(0, 0, width, height);
      ctx.lineWidth = 1;
      ctx.strokeStyle = lineColor;

      for (i = 0; i < dots.length; i++) {
        a = dots[i];
        for (j = i + 1; j < dots.length; j++) {
          b = dots[j];
          dx = a.x - b.x;
          dy = a.y - b.y;
          if (dx > NET_LINK || dx < -NET_LINK || dy > NET_LINK || dy < -NET_LINK) continue;
          dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < NET_LINK) link(a.x, a.y, b.x, b.y, dist, NET_LINK, 0.6);
        }
      }

      if (pointer.on) {
        for (i = 0; i < dots.length; i++) {
          a = dots[i];
          dx = a.x - pointer.x;
          dy = a.y - pointer.y;
          dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < NET_POINTER) link(a.x, a.y, pointer.x, pointer.y, dist, NET_POINTER, 0.55);
        }
      }

      ctx.fillStyle = dotColor;
      for (i = 0; i < dots.length; i++) {
        a = dots[i];
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    function tick(now) {
      // Шаг считается от времени, а не от кадра: на 120 Гц скорость та же, что на 60.
      var step = last ? Math.min((now - last) / 16.7, 3) : 1;
      last = now;
      draw(step);
      frame = window.requestAnimationFrame(tick);
    }

    function start() {
      if (frame || calm() || document.hidden) return;
      last = 0;
      frame = window.requestAnimationFrame(tick);
    }

    function stop() {
      if (!frame) return;
      window.cancelAnimationFrame(frame);
      frame = 0;
    }

    function onMotionChange() {
      if (calm()) { stop(); draw(0); } else start();
    }

    readColors();
    resize();
    start();

    window.addEventListener('resize', function () {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(resize, 150);
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else start();
    });

    window.addEventListener('pointermove', function (event) {
      if (calm()) return;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.on = true;
    }, { passive: true });

    document.addEventListener('pointerleave', function () { pointer.on = false; });

    if (motion && motion.addEventListener) motion.addEventListener('change', onMotionChange);
    if (scheme && scheme.addEventListener) {
      scheme.addEventListener('change', function () {
        readColors();
        if (!frame) draw(0);
      });
    }
  }

  /* ==================================================================== *
   * Схема-фильм: кадры переключаются, как в колоде вердиктов
   *
   * Движок общий и ничего не знает про конкретную схему: он находит [data-film],
   * внутри — кадры [data-film-beat] и подписи [data-film-caption], и переставляет
   * между ними is-live. Всё остальное делает CSS. Отсюда:
   * — длительность кадра живёт рядом с его анимацией, в --dwell на самом кадре:
   *   два числа в двух файлах рано или поздно разъезжаются;
   * — ни одной строки текста и ни одной координаты в коде;
   * — схема стоит, когда её не смотрят, и не запускается вовсе при calmMotion():
   *   тогда на экране остаётся первый кадр — законченная статичная картинка.
   * ==================================================================== */

  function initFilm() {
    var films = document.querySelectorAll('[data-film]');
    for (var i = 0; i < films.length; i++) setupFilm(films[i]);
  }

  /**
   * Кадры по индексам: rows[i] — i-й кадр во всех раскладках схемы сразу.
   *
   * Раскладок у схемы может быть несколько: широкая для десктопа, вертикальная для
   * телефона и для ролика 9:16. Кадр у них один и тот же — разные только координаты,
   * — поэтому и переключаются они вместе, а показывает раскладку CSS: та, что сейчас
   * не нужна, стоит в display:none. Если раскладки разошлись числом кадров, движок
   * отказывается работать целиком: листать одну из них не туда хуже, чем не листать.
   */
  function beatRows(film) {
    var stages = film.querySelectorAll('[data-film-stage]');
    var rows = [];
    for (var s = 0; s < stages.length; s++) {
      var beats = stages[s].querySelectorAll('[data-film-beat]');
      if (s === 0) {
        for (var i = 0; i < beats.length; i++) rows.push([beats[i]]);
      } else {
        if (beats.length !== rows.length) return [];
        for (var j = 0; j < beats.length; j++) rows[j].push(beats[j]);
      }
    }
    return rows;
  }

  function setupFilm(film) {
    var beats = beatRows(film);
    var captions = film.querySelectorAll('[data-film-caption]');
    if (beats.length < 2) return;

    var stages = film.querySelectorAll('[data-film-stage]');
    var controls = film.querySelector('[data-film-controls]');
    var dots = film.querySelectorAll('[data-film-dot]');
    var index = 0;
    var timer = 0;
    var visible = false;
    var started = false;
    // Человек выбрал кадр руками — дальше схему ведёт он, а не таймер.
    var manual = false;

    // Длительность читается с первой раскладки: --dwell объявлен на классе кадра, а
    // класс у кадра во всех раскладках один — иначе это были бы два числа в двух местах.
    function dwellOf(at) {
      var value = parseFloat(window.getComputedStyle(beats[at][0]).getPropertyValue('--dwell'));
      return value > 0 ? value * 1000 : 6000;
    }

    function live(at, on) {
      for (var i = 0; i < beats[at].length; i++) beats[at][i].classList.toggle('is-live', on);
      if (captions[at]) captions[at].classList.toggle('is-live', on);
      if (dots[at]) {
        if (on) dots[at].setAttribute('aria-current', 'true');
        else dots[at].removeAttribute('aria-current');
      }
      // Длительность текущего кадра — наружу, на контейнер схемы: полоска прогресса на
      // поверхности записи (052) заливается ровно за неё. Числа у полоски своего нет
      // сознательно — второе число рано или поздно разъедется с --dwell кадра.
      if (on) film.style.setProperty('--film-dwell', dwellOf(at) + 'ms');
    }

    function show(next) {
      live(index, false);
      index = next;
      live(index, true);
    }

    // Первый кадр помечен живым прямо в разметке — иначе без JS схема была бы пустой.
    // Значит, к моменту, когда до неё долистали, он уже отыграл вхолостую: снимаем
    // класс и ставим обратно через reflow, чтобы анимация началась при зрителе.
    function replay() {
      for (var i = 0; i < beats[index].length; i++) {
        var beat = beats[index][i];
        beat.classList.remove('is-live');
        beat.getBoundingClientRect();
        beat.classList.add('is-live');
      }
    }

    function stop() {
      window.clearTimeout(timer);
      timer = 0;
    }

    function play() {
      stop();
      if (manual || !visible || calmMotion() || document.hidden) return;
      timer = window.setTimeout(function () {
        show((index + 1) % beats.length);
        play();
      }, dwellOf(index));
    }

    function wake() {
      if (!started && !calmMotion()) {
        started = true;
        replay();
      }
      play();
    }

    if (window.IntersectionObserver) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible) wake(); else stop();
      }, { threshold: 0.3 }).observe(film);
    } else {
      visible = true;
      wake();
    }

    // Курсор на схеме — её разглядывают: кадр не меняем, CSS в это же время держит
    // анимацию на паузе, так что картинка замирает целиком, а не наполовину. Слушают
    // именно сцены, а не весь блок: кнопки кадров под ними не должны считаться паузой.
    for (var st = 0; st < stages.length; st++) {
      stages[st].addEventListener('pointerenter', stop);
      stages[st].addEventListener('pointerleave', play);
    }

    // Кнопки открываются только когда их ровно столько же, сколько кадров: иначе
    // они молча листали бы не туда. Клик забирает управление у таймера насовсем —
    // кадр открыли, чтобы прочитать, а не чтобы он уехал через пять секунд.
    if (controls && dots.length === beats.length) {
      controls.hidden = false;
      for (var d = 0; d < dots.length; d++) {
        dots[d].addEventListener('click', (function (to) {
          return function () {
            manual = true;
            stop();
            if (to !== index) show(to);
          };
        })(d));
      }
    }
    live(index, true);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else play();
    });
  }

  function init() {
    initStats();
    initDemo();
    initTypedPlaceholder();
    initSampleDeck();
    initBackdrop();
    initFilm();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
