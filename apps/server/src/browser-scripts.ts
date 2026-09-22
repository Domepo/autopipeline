export const recorderClientScript = String.raw`
(() => {
  if (window.__ascRecorderInstalled) return;
  window.__ascRecorderInstalled = true;
  window.__ascRecorderMode = 'record';

  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const cssEscape = (value) => window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  const roleFor = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (['submit', 'button', 'reset'].includes(type)) return 'button';
      return 'textbox';
    }
    return '';
  };
  const accessibleName = (el) => {
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    if (el.id) {
      const label = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
      if (label) return clean(label.textContent);
    }
    const parent = el.closest('label');
    if (parent) return clean(parent.textContent);
    const isPassword = el instanceof HTMLInputElement && el.type === 'password';
    return clean(el.innerText || (isPassword ? '' : el.value) || el.getAttribute('title'));
  };
  const cssPath = (el) => {
    if (el.id) return '#' + cssEscape(el.id);
    const parts = [];
    let current = el;
    while (current && current.nodeType === 1 && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      const stableClass = [...current.classList].find((value) => !/[0-9]{4,}/.test(value) && value.length < 48);
      if (stableClass) part += '.' + cssEscape(stableClass);
      const siblings = current.parentElement ? [...current.parentElement.children].filter((item) => item.tagName === current.tagName) : [];
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      parts.unshift(part);
      current = current.parentElement;
      if (current && current.id) { parts.unshift('#' + cssEscape(current.id)); break; }
    }
    return parts.join(' > ');
  };
  const locatorFor = (el) => {
    const candidates = [];
    const role = roleFor(el);
    const name = accessibleName(el);
    if (role && name) candidates.push({ kind: 'role', value: role, name, exact: true });
    if (el.id) {
      const label = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
      if (label) candidates.push({ kind: 'label', value: clean(label.textContent), exact: true });
    }
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test');
    if (testId) candidates.push({ kind: 'testId', value: testId, exact: true });
    const placeholder = clean(el.getAttribute('placeholder'));
    if (placeholder) candidates.push({ kind: 'placeholder', value: placeholder, exact: true });
    if (name && !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) candidates.push({ kind: 'text', value: name, exact: true });
    candidates.push({ kind: 'css', value: cssPath(el) });
    return { candidates, description: name || el.tagName.toLowerCase() };
  };
  const emit = (payload) => {
    if (typeof window.__ascEmit === 'function') window.__ascEmit(payload).catch(() => {});
  };
  const target = (event) => event.target instanceof Element ? event.target.closest('button,a,input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[contenteditable="true"]') || event.target : null;

  document.addEventListener('click', (event) => {
    const el = target(event);
    if (!el) return;
    if (window.__ascRecorderMode === 'extract') {
      event.preventDefault(); event.stopImmediatePropagation();
      window.__ascRecorderMode = 'record';
      emit({ type: 'extractText', locator: locatorFor(el), text: clean(el.textContent || el.value), label: accessibleName(el) });
      return;
    }
    if (window.__ascRecorderMode !== 'record') return;
    const tag = el.tagName.toLowerCase();
    const inputType = (el.getAttribute('type') || 'text').toLowerCase();
    if ((tag === 'input' && ['text','email','password','number','search','url','tel','file','checkbox','radio','date','time','datetime-local'].includes(inputType)) || tag === 'textarea' || tag === 'select') return;
    emit({ type: 'click', locator: locatorFor(el), label: accessibleName(el) });
  }, true);

  document.addEventListener('change', (event) => {
    if (window.__ascRecorderMode !== 'record') return;
    const el = event.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return;
    const locator = locatorFor(el);
    if (el instanceof HTMLSelectElement) emit({ type: 'select', locator, value: el.value, label: accessibleName(el) });
    else if (el.type === 'checkbox' || el.type === 'radio') emit({ type: 'toggle', locator, checked: el.checked, label: accessibleName(el) });
    else if (el.type === 'file') emit({ type: 'upload', locator, filename: el.files && el.files[0] ? el.files[0].name : '', label: accessibleName(el) });
    else emit({ type: 'fill', locator, value: el.type === 'password' ? '' : el.value, password: el.type === 'password', label: accessibleName(el) });
  }, true);

  document.addEventListener('keydown', (event) => {
    if (window.__ascRecorderMode !== 'record' || !['Enter', 'Escape', 'Tab'].includes(event.key)) return;
    const el = target(event);
    emit({ type: 'press', locator: el ? locatorFor(el) : undefined, key: event.key, label: el ? accessibleName(el) : event.key });
  }, true);

  window.__ascSetRecorderMode = (mode) => { window.__ascRecorderMode = mode; };
})();
`

export const visualizerClientScript = String.raw`
(() => {
  if (window.__ascVisualizerInstalled) return;
  window.__ascVisualizerInstalled = true;
  const host = document.createElement('div');
  host.id = '__asc-visualizer';
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = '.box{position:fixed;border:3px solid #35d5ff;border-radius:7px;box-shadow:0 0 0 4px rgba(53,213,255,.22),0 0 24px rgba(53,213,255,.5);transition:all .12s ease}.ring{position:fixed;width:18px;height:18px;margin:-9px;border:3px solid #ffb648;border-radius:50%;animation:pulse .45s ease-out forwards}.hud{position:fixed;right:18px;top:18px;min-width:250px;max-width:360px;background:#0b1220ee;color:#f8fbff;border:1px solid #30415f;border-radius:12px;padding:12px 14px;font:600 13px/1.4 system-ui,-apple-system,sans-serif;box-shadow:0 14px 40px #0008}.hud small{display:block;color:#8ea2c4;font-size:11px;font-weight:600;margin-bottom:4px;text-transform:uppercase;letter-spacing:.08em}.hud b{color:#58dcff}.progress{height:4px;background:#27344d;border-radius:5px;margin-top:9px;overflow:hidden}.progress i{display:block;height:100%;background:#35d5ff;transition:width .2s}@keyframes pulse{0%{transform:scale(.7);opacity:1}100%{transform:scale(2.2);opacity:0}}';
  const layer = document.createElement('div');
  shadow.append(style, layer);
  window.__ascVisualize = (element, info) => {
    if (!host.isConnected) document.documentElement.appendChild(host);
    layer.replaceChildren();
    const rect = element && element.getBoundingClientRect ? element.getBoundingClientRect() : null;
    if (rect) {
      const box = document.createElement('div'); box.className = 'box';
      box.style.left = (rect.left - 4) + 'px'; box.style.top = (rect.top - 4) + 'px'; box.style.width = (rect.width + 8) + 'px'; box.style.height = (rect.height + 8) + 'px';
      layer.appendChild(box);
      if (info.action === 'click' || info.action === 'download') {
        const ring = document.createElement('div'); ring.className = 'ring'; ring.style.left = (rect.left + rect.width / 2) + 'px'; ring.style.top = (rect.top + rect.height / 2) + 'px'; layer.appendChild(ring);
      }
    }
    const hud = document.createElement('div'); hud.className = 'hud';
    const percent = info.total ? Math.round(((info.index + 1) / info.total) * 100) : 0;
    hud.innerHTML = '<small>AutoSecureCloud · ' + escapeHtml(info.device) + '</small><div><b>Schritt ' + (info.index + 1) + '/' + info.total + '</b> · ' + escapeHtml(info.label) + '</div><div class="progress"><i style="width:' + percent + '%"></i></div>';
    layer.appendChild(hud);
  };
  window.__ascClearVisualize = () => { layer.replaceChildren(); };
  function escapeHtml(value){ return String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
})();
`
