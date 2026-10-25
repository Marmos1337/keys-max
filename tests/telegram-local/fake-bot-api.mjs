// Local stand-in for api.telegram.org: lets the real server process poll updates
// and send messages without touching Telegram. Control endpoints (not Bot API):
//   POST /_push  {update}      queue an update for getUpdates
//   GET  /_sent                messages the server sent (sendMessage, answerCallbackQuery)
// Usage: node fake-bot-api.mjs <port> <token>
import http from 'node:http';
const [port = '3999', token = ''] = process.argv.slice(2);
let queue = [], waiters = [], sent = [], nextId = 1;
const reply = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {};
        if (req.url === '/_push') { const u = { update_id: nextId++, ...body.update }; queue.push(u); waiters.splice(0).forEach(w => w()); return reply(res, 200, { ok: true, update_id: u.update_id }); }
        if (req.url === '/_sent') return reply(res, 200, sent);
        if (!req.url.startsWith('/bot' + token + '/')) return reply(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
        const method = req.url.split('/').at(-1);
        if (method === 'getUpdates') {
            if (body.offset) queue = queue.filter(u => u.update_id >= body.offset);
            const answer = () => reply(res, 200, { ok: true, result: queue.slice(0, 100) });
            if (queue.length) return answer();
            const timer = setTimeout(answer, Math.min(body.timeout || 0, 50) * 1000);
            waiters.push(() => { clearTimeout(timer); answer(); });
            return;
        }
        if (method === 'getWebhookInfo') return reply(res, 200, { ok: true, result: { url: '', pending_update_count: queue.length } });
        if (['sendMessage', 'answerCallbackQuery'].includes(method)) { sent.push({ method, body, at: Date.now() }); return reply(res, 200, { ok: true, result: { message_id: sent.length } }); }
        reply(res, 200, { ok: true, result: true });
    });
}).listen(Number(port), '127.0.0.1', () => console.log('fake Bot API on ' + port));
