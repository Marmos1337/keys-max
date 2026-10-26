# Design-review catalogue: every screen, sheet and state of every role, plus an
# automatic audit of each frame (overflow, clipped text, plurals, small targets,
# low contrast, tiny type, uneven gaps between blocks).
# Data: seed-rich.mjs + seed-polish.mjs in a pristine data dir. The script starts the
# fake Bot API (:3999) and the server (:3000, test mode, local tokens) itself and
# restarts the server on a fresh copy of the data for every width × theme, because
# some steps create links.
# Usage: KEYS_REPO=<repo> KEYS_DATA=<pristine data dir> python polish_shots.py <out_dir> <prefix> [widths] [themes] [only]
#   widths 320,375,390,430,768   themes light,dark   only: comma list of owner,tenant,coowner,max,newcomer,states
# Writes PNGs and <out_dir>/<prefix>-audit.json; prints a summary.
import hashlib, hmac, json, os, shutil, subprocess, sys, tempfile, time, urllib.parse, urllib.request
from playwright.sync_api import sync_playwright
REPO, PRISTINE, NODE = os.environ['KEYS_REPO'], os.environ['KEYS_DATA'], os.environ.get('NODE', 'node')
RUN_DIR = tempfile.mkdtemp(prefix='keys-shots-')
procs = {}
def start_server():
    if procs.get('app'): procs['app'].terminate(); procs['app'].wait(5)
    shutil.rmtree(RUN_DIR, ignore_errors=True); shutil.copytree(PRISTINE, RUN_DIR)
    env = {**os.environ, 'APP_MODE': 'test', 'PORT': '3000', 'PUBLIC_URL': 'https://keys.local', 'DATA_DIR': RUN_DIR, 'SESSION_SECRET': 'local-run-secret-local-run-secret-1234',
           'KEYS_TG_BOT_TOKEN': '123456:local-test-token-abcdefghijklmnopqrstuv', 'KEYS_TG_BOT_USERNAME': 'rentkeysbot', 'KEYS_TG_API_BASE': 'http://127.0.0.1:3999',
           'MAX_BOT_TOKEN': 'local-max-token-abcdefghijklmnopqrstuvwxyz0123', 'MAX_BOT_USERNAME': 'keys_max_bot'}
    if not procs.get('api'): procs['api'] = subprocess.Popen([NODE, os.path.join(REPO, 'tests/telegram-local/fake-bot-api.mjs'), '3999', env['KEYS_TG_BOT_TOKEN']], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    procs['app'] = subprocess.Popen([NODE, os.path.join(REPO, 'server/index.mjs')], env=env, cwd=REPO, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        try: urllib.request.urlopen('http://localhost:3000/api/health', timeout=1); return
        except Exception: time.sleep(0.25)
    raise SystemExit('server did not start')
TG_TOKEN = '123456:local-test-token-abcdefghijklmnopqrstuv'
MAX_TOKEN = 'local-max-token-abcdefghijklmnopqrstuvwxyz0123'
BASE = 'http://localhost:3000'
OUT, PREFIX = sys.argv[1], sys.argv[2]
WIDTHS = [int(x) for x in (sys.argv[3] if len(sys.argv) > 3 else '375').split(',')]
THEMES = (sys.argv[4] if len(sys.argv) > 4 else 'light,dark').split(',')
ONLY = set(sys.argv[5].split(',')) if len(sys.argv) > 5 and sys.argv[5] else None
os.makedirs(OUT, exist_ok=True)
findings, shots, failures = [], [], []

def signed(token, uid, name, start=''):
    p = {'auth_date': str(int(time.time())), 'query_id': 'local-run', 'user': json.dumps({'id': uid, 'first_name': name, 'allows_write_to_pm': True, 'language_code': 'ru'}, ensure_ascii=False, separators=(',', ':'))}
    if start: p['start_param'] = start
    data = '\n'.join(f'{k}={p[k]}' for k in sorted(p))
    secret = hmac.new(b'WebAppData', token.encode(), hashlib.sha256).digest()
    p['hash'] = hmac.new(secret, data.encode(), hashlib.sha256).hexdigest()
    return urllib.parse.urlencode(p)

def tg_url(uid, name, scheme, start=''):
    theme = {'bg_color': '#17212b', 'text_color': '#f5f5f5', 'button_color': '#5288c1', 'button_text_color': '#ffffff'} if scheme == 'dark' else {'bg_color': '#ffffff', 'text_color': '#000000', 'button_color': '#2481cc', 'button_text_color': '#ffffff'}
    h = urllib.parse.urlencode({'tgWebAppData': signed(TG_TOKEN, uid, name, start), 'tgWebAppVersion': '8.0', 'tgWebAppPlatform': 'ios', 'tgWebAppThemeParams': json.dumps(theme)})
    return BASE + '/#' + h

def max_url(uid, name):
    return BASE + '/#' + urllib.parse.urlencode({'WebAppData': signed(MAX_TOKEN, uid, name)})

AUDIT = r"""() => {
  const out = [], W = document.documentElement.clientWidth, seen = new Set();
  const push = (kind, el, extra) => { const key = kind + (extra || ''); if (seen.has(key)) return; seen.add(key); out.push({ kind, cls: (el && (el.className && el.className.baseVal === undefined ? el.className : el.tagName)) || '', text: extra || '' }); };
  const visible = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0; };
  const scope = document.querySelector('.modal-overlay:not(.closing) .modal') || document.querySelector('#root');
  if (document.documentElement.scrollWidth > W + 1) push('page-overflow', null, document.documentElement.scrollWidth + '>' + W);
  const all = [...scope.querySelectorAll('*')].filter(visible);
  for (const el of all) {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    if (r.right > W + 1.5 && cs.position !== 'fixed' && !el.closest('[data-ui=segmented], .tabs, .property-pills')) push('sticks-out', el, (el.textContent || '').trim().slice(0, 40));
    // Text that is cut: ellipsis or clipped overflow on an element with its own text.
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (own && !el.matches('.sr-only') && (cs.textOverflow === 'ellipsis' || cs.overflow === 'hidden' || cs.overflowX === 'hidden') && el.scrollWidth > el.clientWidth + 1) push('clipped-text', el, el.textContent.trim().slice(0, 60));
    // Tab bar labels follow the platform (10–11 px, like iOS); everything else starts at 12.
    if (own && parseFloat(cs.fontSize) < (el.matches('.nav-label') ? 10 : 12)) push('tiny-type', el, cs.fontSize + ' ' + el.textContent.trim().slice(0, 30));
  }
  // Select options cut by the field width.
  for (const s of scope.querySelectorAll('select')) { if (!visible(s)) continue; const o = s.options[s.selectedIndex]; if (!o) continue; const c = document.createElement('canvas').getContext('2d'); const cs = getComputedStyle(s); c.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily; const need = c.measureText(o.text).width + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight); if (need > s.clientWidth + 1) push('select-cut', s, o.text.slice(0, 80)); }
  // Hit areas.
  for (const el of scope.querySelectorAll('button, a[href], input:not([type=hidden]):not([type=file]), select, textarea, summary, [role=switch], label.setting-row')) {
    if (!visible(el)) continue; const r = el.getBoundingClientRect();
    if (el.matches('p a, small a')) continue; // inline links inside a sentence (WCAG 2.5.8 exception)
    if (el.matches('input[type=checkbox], input[type=radio]') && el.closest('label')) continue;
    if (r.height < 43.5 || r.width < 43.5) push('small-target', el, Math.round(r.width) + 'x' + Math.round(r.height) + ' ' + ((el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)));
  }
  // Contrast of text against the nearest painted background.
  const rgb = s => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }; };
  const lum = c => { const f = x => { x /= 255; return x <= .03928 ? x / 12.92 : Math.pow((x + .055) / 1.055, 2.4); }; return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); };
  const bgOf = el => { let stack = []; for (let n = el; n; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.backgroundImage !== 'none' && !cs.backgroundImage.startsWith('linear-gradient(transparent')) return null; const c = rgb(cs.backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= .99) break; } } let base = { r: 255, g: 255, b: 255 }; for (const c of stack.reverse()) base = { r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a) }; return base; };
  for (const el of all) {
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    if (el.closest('.apartment-hero, .welcome-page, .role-card img, [aria-hidden=true]')) continue;
    const cs = getComputedStyle(el), fg = rgb(cs.color); if (!fg) continue; const bg = bgOf(el); if (!bg) continue;
    const f = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
    const L1 = lum(f), L2 = lum(bg), ratio = (Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05);
    const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700, large = size >= 24 || (bold && size >= 18.66);
    if (ratio < (large ? 3 : 4.5) && !el.closest('button:disabled, [disabled]')) push('low-contrast', el, ratio.toFixed(2) + ' ' + el.textContent.trim().slice(0, 30));
  }
  // Russian plural agreement and leftover abbreviations in visible text.
  const text = scope.innerText;
  const rules = [
    [/(^|[^\d])1 (арендаторов|арендатора|жильцов|жильца|дней|дня|комнат|комнаты|счётчиков|счётчика|файлов|файла|платежей|платежа|заявок|заявки|ссылок|ссылки|человек|собственников|совладельцев|квартир|участников|записей|минут|часов|месяцев)(?![а-яё])/g, 'plural-1'],
    [/(^|[^\d1])[234] (арендаторов|арендатор|жильцов|жилец|дней|день|комнат|комната|счётчиков|счётчик|файлов|файл|заявок|заявка|ссылок|ссылка|совладельцев|квартир|квартира|участников|минут|часов|месяцев|месяц)(?![а-яё])/g, 'plural-2-4'],
    [/(^|[^\d1])[5-9] (арендатора|арендатор|жильца|жилец|дня|день|комнаты|комната|счётчика|счётчик|файла|файл|заявки|заявка|ссылки|ссылка|квартиры|квартира|участника|минуты|часа|месяца|месяц)(?![а-яё])/g, 'plural-5+'],
    [/\d+ (жильц|дн|арендат|комн|шт|мес)\./g, 'abbreviation']
  ];
  for (const [re, kind] of rules) for (const m of text.matchAll(re)) push(kind, null, m[0].trim());
  // Vertical rhythm between stacked blocks of the page and of sections.
  const gapsOf = parent => { const kids = [...parent.children].filter(k => visible(k) && getComputedStyle(k).position !== 'absolute' && getComputedStyle(k).position !== 'fixed'); const g = []; for (let i = 1; i < kids.length; i++) { const a = kids[i - 1].getBoundingClientRect(), b = kids[i].getBoundingClientRect(); if (b.top >= a.bottom - 1 && Math.abs(b.left - a.left) < 40) g.push([Math.round(b.top - a.bottom), (kids[i - 1].className || kids[i - 1].tagName) + ' → ' + (kids[i].className || kids[i].tagName)]); } return g; };
  const containers = [scope.matches('.modal') ? scope : document.querySelector('main'), ...scope.querySelectorAll('main > section, main .section, .modal .form-stack')].filter(Boolean);
  for (const c of containers) for (const [gap, where] of gapsOf(c)) { if (gap <= 2) push('zero-gap', null, gap + 'px ' + String(where).slice(0, 90)); else if (gap % 4) push('off-scale-gap', null, gap + 'px ' + String(where).slice(0, 90)); }
  return out;
}"""

def audit(page, label):
    try: res = page.evaluate(AUDIT)
    except Exception as e: res = [{'kind': 'audit-error', 'cls': '', 'text': str(e)[:200]}]
    for r in res: findings.append({'screen': label, **r})

def settle(page, ms=700): page.wait_for_timeout(ms)

def shot(page, label, full=True):
    settle(page, 750)
    vp = page.viewport_size
    if full:
        h = min(5200, page.evaluate('document.documentElement.scrollHeight'))
        if h > vp['height']: page.set_viewport_size({'width': vp['width'], 'height': h}); settle(page, 250)
    audit(page, label)
    page.screenshot(path=f'{OUT}/{PREFIX}-{label}.png'); shots.append(label)
    if full: page.set_viewport_size(vp); settle(page, 120)

def step(label, fn):
    try: fn()
    except Exception as e: failures.append(f'{label}: {str(e).splitlines()[0][:200]}'); print('FAIL', label, str(e).splitlines()[0][:160])

def new_page(browser, w, scheme, url, proxy=True):
    ctx = browser.new_context(viewport={'width': w, 'height': 844}, device_scale_factor=2, color_scheme=scheme, is_mobile=w < 768, has_touch=w < 768, locale='ru-RU', timezone_id='Europe/Moscow')
    if proxy: ctx.add_init_script("window.TelegramWebviewProxy={postEvent:function(){}};")
    ctx.route('**/st.max.ru/**', lambda r: r.abort()); ctx.route('**/telegram.org/**', lambda r: r.abort())
    page = ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(url)
    return ctx, page, errs

def enter(page):
    page.wait_for_selector('.app-body, [data-act=login], [data-act=choose-role]', timeout=12000); settle(page, 300)
    if page.locator('[data-act=login]').count(): page.click('[data-act=login]'); page.wait_for_selector('.app-body, [data-act=choose-role]', timeout=12000)
    settle(page, 400)

def nav(page, target):
    sel = f'[data-act=nav][data-page={target}]'
    if page.locator(sel + ' >> visible=true').count(): page.click(sel + ' >> visible=true >> nth=0')
    else: page.evaluate("t => document.querySelector(`[data-act=nav][data-page=${t}]`).click()", target)
    settle(page, 250)

def tab(page, name): page.click(f'.apartment-tabs [data-tab={name}]'); settle(page, 250)
def sheet(page, label, opener, full=False):
    opener(); page.wait_for_selector('.modal-overlay:not(.closing) .modal', timeout=6000); shot(page, label, full)
def close(page):
    if page.locator('.modal-overlay:not(.closing) [data-act=close-modal]').count(): page.click('.modal-overlay:not(.closing) .modal-header [data-act=close-modal]')
    else: page.keyboard.press('Escape')
    page.wait_for_timeout(350)
def pick_apartment(page, title):
    loc = page.locator(f'.property-pills [data-act=apartment-select]:has-text("{title}")')
    if loc.count(): loc.first.click(); settle(page, 300)

def owner_run(browser, w, scheme):
    t = f'{w}-{scheme}'; ctx, page, errs = new_page(browser, w, scheme, tg_url(777001, 'Анна', scheme)); enter(page)
    step('owner home', lambda: shot(page, f'owner-home-{t}'))
    step('owner apartment', lambda: (nav(page, 'apartments'), pick_apartment(page, 'Квартира на Лесной'), shot(page, f'owner-apt-overview-{t}')))
    for name in ['contract', 'meters', 'payments', 'history']: step('owner tab ' + name, lambda name=name: (tab(page, name), shot(page, f'owner-apt-{name}-{t}')))
    step('owner tab back', lambda: tab(page, 'overview'))
    step('owner invite sheet', lambda: sheet(page, f'owner-sheet-invite-{t}', lambda: page.click('.people-section [data-act=invite]')))
    def invite_result():
        page.fill('[data-form=invite-create] input[name=label]', 'Маша'); page.click('[data-form=invite-create] button[type=submit]'); page.wait_for_selector('[data-invite-result]'); shot(page, f'owner-sheet-invite-result-{t}', False)
        page.click('[data-act=copy-code]'); page.wait_for_timeout(250); page.screenshot(path=f'{OUT}/{PREFIX}-owner-toast-{t}.png'); shots.append(f'owner-toast-{t}'); close(page)
    step('owner invite result', invite_result)
    step('owner invite manage', lambda: sheet(page, f'owner-sheet-invite-manage-{t}', lambda: page.click('.people-section [data-act=invite-manage] >> nth=0')))
    step('close', lambda: close(page))
    step('owner owners invite', lambda: sheet(page, f'owner-sheet-coowner-invite-{t}', lambda: page.click('.owners-section [data-act=owner-invite]'), True))
    step('close', lambda: close(page))
    step('owner owners link manage', lambda: sheet(page, f'owner-sheet-coowner-link-{t}', lambda: page.click('.owners-section [data-act=owner-invite-manage] >> nth=0')))
    step('close', lambda: close(page))
    step('owner co-owner manage', lambda: sheet(page, f'owner-sheet-coowner-manage-{t}', lambda: page.click('.owners-section [data-act=co-owner-manage] >> nth=0')))
    step('close', lambda: close(page))
    step('owner edit apartment', lambda: sheet(page, f'owner-sheet-edit-apartment-{t}', lambda: page.click('[data-act=edit-apartment]'), True))
    step('close', lambda: close(page))
    step('owner delete apartment', lambda: sheet(page, f'owner-sheet-delete-{t}', lambda: page.click('[data-act=delete-apartment]'), True))
    step('close', lambda: close(page))
    step('owner new meter', lambda: (tab(page, 'meters'), sheet(page, f'owner-sheet-new-meter-{t}', lambda: page.click('[data-act=new-meter] >> nth=0'), True)))
    step('close', lambda: close(page))
    step('owner second apartment', lambda: (tab(page, 'overview'), pick_apartment(page, 'Комнаты на Садовой'), shot(page, f'owner-apt2-overview-{t}')))
    step('owner second meters', lambda: (tab(page, 'meters'), shot(page, f'owner-apt2-meters-{t}')))
    step('owner baselines', lambda: sheet(page, f'owner-sheet-baselines-{t}', lambda: page.click('[data-act=meter-baselines] >> nth=0'), True))
    step('close', lambda: close(page))
    step('owner back to first', lambda: (tab(page, 'overview'), pick_apartment(page, 'Квартира на Лесной')))
    step('owner purchases', lambda: (page.click('[data-act=lease-page][data-page=purchases]'), shot(page, f'owner-purchases-{t}')))
    step('owner visits', lambda: (nav(page, 'apartments'), page.click('[data-act=lease-page][data-page=visits]'), shot(page, f'owner-visits-{t}')))
    step('owner requests', lambda: (nav(page, 'requests'), shot(page, f'owner-requests-{t}')))
    step('owner ticket', lambda: (page.click('text=Протекает кран на кухне >> nth=0'), shot(page, f'owner-ticket-{t}')))
    step('owner new ticket', lambda: (nav(page, 'requests'), sheet(page, f'owner-sheet-new-ticket-{t}', lambda: page.click('main [data-act=new-record][data-kind=ticket] >> nth=0'), True)))
    step('close', lambda: close(page))
    step('owner finances', lambda: (nav(page, 'finances'), shot(page, f'owner-finances-{t}')))
    step('owner charge', lambda: (page.click('text=Аренда за октябрь >> nth=0'), shot(page, f'owner-charge-{t}')))
    step('owner record cash', lambda: sheet(page, f'owner-sheet-record-cash-{t}', lambda: page.click('[data-action=record_payment]'), True))
    step('close', lambda: close(page))
    step('owner new charge', lambda: (nav(page, 'finances'), sheet(page, f'owner-sheet-new-charge-{t}', lambda: page.click('main [data-act=new-record][data-kind=charge] >> nth=0'), True)))
    step('close', lambda: close(page))
    step('owner recurring', lambda: (page.click('main [data-act=nav][data-page=recurring] >> nth=0'), shot(page, f'owner-recurring-{t}')))
    step('owner documents', lambda: (nav(page, 'documents'), shot(page, f'owner-documents-{t}')))
    step('owner notifications', lambda: (nav(page, 'notifications'), shot(page, f'owner-notifications-{t}')))
    step('owner profile', lambda: (nav(page, 'profile'), shot(page, f'owner-profile-{t}')))
    step('owner messengers', lambda: sheet(page, f'owner-sheet-messengers-{t}', lambda: page.click('[data-act=messengers]'), True))
    step('close', lambda: close(page))
    step('owner guide', lambda: sheet(page, f'owner-sheet-guide-{t}', lambda: page.click('[data-act=help]'), True))
    step('close', lambda: close(page))
    failures.extend(f'owner {t} page error: {e}' for e in errs); ctx.close()

def tenant_run(browser, w, scheme):
    t = f'{w}-{scheme}'; ctx, page, errs = new_page(browser, w, scheme, tg_url(900005, 'Ольга', scheme)); enter(page)
    step('tenant home', lambda: shot(page, f'tenant-home-{t}'))
    step('tenant apartment', lambda: (nav(page, 'apartments'), shot(page, f'tenant-apt-overview-{t}')))
    for name in ['contract', 'meters', 'payments', 'history']: step('tenant tab ' + name, lambda name=name: (tab(page, name), shot(page, f'tenant-apt-{name}-{t}')))
    step('tenant requests', lambda: (nav(page, 'requests'), shot(page, f'tenant-requests-{t}')))
    step('tenant ticket', lambda: (page.click('text=Протекает кран на кухне >> nth=0'), shot(page, f'tenant-ticket-{t}')))
    step('tenant finances', lambda: (nav(page, 'finances'), shot(page, f'tenant-finances-{t}')))
    step('tenant charge', lambda: (page.click('text=Аренда за октябрь >> nth=0'), shot(page, f'tenant-charge-{t}')))
    step('tenant claim', lambda: sheet(page, f'tenant-sheet-claim-{t}', lambda: page.click('[data-action=claim]'), True))
    step('close', lambda: close(page))
    step('tenant new purchase', lambda: (nav(page, 'home'), sheet(page, f'tenant-sheet-new-purchase-{t}', lambda: page.click('main [data-act=new-record][data-kind=purchase] >> nth=0'), True)))
    step('close', lambda: close(page))
    step('tenant visit', lambda: (nav(page, 'apartments'), page.click('[data-act=lease-page][data-page=visits]'), shot(page, f'tenant-visits-{t}'), page.click('main [data-act=open-record] >> nth=0'), shot(page, f'tenant-visit-detail-{t}')))
    step('tenant documents', lambda: (nav(page, 'documents'), shot(page, f'tenant-documents-{t}')))
    step('tenant notifications', lambda: (nav(page, 'notifications'), shot(page, f'tenant-notifications-{t}')))
    step('tenant profile', lambda: (nav(page, 'profile'), shot(page, f'tenant-profile-{t}')))
    step('tenant join', lambda: sheet(page, f'tenant-sheet-join-{t}', lambda: page.click('[data-act=join]')))
    step('close', lambda: close(page))
    failures.extend(f'tenant {t} page error: {e}' for e in errs); ctx.close()
    # Room tenant with meters waiting for the first reading (photo form).
    ctx, page, errs = new_page(browser, w, scheme, tg_url(900006, 'Дмитрий', scheme)); enter(page)
    step('room tenant home', lambda: shot(page, f'roomtenant-home-{t}'))
    step('room tenant meters', lambda: (nav(page, 'apartments'), tab(page, 'meters'), shot(page, f'roomtenant-meters-{t}')))
    ctx.close()

def coowner_run(browser, w, scheme):
    t = f'{w}-{scheme}'; ctx, page, errs = new_page(browser, w, scheme, tg_url(900100, 'Мама', scheme)); enter(page)
    step('coowner home', lambda: shot(page, f'coowner-home-{t}'))
    step('coowner apartment', lambda: (nav(page, 'apartments'), pick_apartment(page, 'Квартира на Лесной'), shot(page, f'coowner-apt-overview-{t}')))
    step('coowner leave', lambda: sheet(page, f'coowner-sheet-leave-{t}', lambda: page.click('[data-act=apartment-leave]')))
    step('close', lambda: close(page))
    ctx.close()

def max_run(browser, w, scheme):
    t = f'{w}-{scheme}'; ctx, page, errs = new_page(browser, w, scheme, max_url(5550002, 'Игорь'), proxy=False); enter(page)
    step('max home', lambda: shot(page, f'max-home-{t}'))
    step('max apartment', lambda: (nav(page, 'apartments'), shot(page, f'max-apt-overview-{t}')))
    step('max profile', lambda: (nav(page, 'profile'), shot(page, f'max-profile-{t}')))
    step('max messengers', lambda: sheet(page, f'max-sheet-messengers-{t}', lambda: page.click('[data-act=messengers]')))
    failures.extend(f'max {t} page error: {e}' for e in errs); ctx.close()

def newcomer_run(browser, w, scheme, n):
    t = f'{w}-{scheme}'
    for role in ['owner', 'tenant']:
        uid = 950000 + n * 10 + (role == 'tenant')
        ctx, page, errs = new_page(browser, w, scheme, tg_url(uid, 'Новый', scheme))
        page.wait_for_selector('[data-act=login]', timeout=12000)
        if role == 'owner':
            step('welcome', lambda: shot(page, f'newcomer-welcome-{t}', False))
        page.click('[data-act=login]'); page.wait_for_selector('[data-act=choose-role]', timeout=12000)
        if role == 'owner': step('role', lambda: shot(page, f'newcomer-role-{t}', False))
        page.click(f'[data-act=choose-role][data-role={role}]'); page.wait_for_selector('.empty-state', timeout=12000)
        step('empty ' + role, lambda: shot(page, f'newcomer-{role}-empty-{t}'))
        if role == 'owner': step('new apartment', lambda: sheet(page, f'newcomer-sheet-new-apartment-{t}', lambda: page.click('main [data-act=new-apartment] >> nth=0'), True))
        else: step('join', lambda: sheet(page, f'newcomer-sheet-join-{t}', lambda: page.click('main [data-act=join] >> nth=0')))
        ctx.close()

def states_run(browser, w, scheme):
    t = f'{w}-{scheme}'
    # Boot skeleton: hold the config request.
    ctx = browser.new_context(viewport={'width': w, 'height': 844}, device_scale_factor=2, color_scheme=scheme, is_mobile=True, has_touch=True)
    ctx.add_init_script("window.TelegramWebviewProxy={postEvent:function(){}};"); ctx.route('**/telegram.org/**', lambda r: r.abort())
    ctx.route('**/api/config', lambda r: None); page = ctx.new_page(); page.goto(tg_url(777001, 'Анна', scheme))
    step('boot', lambda: (page.wait_for_timeout(900), page.screenshot(path=f'{OUT}/{PREFIX}-state-boot-{t}.png'), shots.append(f'state-boot-{t}')))
    ctx.close()
    ctx = browser.new_context(viewport={'width': w, 'height': 844}, device_scale_factor=2, color_scheme=scheme, is_mobile=True, has_touch=True)
    ctx.add_init_script("window.TelegramWebviewProxy={postEvent:function(){}};"); ctx.route('**/telegram.org/**', lambda r: r.abort())
    ctx.route('**/api/config', lambda r: r.fulfill(status=503, content_type='application/json', body=json.dumps({'error': 'Сервер обновляется. Попробуйте через минуту.'})))
    page = ctx.new_page(); page.goto(tg_url(777001, 'Анна', scheme))
    step('error', lambda: (page.wait_for_selector('.app-error', timeout=8000), shot(page, f'state-error-{t}', False)))
    ctx.close()
    # Pressed state and mid-animation frames (sheet opening) on the owner's apartment.
    ctx, page, errs = new_page(browser, w, scheme, tg_url(777001, 'Анна', scheme)); enter(page); nav(page, 'apartments'); pick_apartment(page, 'Квартира на Лесной'); settle(page, 900)
    def pressed():
        b = page.locator('.people-section [data-act=invite]'); b.scroll_into_view_if_needed(); box = b.bounding_box(); page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2); page.mouse.down(); page.wait_for_timeout(140)
        page.screenshot(path=f'{OUT}/{PREFIX}-state-pressed-{t}.png'); shots.append(f'state-pressed-{t}'); page.mouse.up(); page.wait_for_timeout(60)
        for n, ms in enumerate([40, 80, 120]): page.wait_for_timeout(ms if n == 0 else 40); page.screenshot(path=f'{OUT}/{PREFIX}-state-sheet-frame{n + 1}-{t}.png'); shots.append(f'state-sheet-frame{n + 1}-{t}')
        close(page)
    step('pressed+frames', pressed)
    def tabs_frames():
        page.click('.apartment-tabs [data-tab=history]'); page.wait_for_timeout(60); page.screenshot(path=f'{OUT}/{PREFIX}-state-tab-frame-{t}.png'); shots.append(f'state-tab-frame-{t}')
    step('tab frame', tabs_frames)
    ctx.close()

ROLES = {'owner': owner_run, 'tenant': tenant_run, 'coowner': coowner_run, 'max': max_run}
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    n = 0
    for w in WIDTHS:
        for scheme in THEMES:
            start_server()
            for name, fn in ROLES.items():
                if ONLY and name not in ONLY: continue
                step(f'{name} {w} {scheme}', lambda fn=fn: fn(browser, w, scheme))
            if not ONLY or 'newcomer' in ONLY: step(f'newcomer {w} {scheme}', lambda: newcomer_run(browser, w, scheme, n))
            if not ONLY or 'states' in ONLY: step(f'states {w} {scheme}', lambda: states_run(browser, w, scheme))
            n += 1
    browser.close()
for proc in procs.values(): proc.terminate()
shutil.rmtree(RUN_DIR, ignore_errors=True)
json.dump({'shots': shots, 'findings': findings, 'failures': failures}, open(f'{OUT}/{PREFIX}-audit.json', 'w'), ensure_ascii=False, indent=1)
kinds = {}
for f in findings: kinds[f['kind']] = kinds.get(f['kind'], 0) + 1
print(f'{len(shots)} shots, {len(findings)} findings {kinds}, {len(failures)} failures')
for f in failures[:30]: print('  !', f)
