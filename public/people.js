/** How a person is called on screen, shared by browser and server. Plain text: callers escape it.
 * The viewer is «Вы». Two people with the same name are told apart by their messenger @handle,
 * else by the order they joined («Саня 1», «Саня 2»). Owners never type labels for people.
 */
const norm = v => String(v || '').trim().toLocaleLowerCase('ru');

// Join order for ordinals: lease members by joined_at (then id), people who never joined last.
export function joinOrder(members = []) {
    return [...members].sort((a, b) => String(a.joined_at).localeCompare(String(b.joined_at)) || String(a.user_id).localeCompare(String(b.user_id)))
        .map(m => m.user_id).filter((id, i, list) => list.indexOf(id) === i);
}

/**
 * displayName(people, viewerId, { id, order, fallback, self })
 * people: [{id, name, handle?}], order: ids in join order, self: what the viewer is called.
 */
export function displayName(people, viewerId, ctx = {}) {
    const { id, order = [], fallback = 'Участник', self = 'Вы' } = typeof ctx === 'string' ? { id: ctx } : ctx;
    if (id && id === viewerId) return self;
    const list = people || [], p = list.find(x => x.id === id);
    const name = String(p?.name || '').trim();
    if (!name) return fallback;
    const twins = list.filter(x => norm(x.name) === norm(name));
    if (twins.length < 2) return name;
    if (p.handle) return `${name} @${p.handle}`;
    const rank = x => { const i = order.indexOf(x.id); return i < 0 ? order.length + list.indexOf(x) : i; };
    const n = [...twins].sort((a, b) => rank(a) - rank(b)).findIndex(x => x.id === id) + 1;
    return `${name} ${n}`;
}

/** Shortcut for the app state: d.people, d.user.id and d.members give everything displayName needs. */
export function nameIn(d, id, opts = {}) {
    if (!d) return opts.fallback || 'Участник';
    return displayName(d.people || [], d.user?.id, { id, order: joinOrder(d.members || []), ...opts });
}
