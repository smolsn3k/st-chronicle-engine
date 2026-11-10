/**
 * Chronicle Engine — a plot and story engine for SillyTavern.
 * Define chronicles (arcs, episodes, story beats), then let the model follow
 * your structure while you control the pacing.
 *
 * https://github.com/smolsn3k/st-chronicle-engine
 */

const MODULE = 'chronicle_engine';
const META_KEY = 'chronicle_engine';
const PROMPT_KEY = 'chronicle_engine_guidance';
const SCHEMA_VERSION = 1;

const STATE_LABEL = { locked: 'Locked', active: 'Active', completed: 'Completed', skipped: 'Skipped', branched: 'Branched' };

const PACE = {
    slow: {
        label: 'Slow',
        text: 'Let scenes breathe. Move the current beat forward only in small steps and do not resolve it quickly. Favor dialogue, atmosphere and character moments.',
    },
    normal: {
        label: 'Normal',
        text: 'Move the current beat forward at a natural pace, with steady progress each reply.',
    },
    fast: {
        label: 'Fast forward',
        text: 'Compress or summarize scenes, skip filler and travel time, and drive decisively toward the required events of the current beat.',
    },
};

const DEFAULTS = {
    version: SCHEMA_VERSION,
    enabled: true,
    showFab: true,
    fab: { x: null, y: null },
    injectDepth: 2,
    defaultPacing: 'normal',
    profileId: '',
    nudgeAfter: 8,
    judgeEvery: 0,
    features: {
        nudge: true,
        judge: true,
        recap: false,
        epilogue: false,
        whatsNext: false,
        loreSuggest: false,
        continuity: false,
    },
    chronicles: [],
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const ctx = () => SillyTavern.getContext();
const $q = (sel, root = document) => root.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));

function toast(type, msg) {
    try { window.toastr[type](msg, 'Chronicle Engine'); } catch { console.log('[Chronicle Engine]', msg); }
}

function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
    target[last] = value;
}

