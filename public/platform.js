// Messenger adapter: one surface for MAX (window.WebApp) and Telegram (window.Telegram.WebApp).
// MAX calls keep their previous behaviour; Telegram-only features are no-ops in MAX.
const name = window.__keysPlatform === 'telegram' ? 'telegram' : 'max';
const launch = new URLSearchParams(location.hash.slice(1));
const tg = () => window.Telegram?.WebApp;
const mx = () => window.WebApp;
const host = () => (name === 'telegram' ? tg() : mx());
const atLeast = v => { try { return !!tg()?.isVersionAtLeast?.(v); } catch { return false; } };

export const platform = { name, label: name === 'telegram' ? 'Telegram' : 'MAX', telegram: name === 'telegram' };

let initialised = false;
function initTelegram() {
    const w = tg();
    if (!w || initialised) return;
    initialised = true;
    try {
        w.ready();
        w.expand();
        // Vertical swipes would close the app while scrolling long forms.
        if (atLeast('7.7')) w.disableVerticalSwipes();
    } catch { }
}
// Waits briefly for the Telegram SDK; if it arrives later it is still initialised then.
export async function bridgeReady(timeout = 2500) {
    if (name !== 'telegram') return;
    const loaded = Promise.resolve(window.__keysBridge).then(initTelegram);
    await Promise.race([loaded, new Promise(r => setTimeout(r, timeout))]);
}

// Signed launch data; the server verifies it, the client never trusts initDataUnsafe.
export function launchData() {
    if (name === 'telegram') return tg()?.initData || launch.get('tgWebAppData') || '';
    return mx()?.initData || launch.get('WebAppData') || '';
}

export function hostScheme() { return name === 'telegram' ? tg()?.colorScheme || null : null; }
export function onHostSchemeChange(fn) { if (name === 'telegram') try { tg()?.onEvent?.('themeChanged', fn); } catch { } }

export function paintHost(colour) {
    if (name !== 'telegram' || !/^#[0-9a-f]{6}$/i.test(colour)) return;
    const w = tg();
    try {
        if (atLeast('6.1')) { w.setHeaderColor(colour); w.setBackgroundColor(colour); }
        if (atLeast('7.10')) w.setBottomBarColor(colour);
    } catch { }
}

export function haptic(kind = 'light') {
    if (name !== 'telegram') return;
    const h = tg()?.HapticFeedback;
    if (!h || !atLeast('6.1')) return;
    try {
        if (kind === 'select') h.selectionChanged();
        else if (kind === 'success' || kind === 'error' || kind === 'warning') h.notificationOccurred(kind);
        else h.impactOccurred(kind);
    } catch { }
}

export function closingConfirmation(on) {
    try { on ? host()?.enableClosingConfirmation?.() : host()?.disableClosingConfirmation?.(); } catch { }
}

// Telegram header back button mirrors the in-app back action.
let backBound = false;
export function syncBackButton(visible, handler) {
    if (name !== 'telegram') return;
    const b = tg()?.BackButton;
    if (!b || !atLeast('6.1')) return;
    try {
        if (!backBound) { b.onClick(() => handler()); backBound = true; }
        visible ? b.show() : b.hide();
    } catch { }
}

export function openLink(url) {
    try {
        if (name === 'telegram' && tg()) {
            if (/^https:\/\/t\.me\//.test(url)) tg().openTelegramLink(url);
            else tg().openLink(url);
            return;
        }
        if (mx()?.openMaxLink && url.startsWith('https://max.ru/')) { mx().openMaxLink(url); return; }
    } catch { }
    window.open(url, '_blank', 'noopener');
}

// Returns true when the host share sheet took over.
export async function share(text, url) {
    if (name === 'telegram' && tg()?.openTelegramLink) {
        tg().openTelegramLink('https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(text));
        return true;
    }
    if (mx()?.initData && mx().shareMaxContent) { await mx().shareMaxContent({ text: text + '\n' + url }); return true; }
    return false;
}

// Resolves 'started' | 'cancelled' | 'unsupported'. MAX keeps its downloadFile bridge.
export function download(file) {
    if (name === 'telegram' && tg()) {
        const w = tg();
        if (atLeast('8.0') && typeof w.downloadFile === 'function')
            return new Promise(resolve => { try { w.downloadFile({ url: file.url, file_name: file.name }, ok => resolve(ok ? 'started' : 'cancelled')); } catch { resolve('unsupported'); } });
        w.openLink(file.url);
        return Promise.resolve('started');
    }
    if (mx()?.initData && typeof mx().downloadFile === 'function') {
        const result = mx().downloadFile(file.url, file.name);
        return Promise.resolve(result).then(() => 'started');
    }
    return Promise.resolve('unsupported');
}

// Telegram bots may write only after the user allowed it. Resolves true when allowed.
export function requestWriteAccess() {
    if (name !== 'telegram' || !atLeast('6.9')) return Promise.resolve(false);
    return new Promise(resolve => { try { tg().requestWriteAccess(ok => resolve(!!ok)); } catch { resolve(false); } });
}
