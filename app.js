/*!
 * 합동 비서실 — app.js
 * GitHub Pages + Firebase Realtime Database
 *
 * 데이터 위치: /office/{ROOM_KEY}/
 *   memos, memoFiles, images, notices
 */
(() => {
  'use strict';

  /* =========================================================
   * 0. 상수 · 상태
   * ========================================================= */
  const CFG = window.FIREBASE_CONFIG || {};

  const TAGS = ['지시', '요청', '보고', '메모'];
  const TAG_CLASS = { 지시: 'tag-order', 요청: 'tag-request', 보고: 'tag-report', 메모: 'tag-memo' };

  /* 이모지 반응 — Firebase 경로: {memos|notices}/{id}[/replies/{replyId}]/reactions/{이모지}/{이름} = true */
  const REACTIONS = [
    { emoji: '✅', label: '확인' },
    { emoji: '👍', label: '좋아요' },
    { emoji: '❤️', label: '최고' },
    { emoji: '👏', label: '박수' },
    { emoji: '👀', label: '읽음' }
  ];

  const MAX_IMAGE_SIDE = 1280;          // 긴 변 기준 리사이즈
  const JPEG_QUALITY = 0.85;            // 기본 압축 품질
  const MAX_WRITE_BYTES = 200 * 1024;   // 이미지 한 장이 가볍게 유지되도록

  /* 메모 첨부 파일 */
  const MAX_FILE_BYTES = 5 * 1024 * 1024;            // 첨부 1개 최대 5MB
  const MAX_ATTACH_TOTAL_BYTES = 15 * 1024 * 1024;   // 메모 한 건 합계 15MB
  const MAX_ATTACH_COUNT = 10;                       // 메모 한 건 최대 10개
  const ATTACH_IMAGE_SIDE = 1400;                    // 첨부 이미지 긴 변
  const ATTACH_IMAGE_BYTES = 300 * 1024;             // 첨부 이미지 압축 목표
  const FILE_CHUNK_CHARS = 512 * 1024;               // Base64 512K자씩 나눠 쓰기
  const IMAGE_COMPRESSIBLE = /^image\/(jpeg|pjpeg|png|webp|bmp|avif)$/i; // gif·svg·heic는 원본 유지

  const LS = {
    room: 'sharedOffice.roomKey.v1',
    project: 'sharedOffice.projectId.v1',
    author: 'sharedOffice.author.v1',
    notify: 'sharedOffice.notify.v1'
  };

  const state = {
    roomKey: '',
    db: null,
    base: null,
    connected: false,
    tab: 'memos',
    memos: {},
    images: {},
    notices: {},
    imagesLoaded: false,
    filters: { memo: 'all' },
    editing: { memo: null, notice: null, reply: null },
    drafts: { memo: '', notice: {} },
    openReplies: new Set(),
    replyDrafts: {},
    replyFiles: {},            // 글 ID → 답글에 첨부할 파일 목록
    replyEditDrafts: {},       // 답글 ID → 수정 중인 내용
    pendingFiles: [],          // 등록 전에 고른 첨부 파일
    attachPreviews: {},        // fileId → dataUrl (카드 썸네일 캐시)
    showRoomKey: false,
    listeners: [],
    notifyEnabled: false,      // 브라우저 알림 켜짐 여부
    memosLoaded: false,        // 첫 로딩이 끝났는지 (초기 데이터는 알리지 않는다)
    ownMemoIds: new Set()      // 이 화면에서 직접 올린 글 (알림 제외)
  };

  const dom = {};
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  /* =========================================================
   * 1. 유틸
   * ========================================================= */
  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, String(value));
      }
    }
    appendChildren(node, children);
    return node;
  }

  function appendChildren(node, children) {
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      if (Array.isArray(child)) appendChildren(node, child);
      else if (child instanceof Node) node.append(child);
      else node.append(document.createTextNode(String(child)));
    }
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  function fmtStamp(ts) {
    const n = Number(ts);
    if (!n) return '';
    const d = new Date(n);
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate();
    const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    if (sameDay) return `오늘 ${time}`;
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}월 ${d.getDate()}일 ${time}`;
    return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
  }

  function fmtDate(dateStr) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    if (!match) return dateStr || '';
    return `${Number(match[1])}. ${Number(match[2])}. ${Number(match[3])}.`;
  }

  function dday(dateStr) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    if (!match) return null;
    const target = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((target - today) / 86400000);
    if (diff === 0) return { label: 'D-day', cls: 'soon' };
    if (diff > 0) return { label: `D-${diff}`, cls: diff <= 3 ? 'soon' : '' };
    return { label: `D+${-diff}`, cls: 'over' };
  }

  function fmtBytes(bytes) {
    const n = Number(bytes);
    if (!n) return '';
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
  }

  function dataUrlBytes(dataUrl) {
    const comma = String(dataUrl || '').indexOf(',');
    if (comma < 0) return 0;
    return Math.round(((dataUrl.length - comma - 1) * 3) / 4);
  }

  function safeImageSrc(value) {
    const src = String(value || '');
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(src)) return src;
    if (/^https:\/\//i.test(src)) return src;
    return '';
  }

  function safeFileName(name, fallback = 'office-image') {
    const cleaned = String(name || '')
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[\\/:*?"<>|\n\r\t]+/g, ' ')
      .trim()
      .slice(0, 40);
    return cleaned || fallback;
  }

  function dataUrlToBlob(dataUrl) {
    const match = /^data:([^;,]*)?(;base64)?,/i.exec(String(dataUrl || ''));
    if (!match) throw new Error('파일 형식이 올바르지 않습니다.');
    const body = String(dataUrl).slice(match[0].length);
    const type = match[1] || 'application/octet-stream';
    if (!match[2]) return new Blob([decodeURIComponent(body)], { type });
    const binary = window.atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('파일을 읽지 못했습니다.'));
      reader.readAsDataURL(file);
    });
  }

  function isImageType(type) {
    return /^image\//i.test(String(type || ''));
  }

  function fileExt(name) {
    const match = /\.([a-z0-9]{1,5})$/i.exec(String(name || ''));
    return match ? match[1].toUpperCase() : 'FILE';
  }

  function replaceExt(name, ext) {
    const base = String(name || 'file').replace(/\.[a-z0-9]{1,6}$/i, '').trim();
    return `${base || 'file'}.${ext}`;
  }

  function downloadFileName(name, type) {
    const base = String(name || 'file').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').trim().slice(0, 120) || 'file';
    if (String(type).toLowerCase() === 'image/jpeg' && !/\.jpe?g$/i.test(base)) return replaceExt(base, 'jpg');
    return base;
  }

  /* =========================================================
   * 1.5 서식 있는 글 (안전한 HTML 화이트리스트)
   *  - 저장은 { text: 평문, html?: 정리된 HTML } 두 가지를 함께 둔다.
   *  - 화면에 그릴 때도 한 번 더 sanitize 해서 외부(REST)에서 들어온 값도 안전하게 다룬다.
   * ========================================================= */
  const RICH_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'span', 'br', 'p', 'div']);
  const RICH_DROP_BLOCK = [
    'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript',
    'head', 'title', 'textarea', 'select', 'button', 'form', 'input', 'img', 'video', 'audio',
    'canvas', 'link', 'meta', 'base', 'frameset', 'frame', 'applet'
  ];
  const STRICT_COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+|\d{1,3}%)\s*)?\)|var\(--rt-[a-z]{3,12}\)|[a-z]{3,20})$/i;
  const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

  function decodeHtmlEntities(value) {
    return String(value == null ? '' : value).replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body) => {
      if (body.charAt(0) === '#') {
        const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
        const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
        try { return String.fromCodePoint(code); } catch (err) { return ''; }
      }
      const key = body.toLowerCase();
      return Object.prototype.hasOwnProperty.call(HTML_ENTITIES, key) ? HTML_ENTITIES[key] : match;
    });
  }

  function escapeHtmlText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function safeStyleColor(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    if (raw === 'inherit' || raw === 'currentcolor') return 'inherit';
    return STRICT_COLOR.test(raw) ? raw : '';
  }

  /* style 속성에서 색만 뽑아 쓴다. 그 밖의 선언(위치·폭·배경이미지 등)은 모두 버린다. */
  function richStyleDecls(raw) {
    const out = [];
    String(raw || '').split(';').forEach((decl) => {
      const idx = decl.indexOf(':');
      if (idx < 0) return;
      const prop = decl.slice(0, idx).trim().toLowerCase();
      if (prop !== 'color' && prop !== 'background-color') return;
      const color = safeStyleColor(decl.slice(idx + 1));
      if (color) out.push(`${prop}: ${color}`);
    });
    return out;
  }

  function sanitizeRichHtml(source) {
    let text = String(source == null ? '' : source);
    text = text.replace(/<!--[\s\S]*?-->/g, '');
    RICH_DROP_BLOCK.forEach((tag) => {
      text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '');
      text = text.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), '');
    });

    let out = '';
    let index = 0;
    const stack = [];
    const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
    let match = tagRe.exec(text);
    while (match) {
      out += escapeHtmlText(decodeHtmlEntities(text.slice(index, match.index)));
      index = tagRe.lastIndex;
      const rawTag = match[0];
      const tag = match[1].toLowerCase();
      const closing = rawTag.charAt(1) === '/';
      const selfClosing = /\/>$/.test(rawTag);
      if (RICH_TAGS.has(tag)) {
        if (tag === 'br') {
          out += '<br>';
        } else if (closing || selfClosing) {
          for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
            if (stack[depth].tag === tag) {
              while (stack.length > depth) out += stack.pop().close;
              break;
            }
          }
        } else {
          const styleAttr = /style\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(match[2] || '');
          const style = styleAttr
            ? richStyleDecls(styleAttr[2] !== undefined ? styleAttr[2] : (styleAttr[3] !== undefined ? styleAttr[3] : styleAttr[4]))
            : [];
          if (tag === 'span') {
            // 색 정보가 없는 span은 의미가 없으니 버린다.
            if (style.length) {
              out += `<span style="${style.join('; ')}">`;
              stack.push({ tag, close: '</span>' });
            }
          } else {
            let close = `</${tag}>`;
            out += `<${tag}>`;
            if (style.length) {
              out += `<span style="${style.join('; ')}">`;
              close = `</span>${close}`;
            }
            stack.push({ tag, close });
          }
        }
      }
      match = tagRe.exec(text);
    }
    out += escapeHtmlText(decodeHtmlEntities(text.slice(index)));
    while (stack.length) out += stack.pop().close;
    return out;
  }

  /* 화면에 보이는 그대로의 평문 (check.sh·AI 연동·미리보기용) */
  function richTextToPlain(html) {
    const plain = decodeHtmlEntities(String(html == null ? '' : html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<(div|p)\b[^>]*>/gi, '\n')
      .replace(/<\/(div|p)\s*>/gi, '')
      .replace(/<[^>]*>/g, ''));
    return plain
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^[\s\n]+/, '')
      .replace(/[\s\n]+$/, '');
  }

  function richHasFormat(html) {
    return /<\/?(b|strong|i|em|u)\b|style\s*=/i.test(String(html || ''));
  }

  function plainToEditorHtml(text) {
    return String(text == null ? '' : text)
      .split(/\r\n|\r|\n/)
      .map((line) => escapeHtmlText(line))
      .join('<br>');
  }

  function itemRichHtml(item, plainKey) {
    const stored = item && typeof item.html === 'string' ? item.html : '';
    if (!stored) return '';
    const clean = sanitizeRichHtml(stored);
    return richHasFormat(clean) ? clean : '';
  }

  function editorHtmlFor(item, plainKey) {
    return itemRichHtml(item, plainKey) || plainToEditorHtml(item && item[plainKey]);
  }

  /* 서식이 있으면 안전한 HTML로, 없으면 기존 평문 그대로 그린다 */
  function richBody(tag, className, item, plainKey) {
    const node = h(tag, { class: className });
    const html = itemRichHtml(item, plainKey);
    if (html) node.innerHTML = html;
    else node.textContent = String((item && item[plainKey]) || '');
    return node;
  }

  /* Firebase 키로 쓸 수 없는 문자(. $ # [ ] /)를 없앤다 */
  function fbKey(value) {
    const safe = String(value == null ? '' : value)
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[.$#\[\]\/\u0000-\u001f\u007f]/g, '_')
      .slice(0, 40)
      .trim();
    return safe || '이름 없음';
  }

  /* =========================================================
   * 1.6 서식 툴바 · 편집기 (contenteditable)
   * ========================================================= */
  const EDITOR_LIMITS = { memo: 2000, notice: 4000, 'memo-edit': 2000, 'notice-edit': 4000 };
  const FORMAT_COLORS = [
    { value: 'inherit', label: '기본' },
    { value: 'var(--rt-red)', label: '빨강' },
    { value: 'var(--rt-blue)', label: '파랑' },
    { value: 'var(--rt-green)', label: '초록' },
    { value: 'var(--rt-orange)', label: '주황' }
  ];
  let savedEditorRange = null;

  function editorLimit(key) {
    return EDITOR_LIMITS[String(key || '').split(':')[0]] || 2000;
  }

  function toolbarControls() {
    const controls = [];
    const button = (props, ...children) => h('button', Object.assign({ type: 'button', class: 'fmt-btn' }, props), ...children);
    controls.push(button({ 'data-fmt': 'bold', title: '굵게 (Ctrl+B)', 'aria-label': '굵게' }, h('b', {}, 'B')));
    controls.push(button({ 'data-fmt': 'italic', title: '기울임 (Ctrl+I)', 'aria-label': '기울임' }, h('i', {}, 'I')));
    controls.push(button({ 'data-fmt': 'underline', title: '밑줄 (Ctrl+U)', 'aria-label': '밑줄' }, h('u', {}, 'U')));
    controls.push(h('span', { class: 'fmt-sep', 'aria-hidden': 'true' }));
    controls.push(h('span', { class: 'fmt-label' }, '글자색'));
    FORMAT_COLORS.forEach((color) => {
      controls.push(h('button', {
        type: 'button',
        class: `fmt-swatch${color.value === 'inherit' ? ' is-default' : ''}`,
        'data-fmt': 'color',
        'data-value': color.value,
        style: color.value === 'inherit' ? null : `--swatch: ${color.value}`,
        title: `글자색 ${color.label}`,
        'aria-label': `글자색 ${color.label}`
      }));
    });
    controls.push(h('span', { class: 'fmt-sep', 'aria-hidden': 'true' }));
    controls.push(button({ 'data-fmt': 'highlight', class: 'fmt-btn fmt-highlight', title: '형광펜', 'aria-label': '형광펜' }, '형광펜'));
    controls.push(button({ 'data-fmt': 'clear', title: '서식 지우기', 'aria-label': '서식 지우기' }, '서식 지우기'));
    return controls;
  }

  function mountToolbars() {
    $$('[data-toolbar]').forEach((host) => {
      if (host.children && host.children.length) return;
      host.append(...toolbarControls());
    });
  }

  function updateEditorEmpty(el) {
    if (!el) return;
    const empty = !richTextToPlain(sanitizeRichHtml(el.innerHTML || '')).trim();
    el.setAttribute('data-empty', empty ? 'true' : 'false');
  }

  function editorValue(el) {
    if (!el) return { html: '', text: '' };
    const clean = sanitizeRichHtml(el.innerHTML || '');
    return { html: clean, text: richTextToPlain(clean) };
  }

  function setEditorHtml(el, html) {
    if (!el) return;
    el.innerHTML = sanitizeRichHtml(html || '');
    updateEditorEmpty(el);
  }

  /* 다시 그린 뒤 빈 편집기의 안내문(placeholder) 상태를 맞춘다 */
  function refreshEditors(root) {
    $$('[data-editor]', root || document).forEach((el) => updateEditorEmpty(el));
  }

  function caretOffset(el) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.startContainer)) return null;
    const pre = range.cloneRange();
    pre.selectNodeContents(el);
    try { pre.setEnd(range.startContainer, range.startOffset); } catch (err) { return null; }
    return pre.toString().length;
  }

  function setCaretOffset(el, offset) {
    const target = Math.max(0, Number(offset) || 0);
    if (typeof document.createTreeWalker !== 'function') return;
    const walker = document.createTreeWalker(el, 4 /* SHOW_TEXT */);
    let remaining = target;
    let node = walker.nextNode();
    while (node) {
      const length = node.nodeValue ? node.nodeValue.length : 0;
      if (remaining <= length) {
        const range = document.createRange();
        range.setStart(node, remaining);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      remaining -= length;
      node = walker.nextNode();
    }
  }

  function editorSelection(editor) {
    if (typeof window.getSelection !== 'function') return null;
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      if (editor.contains(range.commonAncestorContainer)) return range;
    }
    if (savedEditorRange && editor.contains(savedEditorRange.commonAncestorContainer)) {
      sel.removeAllRanges();
      sel.addRange(savedEditorRange);
      return savedEditorRange;
    }
    return null;
  }

  function wrapRange(range, wrapper) {
    const fragment = range.extractContents();
    wrapper.appendChild(fragment);
    range.insertNode(wrapper);
    const sel = window.getSelection();
    if (sel) {
      const next = document.createRange();
      next.selectNodeContents(wrapper);
      sel.removeAllRanges();
      sel.addRange(next);
    }
    return wrapper;
  }

  function unwrapNode(node) {
    const parent = node.parentNode;
    if (!parent) return;
    const first = node.firstChild;
    const last = node.lastChild;
    while (node.firstChild) parent.insertBefore(node.firstChild, node);
    parent.removeChild(node);
    if (typeof parent.normalize === 'function') parent.normalize();
    const sel = window.getSelection();
    if (sel && first && last && first.parentNode && last.parentNode) {
      try {
        const range = document.createRange();
        range.setStartBefore(first);
        range.setEndAfter(last);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (err) { /* 선택 복원은 실패해도 괜찮다 */ }
    }
  }

  function closestTag(node, selector, root) {
    let el = node && node.nodeType === 1 ? node : (node && node.parentElement ? node.parentElement : null);
    while (el && el !== root) {
      if (el.matches && el.matches(selector)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function toggleTag(editor, range, tag) {
    const existing = closestTag(range.commonAncestorContainer, tag, editor) ||
      closestTag(range.startContainer, tag, editor);
    if (existing) unwrapNode(existing);
    else wrapRange(range, document.createElement(tag));
  }

  function styleSpan(prop, value) {
    const span = document.createElement('span');
    span.setAttribute('style', `${prop}: ${safeStyleColor(value) || 'inherit'}`);
    return span;
  }

  const INLINE_FORMAT_TAG = /^(B|STRONG|I|EM|U|SPAN|FONT)$/i;

  function rangeHtml(range) {
    const holder = document.createElement('div');
    holder.appendChild(range.cloneContents());
    return holder.innerHTML;
  }

  /* 선택이 닿은 인라인 서식 요소를 벗긴다 (글자는 그대로 남는다) */
  function unwrapInlineAncestors(node, editor) {
    if (!node) return;
    const chain = [];
    let el = node.nodeType === 1 ? node : node.parentNode;
    while (el && el !== editor) {
      if (el.tagName && INLINE_FORMAT_TAG.test(el.tagName)) chain.push(el);
      el = el.parentNode;
    }
    chain.forEach((element) => {
      const parent = element.parentNode;
      if (!parent) return;
      while (element.firstChild) parent.insertBefore(element.firstChild, element);
      parent.removeChild(element);
      if (typeof parent.normalize === 'function') parent.normalize();
    });
  }

  /* 선택 구간의 서식을 벗긴다. 전체를 고른 경우에는 편집기 전체를 평문으로 다시 그린다. */
  function clearEditorFormat(editor, range) {
    if (!editor) return;
    const selected = richTextToPlain(rangeHtml(range));
    const whole = richTextToPlain(editor.innerHTML);
    if (selected && selected === whole) {
      setEditorHtml(editor, plainToEditorHtml(whole));
      editor.focus();
      const end = document.createRange();
      end.selectNodeContents(editor);
      end.collapse(false);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(end);
      }
      return;
    }
    unwrapInlineAncestors(range.startContainer, editor);
    unwrapInlineAncestors(range.endContainer, editor);
    const sel = window.getSelection();
    if (sel && editor.contains(range.startContainer)) {
      try {
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (err) { /* 무시 */ }
    }
  }

  function applyFormat(fmt, value, editor) {
    if (!editor) return;
    editor.focus();
    const range = editorSelection(editor);
    if (!range || (range.collapsed && fmt !== 'clear')) {
      toast('서식을 적용할 글자를 먼저 선택해 주세요.');
      return;
    }
    if (fmt === 'clear') {
      if (range.collapsed) { toast('서식을 지울 글자를 먼저 선택해 주세요.'); return; }
      clearEditorFormat(editor, range);
    } else if (fmt === 'bold') toggleTag(editor, range, 'b');
    else if (fmt === 'italic') toggleTag(editor, range, 'i');
    else if (fmt === 'underline') toggleTag(editor, range, 'u');
    else if (fmt === 'color') wrapRange(range, styleSpan('color', value || 'inherit'));
    else if (fmt === 'highlight') wrapRange(range, styleSpan('background-color', 'var(--rt-highlight)'));
    updateEditorEmpty(editor);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function insertPlainText(editor, text) {
    if (!editor || typeof window.getSelection !== 'function') return;
    editor.focus();
    const sel = window.getSelection();
    if (!sel) return;
    let range = sel.rangeCount ? sel.getRangeAt(0) : null;
    if (!range || !editor.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    range.deleteContents();
    const lines = String(text == null ? '' : text).split(/\r\n|\r|\n/);
    const fragment = document.createDocumentFragment();
    const nodes = [];
    lines.forEach((line, index) => {
      if (index) {
        const br = document.createElement('br');
        fragment.appendChild(br);
        nodes.push(br);
      }
      if (line) {
        const textNode = document.createTextNode(line);
        fragment.appendChild(textNode);
        nodes.push(textNode);
      }
    });
    if (!nodes.length) return;
    const last = nodes[nodes.length - 1];
    range.insertNode(fragment);
    try {
      const after = document.createRange();
      after.setStartAfter(last);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    } catch (err) { /* 무시 */ }
    updateEditorEmpty(editor);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /* 붙여넣기는 서식·HTML을 버리고 글자만 넣는다 (엉뚱한 태그가 들어오지 않게) */
  function onEditorPaste(event, options) {
    const editor = event.target.closest('[data-editor]');
    if (!editor) return;
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const files = [];
    if (clipboard.files && clipboard.files.length) files.push(...Array.from(clipboard.files));
    else if (clipboard.items) {
      Array.from(clipboard.items).forEach((item) => {
        if (item.kind !== 'file') return;
        const file = item.getAsFile();
        if (file) files.push(file);
      });
    }
    if (files.length) {
      event.preventDefault();
      if (!options || !options.allowFiles) {
        toast('이 칸에는 글자만 붙여넣을 수 있습니다.');
        return;
      }
      addPendingFiles(files);
      toast(files.length === 1 ? '붙여넣은 파일을 첨부에 더했습니다.' : `붙여넣은 파일 ${files.length}개를 첨부에 더했습니다.`);
      return;
    }
    event.preventDefault();
    insertPlainText(editor, clipboard.getData('text/plain') || clipboard.getData('text') || '');
  }

  function onEditorKeydown(event) {
    const editor = event.target.closest('[data-editor]');
    if (!editor) return;
    const meta = event.metaKey || event.ctrlKey;
    if (!meta) return;
    const key = String(event.key || '').toLowerCase();
    if (key !== 'b' && key !== 'i' && key !== 'u') return;
    event.preventDefault();
    applyFormat(key === 'b' ? 'bold' : (key === 'i' ? 'italic' : 'underline'), null, editor);
  }

  function onToolbarClick(event) {
    const button = event.target.closest ? event.target.closest('[data-fmt]') : null;
    if (!button) return;
    event.preventDefault();
    const shell = button.closest('.editor-shell');
    const editor = shell ? shell.querySelector('[data-editor]') : null;
    applyFormat(button.getAttribute('data-fmt'), button.getAttribute('data-value'), editor);
  }

  function onToolbarMouseDown(event) {
    if (event.target.closest && event.target.closest('[data-fmt]')) event.preventDefault();
  }

  function trackEditorSelection() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    const el = node && node.nodeType === 1 ? node : (node && node.parentElement ? node.parentElement : null);
    const editor = el && el.closest ? el.closest('[data-editor]') : null;
    if (editor) savedEditorRange = range.cloneRange();
  }

  /* 다시 그릴 때 입력 중이던 칸과 커서 위치를 되살린다 (다른 사람의 글이 실시간으로 들어와도 타이핑이 끊기지 않게) */
  const FOCUS_ATTRS = ['data-reply-text', 'data-reply-author', 'data-reply-edit-text', 'data-edit-text', 'data-notice-reply-text', 'data-editor'];

  function rememberFocus(root) {
    const el = document.activeElement;
    if (!root || !el || !root.contains(el)) return null;
    if (el.matches('[contenteditable="true"]')) {
      const key = el.getAttribute('data-editor');
      if (!key) return null;
      const offset = caretOffset(el);
      return { selector: `[data-editor="${key}"]`, rich: true, start: offset, end: offset };
    }
    if (!el.matches('input, textarea, select')) return null;
    let selector = '';
    for (const attr of FOCUS_ATTRS) {
      const value = el.getAttribute(attr);
      if (value) {
        selector = `${el.tagName.toLowerCase()}[${attr}="${value}"]`;
        break;
      }
    }
    if (!selector) {
      const field = el.getAttribute('data-field');
      if (field) selector = `${el.tagName.toLowerCase()}[data-field="${field}"]`;
    }
    if (!selector) return null;
    let start = null;
    let end = null;
    try {
      start = el.selectionStart;
      end = el.selectionEnd;
    } catch (err) { /* select에는 selectionStart가 없다 */ }
    return { selector, start, end };
  }

  function restoreFocus(root, saved) {
    if (!root || !saved) return;
    const el = root.querySelector(saved.selector);
    if (!el) return;
    el.focus();
    if (saved.rich) {
      if (typeof saved.start === 'number') setCaretOffset(el, saved.start);
      return;
    }
    if (typeof saved.start === 'number') {
      try { el.setSelectionRange(saved.start, saved.end); } catch (err) { /* 무시 */ }
    }
  }

  let toastTimer = 0;
  function toast(message) {
    if (!dom.toast) return;
    dom.toast.textContent = message;
    dom.toast.hidden = false;
    // 다음 프레임에 show를 붙여야 전환 애니메이션이 동작한다.
    requestAnimationFrame(() => dom.toast.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      dom.toast.classList.remove('show');
      toastTimer = window.setTimeout(() => { dom.toast.hidden = true; }, 220);
    }, 2600);
  }

  function isPermissionError(err) {
    const text = `${(err && err.code) || ''} ${(err && err.message) || ''}`;
    return /permission[_\s-]?denied/i.test(text);
  }

  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        const err = new Error('timeout');
        err.timeout = true;
        reject(err);
      }, ms);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (err) => { clearTimeout(timer); reject(err); }
      );
    });
  }

  async function copyText(text, label = '내용') {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        document.body.append(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      toast(`${label} 복사했습니다.`);
    } catch (err) {
      toast('복사하지 못했습니다. 직접 선택해 주세요.');
    }
  }

  /* =========================================================
   * 2. 부팅
   * ========================================================= */
  document.addEventListener('DOMContentLoaded', boot);

  function boot() {
    cacheDom();
    mountToolbars();
    bindEvents();
    hydrateAuthorFields();
    initNotifyState();
    [dom.memoText, dom.noticeText].forEach((editor) => { if (editor) updateEditorEmpty(editor); });

    if (!isConfigured()) {
      hideBoot();
      showLock();
      if (dom.configWarning) dom.configWarning.hidden = false;
      if (dom.unlockButton) dom.unlockButton.disabled = true;
      if (dom.password) dom.password.disabled = true;
      return;
    }

    const savedKey = localStorage.getItem(LS.room);
    const savedProject = localStorage.getItem(LS.project);
    if (savedKey && savedProject === CFG.projectId) {
      enterRoom(savedKey).catch((err) => {
        hideBoot();
        showLock();
        setLockError(err.message || '입장하지 못했습니다.');
      });
    } else {
      hideBoot();
      showLock();
    }
  }

  function cacheDom() {
    dom.boot = $('#boot');
    dom.lock = $('#lock-screen');
    dom.lockForm = $('#unlock-form');
    dom.password = $('#lock-password');
    dom.unlockButton = $('#unlock-button');
    dom.lockError = $('#lock-error');
    dom.configWarning = $('#config-warning');
    dom.app = $('#app');
    dom.connection = $('#connection');
    dom.connectionText = $('#connection-text');
    dom.lockButton = $('#lock-button');
    dom.tabs = $$('.tab');

    dom.notifyToggle = $('#notify-toggle');
    dom.notifyBanner = $('#notify-banner');
    dom.notifyBannerTitle = $('#notify-banner-title');
    dom.notifyBannerText = $('#notify-banner-text');
    dom.notifyBannerClose = $('#notify-banner-close');

    dom.memoForm = $('#memo-form');
    dom.memoAuthor = $('#memo-author');
    dom.memoTag = $('#memo-tag');
    dom.memoText = $('#memo-text');
    dom.memoSubmit = $('#memo-submit');
    dom.memoFilter = $('#memo-filter');
    dom.memoList = $('#memo-list');
    dom.memoEmpty = $('#memo-empty');
    dom.memoBadge = $('#memo-badge');
    dom.memoAttachButton = $('#memo-attach-button');
    dom.memoFiles = $('#memo-files');
    dom.memoFileList = $('#memo-file-list');
    dom.memoFileNote = $('#memo-file-note');

    dom.imageForm = $('#image-form');
    dom.imageDrop = $('#image-drop');
    dom.imageFiles = $('#image-files');
    dom.imageSelected = $('#image-selected');
    dom.imageAuthor = $('#image-author');
    dom.imageTitle = $('#image-title');
    dom.imageSubmit = $('#image-submit');
    dom.imageProgress = $('#image-progress');
    dom.imageList = $('#image-list');
    dom.imageEmpty = $('#image-empty');

    dom.noticeForm = $('#notice-form');
    dom.noticeTitle = $('#notice-title');
    dom.noticeAuthor = $('#notice-author');
    dom.noticeImportant = $('#notice-important');
    dom.noticePinned = $('#notice-pinned');
    dom.noticeText = $('#notice-text');
    dom.noticeSubmit = $('#notice-submit');
    dom.noticeList = $('#notice-list');
    dom.noticeEmpty = $('#notice-empty');

    dom.aiContent = $('#ai-content');

    dom.modal = $('#image-modal');
    dom.modalTitle = $('#modal-title');
    dom.modalImage = $('#modal-image');
    dom.modalMeta = $('#modal-meta');
    dom.modalDownload = $('#modal-download');
    dom.modalClose = $('#modal-close');

    dom.toast = $('#toast');
  }

  function bindEvents() {
    dom.lockForm.addEventListener('submit', onUnlock);
    dom.lockButton.addEventListener('click', onLock);

    dom.tabs.forEach((tab) => {
      tab.addEventListener('click', () => selectTab(tab.dataset.tab));
      tab.addEventListener('keydown', onTabKeydown);
    });

    dom.memoForm.addEventListener('submit', onAddMemo);
    dom.memoText.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        dom.memoForm.requestSubmit();
        return;
      }
      onEditorKeydown(event);
    });
    dom.memoText.addEventListener('input', () => updateEditorEmpty(dom.memoText));
    if (dom.notifyToggle) dom.notifyToggle.addEventListener('click', onToggleNotify);
    if (dom.notifyBannerClose) dom.notifyBannerClose.addEventListener('click', hideNotifyBanner);
    if (dom.notifyBanner) dom.notifyBanner.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      const memoId = dom.notifyBanner.getAttribute('data-memo');
      hideNotifyBanner();
      if (memoId) focusMemo(memoId);
    });

    // --- 첨부 파일 ---
    if (dom.memoAttachButton && dom.memoFiles) {
      dom.memoAttachButton.addEventListener('click', () => dom.memoFiles.click());
      dom.memoFiles.addEventListener('change', () => {
        addPendingFiles(dom.memoFiles.files);
        dom.memoFiles.value = '';
      });
    }
    if (dom.memoFileList) {
      dom.memoFileList.addEventListener('click', (event) => {
        const button = event.target.closest('[data-remove-file]');
        if (!button) return;
        removePendingFile(Number(button.getAttribute('data-remove-file')));
      });
    }
    if (dom.memoText) dom.memoText.addEventListener('paste', (event) => onEditorPaste(event, { allowFiles: true }));
    bindMemoDrop();

    dom.memoList.addEventListener('click', onMemoClick);
    dom.memoList.addEventListener('change', onMemoChange);
    dom.memoList.addEventListener('submit', onReplySubmit);
    dom.memoList.addEventListener('input', onMemoInput);
    dom.memoList.addEventListener('keydown', onEditorKeydown);
    dom.memoList.addEventListener('paste', (event) => onEditorPaste(event, { allowFiles: true }));
    dom.memoFilter.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-filter]');
      if (!chip) return;
      state.filters.memo = chip.dataset.filter;
      renderMemos();
    });

    dom.imageForm.addEventListener('submit', onUploadImages);
    dom.imageFiles.addEventListener('change', onImagePicked);
    dom.imageList.addEventListener('click', onImageClick);
    bindDropzone();

    dom.noticeForm.addEventListener('submit', onAddNotice);
    dom.noticeText.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        dom.noticeForm.requestSubmit();
        return;
      }
      onEditorKeydown(event);
    });
    dom.noticeText.addEventListener('input', () => updateEditorEmpty(dom.noticeText));
    dom.noticeList.addEventListener('click', onNoticeClick);
    dom.noticeList.addEventListener('submit', onNoticeEditSubmit);
    dom.noticeList.addEventListener('submit', onReplySubmit);
    dom.noticeList.addEventListener('input', onNoticeDraftInput);
    dom.noticeList.addEventListener('change', onNoticeDraftInput);
    dom.noticeList.addEventListener('keydown', onEditorKeydown);
    dom.noticeList.addEventListener('paste', (event) => onEditorPaste(event, { allowFiles: false }));

    document.addEventListener('click', onToolbarClick);
    document.addEventListener('mousedown', onToolbarMouseDown);
    document.addEventListener('selectionchange', trackEditorSelection);

    dom.aiContent.addEventListener('click', onAiClick);

    dom.modalClose.addEventListener('click', () => dom.modal.close());
    dom.modal.addEventListener('click', (event) => {
      if (event.target === dom.modal) dom.modal.close();
    });
    dom.modal.addEventListener('close', () => {
      dom.modalImage.removeAttribute('src');
      dom.modalImage.alt = '';
      const blobUrl = dom.modalDownload.dataset.blobUrl;
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        delete dom.modalDownload.dataset.blobUrl;
        dom.modalDownload.removeAttribute('href');
      }
    });
  }

  function hydrateAuthorFields() {
    const saved = localStorage.getItem(LS.author) || '';
    if (saved) {
      if (dom.memoAuthor && !dom.memoAuthor.value) dom.memoAuthor.value = saved;
      if (dom.noticeAuthor && !dom.noticeAuthor.value) dom.noticeAuthor.value = saved;
      if (dom.imageAuthor && !dom.imageAuthor.value) dom.imageAuthor.value = saved;
    }
  }

  /* =========================================================
   * 3. 화면 전환 · 잠금
   * ========================================================= */
  function hideBoot() {
    if (dom.boot) dom.boot.hidden = true;
  }

  function showLock() {
    hideBoot();
    if (dom.app) dom.app.hidden = true;
    if (dom.lock) dom.lock.hidden = false;
    window.setTimeout(() => {
      if (dom.password && !dom.password.disabled) dom.password.focus();
    }, 60);
  }

  function showApp() {
    hideBoot();
    if (dom.lock) dom.lock.hidden = true;
    if (dom.app) dom.app.hidden = false;
    hydrateAuthorFields();
    renderAll();
    selectTab(state.tab);
  }

  function setLockError(message) {
    if (!dom.lockError) return;
    dom.lockError.textContent = message || '';
    dom.lockError.hidden = !message;
  }

  function setLockBusy(busy) {
    if (!dom.unlockButton) return;
    dom.unlockButton.disabled = busy;
    dom.unlockButton.textContent = busy ? '확인 중…' : '입장하기';
    if (dom.password) dom.password.disabled = busy;
    if (!busy && dom.lock && !dom.lock.hidden && dom.password) dom.password.focus();
  }

  function isConfigured() {
    const projectId = String(CFG.projectId || '').trim();
    const databaseURL = String(CFG.databaseURL || '').trim();
    if (!projectId || !databaseURL) return false;
    if (/^(YOUR|EXAMPLE|PLACEHOLDER)/i.test(projectId)) return false;
    if (/YOUR_|example\.com|placeholder/i.test(databaseURL)) return false;
    return true;
  }

  async function roomKeyFromPassword(password) {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('이 브라우저에서는 암호화 기능을 쓸 수 없습니다. HTTPS 주소로 접속해 주세요.');
    }
    const bytes = new TextEncoder().encode(`${CFG.projectId}:${password}`);
    const digest = await window.crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 32);
  }

  async function onUnlock(event) {
    event.preventDefault();
    const password = dom.password.value;
    if (!password) {
      setLockError('비밀번호를 입력해 주세요.');
      dom.password.focus();
      return;
    }
    setLockError('');
    setLockBusy(true);
    try {
      const key = await roomKeyFromPassword(password);
      await enterRoom(key);
      dom.password.value = '';
    } catch (err) {
      showLock();
      setLockError(err.message || '입장하지 못했습니다.');
    } finally {
      setLockBusy(false);
    }
  }

  function onLock() {
    detachListeners();
    localStorage.removeItem(LS.room);
    state.roomKey = '';
    state.memos = {};
    state.images = {};
    state.notices = {};
    state.imagesLoaded = false;
    state.memosLoaded = false;
    state.ownMemoIds.clear();
    state.editing = { memo: null, notice: null, reply: null };
    state.drafts = { memo: '', notice: {} };
    state.openReplies.clear();
    state.replyDrafts = {};
    state.replyFiles = {};
    state.replyEditDrafts = {};
    state.attachPreviews = {};
    clearPendingFiles();
    showLock();
    setLockError('');
    if (dom.password) dom.password.value = '';
    toast('잠겼습니다. 비밀번호를 입력해 다시 입장하세요.');
  }

  /* =========================================================
   * 4. Firebase 연결
   * ========================================================= */
  async function enterRoom(key) {
    if (!window.firebase) {
      throw new Error('Firebase SDK를 불러오지 못했습니다. 네트워크 연결을 확인해 주세요.');
    }
    initFirebase(key);

    try {
      await withTimeout(state.base.child('memos').once('value'), 15000);
    } catch (err) {
      state.roomKey = '';
      if (isPermissionError(err)) {
        localStorage.removeItem(LS.room);
        throw new Error('비밀번호가 맞지 않거나, Firebase 보안 규칙이 아직 설정되지 않았습니다.');
      }
      if (err && err.timeout) {
        throw new Error('서버 응답이 없습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.');
      }
      throw new Error('연결하지 못했습니다. Firebase 설정을 확인해 주세요.');
    }

    state.roomKey = key;
    localStorage.setItem(LS.room, key);
    localStorage.setItem(LS.project, CFG.projectId);
    attachListeners();
    showApp();
  }

  function initFirebase(key) {
    if (!state.db) {
      try {
        window.firebase.app();
      } catch (err) {
        window.firebase.initializeApp(CFG);
      }
      state.db = window.firebase.database();
    }
    state.base = state.db.ref(`office/${key}`);
  }

  function childRef(path) {
    return state.base.child(path);
  }

  function attachListeners() {
    detachListeners();

    const onDenied = (err) => {
      if (isPermissionError(err)) {
        detachListeners();
        localStorage.removeItem(LS.room);
        state.roomKey = '';
        showLock();
        setLockError('접근 권한이 없습니다. 비밀번호와 Firebase 보안 규칙을 확인해 주세요.');
      } else {
        toast('데이터 연결에 문제가 생겼습니다. 잠시 후 새로고침해 주세요.');
      }
    };

    const listen = (ref, event, callback) => {
      ref.on(event, callback, onDenied);
      state.listeners.push({ ref, event });
    };

    listen(state.base.child('memos'), 'value', (snap) => {
      const previous = state.memos || {};
      const next = snap.val() || {};
      if (state.memosLoaded) announceNewActivity(previous, next);
      state.memos = next;
      state.memosLoaded = true;
      renderMemos();
    });
    listen(state.base.child('notices'), 'value', (snap) => {
      state.notices = snap.val() || {};
      renderNotices();
    });

    const imagesRef = state.base.child('images');
    const setImage = (snap) => {
      if (snap.val() === null) delete state.images[snap.key];
      else state.images[snap.key] = snap.val();
      renderImages();
    };
    listen(imagesRef, 'child_added', setImage);
    listen(imagesRef, 'child_changed', setImage);
    listen(imagesRef, 'child_removed', setImage);
    imagesRef.once('value').then(() => {
      state.imagesLoaded = true;
      renderImages();
    }).catch(onDenied);

    listen(state.db.ref('.info/connected'), 'value', (snap) => {
      state.connected = snap.val() === true;
      renderConnection();
    });
  }

  function detachListeners() {
    state.listeners.forEach(({ ref, event }) => {
      try { ref.off(event); } catch (err) { /* 이미 분리됨 */ }
    });
    state.listeners = [];
    state.connected = false;
  }

  function renderConnection() {
    if (!dom.connection) return;
    dom.connection.classList.toggle('is-on', state.connected);
    dom.connection.classList.toggle('is-off', !state.connected);
    if (dom.connectionText) dom.connectionText.textContent = state.connected ? '실시간 연결됨' : '연결 중…';
  }

  /* =========================================================
   * 4.5 브라우저 알림 (새 보고 · 업무 완료)
   * ========================================================= */
  function notifySupported() {
    return typeof window !== 'undefined' && 'Notification' in window;
  }

  function notifyPermission() {
    return notifySupported() ? window.Notification.permission : 'unsupported';
  }

  function initNotifyState() {
    const saved = localStorage.getItem(LS.notify) === '1';
    state.notifyEnabled = saved && notifyPermission() === 'granted';
    if (saved && !state.notifyEnabled) localStorage.removeItem(LS.notify);
    renderNotifyToggle();
  }

  function renderNotifyToggle() {
    if (!dom.notifyToggle) return;
    const on = !!state.notifyEnabled;
    dom.notifyToggle.textContent = on ? '🔔 알림' : '🔕 알림 꺼짐';
    dom.notifyToggle.classList.toggle('is-on', on);
    dom.notifyToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    dom.notifyToggle.title = on
      ? '새 보고·업무 완료를 브라우저 알림으로 받고 있습니다. 누르면 끕니다.'
      : '새 보고·업무 완료를 브라우저 알림으로 받습니다.';
  }

  function setNotifyEnabled(on) {
    state.notifyEnabled = !!on;
    if (state.notifyEnabled) localStorage.setItem(LS.notify, '1');
    else localStorage.removeItem(LS.notify);
    renderNotifyToggle();
  }

  async function onToggleNotify() {
    if (state.notifyEnabled) {
      setNotifyEnabled(false);
      toast('브라우저 알림을 껐습니다.');
      return;
    }
    if (!notifySupported()) {
      toast('이 브라우저는 알림을 지원하지 않습니다. 화면 안 알림 배너만 보여 드립니다.');
      return;
    }
    let permission = notifyPermission();
    if (permission === 'default') {
      try {
        permission = await window.Notification.requestPermission();
      } catch (err) {
        permission = 'denied';
      }
    }
    if (permission !== 'granted') {
      setNotifyEnabled(false);
      toast('브라우저가 알림을 막고 있습니다. 주소창 옆 사이트 설정에서 알림을 허용한 뒤 다시 눌러 주세요.');
      return;
    }
    setNotifyEnabled(true);
    toast('브라우저 알림을 켰습니다. 새 보고와 업무 완료 소식을 알려 드립니다.');
    showBrowserNotification('합동 비서실 알림을 켰습니다', '새 보고와 업무 완료 소식을 이 브라우저로 알려 드립니다.', '');
  }

  function summarizeText(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  }

  let notifyBannerTimer = 0;

  function showNotifyBanner(title, body, memoId) {
    if (!dom.notifyBanner) return;
    if (dom.notifyBannerTitle) dom.notifyBannerTitle.textContent = title;
    if (dom.notifyBannerText) dom.notifyBannerText.textContent = body || '내용 없음';
    dom.notifyBanner.setAttribute('data-memo', memoId || '');
    dom.notifyBanner.hidden = false;
    window.clearTimeout(notifyBannerTimer);
    notifyBannerTimer = window.setTimeout(hideNotifyBanner, 12000);
  }

  function hideNotifyBanner() {
    if (!dom.notifyBanner) return;
    window.clearTimeout(notifyBannerTimer);
    dom.notifyBanner.hidden = true;
  }

  function focusMemo(memoId) {
    if (!memoId || !dom.memoList) return;
    selectTab('memos');
    if (state.filters.memo !== 'all') {
      state.filters.memo = 'all';
      renderMemos();
    }
    const card = dom.memoList.querySelector(`[data-id="${memoId}"]`);
    if (!card) return;
    if (typeof card.scrollIntoView === 'function') card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (card.classList) {
      card.classList.add('is-flash');
      window.setTimeout(() => card.classList.remove('is-flash'), 2400);
    }
  }

  function showBrowserNotification(title, body, memoId) {
    if (!state.notifyEnabled || !notifySupported() || notifyPermission() !== 'granted') return;
    try {
      const note = new window.Notification(title, {
        body: body || '내용 없음',
        tag: memoId ? `office-${memoId}` : 'office-notify-on'
      });
      note.onclick = () => {
        try { window.focus(); } catch (err) { /* 무시 */ }
        if (memoId) focusMemo(memoId);
        note.close();
      };
    } catch (err) {
      // 모바일 크롬처럼 new Notification()을 허용하지 않는 브라우저는 화면 안 배너로만 알린다.
    }
  }

  /* 초기 로딩 이후 새로 들어온 보고·완료 소식만 골라 알린다 */
  function announceNewActivity(previous, next) {
    const events = [];
    const me = currentAuthor();
    Object.keys(next || {}).forEach((id) => {
      const memo = next[id];
      if (!memo || typeof memo !== 'object') return;
      if (state.ownMemoIds.has(id)) return;
      const author = String(memo.author || '');
      if (me && author === me && Date.now() - (Number(memo.createdAt) || 0) < 20000) return;
      const before = previous ? previous[id] : null;
      if (!before) {
        if (memo.tag === '보고' || memo.done === true) {
          events.push({ kind: memo.tag === '보고' ? 'report' : 'done', id, memo });
        }
      } else if (before.done !== true && memo.done === true) {
        events.push({ kind: 'done', id, memo });
      }
    });
    if (!events.length) return;
    events.sort((a, b) => (Number(a.memo.createdAt) || 0) - (Number(b.memo.createdAt) || 0));
    events.slice(-3).forEach((event) => {
      const author = event.memo.author || '이름 없음';
      const title = event.kind === 'report' ? `새 보고 · ${author}` : `업무 완료 · ${author}`;
      const body = summarizeText(event.memo.text || '');
      showNotifyBanner(event.kind === 'report' ? `📝 ${title}` : `✅ ${title}`, body, event.id);
      showBrowserNotification(title, body, event.id);
    });
  }

  /* =========================================================
   * 5. 탭
   * ========================================================= */
  function selectTab(name) {
    state.tab = name;
    dom.tabs.forEach((tab) => {
      const on = tab.dataset.tab === name;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
    });
    ['memos', 'images', 'notices', 'ai'].forEach((key) => {
      const panel = document.getElementById(`panel-${key}`);
      if (panel) panel.hidden = key !== name;
    });
    if (name === 'ai') renderAiPanel();
  }

  function onTabKeydown(event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = dom.tabs.findIndex((tab) => tab.dataset.tab === state.tab);
    const next = (index + (event.key === 'ArrowRight' ? 1 : dom.tabs.length - 1)) % dom.tabs.length;
    dom.tabs[next].focus();
    selectTab(dom.tabs[next].dataset.tab);
  }

  function renderAll() {
    renderMemos();
    renderImages();
    renderNotices();
    renderAiPanel();
  }

  /* =========================================================
   * 6. 업무 공유
   * ========================================================= */
  async function onAddMemo(event) {
    event.preventDefault();
    const author = dom.memoAuthor.value.trim() || '이름 없음';
    const tag = dom.memoTag.value;
    const value = editorValue(dom.memoText);
    const text = value.text.trim();
    const pending = state.pendingFiles.slice();

    if (!text && !pending.length) {
      dom.memoText.focus();
      toast('내용을 입력하거나 파일을 첨부해 주세요.');
      return;
    }
    if (text.length > EDITOR_LIMITS.memo) {
      dom.memoText.focus();
      toast(`내용은 ${EDITOR_LIMITS.memo}자까지 쓸 수 있습니다. 지금은 ${text.length}자입니다.`);
      return;
    }
    const problem = validatePendingFiles();
    if (problem) {
      setAttachNote(problem, true);
      toast(problem);
      return;
    }

    const memoRef = childRef('memos').push();
    const memoId = memoRef.key;
    const uploadedIds = [];
    const attachments = [];

    setMemoBusy(true, pending.length ? `올리는 중… 0/${pending.length}` : '등록 중…');
    try {
      for (let index = 0; index < pending.length; index += 1) {
        setMemoBusy(true, `올리는 중… ${index + 1}/${pending.length}`);
        const saved = await saveAttachmentFile(pending[index].file, memoId);
        uploadedIds.push(saved.summary.fileId);
        attachments.push(saved.summary);
      }

      const memo = { author, tag, text, done: false, createdAt: Date.now() };
      if (richHasFormat(value.html)) memo.html = value.html;
      if (attachments.length) memo.attachments = attachments;
      await memoRef.set(memo);
      state.ownMemoIds.add(memoId);

      clearPendingFiles();
      setEditorHtml(dom.memoText, '');
      dom.memoText.focus();
      setAttachNote('');
      localStorage.setItem(LS.author, author);
      hydrateAuthorFields();
      toast(attachments.length ? `업무 공유와 파일 ${attachments.length}개를 등록했습니다.` : '업무 공유에 등록했습니다.');
    } catch (err) {
      // 메모가 남지 않았으면 먼저 올린 파일도 함께 지운다.
      if (uploadedIds.length) await removeMemoFiles(uploadedIds);
      setAttachNote(`등록하지 못했습니다: ${err.message || err}`, true);
      toast(`등록하지 못했습니다: ${err.message || err}`);
    } finally {
      setMemoBusy(false);
    }
  }

  function setMemoBusy(busy, label) {
    if (!dom.memoSubmit) return;
    dom.memoSubmit.disabled = busy;
    dom.memoSubmit.textContent = busy ? (label || '등록 중…') : '등록';
  }

  /* ---------- 첨부: 선택 전 미리보기 ---------- */

  function addPendingFiles(fileList) {
    const incoming = Array.from(fileList || []).filter((file) => file && typeof file === 'object');
    if (!incoming.length) return;
    let skippedCount = 0;

    for (const file of incoming) {
      if (state.pendingFiles.length >= MAX_ATTACH_COUNT) {
        skippedCount += 1;
        continue;
      }
      const previewable = isImageType(file.type) && !/^image\/svg/i.test(file.type || '');
      state.pendingFiles.push({
        file,
        previewUrl: previewable ? URL.createObjectURL(file) : ''
      });
    }

    renderPendingFiles();
    if (skippedCount) toast(`한 번에 ${MAX_ATTACH_COUNT}개까지 첨부할 수 있습니다. ${skippedCount}개는 빠졌습니다.`);
  }

  function removePendingFile(index) {
    const entry = state.pendingFiles[index];
    if (!entry) return;
    if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    state.pendingFiles.splice(index, 1);
    renderPendingFiles();
  }

  function clearPendingFiles() {
    state.pendingFiles.forEach((entry) => {
      if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    });
    state.pendingFiles = [];
    renderPendingFiles();
  }

  function validatePendingFiles() {
    if (!state.pendingFiles.length) return '';
    if (state.pendingFiles.length > MAX_ATTACH_COUNT) {
      return `파일은 한 글에 ${MAX_ATTACH_COUNT}개까지 첨부할 수 있습니다.`;
    }
    const tooBig = state.pendingFiles.find((entry) => Number(entry.file.size) > MAX_FILE_BYTES);
    if (tooBig) {
      return `'${tooBig.file.name}'이(가) ${fmtBytes(tooBig.file.size)}입니다. 파일 한 개는 ${fmtBytes(MAX_FILE_BYTES)}까지 올릴 수 있어요.`;
    }
    const total = state.pendingFiles.reduce((sum, entry) => sum + (Number(entry.file.size) || 0), 0);
    if (total > MAX_ATTACH_TOTAL_BYTES) {
      return `첨부 합계가 ${fmtBytes(total)}입니다. 한 글에는 ${fmtBytes(MAX_ATTACH_TOTAL_BYTES)}까지 올릴 수 있어요.`;
    }
    return '';
  }

  function setAttachNote(message, isError) {
    if (!dom.memoFileNote) return;
    dom.memoFileNote.textContent = message || '';
    dom.memoFileNote.hidden = !message;
    dom.memoFileNote.classList.toggle('is-ok', !!message && !isError);
  }

  function renderPendingFiles() {
    if (!dom.memoFileList) return;
    dom.memoFileList.textContent = '';
    dom.memoFileList.hidden = state.pendingFiles.length === 0;

    state.pendingFiles.forEach((entry, index) => {
      const file = entry.file;
      dom.memoFileList.append(h('li', { class: 'attach-item' },
        h('span', { class: 'attach-thumb' },
          entry.previewUrl
            ? h('img', { src: entry.previewUrl, alt: '' })
            : h('span', { class: 'attach-ext' }, fileExt(file.name))
        ),
        h('span', { class: 'attach-body' },
          h('span', { class: 'attach-name', title: file.name }, file.name),
          h('span', { class: 'attach-size' }, fmtBytes(file.size))
        ),
        h('button', {
          type: 'button',
          class: 'text-btn danger tiny',
          'data-remove-file': String(index),
          'aria-label': `${file.name} 첨부 빼기`
        }, '빼기')
      ));
    });

    const total = state.pendingFiles.reduce((sum, entry) => sum + (Number(entry.file.size) || 0), 0);
    const problem = validatePendingFiles();
    if (!state.pendingFiles.length) setAttachNote('');
    else if (problem) setAttachNote(problem, true);
    else setAttachNote(`${state.pendingFiles.length}개 · ${fmtBytes(total)} · 등록을 누르면 함께 올라갑니다.`, false);
  }

  function bindMemoDrop() {
    const form = dom.memoForm;
    if (!form) return;
    const hasFiles = (event) => Boolean(
      event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')
    );
    ['dragenter', 'dragover'].forEach((type) => {
      form.addEventListener(type, (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        form.classList.add('is-dragover');
      });
    });
    form.addEventListener('dragleave', (event) => {
      if (event.relatedTarget && form.contains(event.relatedTarget)) return;
      form.classList.remove('is-dragover');
    });
    form.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      form.classList.remove('is-dragover');
      addPendingFiles(event.dataTransfer.files);
    });
  }

  /* ---------- 첨부: 저장 · 조회 ---------- */

  async function saveAttachmentFile(file, memoId) {
    const fileId = childRef('memoFiles').push().key;
    let name = file.name || 'file';
    let type = file.type || 'application/octet-stream';
    let size = Number(file.size) || 0;
    let dataUrl = '';

    if (IMAGE_COMPRESSIBLE.test(type)) {
      try {
        const output = await compressImage(file, { maxSide: ATTACH_IMAGE_SIDE, maxBytes: ATTACH_IMAGE_BYTES });
        dataUrl = output.dataUrl;
        type = 'image/jpeg';
        size = output.bytes;
        name = replaceExt(name, 'jpg');
      } catch (err) {
        dataUrl = await readFileAsDataUrl(file); // 압축할 수 없는 형식은 원본 그대로
      }
    } else {
      dataUrl = await readFileAsDataUrl(file);
    }

    if (!dataUrl) throw new Error(`${name} 내용을 읽지 못했습니다.`);

    const meta = { fileId, memoId, name, type, size, createdAt: Date.now() };

    try {
      // 큰 파일은 한 번 쓰기 부담이 없도록 잘라서 저장한다.
      if (dataUrl.length <= FILE_CHUNK_CHARS) {
        await childRef(`memoFiles/${fileId}`).set(Object.assign({}, meta, { dataUrl }));
      } else {
        const chunkCount = Math.ceil(dataUrl.length / FILE_CHUNK_CHARS);
        await childRef(`memoFiles/${fileId}`).update(Object.assign({}, meta, { chunkCount }));
        for (let index = 0; index < chunkCount; index += 1) {
          const piece = dataUrl.slice(index * FILE_CHUNK_CHARS, (index + 1) * FILE_CHUNK_CHARS);
          await childRef(`memoFiles/${fileId}/chunks/${index}`).set(piece);
        }
      }
    } catch (err) {
      // 중간에 실패하면 조각까지 지우고 오류를 전달한다.
      await childRef(`memoFiles/${fileId}`).remove().catch(() => {});
      throw err;
    }

    return { summary: { fileId, name, type, size } };
  }

  async function removeMemoFiles(fileIds) {
    await Promise.all((fileIds || []).map((fileId) =>
      childRef(`memoFiles/${fileId}`).remove().catch(() => {})
    ));
  }

  async function fetchAttachmentData(fileId) {
    const snap = await childRef(`memoFiles/${fileId}`).once('value');
    const meta = snap.val();
    if (!meta || typeof meta !== 'object') {
      throw new Error('파일을 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.');
    }
    let dataUrl = typeof meta.dataUrl === 'string' ? meta.dataUrl : '';
    if (!dataUrl && meta.chunks && typeof meta.chunks === 'object') {
      dataUrl = Object.keys(meta.chunks)
        .sort((a, b) => Number(a) - Number(b))
        .map((key) => String(meta.chunks[key] || ''))
        .join('');
    }
    if (!dataUrl) throw new Error('파일 내용이 비어 있습니다.');
    return Object.assign({}, meta, { dataUrl });
  }

  function memoAttachments(memo) {
    const raw = memo && memo.attachments;
    if (!raw || typeof raw !== 'object') return [];
    const list = Array.isArray(raw) ? raw : Object.values(raw);
    return list.filter((item) => item && typeof item === 'object' && item.fileId);
  }

  function replyAttachments(reply) {
    const raw = reply && reply.attachments;
    if (!raw || typeof raw !== 'object') return [];
    const list = Array.isArray(raw) ? raw : Object.values(raw);
    return list.filter((item) => item && typeof item === 'object' && item.fileId);
  }

  function findAttachment(fileId) {
    const memos = state.memos || {};
    for (const memo of Object.values(memos)) {
      const hit = memoAttachments(memo).find((file) => file.fileId === fileId);
      if (hit) return hit;
      const replies = (memo && memo.replies) || {};
      for (const reply of Object.values(replies)) {
        const inReply = replyAttachments(reply).find((file) => file.fileId === fileId);
        if (inReply) return inReply;
      }
    }
    return null;
  }

  function attachmentBlock(memo) {
    return attachmentsBlock(memoAttachments(memo));
  }

  function attachmentsBlock(files, extraClass) {
    if (!files.length) return null;

    const images = files.filter((file) => isImageType(file.type));
    const others = files.filter((file) => !isImageType(file.type));
    const box = h('div', { class: `memo-files${extraClass ? ` ${extraClass}` : ''}` });

    if (images.length) {
      const grid = h('div', { class: 'memo-file-grid' });
      images.forEach((file) => {
        const cached = state.attachPreviews[file.fileId];
        const ready = typeof cached === 'string' && /^data:image\//i.test(cached);
        const failed = cached === 'error';
        grid.append(h('button', {
          type: 'button',
          class: 'memo-file-thumb',
          'data-action': 'preview-file',
          'data-file-id': file.fileId,
          'aria-label': `${file.name} 크게 보기`
        }, ready
          ? h('img', { src: cached, alt: file.name })
          : h('span', { class: 'thumb-loading' }, failed ? '미리보기 없음' : (cached === 'loading' ? '불러오는 중…' : '미리보기'))));
        if (!ready && !failed) loadAttachmentPreview(file.fileId);
      });
      box.append(grid);
    }

    others.forEach((file) => {
      box.append(h('div', { class: 'memo-file-row' },
        h('span', { class: 'file-badge' }, fileExt(file.name)),
        h('span', { class: 'memo-file-body' },
          h('span', { class: 'memo-file-name', title: file.name }, file.name),
          h('span', { class: 'memo-file-size' }, fmtBytes(file.size))
        ),
        h('button', {
          type: 'button',
          class: 'btn ghost small',
          'data-action': 'download-file',
          'data-file-id': file.fileId
        }, '다운로드')
      ));
    });

    return box;
  }

  async function loadAttachmentPreview(fileId) {
    if (state.attachPreviews[fileId]) return;
    state.attachPreviews[fileId] = 'loading';
    try {
      const data = await fetchAttachmentData(fileId);
      const src = safeImageSrc(data.dataUrl);
      if (!src) throw new Error('이미지 미리보기를 지원하지 않는 형식입니다.');
      state.attachPreviews[fileId] = src;
      updateAttachmentThumb(fileId, h('img', { src, alt: data.name || '첨부 이미지' }));
    } catch (err) {
      state.attachPreviews[fileId] = 'error';
      updateAttachmentThumb(fileId, h('span', { class: 'thumb-loading' }, '미리보기 없음'));
    }
  }

  function updateAttachmentThumb(fileId, content) {
    if (!dom.memoList) return;
    $$(`[data-file-id="${fileId}"]`, dom.memoList).forEach((node) => {
      if (!node.classList.contains('memo-file-thumb')) return;
      node.textContent = '';
      node.append(content.cloneNode(true));
    });
  }

  async function downloadMemoFile(fileId, button) {
    const info = findAttachment(fileId) || {};
    const label = button ? button.textContent : '';
    if (button) {
      button.disabled = true;
      button.textContent = '불러오는 중…';
    }
    try {
      const data = await fetchAttachmentData(fileId);
      const blob = dataUrlToBlob(data.dataUrl);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = downloadFileName(data.name || info.name, data.type || info.type);
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      toast(`내려받지 못했습니다: ${err.message || err}`);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = label;
      }
    }
  }

  async function openMemoFilePreview(fileId) {
    const info = findAttachment(fileId) || {};
    let src = safeImageSrc(state.attachPreviews[fileId] || '');
    let name = info.name || '이미지';
    let type = info.type || '';
    let size = info.size;
    try {
      if (!src) {
        const data = await fetchAttachmentData(fileId);
        src = safeImageSrc(data.dataUrl);
        name = data.name || name;
        type = data.type || type;
        size = data.size || size;
        if (src) state.attachPreviews[fileId] = src;
      }
      if (!src) throw new Error('미리보기를 지원하지 않는 형식입니다.');
      dom.modalTitle.textContent = name;
      dom.modalImage.src = src;
      dom.modalImage.alt = name;
      dom.modalMeta.textContent = [name, fmtBytes(size)].filter(Boolean).join(' · ');
      setModalDownload(src, downloadFileName(name, type), true);
      if (typeof dom.modal.showModal === 'function') dom.modal.showModal();
      else dom.modal.setAttribute('open', '');
    } catch (err) {
      toast(`열지 못했습니다: ${err.message || err}`);
    }
  }

  function setModalDownload(src, downloadName, asBlob) {
    const previous = dom.modalDownload.dataset.blobUrl;
    if (previous) {
      URL.revokeObjectURL(previous);
      delete dom.modalDownload.dataset.blobUrl;
    }
    if (asBlob) {
      try {
        const url = URL.createObjectURL(dataUrlToBlob(src));
        dom.modalDownload.dataset.blobUrl = url;
        dom.modalDownload.href = url;
      } catch (err) {
        dom.modalDownload.href = src;
      }
    } else {
      dom.modalDownload.href = src;
    }
    dom.modalDownload.download = downloadName;
  }

  function renderMemoFilters() {
    const items = Object.values(state.memos || {}).filter((m) => m && typeof m === 'object');
    const options = [
      { key: 'all', label: '전체', count: items.length },
      { key: 'open', label: '미완료', count: items.filter((m) => !m.done).length },
      ...TAGS.map((tag) => ({ key: tag, label: tag, count: items.filter((m) => m.tag === tag).length }))
    ];
    dom.memoFilter.textContent = '';
    options.forEach((option) => {
      const active = state.filters.memo === option.key;
      dom.memoFilter.append(h('button', {
        type: 'button',
        class: `chip${active ? ' is-active' : ''}`,
        'data-filter': option.key,
        'aria-pressed': active ? 'true' : 'false'
      }, option.label, h('span', { class: 'chip-count' }, String(option.count))));
    });
  }

  function renderMemos() {
    if (!dom.memoList) return;
    const savedFocus = rememberFocus(dom.memoList);
    renderMemoFilters();
    const all = Object.entries(state.memos || {})
      .filter(([, memo]) => memo && typeof memo === 'object')
      .map(([id, memo]) => ({ id, ...memo }))
      .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));

    const filter = state.filters.memo;
    const visible = all.filter((memo) => {
      if (filter === 'all') return true;
      if (filter === 'open') return !memo.done;
      return memo.tag === filter;
    });

    dom.memoList.textContent = '';
    dom.memoEmpty.hidden = visible.length > 0;
    dom.memoEmpty.textContent = all.length
      ? '이 필터에 해당하는 글이 없습니다.'
      : '아직 공유된 업무가 없습니다. 위에서 첫 글을 남겨 보세요.';
    visible.forEach((memo) => dom.memoList.append(memoCard(memo)));
    refreshEditors(dom.memoList);
    restoreFocus(dom.memoList, savedFocus);

    const openCount = all.filter((memo) => !memo.done).length;
    dom.memoBadge.textContent = openCount ? String(openCount) : '';
    dom.memoBadge.hidden = openCount === 0;
  }

  /* ---------- 이모지 반응 ---------- */

  function currentAuthor() {
    const fields = [dom.memoAuthor, dom.noticeAuthor];
    for (let index = 0; index < fields.length; index += 1) {
      const value = fields[index] && fields[index].value ? String(fields[index].value).trim() : '';
      if (value) return value;
    }
    const saved = localStorage.getItem(LS.author) || '';
    return saved.trim();
  }

  function focusAuthorField(node) {
    const field = node === 'notices' ? dom.noticeAuthor : dom.memoAuthor;
    if (field) field.focus();
  }

  function reactionWho(reactions, emoji) {
    const bucket = reactions && reactions[emoji];
    if (!bucket || typeof bucket !== 'object') return [];
    return Object.keys(bucket).filter((key) => bucket[key]);
  }

  function reactionBar(node, parentId, replyId, reactions, variant) {
    const me = fbKey(currentAuthor());
    const bar = h('div', {
      class: `reactions${variant === 'reply' ? ' reactions-sm' : ''}`,
      role: 'group',
      'aria-label': '이모지 반응'
    });
    REACTIONS.forEach(({ emoji, label }) => {
      const who = reactionWho(reactions, emoji);
      const on = !!currentAuthor() && who.indexOf(me) >= 0;
      const tip = who.length ? `${emoji} ${label} · ${who.join(', ')}` : `${emoji} ${label} 남기기`;
      const button = h('button', {
        type: 'button',
        class: `reaction${on ? ' is-on' : ''}${who.length ? '' : ' is-zero'}`,
        'data-action': 'react',
        'data-node': node,
        'data-id': parentId,
        'data-emoji': emoji,
        'aria-pressed': on ? 'true' : 'false',
        'aria-label': `${label} ${emoji}${who.length ? ` ${who.length}명 (${who.join(', ')})` : ' 남기기'}`,
        title: tip
      }, h('span', { class: 'reaction-emoji', 'aria-hidden': 'true' }, emoji),
        who.length ? h('span', { class: 'reaction-count' }, String(who.length)) : null);
      if (replyId) button.dataset.reply = replyId;
      if (who.length) button.setAttribute('data-who', tip);
      bar.append(button);
    });
    return bar;
  }

  async function toggleReaction(node, parentId, replyId, emoji) {
    if (!emoji) return;
    const author = currentAuthor();
    if (!author) {
      toast('먼저 작성자 이름을 입력해 주세요. 이름이 있어야 누가 남긴 반응인지 표시됩니다.');
      focusAuthorField(node);
      return;
    }
    const parent = node === 'notices' ? state.notices[parentId] : state.memos[parentId];
    if (!parent || typeof parent !== 'object') return;
    const target = replyId ? (parent.replies && parent.replies[replyId]) : parent;
    if (!target || typeof target !== 'object') return;

    const key = fbKey(author);
    const before = target.reactions ? JSON.parse(JSON.stringify(target.reactions)) : null;
    const bucket = before && before[emoji] && typeof before[emoji] === 'object' ? before[emoji] : {};
    const on = !!bucket[key];
    const next = Object.assign({}, bucket);
    if (on) delete next[key];
    else next[key] = true;

    const reactions = Object.assign({}, before || {});
    if (Object.keys(next).length) reactions[emoji] = next;
    else delete reactions[emoji];
    if (Object.keys(reactions).length) target.reactions = reactions;
    else delete target.reactions;
    renderFor(node);

    const path = replyId
      ? `${node}/${parentId}/replies/${replyId}/reactions/${emoji}/${key}`
      : `${node}/${parentId}/reactions/${emoji}/${key}`;
    try {
      if (on) await childRef(path).remove();
      else await childRef(path).set(true);
      if (!on) localStorage.setItem(LS.author, author);
    } catch (err) {
      if (before) target.reactions = before;
      else delete target.reactions;
      renderFor(node);
      toast(`반응을 저장하지 못했습니다: ${err.message || err}`);
    }
  }

  function memoCard(memo) {
    const editing = state.editing.memo === memo.id;
    const replies = Object.entries(memo.replies || {})
      .filter(([, reply]) => reply && typeof reply === 'object')
      .map(([id, reply]) => ({ id, ...reply }))
      .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
    const repliesOpen = state.openReplies.has(memo.id);

    const card = h('article', { class: `memo${memo.done ? ' is-done' : ''}`, 'data-id': memo.id },
      h('header', { class: 'memo-head' },
        h('span', { class: `tag ${TAG_CLASS[memo.tag] || 'tag-memo'}` }, memo.tag || '메모'),
        h('span', { class: 'memo-author' }, memo.author || '이름 없음'),
        h('time', { class: 'memo-time' }, fmtStamp(memo.createdAt)),
        h('label', { class: 'done-toggle' },
          h('input', { type: 'checkbox', 'data-action': 'toggle', 'data-id': memo.id, checked: !!memo.done }),
          h('span', {}, '완료')
        )
      ),
      editing
        ? h('div', { class: 'memo-edit' },
            h('div', { class: 'editor-shell' },
              h('div', { class: 'editor-toolbar', role: 'toolbar', 'aria-label': '본문 서식' }, ...toolbarControls()),
              h('div', {
                class: 'input textarea editor',
                contenteditable: 'true',
                role: 'textbox',
                'aria-multiline': 'true',
                'aria-label': '글 내용 수정',
                'data-editor': `memo-edit:${memo.id}`,
                'data-empty': 'true',
                'data-placeholder': '글 내용을 적어 주세요.',
                html: state.drafts.memo
              })
            ),
            h('div', { class: 'memo-edit-actions' },
              h('button', { type: 'button', class: 'btn ghost small', 'data-action': 'cancel-edit' }, '취소'),
              h('button', { type: 'button', class: 'btn primary small', 'data-action': 'save-edit', 'data-id': memo.id }, '저장')
            )
          )
        : (memo.text || itemRichHtml(memo, 'text') ? richBody('p', 'memo-text', memo, 'text') : null),
      attachmentBlock(memo),
      reactionBar('memos', memo.id, '', memo.reactions),
      h('div', { class: 'memo-actions' },
        h('button', { type: 'button', class: 'text-btn', 'data-action': 'edit', 'data-id': memo.id }, '수정'),
        h('button', { type: 'button', class: 'text-btn', 'data-action': 'toggle-replies', 'data-id': memo.id }, replies.length ? `답글 ${replies.length}` : '답글'),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'text-btn danger', 'data-action': 'delete', 'data-id': memo.id }, '삭제')
      )
    );

    if (repliesOpen) card.append(repliesBlock('memos', memo, replies));
    return card;
  }

  function renderFor(node) {
    if (node === 'notices') renderNotices();
    else renderMemos();
  }

  function replyEditDraft(reply) {
    const draft = state.replyEditDrafts[reply.id];
    return draft !== undefined ? draft : (reply.text || '');
  }

  function isEditingReply(node, parentId, replyId) {
    const target = state.editing.reply;
    return !!target && target.node === node && target.parentId === parentId && target.replyId === replyId;
  }

  function replyItem(node, parent, reply) {
    const editing = isEditingReply(node, parent.id, reply.id);
    const files = replyAttachments(reply);

    const head = h('div', { class: 'reply-head' },
      h('strong', {}, reply.author || '이름 없음'),
      h('time', {}, fmtStamp(reply.createdAt)),
      reply.updatedAt && Number(reply.updatedAt) !== Number(reply.createdAt)
        ? h('time', {}, `수정 ${fmtStamp(reply.updatedAt)}`)
        : null,
      h('button', {
        type: 'button',
        class: 'text-btn tiny',
        'data-action': 'edit-reply',
        'data-node': node,
        'data-id': parent.id,
        'data-reply': reply.id
      }, '수정'),
      h('button', {
        type: 'button',
        class: 'text-btn danger tiny',
        'data-action': 'delete-reply',
        'data-node': node,
        'data-id': parent.id,
        'data-reply': reply.id
      }, '삭제')
    );

    const body = editing
      ? h('div', { class: 'reply-edit' },
          h('textarea', {
            class: 'input textarea',
            rows: 2,
            maxlength: 2000,
            'data-reply-edit-text': reply.id,
            'aria-label': '답글 내용 수정'
          }, replyEditDraft(reply)),
          h('div', { class: 'reply-edit-actions' },
            h('button', { type: 'button', class: 'btn ghost small', 'data-action': 'cancel-reply-edit' }, '취소'),
            h('button', {
              type: 'button',
              class: 'btn primary small',
              'data-action': 'save-reply-edit',
              'data-node': node,
              'data-id': parent.id,
              'data-reply': reply.id
            }, '저장')
          )
        )
      : h('p', { class: 'reply-text' }, reply.text || '');

    return h('li', { class: 'reply' }, head, body, attachmentsBlock(files, 'reply-files'),
      reactionBar(node, parent.id, reply.id, reply.reactions, 'reply'));
  }

  function replyPendingBlock(memoId, pending) {
    return h('ul', { class: 'attach-list reply-attach-list', 'aria-label': '답글에 첨부할 파일' },
      pending.map((entry, index) => {
        const file = entry.file;
        return h('li', { class: 'attach-item' },
          h('span', { class: 'attach-thumb' },
            entry.previewUrl
              ? h('img', { src: entry.previewUrl, alt: '' })
              : h('span', { class: 'attach-ext' }, fileExt(file.name))
          ),
          h('span', { class: 'attach-body' },
            h('span', { class: 'attach-name', title: file.name }, file.name),
            h('span', { class: 'attach-size' }, fmtBytes(file.size))
          ),
          h('button', {
            type: 'button',
            class: 'text-btn danger tiny',
            'data-action': 'reply-remove-file',
            'data-id': memoId,
            'data-index': String(index),
            'aria-label': `${file.name} 첨부 빼기`
          }, '빼기')
        );
      })
    );
  }

  function repliesBlock(node, parent, replies) {
    const draft = state.replyDrafts[parent.id] || {};
    const box = h('div', { class: 'replies' });

    if (replies.length) {
      box.append(h('ul', { class: 'reply-list' }, replies.map((reply) => replyItem(node, parent, reply))));
    }

    const form = h('form', {
      class: 'reply-form',
      'data-reply-form': parent.id,
      'data-reply-node': node
    },
      h('input', {
        type: 'text', class: 'input reply-author', maxlength: 20, placeholder: '작성자',
        'data-reply-author': parent.id, 'aria-label': '답글 작성자',
        value: draft.author !== undefined ? draft.author : (localStorage.getItem(LS.author) || '')
      }),
      h('input', {
        type: 'text', class: 'input reply-input', maxlength: 500, placeholder: '답글을 입력하세요',
        'data-reply-text': parent.id, 'aria-label': '답글 내용',
        value: draft.text || ''
      })
    );

    if (node === 'memos') {
      form.append(
        h('button', {
          type: 'button',
          class: 'icon-btn reply-attach',
          'data-action': 'reply-attach',
          'data-id': parent.id,
          'aria-label': '답글에 파일 첨부',
          title: '파일 첨부'
        }, '📎'),
        h('input', {
          type: 'file', multiple: true, class: 'sr-only',
          'data-reply-files': parent.id, 'aria-label': '답글 첨부 파일 선택'
        })
      );
    }
    form.append(h('button', { type: 'submit', class: 'btn primary small' }, '등록'));
    box.append(form);

    if (node === 'memos') {
      const pending = state.replyFiles[parent.id] || [];
      if (pending.length) box.append(replyPendingBlock(parent.id, pending));
    }

    return box;
  }

  /* ---------- 답글 첨부: 선택 · 해제 ---------- */

  function validateFileList(list) {
    if (!list.length) return '';
    if (list.length > MAX_ATTACH_COUNT) {
      return `파일은 한 번에 ${MAX_ATTACH_COUNT}개까지 첨부할 수 있습니다.`;
    }
    const tooBig = list.find((entry) => Number(entry.file.size) > MAX_FILE_BYTES);
    if (tooBig) {
      return `'${tooBig.file.name}'이(가) ${fmtBytes(tooBig.file.size)}입니다. 파일 한 개는 ${fmtBytes(MAX_FILE_BYTES)}까지 올릴 수 있어요.`;
    }
    const total = list.reduce((sum, entry) => sum + (Number(entry.file.size) || 0), 0);
    if (total > MAX_ATTACH_TOTAL_BYTES) {
      return `첨부 합계가 ${fmtBytes(total)}입니다. 한 번에 ${fmtBytes(MAX_ATTACH_TOTAL_BYTES)}까지 올릴 수 있어요.`;
    }
    return '';
  }

  function addReplyFiles(memoId, fileList) {
    const incoming = Array.from(fileList || []).filter((file) => file && typeof file === 'object');
    if (!incoming.length) return;
    const list = state.replyFiles[memoId] || (state.replyFiles[memoId] = []);
    let skipped = 0;

    for (const file of incoming) {
      if (list.length >= MAX_ATTACH_COUNT) {
        skipped += 1;
        continue;
      }
      const previewable = isImageType(file.type) && !/^image\/svg/i.test(file.type || '');
      list.push({ file, previewUrl: previewable ? URL.createObjectURL(file) : '' });
    }

    renderMemos();
    const problem = validateFileList(list);
    if (problem) toast(problem);
    else if (skipped) toast(`한 번에 ${MAX_ATTACH_COUNT}개까지 첨부할 수 있습니다. ${skipped}개는 빠졌습니다.`);
  }

  function removeReplyFile(memoId, index) {
    const list = state.replyFiles[memoId];
    if (!list) return;
    const entry = list[index];
    if (!entry) return;
    if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    list.splice(index, 1);
    if (!list.length) delete state.replyFiles[memoId];
    renderMemos();
  }

  function clearReplyFiles(memoId) {
    const list = state.replyFiles[memoId];
    if (!list) return;
    list.forEach((entry) => {
      if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    });
    delete state.replyFiles[memoId];
  }

  /* ---------- 답글 수정 ---------- */

  function startReplyEdit(node, parentId, replyId) {
    state.editing.reply = { node, parentId, replyId };
    delete state.replyEditDrafts[replyId];
    renderFor(node);
    const box = document.querySelector(`[data-reply-edit-text="${replyId}"]`);
    if (box) {
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }
  }

  function cancelReplyEdit() {
    const target = state.editing.reply;
    if (!target) return;
    delete state.replyEditDrafts[target.replyId];
    state.editing.reply = null;
    renderFor(target.node);
  }

  async function saveReplyEdit() {
    const target = state.editing.reply;
    if (!target) return;
    const field = document.querySelector(`[data-reply-edit-text="${target.replyId}"]`);
    const text = field ? field.value.trim() : '';
    if (!text) {
      toast('답글 내용을 입력해 주세요.');
      if (field) field.focus();
      return;
    }
    try {
      await childRef(`${target.node}/${target.parentId}/replies/${target.replyId}`)
        .update({ text, updatedAt: Date.now() });
      delete state.replyEditDrafts[target.replyId];
      state.editing.reply = null;
      renderFor(target.node);
      toast('답글을 수정했습니다.');
    } catch (err) {
      toast(`수정하지 못했습니다: ${err.message || err}`);
    }
  }

  function onMemoClick(event) {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const { action, id } = button.dataset;
    if (action === 'edit') startMemoEdit(id);
    else if (action === 'save-edit') saveMemoEdit(id);
    else if (action === 'cancel-edit') cancelMemoEdit();
    else if (action === 'toggle-replies') toggleReplies(id);
    else if (action === 'delete') deleteMemo(id);
    else if (action === 'edit-reply') startReplyEdit('memos', id, button.dataset.reply);
    else if (action === 'cancel-reply-edit') cancelReplyEdit();
    else if (action === 'save-reply-edit') saveReplyEdit();
    else if (action === 'delete-reply') deleteReply('memos', id, button.dataset.reply);
    else if (action === 'reply-attach') openReplyFilePicker(button);
    else if (action === 'reply-remove-file') removeReplyFile(id, Number(button.dataset.index));
    else if (action === 'download-file') downloadMemoFile(button.dataset.fileId, button);
    else if (action === 'preview-file') openMemoFilePreview(button.dataset.fileId);
    else if (action === 'react') toggleReaction(button.dataset.node || 'memos', id, button.dataset.reply || '', button.dataset.emoji);
  }

  function onMemoChange(event) {
    const fileInput = event.target.closest('[data-reply-files]');
    if (fileInput) {
      addReplyFiles(fileInput.getAttribute('data-reply-files'), fileInput.files);
      fileInput.value = '';
      return;
    }
    const input = event.target.closest('[data-action="toggle"]');
    if (!input) return;
    updateMemo(input.dataset.id, { done: input.checked, updatedAt: Date.now() }, '완료 상태를 저장했습니다.');
  }

  function openReplyFilePicker(button) {
    const form = button.closest('form');
    const input = form && form.querySelector('[data-reply-files]');
    if (input) input.click();
  }

  function onMemoInput(event) {
    if (event.target.matches('[data-editor]')) {
      const key = event.target.getAttribute('data-editor') || '';
      updateEditorEmpty(event.target);
      if (key.indexOf('memo-edit:') === 0) state.drafts.memo = event.target.innerHTML || '';
      return;
    }
    if (event.target.matches('[data-edit-text]')) {
      state.drafts.memo = event.target.value;
      return;
    }
    if (event.target.matches('[data-reply-edit-text]')) {
      state.replyEditDrafts[event.target.getAttribute('data-reply-edit-text')] = event.target.value;
      return;
    }
    if (event.target.matches('[data-reply-text]') || event.target.matches('[data-reply-author]')) {
      const id = event.target.dataset.replyText || event.target.dataset.replyAuthor;
      state.replyDrafts[id] = state.replyDrafts[id] || {};
      if (event.target.matches('[data-reply-text]')) state.replyDrafts[id].text = event.target.value;
      else state.replyDrafts[id].author = event.target.value;
    }
  }

  async function onReplySubmit(event) {
    const form = event.target.closest('[data-reply-form]');
    if (!form) return;
    event.preventDefault();
    const node = form.getAttribute('data-reply-node') || 'memos';
    const id = form.getAttribute('data-reply-form');
    const authorInput = form.querySelector('[data-reply-author]');
    const textInput = form.querySelector('[data-reply-text]');
    const text = textInput.value.trim();
    const pending = node === 'memos' ? (state.replyFiles[id] || []).slice() : [];
    const submitButton = form.querySelector('button[type="submit"]');

    if (!text) {
      textInput.focus();
      toast('답글 내용을 입력해 주세요.');
      return;
    }
    const problem = validateFileList(pending);
    if (problem) {
      toast(problem);
      return;
    }

    const author = authorInput.value.trim() || '이름 없음';
    const uploadedIds = [];
    const attachments = [];
    if (submitButton) submitButton.disabled = true;
    try {
      for (let index = 0; index < pending.length; index += 1) {
        if (submitButton) submitButton.textContent = `올리는 중 ${index + 1}/${pending.length}`;
        const saved = await saveAttachmentFile(pending[index].file, id);
        uploadedIds.push(saved.summary.fileId);
        attachments.push(saved.summary);
      }
      const reply = { author, text, createdAt: Date.now() };
      if (attachments.length) reply.attachments = attachments;
      await childRef(`${node}/${id}/replies`).push(reply);
      clearReplyFiles(id);
      state.openReplies.add(id);
      state.replyDrafts[id] = { author };
      localStorage.setItem(LS.author, author);
      renderFor(node);
      toast(attachments.length
        ? `답글과 파일 ${attachments.length}개를 등록했습니다.`
        : '답글을 등록했습니다.');
    } catch (err) {
      if (uploadedIds.length) await removeMemoFiles(uploadedIds);
      toast(`답글을 등록하지 못했습니다: ${err.message || err}`);
      renderFor(node);
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = '등록';
      }
    }
  }

  function startMemoEdit(id) {
    const memo = state.memos[id];
    if (!memo) return;
    state.editing.memo = id;
    state.drafts.memo = editorHtmlFor(memo, 'text');
    renderMemos();
    const editor = dom.memoList.querySelector(`[data-editor="memo-edit:${id}"]`);
    if (editor) {
      editor.focus();
      setCaretOffset(editor, richTextToPlain(editor.innerHTML || '').length);
    }
  }

  function cancelMemoEdit() {
    state.editing.memo = null;
    state.drafts.memo = '';
    renderMemos();
  }

  async function saveMemoEdit(id) {
    const editor = dom.memoList.querySelector(`[data-editor="memo-edit:${id}"]`);
    const value = editor
      ? editorValue(editor)
      : { html: sanitizeRichHtml(state.drafts.memo || ''), text: richTextToPlain(state.drafts.memo || '') };
    const text = value.text.trim();
    if (!text) {
      if (editor) editor.focus();
      toast('내용을 입력해 주세요.');
      return;
    }
    if (text.length > EDITOR_LIMITS['memo-edit']) {
      if (editor) editor.focus();
      toast(`내용은 ${EDITOR_LIMITS['memo-edit']}자까지 쓸 수 있습니다. 지금은 ${text.length}자입니다.`);
      return;
    }
    try {
      await childRef(`memos/${id}`).update({
        text,
        html: richHasFormat(value.html) ? value.html : null,
        updatedAt: Date.now()
      });
      state.editing.memo = null;
      state.drafts.memo = '';
      renderMemos();
      toast('글을 수정했습니다.');
    } catch (err) {
      toast(`수정하지 못했습니다: ${err.message || err}`);
    }
  }

  // Firebase SDK의 update()는 REST의 PATCH와 같은 부분 수정입니다.
  async function updateMemo(id, patch, message) {
    try {
      await childRef(`memos/${id}`).update(patch);
      if (message) toast(message);
    } catch (err) {
      toast(`저장하지 못했습니다: ${err.message || err}`);
      renderMemos();
    }
  }

  function toggleReplies(id) {
    if (state.openReplies.has(id)) state.openReplies.delete(id);
    else state.openReplies.add(id);
    renderMemos();
  }

  async function deleteMemo(id) {
    const memo = state.memos[id];
    const files = memoAttachments(memo);
    const replyFiles = [];
    Object.values((memo && memo.replies) || {}).forEach((reply) => {
      replyAttachments(reply).forEach((file) => replyFiles.push(file));
    });
    const totalFiles = files.length + replyFiles.length;
    const message = totalFiles
      ? `이 글과 답글, 첨부 파일 ${totalFiles}개를 삭제할까요? 되돌릴 수 없습니다.`
      : '이 글과 답글을 삭제할까요? 되돌릴 수 없습니다.';
    if (!window.confirm(message)) return;
    try {
      await childRef(`memos/${id}`).remove();
      clearReplyFiles(id);
      if (totalFiles) {
        await removeMemoFiles(files.concat(replyFiles).map((file) => file.fileId));
        files.concat(replyFiles).forEach((file) => { delete state.attachPreviews[file.fileId]; });
      }
      toast('글을 삭제했습니다.');
    } catch (err) {
      toast(`삭제하지 못했습니다: ${err.message || err}`);
    }
  }

  async function deleteReply(node, parentId, replyId) {
    const parent = node === 'notices' ? state.notices[parentId] : state.memos[parentId];
    const reply = parent && parent.replies ? parent.replies[replyId] : null;
    const files = replyAttachments(reply);
    const message = files.length
      ? `이 답글과 첨부 파일 ${files.length}개를 삭제할까요? 되돌릴 수 없습니다.`
      : '이 답글을 삭제할까요?';
    if (!window.confirm(message)) return;
    try {
      await childRef(`${node}/${parentId}/replies/${replyId}`).remove();
      if (files.length) {
        await removeMemoFiles(files.map((file) => file.fileId));
        files.forEach((file) => { delete state.attachPreviews[file.fileId]; });
      }
      if (state.editing.reply && state.editing.reply.replyId === replyId) state.editing.reply = null;
      renderFor(node);
      toast('답글을 삭제했습니다.');
    } catch (err) {
      toast(`삭제하지 못했습니다: ${err.message || err}`);
    }
  }

  /* =========================================================
   * 7. 이미지
   * ========================================================= */
  function bindDropzone() {
    const zone = dom.imageDrop;
    if (!zone) return;
    ['dragenter', 'dragover'].forEach((type) => {
      zone.addEventListener(type, (event) => {
        event.preventDefault();
        zone.classList.add('is-over');
      });
    });
    ['dragleave', 'dragend', 'drop'].forEach((type) => {
      zone.addEventListener(type, (event) => {
        event.preventDefault();
        zone.classList.remove('is-over');
      });
    });
    zone.addEventListener('drop', (event) => {
      const files = event.dataTransfer && event.dataTransfer.files;
      if (!files || !files.length) return;
      try {
        dom.imageFiles.files = files;
        onImagePicked();
      } catch (err) {
        toast('파일을 선택하지 못했습니다. 파일 선택 버튼을 이용해 주세요.');
      }
    });
  }

  function onImagePicked() {
    const files = Array.from(dom.imageFiles.files || []);
    if (!files.length) {
      dom.imageSelected.hidden = true;
      dom.imageSelected.textContent = '';
      return;
    }
    const total = files.reduce((sum, file) => sum + file.size, 0);
    dom.imageSelected.hidden = false;
    dom.imageSelected.textContent = `${files.length}장 선택됨 · 원본 ${fmtBytes(total)} → 올릴 때 자동으로 줄입니다.`;
  }

  async function onUploadImages(event) {
    event.preventDefault();
    const files = Array.from(dom.imageFiles.files || []);
    if (!files.length) {
      toast('이미지를 먼저 선택해 주세요.');
      return;
    }
    // 한 번의 쓰기 256KB 제한을 넘지 않도록 compressImage가 200KB 이하로 맞춥니다.
    const author = dom.imageAuthor.value.trim() || '이름 없음';
    const baseTitle = dom.imageTitle.value.trim();
    dom.imageSubmit.disabled = true;
    let uploaded = 0;
    const errors = [];

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      dom.imageProgress.textContent = `처리 중 ${index + 1}/${files.length} · ${file.name}`;
      try {
        const output = await compressImage(file);
        const title = baseTitle
          ? (files.length > 1 ? `${baseTitle} ${index + 1}` : baseTitle)
          : safeFileName(file.name, `이미지 ${index + 1}`);
        await childRef('images').push({
          author,
          title,
          dataUrl: output.dataUrl,
          width: output.width,
          height: output.height,
          bytes: output.bytes,
          createdAt: Date.now()
        });
        uploaded += 1;
      } catch (err) {
        errors.push(`${file.name}: ${err.message || err}`);
      }
    }

    dom.imageSubmit.disabled = false;
    dom.imageProgress.textContent = '';
    dom.imageFiles.value = '';
    dom.imageTitle.value = '';
    dom.imageSelected.hidden = true;
    dom.imageSelected.textContent = '';
    if (uploaded) {
      localStorage.setItem(LS.author, author);
      hydrateAuthorFields();
    }

    if (errors.length && !uploaded) toast(`업로드 실패 — ${errors[0]}`);
    else if (errors.length) toast(`${uploaded}장 완료, ${errors.length}장 실패 — ${errors[0]}`);
    else toast(`${uploaded}장을 올렸습니다.`);
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('이미지를 읽지 못했습니다.'));
      };
      image.src = url;
    });
  }

  async function compressImage(file, options) {
    const opts = options || {};
    const maxSide = Number(opts.maxSide) || MAX_IMAGE_SIDE;
    const maxBytes = Number(opts.maxBytes) || MAX_WRITE_BYTES;
    if (!file.type || !file.type.startsWith('image/')) {
      throw new Error('이미지 파일이 아닙니다.');
    }
    const image = await loadImage(file);

    const ratio = Math.min(1, maxSide / Math.max(image.width || 1, image.height || 1));
    let width = Math.max(1, Math.round((image.width || maxSide) * ratio));
    let height = Math.max(1, Math.round((image.height || maxSide) * ratio));

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('이미지를 처리할 수 없는 브라우저입니다.');

    let quality = JPEG_QUALITY;
    let dataUrl = '';

    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (attempt >= 3) {
        width = Math.max(320, Math.round(width * 0.82));
        height = Math.max(320, Math.round(height * 0.82));
      }
      canvas.width = width;
      canvas.height = height;
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      dataUrl = canvas.toDataURL('image/jpeg', quality);
      if (dataUrlBytes(dataUrl) <= maxBytes) break;
      quality = Math.max(0.45, quality - 0.1);
    }

    if (dataUrlBytes(dataUrl) > maxBytes) {
      throw new Error('용량을 줄이지 못했습니다. 더 작은 이미지를 써 주세요.');
    }

    return { dataUrl, width, height, bytes: dataUrlBytes(dataUrl) };
  }

  function renderImages() {
    if (!dom.imageList) return;
    const items = Object.entries(state.images || {})
      .filter(([, image]) => image && typeof image === 'object')
      .map(([id, image]) => ({ id, ...image }))
      .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));

    dom.imageList.textContent = '';
    dom.imageEmpty.hidden = items.length > 0;
    if (!items.length) {
      dom.imageEmpty.textContent = state.imagesLoaded
        ? '아직 올린 이미지가 없습니다. 회의 자료나 시안을 올려 보세요.'
        : '이미지를 불러오는 중…';
    }

    items.forEach((image) => {
      const meta = [
        image.author || '이름 없음',
        fmtStamp(image.createdAt),
        image.width && image.height ? `${image.width}×${image.height}` : '',
        fmtBytes(image.bytes)
      ].filter(Boolean).join(' · ');

      dom.imageList.append(h('article', { class: 'image-card', 'data-id': image.id },
        h('button', {
          type: 'button',
          class: 'image-thumb',
          'data-action': 'view',
          'data-id': image.id,
          'aria-label': `${image.title || '이미지'} 크게 보기`
        }, h('img', { src: safeImageSrc(image.dataUrl), alt: image.title || '공유 이미지', loading: 'lazy' })),
        h('div', { class: 'image-meta' },
          h('strong', { class: 'image-title', title: image.title || '' }, image.title || '제목 없음'),
          h('p', { class: 'muted' }, meta),
          h('div', { class: 'image-actions' },
            h('button', { type: 'button', class: 'btn ghost small', 'data-action': 'download', 'data-id': image.id }, '다운로드'),
            h('button', { type: 'button', class: 'btn ghost small', 'data-action': 'delete-image', 'data-id': image.id }, '삭제')
          )
        )
      ));
    });
  }

  function downloadImage(image) {
    const src = safeImageSrc(image.dataUrl);
    if (!src) {
      toast('이미지 주소가 올바르지 않아 내려받을 수 없습니다.');
      return;
    }
    const anchor = document.createElement('a');
    anchor.href = src;
    anchor.download = `${safeFileName(image.title)}.jpg`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }

  function onImageClick(event) {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const image = state.images[button.dataset.id];
    if (!image) return;
    if (button.dataset.action === 'view') openImageModal(image);
    else if (button.dataset.action === 'download') downloadImage(image);
    else if (button.dataset.action === 'delete-image') deleteImage(button.dataset.id);
  }

  function openImageModal(image) {
    const src = safeImageSrc(image.dataUrl);
    dom.modalTitle.textContent = image.title || '이미지';
    dom.modalImage.src = src;
    dom.modalImage.alt = image.title || '공유 이미지';
    dom.modalMeta.textContent = [
      image.author || '이름 없음',
      fmtStamp(image.createdAt),
      image.width && image.height ? `${image.width}×${image.height}` : '',
      fmtBytes(image.bytes)
    ].filter(Boolean).join(' · ');
    dom.modalDownload.href = src;
    dom.modalDownload.download = `${safeFileName(image.title)}.jpg`;
    if (typeof dom.modal.showModal === 'function') dom.modal.showModal();
    else dom.modal.setAttribute('open', '');
  }

  async function deleteImage(id) {
    if (!window.confirm('이 이미지를 삭제할까요? 되돌릴 수 없습니다.')) return;
    try {
      await childRef(`images/${id}`).remove();
      toast('이미지를 삭제했습니다.');
    } catch (err) {
      toast(`삭제하지 못했습니다: ${err.message || err}`);
    }
  }

  /* =========================================================
   * 8. 공지
   * ========================================================= */
  function noticeList() {
    return Object.entries(state.notices || {})
      .filter(([, item]) => item && typeof item === 'object')
      .map(([id, item]) => ({ id, ...item }))
      .sort((a, b) => {
        // 상단 고정 공지가 먼저, 같은 순위에서는 최신순
        const pinDiff = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
        if (pinDiff) return pinDiff;
        return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
      });
  }

  function renderNotices() {
    if (!dom.noticeList) return;
    const savedFocus = rememberFocus(dom.noticeList);
    const all = noticeList();
    dom.noticeList.textContent = '';
    dom.noticeEmpty.hidden = all.length > 0;
    dom.noticeEmpty.textContent = '아직 등록된 공지가 없습니다. 위에서 첫 공지를 남겨 보세요.';
    all.forEach((item) => dom.noticeList.append(noticeItem(item)));
    refreshEditors(dom.noticeList);
    restoreFocus(dom.noticeList, savedFocus);
  }

  function noticeItem(item) {
    if (state.editing.notice === item.id) return noticeEditForm(item);

    const replies = Object.entries(item.replies || {})
      .filter(([, reply]) => reply && typeof reply === 'object')
      .map(([id, reply]) => ({ id, ...reply }))
      .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
    const repliesOpen = state.openReplies.has(item.id);

    const card = h('article', { class: `notice-item${item.pinned ? ' is-pinned' : ''}`, 'data-id': item.id },
      h('div', { class: 'notice-head' },
        item.pinned ? h('span', { class: 'notice-badge pin' }, '상단 고정') : null,
        item.important ? h('span', { class: 'notice-badge important' }, '중요') : null,
        h('h3', { class: 'notice-title' }, item.title || '(제목 없음)')
      ),
      h('p', { class: 'notice-meta' },
        h('span', {}, item.author || '이름 없음'),
        h('span', {}, fmtStamp(item.createdAt)),
        item.updatedAt && Number(item.updatedAt) !== Number(item.createdAt)
          ? h('span', {}, `수정 ${fmtStamp(item.updatedAt)}`)
          : null
      ),
      (item.content || itemRichHtml(item, 'content')) ? richBody('p', 'notice-content', item, 'content') : null,
      reactionBar('notices', item.id, '', item.reactions),
      h('div', { class: 'notice-actions' },
        h('button', { type: 'button', class: 'text-btn', 'data-action': 'edit-notice', 'data-id': item.id }, '수정'),
        h('button', {
          type: 'button',
          class: 'text-btn',
          'data-action': 'toggle-pin',
          'data-id': item.id
        }, item.pinned ? '고정 해제' : '상단 고정'),
        h('button', {
          type: 'button',
          class: 'text-btn',
          'data-action': 'toggle-replies',
          'data-id': item.id
        }, replies.length ? `답글 ${replies.length}` : '답글'),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'text-btn danger', 'data-action': 'delete-notice', 'data-id': item.id }, '삭제')
      )
    );

    if (repliesOpen) card.append(repliesBlock('notices', item, replies));
    return card;
  }

  function noticeEditForm(item) {
    const draft = state.drafts.notice[item.id] || {};
    const value = (key) => (draft[key] !== undefined ? draft[key] : (item[key] !== undefined ? item[key] : ''));
    const checked = (key) => (draft[key] !== undefined ? !!draft[key] : !!item[key]);

    return h('form', { class: 'notice-item notice-edit', 'data-edit-notice': item.id },
      h('div', { class: 'form-grid' },
        h('label', { class: 'field span-2' },
          h('span', { class: 'field-label' }, '제목'),
          h('input', { class: 'input', 'data-field': 'title', maxlength: 100, value: value('title') })
        ),
        h('label', { class: 'field' },
          h('span', { class: 'field-label' }, '작성자'),
          h('input', { class: 'input', 'data-field': 'author', maxlength: 20, value: value('author') })
        ),
        h('div', { class: 'field notice-edit-flags' },
          h('label', { class: 'check' },
            h('input', { type: 'checkbox', 'data-field': 'important', checked: checked('important') }),
            h('span', {}, '중요 공지')
          ),
          h('label', { class: 'check' },
            h('input', { type: 'checkbox', 'data-field': 'pinned', checked: checked('pinned') }),
            h('span', {}, '상단 고정')
          )
        ),
        h('div', { class: 'field span-2 editor-shell' },
          h('span', { class: 'field-label' }, '내용'),
          h('div', { class: 'editor-toolbar', role: 'toolbar', 'aria-label': '본문 서식' }, ...toolbarControls()),
          h('div', {
            class: 'input textarea editor',
            contenteditable: 'true',
            role: 'textbox',
            'aria-multiline': 'true',
            'aria-label': '공지 내용 수정',
            'data-editor': `notice-edit:${item.id}`,
            'data-empty': 'true',
            'data-placeholder': '공지 내용을 적어 주세요.',
            html: draft.content !== undefined ? draft.content : editorHtmlFor(item, 'content')
          })
        )
      ),
      h('div', { class: 'row-actions end' },
        h('button', { type: 'button', class: 'btn ghost small', 'data-action': 'cancel-notice' }, '취소'),
        h('button', { type: 'submit', class: 'btn primary small' }, '저장')
      )
    );
  }

  async function onAddNotice(event) {
    event.preventDefault();
    const title = dom.noticeTitle.value.trim();
    const value = editorValue(dom.noticeText);
    const content = value.text.trim();
    const author = dom.noticeAuthor.value.trim() || '이름 없음';

    if (!title) {
      dom.noticeTitle.focus();
      toast('공지 제목을 입력해 주세요.');
      return;
    }
    if (!content) {
      dom.noticeText.focus();
      toast('공지 내용을 입력해 주세요.');
      return;
    }
    if (content.length > EDITOR_LIMITS.notice) {
      dom.noticeText.focus();
      toast(`공지 내용은 ${EDITOR_LIMITS.notice}자까지 쓸 수 있습니다. 지금은 ${content.length}자입니다.`);
      return;
    }

    const now = Date.now();
    setNoticeBusy(true);
    try {
      const notice = {
        title,
        author,
        content,
        important: !!dom.noticeImportant.checked,
        pinned: !!dom.noticePinned.checked,
        createdAt: now,
        updatedAt: now
      };
      if (richHasFormat(value.html)) notice.html = value.html;
      await childRef('notices').push(notice);
      dom.noticeTitle.value = '';
      setEditorHtml(dom.noticeText, '');
      dom.noticeImportant.checked = false;
      dom.noticePinned.checked = false;
      localStorage.setItem(LS.author, author);
      hydrateAuthorFields();
      toast('공지를 등록했습니다.');
    } catch (err) {
      toast(`등록하지 못했습니다: ${err.message || err}`);
    } finally {
      setNoticeBusy(false);
    }
  }

  function setNoticeBusy(busy) {
    if (!dom.noticeSubmit) return;
    dom.noticeSubmit.disabled = busy;
    dom.noticeSubmit.textContent = busy ? '등록 중…' : '등록';
  }

  function onNoticeClick(event) {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const { action, id } = button.dataset;
    if (action === 'edit-notice') startNoticeEdit(id);
    else if (action === 'cancel-notice') cancelNoticeEdit();
    else if (action === 'toggle-pin') toggleNoticePin(id);
    else if (action === 'toggle-replies') toggleNoticeReplies(id);
    else if (action === 'edit-reply') startReplyEdit('notices', id, button.dataset.reply);
    else if (action === 'cancel-reply-edit') cancelReplyEdit();
    else if (action === 'save-reply-edit') saveReplyEdit();
    else if (action === 'delete-reply') deleteReply('notices', id, button.dataset.reply);
    else if (action === 'delete-notice') deleteNotice(id);
    else if (action === 'react') toggleReaction('notices', id, button.dataset.reply || '', button.dataset.emoji);
  }

  function startNoticeEdit(id) {
    if (!state.notices[id]) return;
    state.editing.notice = id;
    state.drafts.notice[id] = {};
    renderNotices();
    const form = dom.noticeList.querySelector(`[data-edit-notice="${id}"]`);
    const input = form && form.querySelector('[data-field="title"]');
    if (input) input.focus();
  }

  function cancelNoticeEdit() {
    if (state.editing.notice) delete state.drafts.notice[state.editing.notice];
    state.editing.notice = null;
    renderNotices();
  }

  async function saveNotice(id) {
    const item = state.notices[id] || {};
    const draft = state.drafts.notice[id] || {};
    const pick = (key) => (draft[key] !== undefined ? draft[key] : item[key]);
    const editor = dom.noticeList.querySelector(`[data-editor="notice-edit:${id}"]`);
    const value = editor
      ? editorValue(editor)
      : {
        html: sanitizeRichHtml(draft.content !== undefined ? draft.content : editorHtmlFor(item, 'content')),
        text: ''
      };
    const next = {
      title: String(pick('title') || '').trim(),
      author: String(pick('author') || '').trim(),
      content: value.text.trim(),
      html: richHasFormat(value.html) ? value.html : null,
      important: !!pick('important'),
      pinned: !!pick('pinned'),
      updatedAt: Date.now()
    };
    if (!next.title) {
      toast('제목을 입력해 주세요.');
      return;
    }
    if (!next.content) {
      if (editor) editor.focus();
      toast('내용을 입력해 주세요.');
      return;
    }
    if (next.content.length > EDITOR_LIMITS['notice-edit']) {
      if (editor) editor.focus();
      toast(`내용은 ${EDITOR_LIMITS['notice-edit']}자까지 쓸 수 있습니다. 지금은 ${next.content.length}자입니다.`);
      return;
    }
    try {
      await childRef(`notices/${id}`).update(next);
      delete state.drafts.notice[id];
      state.editing.notice = null;
      renderNotices();
      toast('공지를 수정했습니다.');
    } catch (err) {
      toast(`저장하지 못했습니다: ${err.message || err}`);
    }
  }

  async function toggleNoticePin(id) {
    const item = state.notices[id];
    if (!item || typeof item !== 'object') return;
    const pinned = !item.pinned;
    try {
      await childRef(`notices/${id}`).update({ pinned, updatedAt: Date.now() });
      toast(pinned ? '공지를 상단에 고정했습니다.' : '상단 고정을 해제했습니다.');
    } catch (err) {
      toast(`저장하지 못했습니다: ${err.message || err}`);
      renderNotices();
    }
  }

  async function deleteNotice(id) {
    const replies = Object.keys((state.notices[id] && state.notices[id].replies) || {}).length;
    const message = replies
      ? `이 공지와 답글 ${replies}개를 삭제할까요? 되돌릴 수 없습니다.`
      : '이 공지를 삭제할까요? 되돌릴 수 없습니다.';
    if (!window.confirm(message)) return;
    try {
      await childRef(`notices/${id}`).remove();
      if (state.editing.notice === id) {
        delete state.drafts.notice[id];
        state.editing.notice = null;
      }
      toast('공지를 삭제했습니다.');
    } catch (err) {
      toast(`삭제하지 못했습니다: ${err.message || err}`);
    }
  }

  function toggleNoticeReplies(id) {
    if (state.openReplies.has(id)) state.openReplies.delete(id);
    else state.openReplies.add(id);
    renderNotices();
  }

  function onNoticeDraftInput(event) {
    if (event.target.matches('[data-editor]')) {
      const key = event.target.getAttribute('data-editor') || '';
      updateEditorEmpty(event.target);
      if (key.indexOf('notice-edit:') === 0) {
        const id = key.slice('notice-edit:'.length);
        state.drafts.notice[id] = state.drafts.notice[id] || {};
        state.drafts.notice[id].content = event.target.innerHTML || '';
      }
      return;
    }
    if (event.target.matches('[data-reply-edit-text]')) {
      state.replyEditDrafts[event.target.getAttribute('data-reply-edit-text')] = event.target.value;
      return;
    }
    if (event.target.matches('[data-reply-text]') || event.target.matches('[data-reply-author]')) {
      const id = event.target.dataset.replyText || event.target.dataset.replyAuthor;
      state.replyDrafts[id] = state.replyDrafts[id] || {};
      if (event.target.matches('[data-reply-text]')) state.replyDrafts[id].text = event.target.value;
      else state.replyDrafts[id].author = event.target.value;
      return;
    }
    const form = event.target.closest('[data-edit-notice]');
    if (!form) return;
    const field = event.target.getAttribute('data-field');
    if (!field || !event.target.matches('input, textarea')) return;
    const id = form.getAttribute('data-edit-notice');
    state.drafts.notice[id] = state.drafts.notice[id] || {};
    state.drafts.notice[id][field] = event.target.type === 'checkbox'
      ? event.target.checked
      : event.target.value;
  }

  function onNoticeEditSubmit(event) {
    const form = event.target.closest('[data-edit-notice]');
    if (!form) return;
    event.preventDefault();
    saveNotice(form.getAttribute('data-edit-notice'));
  }

  /* =========================================================
   * 9. AI 연동
   * ========================================================= */
  function renderAiPanel() {
    const root = dom.aiContent;
    if (!root) return;
    root.textContent = '';

    if (!state.roomKey || !CFG.databaseURL) {
      root.append(h('p', { class: 'empty' }, '비서실에 입장하면 연결 정보와 REST API 예시가 여기에 표시됩니다.'));
      return;
    }

    const dbUrl = String(CFG.databaseURL).replace(/\/+$/, '');
    const projectId = CFG.projectId || '';
    const base = `${dbUrl}/office/${state.roomKey}`;

    root.append(h('section', { class: 'card ai-card' },
      h('h2', {}, '연결 정보'),
      h('p', { class: 'muted' }, '아래 주소와 방 키를 다른 AI나 스크립트에 알려 주면, 같은 비서실의 업무 공유·공지·이미지를 REST API로 읽고 쓸 수 있습니다.'),
      kvRow('Firebase 주소', dbUrl, 'Firebase 주소를'),
      kvRow('프로젝트 ID', projectId, '프로젝트 ID를'),
      h('div', { class: 'kv' },
        h('span', { class: 'kv-label' }, 'ROOM_KEY'),
        h('code', {}, state.showRoomKey ? state.roomKey : `${state.roomKey.slice(0, 8)}…${state.roomKey.slice(-4)}`),
        h('span', { class: 'row-actions' },
          h('button', { type: 'button', class: 'btn ghost small', 'data-toggle-key': '1' }, state.showRoomKey ? '숨기기' : '보기'),
          h('button', { type: 'button', class: 'btn ghost small', 'data-copy': state.roomKey, 'data-copy-label': 'ROOM_KEY를' }, '복사')
        )
      ),
      kvRow('REST 기본 주소', base, 'REST 주소를')
    ));

    root.append(codeCard(
      '업무 공유 읽기·쓰기 (curl)',
      'GET으로 읽고, POST로 새 글을 넣고, PATCH로 완료 상태만 바꿉니다.',
      [
        `# 1) 업무 공유 전체 조회 (GET)`,
        `curl "${base}/memos.json"`,
        ``,
        `# 2) 업무 공유 등록 (POST)`,
        `curl -X POST -H "Content-Type: application/json" \\`,
        `  -d '{"author":"AI비서","tag":"보고","text":"보고 내용","done":false,"createdAt":1795768800000}' \\`,
        `  "${base}/memos.json"`,
        ``,
        `# 3) 완료 처리 (PATCH — 일부 값만 수정)`,
        `curl -X PATCH -H "Content-Type: application/json" \\`,
        `  -d '{"done":true,"updatedAt":1795768800000}' \\`,
        `  "${base}/memos/{글ID}.json"`,
        ``,
        `# 4) 답글 등록 (POST — 이미지·파일은 attachments에 요약만)`,
        `curl -X POST -H "Content-Type: application/json" \\`,
        `  -d '{"author":"AI비서","text":"답글 내용","createdAt":1795768800000,"attachments":[{"fileId":"-N...","name":"시안.jpg","type":"image/jpeg","size":182000}]}' \\`,
        `  "${base}/memos/{글ID}/replies.json"`,
        ``,
        `# 4-1) 답글 수정 (PATCH — 내용만)`,
        `curl -X PATCH -H "Content-Type: application/json" \\`,
        `  -d '{"text":"고친 답글 내용","updatedAt":1795768800000}' \\`,
        `  "${base}/memos/{글ID}/replies/{답글ID}.json"`,
        ``,
        `# 5) 삭제 (DELETE)`,
        `curl -X DELETE "${base}/memos/{글ID}.json"`
      ].join('\n')
    ));

    root.append(codeCard(
      '서식(굵게·색·형광펜)과 이모지 반응',
      '본문은 평문(text)과 서식 있는 HTML(html, 선택)을 함께 저장합니다. 화면·AI 판독·정기 확인(check.sh)은 평문 text를 쓰고, 보여 줄 때는 html을 화이트리스트로 다시 정리해 그립니다. 이모지 반응은 글·답글·공지 아래 reactions/{이모지}/{이름} = true 로 쌓입니다.',
      [
        `# 서식 있는 업무 공유 등록 (html은 넣어도 되고 빼도 됩니다)`,
        `curl -X POST -H "Content-Type: application/json" \\`,
        `  -d '{"author":"AI비서","tag":"보고","text":"중요 보고입니다.","html":"<b>중요</b> <span style=\\"color: var(--rt-red)\\">보고</span>입니다.","done":false,"createdAt":1795768800000}' \\`,
        `  "${base}/memos.json"`,
        ``,
        `# 이모지 반응 남기기 / 취소하기 (PUT·DELETE — 이름의 공백은 URL 인코딩)`,
        `curl -X PUT -H "Content-Type: application/json" -d 'true' \\`,
        `  "${base}/memos/{글ID}/reactions/%E2%9C%85/%EB%B3%84%20%EA%B3%BC%EC%9E%A5.json"`,
        `curl -X DELETE "${base}/memos/{글ID}/reactions/%E2%9C%85/%EB%B3%84%20%EA%B3%BC%EC%9E%A5.json"`,
        ``,
        `# 반응 전체 보기 (누가 눌렀는지 포함)`,
        `curl "${base}/memos/{글ID}/reactions.json"`,
        ``,
        `# 답글은 replies/{답글ID}/reactions/{이모지}/{이름}, 공지는 notices/{공지ID}/reactions/... 로 같습니다.`,
        `# 이모지 키: ✅ 👍 ❤️ 👏 👀 (URL에서는 %E2%9C%85 처럼 인코딩됩니다)`
      ].join('\n')
    ));

    root.append(codeCard(
      '공지 (curl)',
      '상단 고정(pinned)과 중요 표시(important)를 함께 저장하고, 공지마다 답글(replies)을 달 수 있습니다. 목록은 상단 고정이 먼저, 나머지는 최신순입니다.',
      [
        `# 공지 전체 조회 (GET)`,
        `curl "${base}/notices.json"`,
        ``,
        `# 공지 등록 (POST)`,
        `curl -X POST -H "Content-Type: application/json" \\`,
        `  -d '{"title":"12월 업무 일정 안내","author":"AI비서","content":"공지 내용","important":false,"pinned":true,"createdAt":1795768800000,"updatedAt":1795768800000}' \\`,
        `  "${base}/notices.json"`,
        ``,
        `# 상단 고정 해제 (PATCH — 일부 값만 수정)`,
        `curl -X PATCH -H "Content-Type: application/json" \\`,
        `  -d '{"pinned":false,"updatedAt":1795768800000}' \\`,
        `  "${base}/notices/{공지ID}.json"`,
        ``,
        `# 공지 답글 조회 / 등록 (POST)`,
        `curl "${base}/notices/{공지ID}/replies.json"`,
        `curl -X POST -H "Content-Type: application/json" \\`,
        `  -d '{"author":"AI비서","text":"확인했습니다.","createdAt":1795768800000}' \\`,
        `  "${base}/notices/{공지ID}/replies.json"`,
        ``,
        `# 공지 답글 수정 (PATCH — 내용만)`,
        `curl -X PATCH -H "Content-Type: application/json" \\`,
        `  -d '{"text":"고친 답글 내용","updatedAt":1795768800000}' \\`,
        `  "${base}/notices/{공지ID}/replies/{답글ID}.json"`,
        ``,
        `# 공지 삭제 (DELETE — 답글도 함께 사라집니다)`,
        `curl -X DELETE "${base}/notices/{공지ID}.json"`,
        ``,
        `# 이미지 목록`,
        `curl "${base}/images.json"`
      ].join('\n')
    ));

    root.append(codeCard(
      '업무 공유 첨부 파일 (memoFiles)',
      '첨부 파일 본문은 글·답글과 분리해 memoFiles에 둡니다. 글과 답글에는 이름·형식·용량만 남아 목록과 정기 확인이 가볍습니다. 5MB를 넘는 파일은 512K자씩 chunks로 나뉘어 저장됩니다. 답글 첨부도 같은 memoFiles/{fileId}에 저장하고 답글 객체에는 attachments 요약만 둡니다.',
      [
        `# 글에는 첨부 메타데이터만 들어갑니다`,
        `curl "${base}/memos.json"`,
        `# → { "text": "...", "attachments": [{ "fileId": "-N...", "name": "보고서.hwp", "type": "application/x-hwp", "size": 234567 }] }`,
        ``,
        `# 첨부 파일 본문 조회 (dataUrl 또는 chunks)`,
        `curl "${base}/memoFiles/{fileId}.json"`,
        ``,
        `# 파일 하나 올리기 (Base64 data URL 문자열)`,
        `curl -X PUT -H "Content-Type: application/json" \\`,
        `  -d '{"name":"메모.txt","type":"text/plain","size":12,"dataUrl":"data:text/plain;base64,...","createdAt":1795768800000}' \\`,
        `  "${base}/memoFiles/{fileId}.json"`,
        ``,
        `# 글 삭제 시 첨부도 함께 정리`,
        `curl -X DELETE "${base}/memoFiles/{fileId}.json"`
      ].join('\n')
    ));

    root.append(codeCard(
      '자바스크립트(fetch) 예시',
      '브라우저나 Node 스크립트에서도 같은 방식으로 쓸 수 있습니다.',
      [
        `const BASE = "${base}";`,
        ``,
        `// 업무 공유 읽기`,
        'const res = await fetch(`${BASE}/memos.json`);',
        'const memos = await res.json();',
        '',
        '// 업무 공유 등록',
        'await fetch(`${BASE}/memos.json`, {',
        '  method: "POST",',
        '  headers: { "Content-Type": "application/json" },',
        '  body: JSON.stringify({ author: "AI비서", tag: "보고", text: "내용", done: false, createdAt: Date.now() })',
        '});',
        '',
        '// 완료 처리 (PATCH)',
        'await fetch(`${BASE}/memos/${memoId}.json`, {',
        '  method: "PATCH",',
        '  headers: { "Content-Type": "application/json" },',
        '  body: JSON.stringify({ done: true })',
        '});'
      ].join('\n')
    ));

    root.append(h('section', { class: 'card ai-card' },
      h('h3', {}, '정기 확인 (check.sh) 팁'),
      h('p', { class: 'muted' }, '정해진 시간에 아래 스크립트를 돌려, 완료되지 않은 업무 공유 글이 있을 때만 AI를 깨우면 활동량을 아낄 수 있습니다.'),
      codeBlock([
        '#!/bin/sh',
        '# 완료되지 않은 업무 공유 글이 있으면 exit 0 (AI를 깨움)',
        'BASE="' + base + '"',
        'json=$(curl -fsS "$BASE/memos.json?print=pretty") || exit 1',
        'printf "%s" "$json" | grep -q \'"done": false\' && exit 0',
        'exit 1'
      ].join('\n'))
    ));

    root.append(codeCard(
      'Firebase 보안 규칙',
      'Realtime Database > 규칙에 아래 내용을 붙여넣으면, 이 방 키로만 읽고 쓸 수 있습니다.',
      [
        '{',
        '  "rules": {',
        '    "office": {',
        '      "$room": {',
        `        ".read": "$room === '${state.roomKey}'",`,
        `        ".write": "$room === '${state.roomKey}'"`,
        '      }',
        '    }',
        '  }',
        '}'
      ].join('\n')
    ));

    root.append(h('section', { class: 'card ai-card ai-warn' },
      h('h3', {}, '주의해서 다뤄 주세요'),
      h('p', {}, '· ROOM_KEY는 비밀번호를 해시한 값으로, 사실상 이 방의 열쇠입니다. 공개 게시물이나 남에게 그대로 알려 주지 마세요.'),
      h('p', {}, '· 이 저장소는 공개(Public)입니다. 이름·전화번호·주소·계정 비밀번호 같은 개인정보는 업무 공유 글이나 이미지로 올리지 마세요.'),
      h('p', {}, '· REST API에는 별도 로그인이 없습니다. 주소를 아는 사람은 규칙이 허용하는 범위에서 읽고 쓸 수 있습니다.')
    ));
  }

  function kvRow(label, value, copyLabel) {
    return h('div', { class: 'kv' },
      h('span', { class: 'kv-label' }, label),
      h('code', {}, value),
      h('button', {
        type: 'button',
        class: 'btn ghost small',
        'data-copy': value,
        'data-copy-label': copyLabel || label
      }, '복사')
    );
  }

  function codeBlock(code) {
    return h('div', { class: 'code-wrap' },
      h('pre', { class: 'code' }, h('code', {}, code)),
      h('button', { type: 'button', class: 'btn ghost small code-copy', 'data-copy': code, 'data-copy-label': '예시 코드를' }, '복사')
    );
  }

  function codeCard(title, description, code) {
    return h('section', { class: 'card ai-card' },
      h('h3', {}, title),
      description ? h('p', { class: 'muted' }, description) : null,
      codeBlock(code)
    );
  }

  function onAiClick(event) {
    const copyButton = event.target.closest('[data-copy]');
    if (copyButton) {
      copyText(copyButton.getAttribute('data-copy'), copyButton.getAttribute('data-copy-label') || '내용');
      return;
    }
    if (event.target.closest('[data-toggle-key]')) {
      state.showRoomKey = !state.showRoomKey;
      renderAiPanel();
    }
  }
})();