function parseJson(text) {
    if (!text) return null;
    const t = String(text).replace(/```(?:json)?/gi, '');
    const attempt = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
    let r = attempt(t.trim());
    if (r !== undefined) return r;
    const starts = [t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0).sort((a, b) => a - b);
    for (const s of starts) {
        const close = t[s] === '{' ? '}' : ']';
        const e = t.lastIndexOf(close);
        if (e > s) {
            r = attempt(t.slice(s, e + 1));
            if (r !== undefined) return r;
        }
    }
    return null;
}

/* ------------------------------------------------------------------ */
/* Settings and per-chat state                                         */
/* ------------------------------------------------------------------ */

const S = () => ctx().extensionSettings[MODULE];

function loadSettings() {
    const es = ctx().extensionSettings;
    const cur = es[MODULE] || {};
    es[MODULE] = {
        ...clone(DEFAULTS),
        ...cur,
        features: { ...DEFAULTS.features, ...(cur.features || {}) },
        fab: { ...DEFAULTS.fab, ...(cur.fab || {}) },
        chronicles: Array.isArray(cur.chronicles) ? cur.chronicles : [],
    };
}
const saveSettings = () => ctx().saveSettingsDebounced();

/** Per-chat state lives in chat metadata, so every chat has its own position. */
function cs(create = false) {
    const c = ctx();
    if (!c.chatId || !c.chatMetadata) return null;
    if (!c.chatMetadata[META_KEY] && create) {
        c.chatMetadata[META_KEY] = {
            chronicleId: null,
            enabled: true,
            pacing: null,
            activeBeatId: null,
            beatStates: {},
            history: [],
            lastProgressAt: 0,
            judgeCount: 0,
        };
    }
    return c.chatMetadata[META_KEY] || null;
}
function saveChat() {
    try { ctx().saveMetadata(); } catch (e) { console.warn('[Chronicle Engine] saveMetadata failed', e); }
}

function activeChron() {
    const st = cs();
    if (!st?.chronicleId) return null;
    return S().chronicles.find((x) => x.id === st.chronicleId) || null;
}
function isOn() {
    const st = cs();
    return !!(S().enabled && st && st.enabled !== false && activeChron());
}

/* ------------------------------------------------------------------ */
/* Chronicle model                                                     */
/* ------------------------------------------------------------------ */

const newBeat = (title = 'New beat') => ({
    id: uid(), title, description: '', goals: [], requiredEvents: [], priority: 'should', branchOf: '', branchTrigger: '',
});
const newEpisode = (n = 1) => ({ id: uid(), title: `Episode ${n}`, beats: [newBeat('First beat')] });
const newArc = (n = 1) => ({ id: uid(), title: `Arc ${n}`, summary: '', pacing: '', episodes: [newEpisode(1)] });
const newChronicle = (title = 'New chronicle') => ({
    id: uid(), schema: SCHEMA_VERSION, title, description: '', lorebook: '', characters: [], draft: false, arcs: [newArc(1)],
});

/** Flat list of main-line beats (branch beats excluded), in story order. */
function mainBeats(ch) {
    const out = [];
    ch.arcs.forEach((arc, ai) => arc.episodes.forEach((ep, ei) => ep.beats.forEach((beat) => {
        if (!beat.branchOf) out.push({ beat, arc, ep, ai, ei });
    })));
    return out;
}
function findBeat(ch, id) {
    if (!ch || !id) return null;
    for (let ai = 0; ai < ch.arcs.length; ai++) {
        const arc = ch.arcs[ai];
        for (let ei = 0; ei < arc.episodes.length; ei++) {
            const ep = arc.episodes[ei];
            const beat = ep.beats.find((b) => b.id === id);
            if (beat) return { beat, arc, ep, ai, ei };
        }
    }
    return null;
}

const stateOf = (st, id) => st.beatStates[id] || 'locked';
const isDone = (st, id) => ['completed', 'skipped'].includes(stateOf(st, id));

/** Normalize unknown JSON (import or model output) into a valid chronicle with fresh ids. */
function normalizeChronicle(raw) {
    const lines = (v) => Array.isArray(v)
        ? v.map((x) => String(x).trim()).filter(Boolean)
        : typeof v === 'string' ? v.split('\n').map((s) => s.trim()).filter(Boolean) : [];
    const str = (v) => (v == null ? '' : String(v));
    const ch = {
        id: uid(), schema: SCHEMA_VERSION,
        title: str(raw.title) || 'Untitled chronicle',
        description: str(raw.description),
        lorebook: typeof raw.lorebook === 'string' ? raw.lorebook : '',
        characters: lines(raw.characters),
        draft: !!raw.draft,
        arcs: [],
    };
    for (const a of Array.isArray(raw.arcs) ? raw.arcs : []) {
        const arc = {
            id: uid(), title: str(a.title) || 'Untitled arc', summary: str(a.summary),
            pacing: ['slow', 'normal', 'fast'].includes(a.pacing) ? a.pacing : '', episodes: [],
        };
        for (const e of Array.isArray(a.episodes) ? a.episodes : []) {
            const ep = { id: uid(), title: str(e.title) || 'Untitled episode', beats: [] };
            const rawBeats = Array.isArray(e.beats) ? e.beats : [];
            const idMap = {}; const titleMap = {};
            rawBeats.forEach((b) => {
                const nb = {
                    id: uid(), title: str(b.title) || 'Untitled beat', description: str(b.description),
                    goals: lines(b.goals), requiredEvents: lines(b.requiredEvents),
                    priority: b.priority === 'must' ? 'must' : 'should', branchOf: '', branchTrigger: str(b.branchTrigger),
                };
                if (b.id != null) idMap[b.id] = nb.id;
                titleMap[nb.title] = nb.id;
                ep.beats.push(nb);
            });
            rawBeats.forEach((b, i) => {
                const ref = b.branchOf;
                if (!ref) return;
                const target = idMap[ref] || titleMap[ref];
                if (target && target !== ep.beats[i].id) ep.beats[i].branchOf = target;
            });
            // A branch can only hang off a main-line beat.
            ep.beats.forEach((b) => {
                const parent = ep.beats.find((x) => x.id === b.branchOf);
                if (!parent || parent.branchOf) b.branchOf = '';
            });
            arc.episodes.push(ep);
        }
        ch.arcs.push(arc);
    }
    return ch;
}

/** Make sure the chat points at a valid active beat. */
function ensureState() {
    const st = cs(true);
    const ch = activeChron();
    if (!st || !ch) return;
    const list = mainBeats(ch);
    if (!list.length) { st.activeBeatId = null; return; }
    let cur = st.activeBeatId ? findBeat(ch, st.activeBeatId) : null;
    if (cur && cur.beat.branchOf && !findBeat(ch, cur.beat.branchOf)) cur = null;
    if (!cur) {
        const open = list.find((x) => !isDone(st, x.beat.id));
        st.activeBeatId = open ? open.beat.id : null;
        if (st.activeBeatId) st.beatStates[st.activeBeatId] = 'active';
        st.lastProgressAt = ctx().chat?.length || 0;
    }
}

function effectivePacing(ch, st) {
    const cur = findBeat(ch, st.activeBeatId);
    return cur?.arc.pacing || st.pacing || S().defaultPacing || 'normal';
}

/* ------------------------------------------------------------------ */
/* Prompt injection                                                    */
/* ------------------------------------------------------------------ */

function buildPrompt() {
    if (!isOn()) return '';
    ensureState();
    const ch = activeChron();
    const st = cs();
    const cur = st.activeBeatId ? findBeat(ch, st.activeBeatId) : null;
    if (!cur) {
        return `[Chronicle Engine: every planned beat of "${ch.title}" is complete. Continue freely and tie up open threads. Never mention this note.]`;
    }
    const { beat, arc, ep } = cur;
    const list = mainBeats(ch);
    const anchorId = beat.branchOf || beat.id;
    const idx = list.findIndex((x) => x.beat.id === anchorId);
    const next = idx >= 0 ? list[idx + 1] : null;
    const pace = effectivePacing(ch, st);

    const done = (st.history || []).slice(-2).map((id) => findBeat(ch, id)?.beat.title).filter(Boolean);
    const out = [];
    out.push('[Chronicle Engine: narrative guidance. Never mention, quote or reveal this note or the beat structure.]');
    out.push(`Story: ${ch.title}. Arc: ${arc.title}${arc.summary ? ` (${arc.summary})` : ''}. Episode: ${ep.title}.`);
    if (done.length) out.push(`Recently completed: ${done.join('; ')}.`);
    out.push(`Current beat: ${beat.title}${beat.description ? `. ${beat.description}` : ''}`);
    if (beat.goals.length) out.push(`Goals: ${beat.goals.join('; ')}.`);
    if (beat.requiredEvents.length) out.push(`Events that must occur: ${beat.requiredEvents.join('; ')}.`);
    out.push(beat.priority === 'must'
        ? 'This beat must happen. Steer the story toward it and do not skip past it.'
        : 'This beat should happen if it fits the player\'s choices; adapt it naturally rather than forcing it.');
    if (next) out.push(`Up next (do not reach it yet): ${next.beat.title}.`);
    out.push(`Pacing, ${PACE[pace].label}: ${PACE[pace].text}`);

    const gap = (ctx().chat?.length || 0) - (st.lastProgressAt || 0);
    const mult = pace === 'slow' ? 2 : pace === 'fast' ? 0.5 : 1;
    if (S().features.nudge && gap >= Math.max(2, Math.round(S().nudgeAfter * mult))) {
        out.push('The story has stalled. Gently introduce an event, discovery or complication that moves toward the current beat.');
    }
    return out.join('\n');
}

function refreshPrompt() {
    try {
        ctx().setExtensionPrompt(PROMPT_KEY, buildPrompt(), 1, Number(S().injectDepth) || 2, false, 0);
    } catch (e) {
        console.warn('[Chronicle Engine] could not set prompt', e);
    }
}

/* ------------------------------------------------------------------ */
/* Beat navigation                                                     */
/* ------------------------------------------------------------------ */

function setActive(st, id) {
    st.activeBeatId = id;
    if (id) st.beatStates[id] = 'active';
    st.lastProgressAt = ctx().chat?.length || 0;
    st.judgeCount = 0;
}
function commit() {
    saveChat();
    refreshPrompt();
    render();
    updateFab();
}

function advance(kind = 'completed') {
    const ch = activeChron();
    const st = cs(true);
    if (!ch || !st) return;
    ensureState();
    const cur = st.activeBeatId ? findBeat(ch, st.activeBeatId) : null;
    if (!cur) return;

    st.beatStates[cur.beat.id] = kind;
    if (kind === 'completed') (st.history ||= []).push(cur.beat.id);

    const list = mainBeats(ch);
    const anchorId = cur.beat.branchOf || cur.beat.id;
    const idx = list.findIndex((x) => x.beat.id === anchorId);
    const here = list[idx];
    const next = idx >= 0 ? list[idx + 1] : null;
    const arcEnded = !!here && (!next || next.arc.id !== here.arc.id);
    const episodeChanged = !!next && !!here && next.ep.id !== here.ep.id;

    setActive(st, next ? next.beat.id : null);
    commit();

    const F = S().features;
    if (F.loreSuggest && kind === 'completed') enqueue('Looking for lore to save', () => suggestLore(cur.beat));
    if (arcEnded && here) {
        if (!next) toast('success', 'Chronicle complete.');
        if (F.epilogue) enqueue('Preparing epilogue offer', () => offerEpilogue(here.arc));
        if (F.whatsNext) enqueue('Thinking about what comes next', () => whatsNext());
    }
    if (episodeChanged && F.recap) enqueue('Writing recap', () => generateRecap(next.ep));
}

function rewind() {
    const ch = activeChron();
    const st = cs(true);
    if (!ch || !st) return;
    ensureState();
    const list = mainBeats(ch);
    const cur = st.activeBeatId ? findBeat(ch, st.activeBeatId) : null;
    let idx = list.length;
    let anchor = null;
    if (cur) {
        anchor = cur.beat.branchOf || cur.beat.id;
        idx = list.findIndex((x) => x.beat.id === anchor);
    }
    const prev = list[idx - 1];
    if (!prev) { toast('info', 'Already at the first beat.'); return; }
    if (cur) st.beatStates[cur.beat.id] = 'locked';
    if (anchor) st.beatStates[anchor] = 'locked';
    st.history = (st.history || []).filter((id) => id !== prev.beat.id);
    setActive(st, prev.beat.id);
    commit();
}

function branchInto(id) {
    const ch = activeChron();
    const st = cs(true);
    const cur = findBeat(ch, st?.activeBeatId);
    const tgt = findBeat(ch, id);
    if (!cur || !tgt) return;
    st.beatStates[cur.beat.id] = 'branched';
    setActive(st, id);
    commit();
}

function jump(id) {
    const ch = activeChron();
    const st = cs(true);
    if (!ch || !st || !findBeat(ch, id)) return;
    if (st.activeBeatId && st.activeBeatId !== id && stateOf(st, st.activeBeatId) === 'active') {
        st.beatStates[st.activeBeatId] = 'locked';
    }
    setActive(st, id);
    commit();
}

/* ------------------------------------------------------------------ */
/* Side calls (judge, recap, epilogue, ...)                            */
/* ------------------------------------------------------------------ */

function profiles() {
    return ctx().extensionSettings.connectionManager?.profiles || [];
}

async function sideCall(system, user, maxTokens = 600) {
    const c = ctx();
    const profileId = S().profileId;
    if (profileId && c.ConnectionManagerRequestService) {
        const r = await c.ConnectionManagerRequestService.sendRequest(
            profileId,
            [{ role: 'system', content: system }, { role: 'user', content: user }],
            maxTokens,
        );
        return String(r?.content ?? '').trim();
    }
    if (profileId) toast('warning', 'This SillyTavern version cannot run side tasks on another profile. Using the current connection.');
    try {
        const out = await c.generateRaw({ prompt: user, systemPrompt: system, responseLength: maxTokens });
        return String(out ?? '').trim();
    } catch {
        const out = await c.generateRaw(user, null, false, false, system, maxTokens);
        return String(out ?? '').trim();
    }
}

let taskChain = Promise.resolve();
function enqueue(label, fn, btn) {
    if (btn) btn.disabled = true;
    toast('info', `${label}…`);
    taskChain = taskChain
        .then(fn)
        .catch((e) => {
            console.error('[Chronicle Engine]', e);
            toast('error', `${label} failed: ${e?.message || e}`);
        })
        .finally(() => { if (btn) btn.disabled = false; });
    return taskChain;
}

function recentChat(n = 10) {
    return (ctx().chat || [])
        .filter((m) => !m.is_system)
        .slice(-n)
        .map((m) => `${m.name}: ${String(m.mes || '').slice(0, 1200)}`)
        .join('\n\n');
}

function beatSummary(b) {
    return [
        `Title: ${b.title}`,
        b.description && `Description: ${b.description}`,
        b.goals?.length && `Goals: ${b.goals.join('; ')}`,
        b.requiredEvents?.length && `Required events: ${b.requiredEvents.join('; ')}`,
    ].filter(Boolean).join('\n');
}

async function judgeBeat(auto = false) {
    const ch = activeChron();
    const st = cs();
    const cur = findBeat(ch, st?.activeBeatId);
    if (!cur) return;
    const system = 'You judge whether planned events have happened in a roleplay. Reply with one JSON object only: {"completed": true or false, "missing": ["..."], "reason": "..."}';
    const user = `Beat to check:\n${beatSummary(cur.beat)}\n\nRecent messages:\n${recentChat(12)}\n\nHave the required events happened and the goals been reached? If no events are listed, judge whether the description has played out.`;
    const j = parseJson(await sideCall(system, user, 300));
    if (!j || typeof j !== 'object') {
        if (!auto) toast('warning', 'Could not read the beat check. Try again.');
        return;
    }
    if (j.completed) {
        await showModal({
            title: 'This beat looks complete',
            body: textBlock(`${cur.beat.title}\n\n${j.reason || ''}`),
            buttons: [
                { label: 'Complete beat', primary: true, onClick: () => advance('completed') },
                { label: 'Not yet' },
            ],
        });
    } else if (!auto) {
        const missing = Array.isArray(j.missing) && j.missing.length ? `Still missing: ${j.missing.join('; ')}` : (j.reason || '');
        await showModal({ title: 'Not complete yet', body: textBlock(missing), buttons: [{ label: 'Close' }] });
    }
}

async function showTextResult(title, text) {
    await showModal({
        title,
        body: textBlock(text || '(Empty reply)'),
        buttons: [
            { label: 'Copy', onClick: () => navigator.clipboard?.writeText(text).then(() => toast('success', 'Copied')) },
            { label: 'Post to chat', onClick: () => postToChat(text) },
            { label: 'Close', primary: true },
        ],
    });
}

async function postToChat(text) {
    try {
        await ctx().executeSlashCommandsWithOptions(`/sys ${String(text).replace(/\|/g, '{{pipe}}')}`);
    } catch (e) {
        console.warn(e);
        toast('warning', 'Could not post to chat. Use Copy instead.');
    }
}

async function generateRecap(ep) {
    const ch = activeChron();
    const st = cs();
    const titles = (st.history || []).slice(-8).map((id) => findBeat(ch, id)?.beat.title).filter(Boolean);
    const system = 'You write short story recaps for a roleplay. Plain prose, past tense, 3 to 5 sentences. Recap only events that actually happened. Do not add new events or foreshadow.';
    const user = `Story: ${ch.title}\nBeats completed recently: ${titles.join('; ') || 'none'}\nEpisode starting now: ${ep.title}\n\nRecent messages:\n${recentChat(16)}\n\nWrite the recap.`;
    await showTextResult(`Recap: ${ep.title}`, await sideCall(system, user, 350));
}

async function offerEpilogue(arc) {
    await showModal({
        title: 'Arc complete',
        body: textBlock(`"${arc.title}" is finished. Generate an epilogue?`),
        buttons: [
            { label: 'Generate epilogue', primary: true, onClick: () => enqueue('Writing epilogue', () => generateEpilogue(arc)) },
            { label: 'Not now' },
        ],
    });
}

async function generateEpilogue(arc) {
    const ch = activeChron();
    const system = 'You write short epilogues for a roleplay arc. Literary narration, 2 to 4 paragraphs, past tense. Reflect on what happened and how it changed the characters. Do not start the next arc.';
    const user = `Story: ${ch.title}\nArc: ${arc.title}\nArc summary: ${arc.summary || '(none)'}\nBeats in this arc: ${arc.episodes.flatMap((e) => e.beats).filter((b) => !b.branchOf).map((b) => b.title).join('; ')}\n\nRecent messages:\n${recentChat(14)}\n\nWrite the epilogue.`;
    await showTextResult(`Epilogue: ${arc.title}`, await sideCall(system, user, 700));
}

async function whatsNext() {
    const ch = activeChron();
    const st = cs();
    const cur = findBeat(ch, st.activeBeatId);
    const list = mainBeats(ch);
    const doneTitles = (st.history || []).slice(-10).map((id) => findBeat(ch, id)?.beat.title).filter(Boolean);
    const upcoming = cur ? `${cur.arc.title}: ${cur.beat.title}` : 'nothing is planned';
    const nextArc = cur ? ch.arcs[cur.ai + 1] : null;
    const branches = cur ? cur.ep.beats.filter((b) => b.branchOf === cur.beat.id).map((b) => `${b.title} (${b.branchTrigger || 'no trigger'})`) : [];
    const system = 'You are a story advisor for a roleplay. Be concise and concrete. Give exactly 3 numbered options, each one or two sentences.';
    const user = `Story: ${ch.title}\nCompleted beats: ${doneTitles.join('; ') || 'none'}\nPlanned next: ${upcoming}\nNext arc: ${nextArc ? `${nextArc.title}: ${nextArc.summary}` : 'none planned'}\nAvailable branches: ${branches.join('; ') || 'none'}\nBeats left on the main line: ${list.filter((x) => !isDone(st, x.beat.id)).length}\n\nRecent messages:\n${recentChat(8)}\n\nSuggest what could happen next: the planned path, a branch, or a fresh direction.`;
    await showTextResult("What's next?", await sideCall(system, user, 400));
}

async function checkContinuity() {
    const ch = activeChron();
    const st = cs();
    const done = (st.history || []).map((id) => findBeat(ch, id)?.beat).filter(Boolean).slice(-12);
    let lore = '';
    if (ch.lorebook) {
        try {
            const ents = await entriesOf(ch.lorebook);
            lore = ents.filter((e) => !e.disable).slice(0, 20)
                .map((e) => `${(e.key || []).join(', ')}: ${String(e.content || '').slice(0, 300)}`).join('\n');
        } catch { /* lorebook optional */ }
    }
    const system = 'You check roleplay continuity. Reply with one JSON object only: {"issues": [{"issue": "...", "evidence": "..."}]}. Use an empty list if nothing contradicts.';
    const user = `Completed story beats:\n${done.map((b) => `- ${b.title}: ${b.description}`).join('\n') || '(none)'}\n\nEstablished lore:\n${lore || '(none)'}\n\nRecent messages:\n${recentChat(8)}\n\nList any statements in the recent messages that contradict the completed beats or the lore.`;
    const j = parseJson(await sideCall(system, user, 500));
    const issues = Array.isArray(j?.issues) ? j.issues : null;
    if (!issues) { toast('warning', 'Could not read the continuity check. Try again.'); return; }
    const text = issues.length
        ? issues.map((i, n) => `${n + 1}. ${i.issue}${i.evidence ? `\n   Evidence: ${i.evidence}` : ''}`).join('\n\n')
        : 'No contradictions found in the last messages.';
    await showModal({ title: 'Continuity check', body: textBlock(text), buttons: [{ label: 'Close', primary: true }] });
}

async function suggestLore(beat) {
    const ch = activeChron();
    if (!ch?.lorebook) return;
    let existing = [];
    try { existing = (await entriesOf(ch.lorebook)).map((e) => (e.key || []).join(', ')); } catch { return; }
    const system = 'You propose lorebook entries for a roleplay. Reply with a JSON array only: [{"keys": ["..."], "content": "..."}]. At most 3 entries. Use [] if nothing new and important was established.';
    const user = `Beat just completed:\n${beatSummary(beat)}\n\nExisting entry keys: ${existing.join(' | ') || '(none)'}\n\nRecent messages:\n${recentChat(12)}\n\nPropose lore worth saving: new characters, places, items, rules or facts that were established. Do not repeat existing entries.`;
    const arr = parseJson(await sideCall(system, user, 600));
    const items = (Array.isArray(arr) ? arr : []).filter((x) => x && Array.isArray(x.keys) && x.content);
    if (!items.length) return;

    const wrap = document.createElement('div');
    items.forEach((it, i) => {
        const row = document.createElement('label');
        row.className = 'ce-lore-suggest';
        row.innerHTML = `<input type="checkbox" checked data-i="${i}"><span><b>${esc(it.keys.join(', '))}</b><small>${esc(it.content)}</small></span>`;
        wrap.append(row);
    });
    await showModal({
        title: `Add to ${ch.lorebook}?`,
        body: wrap,
        buttons: [
            {
                label: 'Add selected', primary: true,
                onClick: async (body) => {
                    const picked = [...body.querySelectorAll('input:checked')].map((el) => items[+el.dataset.i]);
                    for (const it of picked) await addEntry(ch.lorebook, { keys: it.keys.map(String), content: String(it.content), comment: 'Added by Chronicle Engine' });
                    if (picked.length) toast('success', `Added ${picked.length} lorebook ${picked.length === 1 ? 'entry' : 'entries'}.`);
                },
            },
            { label: 'Skip' },
        ],
    });
}

/* ------------------------------------------------------------------ */
/* World Info helpers (loaded lazily, so older versions still run)     */
/* ------------------------------------------------------------------ */

const WI = () => import('../../../world-info.js');

async function lorebookNames() {
    const wi = await WI();
    return [...(wi.world_names || [])];
}
async function loadBook(name) {
    const wi = await WI();
    return wi.loadWorldInfo(name);
}
async function entriesOf(name) {
    const d = await loadBook(name);
    return d?.entries ? Object.values(d.entries) : [];
}
async function saveBook(name, data) {
    const wi = await WI();
    await wi.saveWorldInfo(name, data, true);
    try { wi.reloadEditor?.(name); } catch { /* optional */ }
}
async function addEntry(name, { keys, content, comment }) {
    const wi = await WI();
    const d = await wi.loadWorldInfo(name);
    const e = wi.createWorldInfoEntry(name, d);
    e.key = keys;
    e.content = content;
    e.comment = comment || '';
    await saveBook(name, d);
}

/* ------------------------------------------------------------------ */
/* Generating chronicles                                               */
/* ------------------------------------------------------------------ */

const OUTLINE_SCHEMA = '{"title":"","description":"","arcs":[{"title":"","summary":"","episodes":[{"title":"","beats":[{"title":"","description":"","goals":[""],"requiredEvents":[""],"priority":"must or should","branchOf":"title of another beat in the same episode, optional","branchTrigger":"optional"}]}]}]}';

async function generateChronicleFrom(sourceLabel, sourceText, lorebookName = '') {
    const system = 'You design structured roleplay campaign outlines. Reply with one JSON object only and no commentary.';
    const user = `Design a roleplay campaign outline from the source below.
Structure: chronicle, arcs, episodes, beats. A beat is one story point the roleplay should steer toward.
Rules: 2 to 5 arcs, 2 to 5 episodes per arc, 3 to 6 beats per episode. Each beat needs a short title, a one or two sentence description, 1 to 3 goals, 1 to 4 requiredEvents, and a priority of "must" (pivotal) or "should" (flexible). Add alternate branch beats only where a player could plausibly go off-script. Stay faithful to the source and do not invent canon you are unsure about.
Match this JSON shape exactly: ${OUTLINE_SCHEMA}

Source (${sourceLabel}):
${sourceText}`;
    const j = parseJson(await sideCall(system, user, 4000));
    if (!j || !Array.isArray(j.arcs) || !j.arcs.length) {
        toast('error', 'The reply was cut off or unreadable. Try a shorter source or a model with a longer output limit.');
        return;
    }
    const ch = normalizeChronicle({ ...j, draft: true, lorebook: lorebookName });
    S().chronicles.push(ch);
    ui.editId = ch.id;
    ui.view = 'edit';
    saveSettings();
    render();
    toast('success', 'Draft chronicle created. Review it before you use it.');
}

/* ------------------------------------------------------------------ */
/* Import / export                                                     */
/* ------------------------------------------------------------------ */

function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

async function exportChronicle(ch, withLorebook) {
    const payload = { format: 'chronicle-engine', version: SCHEMA_VERSION, chronicle: clone(ch) };
    if (withLorebook && ch.lorebook) {
        try {
            const data = await loadBook(ch.lorebook);
            if (data) payload.lorebook = { name: ch.lorebook, data };
        } catch { toast('warning', 'Could not read the lorebook. Exporting the chronicle only.'); }
    }
    const file = `${(ch.title || 'chronicle').replace(/[^\w-]+/g, '_')}.chronicle.json`;
    download(file, JSON.stringify(payload, null, 2));
}

async function importChronicle(text) {
    const raw = parseJson(text);
    if (!raw || typeof raw !== 'object') { toast('error', 'That is not valid JSON.'); return; }
    const src = raw.chronicle || raw;
    if (!Array.isArray(src.arcs)) { toast('error', 'No arcs found. Is this a Chronicle Engine file?'); return; }
    const ch = normalizeChronicle(src);
    if (raw.lorebook?.name && raw.lorebook?.data) {
        try {
            const exists = (await lorebookNames()).includes(raw.lorebook.name);
            if (!exists || window.confirm(`A lorebook named "${raw.lorebook.name}" already exists. Overwrite it with the imported one?`)) {
                await saveBook(raw.lorebook.name, raw.lorebook.data);
                try { await (await WI()).updateWorldInfoList?.(); } catch { /* optional */ }
            }
            ch.lorebook = raw.lorebook.name;
            await refreshBooks();
        } catch (e) {
            console.warn(e);
            toast('warning', 'Imported the chronicle, but could not save its lorebook.');
        }
    }
    S().chronicles.push(ch);
    ui.editId = ch.id;
    ui.view = 'edit';
    saveSettings();
    render();
    toast('success', `Imported "${ch.title}".`);
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

const modalQueue = [];
let modalOpen = false;

const textBlock = (text) => {
    const p = document.createElement('p');
    p.className = 'ce-pre';
    p.textContent = text;
    return p;
};

function showModal({ title, body, buttons }) {
    return new Promise((resolve) => {
        modalQueue.push({ title, body, buttons: buttons || [{ label: 'Close', primary: true }], resolve });
        pumpModal();
    });
}

function pumpModal() {
    if (modalOpen || !modalQueue.length) return;
    modalOpen = true;
    const m = modalQueue.shift();
    const host = $q('#ce-modal-host');
    host.innerHTML = `<div class="ce-modal-bg"><div class="ce-modal" role="dialog" aria-modal="true" aria-label="${esc(m.title)}"><h3>${esc(m.title)}</h3><div class="ce-modal-body"></div><div class="ce-modal-actions"></div></div></div>`;
    const bodyEl = $q('.ce-modal-body', host);
    const actions = $q('.ce-modal-actions', host);
    if (typeof m.body === 'string') bodyEl.innerHTML = m.body; else bodyEl.append(m.body);
    const close = () => { host.innerHTML = ''; modalOpen = false; m.resolve(); pumpModal(); };
    m.buttons.forEach((b) => {
        const btn = document.createElement('button');
        btn.className = `ce-btn${b.primary ? ' ce-primary' : ''}`;
        btn.textContent = b.label;
        btn.addEventListener('click', async () => {
            close();
            try { await b.onClick?.(bodyEl); } catch (e) { console.error(e); toast('error', e?.message || String(e)); }
        });
        actions.append(btn);
    });
    actions.lastElementChild?.focus();
}

/* ------------------------------------------------------------------ */
/* UI state                                                            */
/* ------------------------------------------------------------------ */

const ui = { isOpen: false, view: 'dash', editId: null, expanded: new Set(), books: [] };

async function refreshBooks() {
    try { ui.books = await lorebookNames(); } catch { ui.books = []; }
}

const editing = () => S().chronicles.find((x) => x.id === ui.editId) || activeChron() || S().chronicles[0] || null;

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

const emptyState = (title, text, extra = '') => `<div class="ce-empty"><h3>${esc(title)}</h3><p>${esc(text)}</p>${extra}</div>`;

const strip = (items, st) => `<div class="ce-strip" role="img" aria-label="Beat progress">${items.map((x) =>
    `<i class="ce-seg s-${stateOf(st, x.beat.id)}" title="${esc(x.beat.title)}: ${STATE_LABEL[stateOf(st, x.beat.id)]}"></i>`).join('')}</div>`;

const bar = (done, total) => {
    const pct = total ? Math.round((done / total) * 100) : 0;
    return `<div class="ce-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><b style="width:${pct}%"></b></div>`;
};

function profileOptions(selected) {
    return profiles().map((p) => `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
}

function renderDash() {
    const c = ctx();
    if (!c.chatId) return emptyState('Open a chat first', 'Chronicle Engine keeps its progress inside each chat.');
    const st = cs(true);
    const chrons = S().chronicles;
    const ch = activeChron();

    let h = `<section class="ce-card">
        <label class="ce-field"><span>Chronicle in this chat</span>
            <select class="ce-in" data-sel="chron"><option value="">None</option>${chrons.map((x) => `<option value="${x.id}" ${x.id === st.chronicleId ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</select>
        </label>
        <label class="ce-switch"><input type="checkbox" data-sel="chatenabled" ${st.enabled !== false ? 'checked' : ''}><span><b>Active in this chat</b></span></label>
        ${S().enabled ? '' : '<p class="ce-note">Chronicle Engine is switched off for all chats. Turn it on in Features.</p>'}
    </section>`;

    if (!ch) {
        return h + emptyState(
            chrons.length ? 'Pick a chronicle' : 'No chronicles yet',
            chrons.length ? 'Choose one above to start steering this chat.' : 'Create one in Edit, import one, or generate a draft in Worlds.',
            `<button class="ce-btn ce-primary" data-view="edit">${chrons.length ? 'Open Edit' : 'Create a chronicle'}</button>`,
        );
    }

    ensureState();
    const list = mainBeats(ch);
    if (!list.length) return h + emptyState('No beats yet', 'Add arcs, episodes and beats in Edit.', '<button class="ce-btn ce-primary" data-view="edit">Open Edit</button>');

    const doneN = list.filter((x) => isDone(st, x.beat.id)).length;
    const cur = st.activeBeatId ? findBeat(ch, st.activeBeatId) : null;
    const pace = effectivePacing(ch, st);
    const chatPace = st.pacing || S().defaultPacing;

    h += `<section class="ce-card">
        <div class="ce-row"><h2 class="ce-h">${esc(ch.title)}</h2>${ch.draft ? '<span class="ce-chip ce-chip-draft">Draft</span>' : ''}</div>
        ${bar(doneN, list.length)}
        <p class="ce-meta">${doneN} of ${list.length} beats done</p>`;

    if (cur) {
        const arcBeats = list.filter((x) => x.arc.id === cur.arc.id);
        const epBeats = list.filter((x) => x.ep.id === cur.ep.id);
        h += `<h3 class="ce-h3">${esc(cur.arc.title)}</h3>
            ${cur.arc.summary ? `<p class="ce-sum">${esc(cur.arc.summary)}</p>` : ''}
            ${strip(arcBeats, st)}
            <h4 class="ce-h4">${esc(cur.ep.title)}</h4>
            ${strip(epBeats, st)}`;
    }
    h += '</section>';

    if (!cur) {
        h += `<section class="ce-card ce-done"><h3 class="ce-h3">Chronicle complete</h3><p>Every beat is done or skipped. You can rewind to reopen the last beat.</p>
            <div class="ce-actions"><button class="ce-btn" data-act="rewind">Rewind</button></div></section>`;
    } else {
        const b = cur.beat;
        const branches = cur.ep.beats.filter((x) => x.branchOf === b.id);
        h += `<section class="ce-card ce-beatcard s-${stateOf(st, b.id)}">
            <div class="ce-row"><h3 class="ce-h3">${esc(b.title)}</h3><span class="ce-chip ${b.priority === 'must' ? 'ce-chip-must' : ''}">${b.priority === 'must' ? 'Must happen' : 'Should happen'}</span></div>
            ${b.branchOf ? '<p class="ce-note">On a branch. Completing it returns to the main story.</p>' : ''}
            ${b.description ? `<p>${esc(b.description)}</p>` : ''}
            ${b.goals.length ? `<p class="ce-lbl">Goals</p><ul class="ce-ul">${b.goals.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
            ${b.requiredEvents.length ? `<p class="ce-lbl">Required events</p><ul class="ce-ul">${b.requiredEvents.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
            <div class="ce-actions">
                <button class="ce-btn ce-primary" data-act="complete">Complete beat</button>
                <button class="ce-btn" data-act="skip">Skip</button>
                <button class="ce-btn" data-act="rewind">Rewind</button>
                ${S().features.judge ? '<button class="ce-btn" data-act="check">Check beat</button>' : ''}
            </div>
            ${branches.length ? `<p class="ce-lbl">Branch</p><div class="ce-actions">${branches.map((x) => `<button class="ce-btn" data-act="branch" data-id="${x.id}" title="${esc(x.branchTrigger)}">${esc(x.title)}</button>`).join('')}</div>` : ''}
        </section>`;

        const ordered = [];
        cur.ep.beats.filter((x) => !x.branchOf).forEach((m) => {
            ordered.push(m);
            cur.ep.beats.filter((x) => x.branchOf === m.id).forEach((x) => ordered.push(x));
        });
        h += `<section class="ce-card"><p class="ce-lbl">Beats in this episode</p><ul class="ce-beats">${ordered.map((x) => {
            const s = stateOf(st, x.id);
            return `<li class="ce-beat s-${s}${x.branchOf ? ' is-branch' : ''}"><span class="ce-dot"></span>
                <span class="ce-beat-t"><b>${esc(x.title)}</b>${x.branchOf ? `<small>Branch: ${esc(x.branchTrigger || 'no trigger set')}</small>` : `<small>${STATE_LABEL[s]}</small>`}</span>
                ${x.id === st.activeBeatId ? '' : `<button class="ce-mini" data-act="jump" data-id="${x.id}">Go here</button>`}</li>`;
        }).join('')}</ul></section>`;
    }

    const arcOverride = cur?.arc.pacing;
    h += `<section class="ce-card"><p class="ce-lbl">Pacing</p>
        <div class="ce-seg-ctl" role="group" aria-label="Pacing">${Object.entries(PACE).map(([k, v]) =>
            `<button class="ce-btn ${chatPace === k ? 'ce-on' : ''}" data-act="pace" data-v="${k}" aria-pressed="${chatPace === k}">${v.label}</button>`).join('')}</div>
        ${arcOverride ? `<p class="ce-note">This arc overrides the chat pace: ${PACE[arcOverride].label}.</p>` : `<p class="ce-note">Now using: ${PACE[pace].label}.</p>`}
    </section>`;

    const F = S().features;
    const tools = [
        F.whatsNext && '<button class="ce-btn" data-act="whatsnext">What\'s next?</button>',
        F.continuity && '<button class="ce-btn" data-act="continuity">Check continuity</button>',
        F.recap && cur && '<button class="ce-btn" data-act="recap">Recap</button>',
        F.epilogue && '<button class="ce-btn" data-act="epilogue">Epilogue</button>',
    ].filter(Boolean);
    if (tools.length) h += `<section class="ce-card"><p class="ce-lbl">Tools</p><div class="ce-actions">${tools.join('')}</div></section>`;

    const profs = profiles();
    const cmSel = ctx().extensionSettings.connectionManager?.selectedProfile;
    h += `<section class="ce-card"><p class="ce-lbl">Profiles</p>
        ${profs.length ? `
        <label class="ce-field"><span>Side tasks run on</span>
            <select class="ce-in" data-sel="profile"><option value="">Current connection</option>${profileOptions(S().profileId)}</select></label>
        <label class="ce-field"><span>Chat profile</span>
            <select class="ce-in" data-sel="chatprofile">${profileOptions(cmSel)}</select></label>
        <button class="ce-btn" data-act="refresh">Update list</button>`
        : `<p class="ce-note">No connection profiles found. Enable the Connection Manager extension to route side tasks to a cheaper model, or switch connections manually in SillyTavern.</p>
           <button class="ce-btn" data-act="refresh">Update list</button>`}
    </section>`;
    return h;
}

/* ---- Editor ---- */

const attrs = (d) => Object.entries(d || {}).map(([k, v]) => `data-${k}="${v}"`).join(' ');
const fld = (label, inner) => `<label class="ce-field"><span>${label}</span>${inner}</label>`;
const inp = (f, val, d, ph = '') => `<input type="text" class="ce-in" data-f="${f}" ${attrs(d)} value="${esc(val)}" placeholder="${esc(ph)}">`;
const txt = (f, val, d, rows = 3, lines = false) => `<textarea class="ce-in" rows="${rows}" data-f="${f}" ${lines ? 'data-lines="1"' : ''} ${attrs(d)}>${esc(lines ? (val || []).join('\n') : val)}</textarea>`;
const pacingSelect = (val, d) => `<select class="ce-in" data-f="pacing" ${attrs(d)}><option value="">Use chat pace</option>${Object.entries(PACE).map(([k, v]) => `<option value="${k}" ${val === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>`;
const icon = (act, d, cls, label, fa) => `<button class="ce-mini ${cls || ''}" data-act="${act}" ${attrs(d)} aria-label="${label}" title="${label}"><i class="fa-solid ${fa}"></i></button>`;
const openAttr = (key) => (ui.expanded.has(key) ? 'open' : '');

function beatHtml(ep, b, bi, ai, ei) {
    const d = { a: ai, e: ei, b: bi };
    const key = `b:${b.id}`;
    const mains = ep.beats.filter((x) => !x.branchOf && x.id !== b.id);
    return `<details class="ce-det ce-det-beat${b.branchOf ? ' is-branch' : ''}" data-key="${key}" ${openAttr(key)}>
        <summary><span class="ce-chip ${b.priority === 'must' ? 'ce-chip-must' : ''}">${b.priority === 'must' ? 'Must' : 'Should'}</span><span data-sum="${key}">${esc(b.title)}</span>${b.branchOf ? '<span class="ce-chip">Branch</span>' : ''}</summary>
        <div class="ce-det-body">
            ${fld('Beat title', inp('title', b.title, d))}
            ${fld('Description (what happens)', txt('description', b.description, d, 3))}
            ${fld('Goals (one per line)', txt('goals', b.goals, d, 2, true))}
            ${fld('Required events (one per line)', txt('requiredEvents', b.requiredEvents, d, 3, true))}
            ${fld('Priority', `<select class="ce-in" data-f="priority" ${attrs(d)}><option value="should" ${b.priority !== 'must' ? 'selected' : ''}>Should happen</option><option value="must" ${b.priority === 'must' ? 'selected' : ''}>Must happen</option></select>`)}
            ${fld('Branch of (optional)', `<select class="ce-in" data-f="branchOf" ${attrs(d)}><option value="">Main story</option>${mains.map((m) => `<option value="${m.id}" ${b.branchOf === m.id ? 'selected' : ''}>${esc(m.title)}</option>`).join('')}</select>`)}
            ${fld('Branch trigger (when to take it)', inp('branchTrigger', b.branchTrigger, d, 'e.g. the player refuses the offer'))}
            <div class="ce-actions">${icon('up', d, '', 'Move up', 'fa-arrow-up')}${icon('down', d, '', 'Move down', 'fa-arrow-down')}${icon('del', d, 'ce-danger', 'Delete beat', 'fa-trash')}</div>
        </div></details>`;
}

function renderEditor() {
    const chrons = S().chronicles;
    const ch = editing();
    ui.editId = ch?.id || null;

    let h = `<section class="ce-card">
        <label class="ce-field"><span>Chronicle</span>
            <select class="ce-in" data-sel="editchron">${chrons.length ? chrons.map((x) => `<option value="${x.id}" ${ch && x.id === ch.id ? 'selected' : ''}>${esc(x.title)}</option>`).join('') : '<option>No chronicles yet</option>'}</select></label>
        <div class="ce-actions">
            <button class="ce-btn" data-act="new-chron">New</button>
            <button class="ce-btn" data-act="dup-chron" ${ch ? '' : 'disabled'}>Duplicate</button>
            <button class="ce-btn ce-danger" data-act="del-chron" ${ch ? '' : 'disabled'}>Delete</button>
        </div></section>`;
    if (!ch) return h + emptyState('Start your first chronicle', 'A chronicle holds arcs. Each arc holds episodes, and each episode holds story beats.', '<button class="ce-btn ce-primary" data-act="new-chron">New chronicle</button>');

    h += `<section class="ce-card">
        ${ch.draft ? '<div class="ce-banner">Generated draft. Review it for mistakes, then <button class="ce-link" data-act="reviewed">mark it reviewed</button>.</div>' : ''}
        ${fld('Title', inp('title', ch.title, {}))}
        ${fld('Description', txt('description', ch.description, {}, 2))}
        ${fld('Linked lorebook', `<input class="ce-in" list="ce-books" data-f="lorebook" value="${esc(ch.lorebook)}" placeholder="Lorebook name"><datalist id="ce-books">${ui.books.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>`)}
        ${fld('Character cards (one name per line)', txt('characters', ch.characters, {}, 2, true))}
    </section>`;

    ch.arcs.forEach((a, ai) => {
        const key = `a:${a.id}`;
        h += `<details class="ce-det ce-det-arc" data-key="${key}" ${openAttr(key)}><summary><span data-sum="${key}">${esc(a.title)}</span></summary><div class="ce-det-body">
            ${fld('Arc title', inp('title', a.title, { a: ai }))}
            ${fld('Arc summary (sent to the model)', txt('summary', a.summary, { a: ai }, 3))}
            ${fld('Pacing override', pacingSelect(a.pacing, { a: ai }))}
            <div class="ce-actions">${icon('up', { a: ai }, '', 'Move arc up', 'fa-arrow-up')}${icon('down', { a: ai }, '', 'Move arc down', 'fa-arrow-down')}${icon('del', { a: ai }, 'ce-danger', 'Delete arc', 'fa-trash')}</div>`;
        a.episodes.forEach((ep, ei) => {
            const ekey = `e:${ep.id}`;
            const d = { a: ai, e: ei };
            h += `<details class="ce-det ce-det-ep" data-key="${ekey}" ${openAttr(ekey)}><summary><span data-sum="${ekey}">${esc(ep.title)}</span></summary><div class="ce-det-body">
                ${fld('Episode title', inp('title', ep.title, d))}
                <div class="ce-actions">${icon('up', d, '', 'Move episode up', 'fa-arrow-up')}${icon('down', d, '', 'Move episode down', 'fa-arrow-down')}${icon('del', d, 'ce-danger', 'Delete episode', 'fa-trash')}</div>
                ${ep.beats.map((b, bi) => beatHtml(ep, b, bi, ai, ei)).join('')}
                <button class="ce-btn" data-act="add-beat" ${attrs(d)}>Add beat</button>
            </div></details>`;
        });
        h += `<button class="ce-btn" data-act="add-ep" data-a="${ai}">Add episode</button></div></details>`;
    });
    h += '<button class="ce-btn ce-primary ce-wide" data-act="add-arc">Add arc</button>';
    return h;
}

/* ---- Worlds ---- */

function renderWorlds() {
    const ch = editing();
    if (!ch) return emptyState('Create a chronicle first', 'Worlds tools work on the chronicle you are editing.', '<button class="ce-btn ce-primary" data-act="new-chron">New chronicle</button>');
    const bookOpts = (sel) => `<option value="">None</option>${ui.books.map((n) => `<option value="${esc(n)}" ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('')}`;
    setTimeout(() => fillLore(ch), 0);
    return `
    <section class="ce-card"><p class="ce-lbl">World for “${esc(ch.title)}”</p>
        <label class="ce-field"><span>Linked lorebook</span><select class="ce-in" data-f="lorebook">${bookOpts(ch.lorebook)}</select></label>
        <button class="ce-btn" data-act="refresh-books">Update list</button>
        <div id="ce-lore" class="ce-lore"></div>
    </section>
    <section class="ce-card"><p class="ce-lbl">Generate a chronicle</p>
        <p class="ce-note">Results are drafts. Models can get story details wrong, so review before use.</p>
        <label class="ce-field"><span>From a lorebook</span><select class="ce-in" id="ce-gen-book">${bookOpts(ch.lorebook)}</select></label>
        <button class="ce-btn" data-act="gen-lore">Generate from lorebook</button>
        <label class="ce-field"><span>From a known fandom or story</span><input class="ce-in" id="ce-gen-fandom" type="text" placeholder="Name of the story or franchise"></label>
        <label class="ce-field"><span>Part to cover (optional)</span><input class="ce-in" id="ce-gen-scope" type="text" placeholder="e.g. first season, first book"></label>
        <button class="ce-btn" data-act="gen-fandom">Generate from fandom</button>
    </section>
    <section class="ce-card"><p class="ce-lbl">Share</p>
        <label class="ce-switch"><input type="checkbox" id="ce-exp-book" checked><span><b>Include the lorebook</b><small>Bundles its entries in the file</small></span></label>
        <div class="ce-actions"><button class="ce-btn" data-act="export">Export JSON</button><button class="ce-btn" data-act="import-file">Import file</button></div>
        <label class="ce-field"><span>Or paste JSON</span><textarea class="ce-in" id="ce-paste" rows="3" placeholder="Paste an exported chronicle here"></textarea></label>
        <button class="ce-btn" data-act="import-paste">Import pasted JSON</button>
    </section>`;
}

async function fillLore(ch) {
    const box = $q('#ce-lore');
    if (!box) return;
    if (!ch.lorebook) { box.innerHTML = '<p class="ce-note">Pick a lorebook to edit its entries here.</p>'; return; }
    try {
        const ents = await entriesOf(ch.lorebook);
        box.innerHTML = ents.map((e) => `<details class="ce-det" data-key="l:${e.uid}"><summary>${esc((e.key || []).join(', ') || e.comment || 'Entry')}</summary>
            <div class="ce-det-body ce-lore-row" data-uid="${e.uid}">
                <label class="ce-field"><span>Keys (comma separated)</span><input class="ce-in ce-lore-keys" type="text" value="${esc((e.key || []).join(', '))}"></label>
                <label class="ce-field"><span>Content</span><textarea class="ce-in ce-lore-content" rows="4">${esc(e.content || '')}</textarea></label>
                <div class="ce-actions"><button class="ce-btn ce-primary" data-act="lore-save" data-uid="${e.uid}">Save entry</button><button class="ce-btn ce-danger" data-act="lore-del" data-uid="${e.uid}">Delete</button></div>
            </div></details>`).join('') + '<button class="ce-btn" data-act="lore-add">Add entry</button>';
    } catch (e) {
        console.warn(e);
        box.innerHTML = '<p class="ce-note">Could not read this lorebook. Check the name, or update the list.</p>';
    }
}

/* ---- Features ---- */

function renderFeatures() {
    const sw = (path, label, hint = '') => `<label class="ce-switch"><input type="checkbox" data-set="${path}" ${getPath(S(), path) ? 'checked' : ''}><span><b>${label}</b>${hint ? `<small>${hint}</small>` : ''}</span></label>`;
    const num = (path, label, hint, min, max) => `<label class="ce-field"><span>${label}</span><input class="ce-in" type="number" min="${min}" max="${max}" data-set="${path}" value="${esc(getPath(S(), path))}"><small class="ce-note">${hint}</small></label>`;
    return `
    <section class="ce-card"><p class="ce-lbl">General</p>
        ${sw('enabled', 'Chronicle Engine on', 'Master switch for every chat')}
        ${sw('showFab', 'Floating button', 'Drag it anywhere. Tap to open')}
        <label class="ce-field"><span>Default pacing</span><select class="ce-in" data-set="defaultPacing">${Object.entries(PACE).map(([k, v]) => `<option value="${k}" ${S().defaultPacing === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
        ${num('injectDepth', 'Injection depth', 'How many messages from the end the guidance is placed', 0, 20)}
    </section>
    <section class="ce-card"><p class="ce-lbl">Story steering</p>
        ${sw('features.nudge', 'Dynamic nudge', 'Push toward the beat when the chat stalls')}
        ${num('nudgeAfter', 'Nudge after (messages)', 'Counted since the last beat change. Slow pace waits longer, fast waits less', 2, 60)}
        ${sw('features.judge', 'Beat check', 'Adds a button that asks the model if the beat is done')}
        ${num('judgeEvery', 'Auto-check every N replies', '0 turns it off. Uses the side-task profile', 0, 50)}
    </section>
    <section class="ce-card"><p class="ce-lbl">Extras</p>
        ${sw('features.recap', 'Arc recap', 'Short recap when a new episode starts')}
        ${sw('features.epilogue', 'Epilogue generator', 'Offer an epilogue when an arc ends')}
        ${sw('features.whatsNext', 'What\'s next?', 'Suggest the next arc or branch')}
        ${sw('features.loreSuggest', 'Lore suggestions', 'Propose lorebook entries after completed beats')}
        ${sw('features.continuity', 'Continuity guard', 'Adds a button that checks recent messages for contradictions')}
    </section>`;
}

/* ---- Render dispatcher ---- */

function render() {
    updateFab();
    if (!ui.isOpen) return;
    const body = $q('#ce-body');
    const top = body.scrollTop;
    const views = { dash: renderDash, edit: renderEditor, worlds: renderWorlds, features: renderFeatures };
    body.innerHTML = (views[ui.view] || renderDash)();
    body.scrollTop = top;
    document.querySelectorAll('#ce-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === ui.view)));
}

/* ------------------------------------------------------------------ */
/* Event handling                                                      */
/* ------------------------------------------------------------------ */

function editorChanged() {
    saveSettings();
    refreshPrompt();
    render();
}

function arrayAt(d) {
    const ch = editing();
    if (d.b !== undefined) return ch.arcs[+d.a].episodes[+d.e].beats;
    if (d.e !== undefined) return ch.arcs[+d.a].episodes;
    return ch.arcs;
}
const indexAt = (d) => +(d.b ?? d.e ?? d.a);

const ACTIONS = {
    complete: () => advance('completed'),
    skip: () => advance('skipped'),
    rewind: () => rewind(),
    check: (d, t) => enqueue('Checking beat', () => judgeBeat(false), t),
    branch: (d) => branchInto(d.id),
    jump: (d) => jump(d.id),
    pace: (d) => { const st = cs(true); st.pacing = d.v; commit(); },
    whatsnext: (d, t) => enqueue('Thinking about what comes next', () => whatsNext(), t),
    continuity: (d, t) => enqueue('Checking continuity', () => checkContinuity(), t),
    recap: (d, t) => {
        const cur = findBeat(activeChron(), cs()?.activeBeatId);
        if (cur) enqueue('Writing recap', () => generateRecap(cur.ep), t);
    },
    epilogue: (d, t) => {
        const ch = activeChron();
        const cur = findBeat(ch, cs()?.activeBeatId);
        const arc = cur?.arc || ch?.arcs[ch.arcs.length - 1];
        if (arc) enqueue('Writing epilogue', () => generateEpilogue(arc), t);
    },
    refresh: async () => { await refreshBooks(); render(); toast('success', 'Lists updated.'); },
    'refresh-books': async () => { await refreshBooks(); render(); toast('success', 'Lorebook list updated.'); },

    'new-chron': () => {
        const ch = newChronicle(`Chronicle ${S().chronicles.length + 1}`);
        S().chronicles.push(ch);
        ui.editId = ch.id;
        ui.view = 'edit';
        ui.expanded.add(`a:${ch.arcs[0].id}`);
        editorChanged();
    },
    'dup-chron': () => {
        const ch = editing();
        if (!ch) return;
        const copy = normalizeChronicle({ ...clone(ch), title: `${ch.title} (copy)` });
        S().chronicles.push(copy);
        ui.editId = copy.id;
        editorChanged();
    },
    'del-chron': () => {
        const ch = editing();
        if (!ch || !window.confirm(`Delete "${ch.title}"? This cannot be undone. Export it first if you want a backup.`)) return;
        S().chronicles = S().chronicles.filter((x) => x.id !== ch.id);
        ui.editId = null;
        editorChanged();
    },
    reviewed: () => { const ch = editing(); if (ch) { ch.draft = false; editorChanged(); } },
    'add-arc': () => {
        const ch = editing();
        const a = newArc(ch.arcs.length + 1);
        ch.arcs.push(a);
        ui.expanded.add(`a:${a.id}`);
        editorChanged();
    },
    'add-ep': (d) => {
        const a = editing().arcs[+d.a];
        const ep = newEpisode(a.episodes.length + 1);
        a.episodes.push(ep);
        ui.expanded.add(`e:${ep.id}`);
        editorChanged();
    },
    'add-beat': (d) => {
        const ep = editing().arcs[+d.a].episodes[+d.e];
        const b = newBeat();
        ep.beats.push(b);
        ui.expanded.add(`b:${b.id}`);
        editorChanged();
    },
    up: (d) => { const arr = arrayAt(d); const i = indexAt(d); if (i > 0) { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; editorChanged(); } },
    down: (d) => { const arr = arrayAt(d); const i = indexAt(d); if (i < arr.length - 1) { [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; editorChanged(); } },
    del: (d) => {
        if (!window.confirm('Delete this item and everything inside it?')) return;
        const arr = arrayAt(d);
        const [removed] = arr.splice(indexAt(d), 1);
        if (d.b !== undefined) arr.forEach((b) => { if (b.branchOf === removed.id) b.branchOf = ''; });
        editorChanged();
    },

    'gen-lore': (d, t) => {
        const name = $q('#ce-gen-book')?.value;
        if (!name) { toast('warning', 'Pick a lorebook first.'); return; }
        enqueue('Generating draft from lorebook', async () => {
            const ents = (await entriesOf(name)).filter((e) => !e.disable);
            if (!ents.length) { toast('warning', 'That lorebook has no entries.'); return; }
            const src = ents.map((e) => `${(e.key || []).join(', ')}: ${e.content}`).join('\n').slice(0, 14000);
            await generateChronicleFrom(`lorebook "${name}"`, src, name);
        }, t);
    },
    'gen-fandom': (d, t) => {
        const name = $q('#ce-gen-fandom')?.value.trim();
        const scope = $q('#ce-gen-scope')?.value.trim();
        if (!name) { toast('warning', 'Enter the name of a story or franchise.'); return; }
        enqueue('Generating draft', () => generateChronicleFrom(
            'known story',
            `Outline the story of "${name}"${scope ? `, covering only: ${scope}` : ''}, as a roleplay campaign. Use only what you reliably know of the original.`,
        ), t);
    },
    export: (d, t) => {
        const ch = editing();
        if (ch) enqueue('Exporting', () => exportChronicle(ch, $q('#ce-exp-book')?.checked), t);
    },
    'import-file': () => $q('#ce-file').click(),
    'import-paste': (d, t) => {
        const v = $q('#ce-paste')?.value;
        if (!v?.trim()) { toast('warning', 'Paste some JSON first.'); return; }
        enqueue('Importing', () => importChronicle(v), t);
    },

    'lore-save': async (d, t) => {
        const ch = editing();
        const row = t.closest('.ce-lore-row');
        try {
            const data = await loadBook(ch.lorebook);
            const e = data.entries[d.uid];
            e.key = $q('.ce-lore-keys', row).value.split(',').map((s) => s.trim()).filter(Boolean);
            e.content = $q('.ce-lore-content', row).value;
            await saveBook(ch.lorebook, data);
            toast('success', 'Entry saved.');
            fillLore(ch);
        } catch (e) { console.warn(e); toast('error', 'Could not save the entry.'); }
    },
    'lore-del': async (d) => {
        const ch = editing();
        if (!window.confirm('Delete this lorebook entry?')) return;
        try {
            const data = await loadBook(ch.lorebook);
            delete data.entries[d.uid];
            await saveBook(ch.lorebook, data);
            fillLore(ch);
        } catch (e) { console.warn(e); toast('error', 'Could not delete the entry.'); }
    },
    'lore-add': async () => {
        const ch = editing();
        try {
            await addEntry(ch.lorebook, { keys: ['new entry'], content: '', comment: '' });
            fillLore(ch);
        } catch (e) { console.warn(e); toast('error', 'Could not add an entry.'); }
    },
};

async function onClick(ev) {
    const t = ev.target.closest('[data-act],[data-view]');
    if (!t || !$q('#ce-drawer').contains(t)) return;
    if (t.dataset.view) { ui.view = t.dataset.view; render(); return; }
    const fn = ACTIONS[t.dataset.act];
    if (fn) await fn(t.dataset, t);
}

async function onSel(t) {
    const k = t.dataset.sel;
    const v = t.value;
    if (k === 'chron') {
        const st = cs(true);
        st.chronicleId = v || null;
        st.activeBeatId = null;
        if (v) ui.editId = v;
        ensureState();
        commit();
    } else if (k === 'chatenabled') {
        cs(true).enabled = t.checked;
        commit();
    } else if (k === 'profile') {
        S().profileId = v;
        saveSettings();
    } else if (k === 'chatprofile') {
        const p = profiles().find((x) => x.id === v);
        if (!p) return;
        try {
            await ctx().executeSlashCommandsWithOptions(`/profile ${p.name}`);
            toast('success', `Chat profile: ${p.name}`);
        } catch (e) {
            console.warn(e);
            toast('warning', 'Could not switch the profile. Change it in the Connection Manager instead.');
        }
    } else if (k === 'editchron') {
        ui.editId = v;
        render();
    }
}

function onSet(t) {
    const path = t.dataset.set;
    const v = t.type === 'checkbox' ? t.checked : t.type === 'number' ? Number(t.value) : t.value;
    setPath(S(), path, v);
    saveSettings();
    refreshPrompt();
    updateFab();
    syncPanel();
    if (t.type === 'checkbox' || t.tagName === 'SELECT') render();
}

function onEditField(t) {
    const ch = editing();
    if (!ch) return;
    const d = t.dataset;
    let obj = ch;
    if (d.a !== undefined) {
        obj = ch.arcs[+d.a];
        if (d.e !== undefined) obj = obj.episodes[+d.e];
        if (d.b !== undefined) obj = obj.beats[+d.b];
    }
    let v = t.value;
    if (d.lines) v = v.split('\n').map((s) => s.trim()).filter(Boolean);
    obj[d.f] = v;

    if (d.f === 'branchOf' && v) {
        // A beat that becomes a branch cannot also be a parent.
        const ep = ch.arcs[+d.a].episodes[+d.e];
        ep.beats.forEach((b) => { if (b.branchOf === obj.id) b.branchOf = ''; });
    }
    if (d.f === 'title') {
        const prefix = d.b !== undefined ? 'b' : d.e !== undefined ? 'e' : d.a !== undefined ? 'a' : null;
        const el = prefix && $q(`[data-sum="${prefix}:${obj.id}"]`);
        if (el) el.textContent = v || 'Untitled';
    }
    saveSettings();
    refreshPrompt();
    if (d.f === 'lorebook' && ui.view === 'worlds') render();
    if (d.f === 'branchOf' || d.f === 'priority') render();
}

function onChange(ev) {
    const t = ev.target;
    if (t.dataset.sel) onSel(t);
    else if (t.dataset.set) onSet(t);
    else if (t.dataset.f) onEditField(t);
}

/* ------------------------------------------------------------------ */
/* Floating button and drawer                                          */
/* ------------------------------------------------------------------ */

function applyFabPos() {
    const fab = $q('#ce-fab');
    if (!fab || fab.hidden) return;
    const { x, y } = S().fab;
    const fx = x ?? 1;
    const fy = y ?? 0.7;
    const w = fab.offsetWidth || 48;
    const h = fab.offsetHeight || 48;
    fab.style.left = `${Math.max(0, (window.innerWidth - w) * fx)}px`;
    fab.style.top = `${Math.max(0, (window.innerHeight - h) * fy)}px`;
}

function updateFab() {
    const fab = $q('#ce-fab');
    if (!fab) return;
    fab.hidden = !S().showFab;
    fab.classList.toggle('ce-live', isOn());
    applyFabPos();
}

function initFab() {
    const fab = $q('#ce-fab');
    let sx = 0; let sy = 0; let ox = 0; let oy = 0;
    let down = false; let drag = false;
    fab.addEventListener('pointerdown', (e) => {
        down = true; drag = false;
        sx = e.clientX; sy = e.clientY;
        const r = fab.getBoundingClientRect();
        ox = r.left; oy = r.top;
        fab.setPointerCapture(e.pointerId);
    });
    fab.addEventListener('pointermove', (e) => {
        if (!down) return;
        const dx = e.clientX - sx; const dy = e.clientY - sy;
        if (!drag && Math.hypot(dx, dy) > 6) drag = true;
        if (!drag) return;
        const w = fab.offsetWidth; const h = fab.offsetHeight;
        fab.style.left = `${Math.min(Math.max(0, ox + dx), window.innerWidth - w)}px`;
        fab.style.top = `${Math.min(Math.max(0, oy + dy), window.innerHeight - h)}px`;
    });
    fab.addEventListener('pointerup', () => {
        if (!down) return;
        down = false;
        if (drag) {
            const w = fab.offsetWidth; const h = fab.offsetHeight;
            S().fab = {
                x: Math.min(1, Math.max(0, parseFloat(fab.style.left) / Math.max(1, window.innerWidth - w))),
                y: Math.min(1, Math.max(0, parseFloat(fab.style.top) / Math.max(1, window.innerHeight - h))),
            };
            saveSettings();
        } else {
            toggleDrawer();
        }
    });
    fab.addEventListener('pointercancel', () => { down = false; });
    fab.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDrawer(); } });
    window.addEventListener('resize', applyFabPos);
}

function toggleDrawer(force) {
    ui.isOpen = force ?? !ui.isOpen;
    $q('#ce-drawer').classList.toggle('ce-open', ui.isOpen);
    $q('#ce-scrim').classList.toggle('ce-open', ui.isOpen);
    $q('#ce-drawer').setAttribute('aria-hidden', String(!ui.isOpen));
    if (ui.isOpen) {
        if (!ui.editId) ui.editId = activeChron()?.id || null;
        refreshBooks().then(() => { if (ui.isOpen && ui.view !== 'edit') render(); });
        render();
    }
}

function buildDom() {
    const root = document.createElement('div');
    root.id = 'ce-root';
    root.innerHTML = `
        <button id="ce-fab" type="button" aria-label="Open Chronicle Engine" title="Chronicle Engine"><i class="fa-solid fa-book-open"></i></button>
        <div id="ce-scrim"></div>
        <aside id="ce-drawer" role="dialog" aria-label="Chronicle Engine" aria-hidden="true">
            <div class="ce-grab" aria-hidden="true"></div>
            <header class="ce-head"><h2>Chronicle Engine</h2><button id="ce-close" type="button" class="ce-mini" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></header>
            <nav id="ce-tabs" role="tablist">
                <button type="button" role="tab" data-view="dash">Dashboard</button>
                <button type="button" role="tab" data-view="edit">Edit</button>
                <button type="button" role="tab" data-view="worlds">Worlds</button>
                <button type="button" role="tab" data-view="features">Features</button>
            </nav>
            <div id="ce-body"></div>
            <input id="ce-file" type="file" accept=".json,application/json" hidden>
        </aside>
        <div id="ce-modal-host"></div>`;
    document.body.append(root);

    const drawer = $q('#ce-drawer');
    drawer.addEventListener('click', onClick);
    drawer.addEventListener('change', onChange);
    $q('#ce-body').addEventListener('toggle', (e) => {
        const k = e.target?.dataset?.key;
        if (!k) return;
        if (e.target.open) ui.expanded.add(k); else ui.expanded.delete(k);
    }, true);
    $q('#ce-scrim').addEventListener('click', () => toggleDrawer(false));
    $q('#ce-close').addEventListener('click', () => toggleDrawer(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.isOpen && !modalOpen) toggleDrawer(false); });
    $q('#ce-file').addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) enqueue('Importing', async () => importChronicle(await file.text()));
    });
    initFab();
}

function buildSettingsPanel() {
    const html = `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header"><b>Chronicle Engine</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
        <div class="inline-drawer-content">
            <label class="checkbox_label"><input id="ce_enabled" type="checkbox"><span>Enable Chronicle Engine</span></label>
            <label class="checkbox_label"><input id="ce_fab" type="checkbox"><span>Show floating button</span></label>
            <div id="ce_open" class="menu_button">Open Chronicle Engine</div>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);
    $('#ce_enabled').on('change', function () { S().enabled = this.checked; saveSettings(); refreshPrompt(); render(); });
    $('#ce_fab').on('change', function () { S().showFab = this.checked; saveSettings(); updateFab(); render(); });
    $('#ce_open').on('click', () => toggleDrawer(true));
    syncPanel();
}
function syncPanel() {
    $('#ce_enabled').prop('checked', !!S().enabled);
    $('#ce_fab').prop('checked', !!S().showFab);
}

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

function onChatChanged() {
    if (activeChron()) ensureState();
    refreshPrompt();
    render();
}

function onMessageReceived() {
    if (!isOn()) return;
    const st = cs();
    const n = Number(S().judgeEvery) || 0;
    if (!n || !S().features.judge || !st.activeBeatId) return;
    st.judgeCount = (st.judgeCount || 0) + 1;
    if (st.judgeCount >= n) {
        st.judgeCount = 0;
        enqueue('Checking beat', () => judgeBeat(true));
    }
    saveChat();
}

jQuery(async () => {
    loadSettings();
    buildDom();
    buildSettingsPanel();

    const c = ctx();
    const ev = c.eventTypes || c.event_types;
    c.eventSource.on(ev.CHAT_CHANGED, onChatChanged);
    c.eventSource.on(ev.GENERATION_STARTED, refreshPrompt);
    c.eventSource.on(ev.MESSAGE_RECEIVED, onMessageReceived);

    await refreshBooks();
    refreshPrompt();
    updateFab();
    console.log('[Chronicle Engine] loaded');
});
