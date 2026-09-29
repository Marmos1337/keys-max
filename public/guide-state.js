/** Small, bounded and monotonic onboarding state, shared by browser and server.
 * Progress contains section IDs only — never the user's documents or actions.
 */
export const GUIDE_LIMIT = 4;
export const GUIDE_TOPICS = Object.freeze(['apartments', 'documents', 'finances', 'requests', 'meters', 'purchases', 'visits']);
export function normalizeGuide(value = {}) {
    const n = Number(value?.opens);
    return {
        opens: Number.isFinite(n) ? Math.max(0, Math.min(GUIDE_LIMIT, Math.trunc(n))) : 0,
        topics: [...new Set(Array.isArray(value?.topics) ? value.topics.filter(t => GUIDE_TOPICS.includes(t)) : [])].sort(),
        dismissed: value?.dismissed === true
    };
}
export function mergeGuide(a, b) {
    a = normalizeGuide(a); b = normalizeGuide(b);
    return normalizeGuide({ opens: Math.max(a.opens, b.opens), topics: [...a.topics, ...b.topics], dismissed: a.dismissed || b.dismissed });
}
export function guideHidden(value) {
    const p = normalizeGuide(value);
    return p.dismissed || p.opens >= GUIDE_LIMIT || p.topics.length >= GUIDE_LIMIT;
}
export function advanceGuide(value, event, topic) {
    const p = normalizeGuide(value);
    if (event === 'open') p.opens = Math.min(GUIDE_LIMIT, p.opens + 1);
    if (event === 'visit' && GUIDE_TOPICS.includes(topic)) p.topics.push(topic);
    if (event === 'dismiss') p.dismissed = true;
    return normalizeGuide(p);
}
export function guideTopic(page, tab) {
    if (page === 'apartments' && tab === 'contract') return 'documents';
    if (page === 'apartments' && tab === 'payments') return 'finances';
    if (page === 'apartments' && tab === 'meters') return 'meters';
    if (page === 'recurring') return 'finances';
    return GUIDE_TOPICS.includes(page) ? page : null;
}
