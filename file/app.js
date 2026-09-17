/**
 * bjkravets.com/file — in-browser file converter (UI).
 * The conversions themselves live in ./engines/*.js; this file only detects,
 * queues, shows progress and hands results back as downloads.
 */

const ENGINE_NAMES = ['image', 'av', 'model'];
const ENGINE_LABELS = { image: 'Image', av: 'Audio & Video', model: '3D Model' };
const FFLATE_URL = 'https://cdn.jsdelivr.net/npm/fflate@0.8.3/esm/browser.js';

const $ = (sel) => document.querySelector(sel);

/** Tiny DOM builder: el('div', { class: 'x', onclick: fn, text: '…' }, ...children). */
function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, val] of Object.entries(attrs)) {
        if (val == null || val === false) continue;
        if (key === 'class') node.className = val;
        else if (key === 'text') node.textContent = val;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), val);
        else if (val === true) node.setAttribute(key, '');
        else node.setAttribute(key, val);
    }
    for (const child of children.flat()) {
        if (child == null || child === false) continue;
        node.append(child.nodeType ? child : String(child));
    }
    return node;
}

const state = {
    engines: [],      // loaded engine modules, in ENGINE_NAMES order
    failed: [],       // engine names that failed to load
    browse: 'image',  // domain shown when no files are loaded
    files: [],        // { id, file, engine, inputId, status, progress, message, result }
    target: null,     // output format id
    opts: {},         // option values for (batch engine, target)
    running: false,
    abort: null,
    zipping: false,   // Save-all is building the archive
    saveError: '',    // last Save-all failure, shown under the buttons
};
let nextId = 1;

// ---- engines ---------------------------------------------------------------

async function loadEngines() {
    const names = [...ENGINE_NAMES];
    // Dev-only fake engine (file/_dev/stub.js); never on the live site.
    if (['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('stub')) {
        names.push('../_dev/stub');
    }
    const loaded = await Promise.all(names.map(async (name) => {
        try {
            const mod = await import(`./engines/${name}.js`);
            if (!mod.domain || !Array.isArray(mod.formats) || typeof mod.detect !== 'function' || typeof mod.convert !== 'function') {
                throw new Error('module does not match the engine contract');
            }
            return mod;
        } catch (err) {
            console.warn(`engine "${name}" failed to load:`, err);
            state.failed.push(name);
            return null;
        }
    }));
    state.engines = loaded.filter(Boolean);
    if (!state.engines.some((e) => e.domain.id === state.browse) && state.engines[0]) {
        state.browse = state.engines[0].domain.id;
    }
}

const formatOf = (engine, id) => engine.formats.find((f) => f.id === id);

function targetsFor(engine, inputId) {
    let ids;
    if (typeof engine.targets === 'function') ids = engine.targets(inputId);
    else ids = engine.formats.filter((f) => f.write && f.id !== inputId).map((f) => f.id);
    return new Set((ids || []).filter((id) => formatOf(engine, id)?.write));
}

// ---- batch state -----------------------------------------------------------

/** The first accepted file decides which engine the batch uses. */
const batchEngine = () => state.files.find((f) => f.engine)?.engine ?? null;

const activeItems = () => state.files.filter((f) => f.engine && f.status !== 'skipped');

/**
 * Output formats the whole batch can go to. A file that is already in the
 * target format (and cannot be re-encoded) simply passes through unchanged, so
 * an STL next to an OBJ can still be sent to STL.
 */
function targetList() {
    const engine = batchEngine();
    const items = activeItems();
    if (!engine || !items.length) return [];
    const sets = items.map((item) => targetsFor(engine, item.inputId));
    const candidates = new Set(sets.flatMap((set) => [...set]));
    const valid = [...candidates].filter((id) => items.every((item, k) => sets[k].has(id) || item.inputId === id));
    return engine.formats.filter((f) => valid.includes(f.id));
}

/** True when the file is already in the target format and the engine offers no re-encode for it. */
function passesThrough(item) {
    if (!item.engine || !state.target || item.inputId !== state.target) return false;
    return !targetsFor(item.engine, item.inputId).has(state.target);
}

/** Re-derive per-file statuses after files are added or removed. */
function reconcile() {
    const engine = batchEngine();
    for (const item of state.files) {
        if (!item.engine) continue;
        if (item.engine !== engine) {
            item.status = 'skipped';
            item.message = `Different type — convert ${item.engine.domain.name.toLowerCase()} files separately`;
        } else if (item.status === 'skipped') {
            item.status = 'ready';
            item.message = '';
        }
    }
    if (state.target && !targetList().some((f) => f.id === state.target)) setTarget(null, false);
    if (!batchEngine() && state.target) setTarget(null, false);
}

async function addFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => f && f.size >= 0);
    if (!files.length) return;
    for (const file of files) {
        let head = new Uint8Array(0);
        try { head = new Uint8Array(await file.slice(0, 64).arrayBuffer()); } catch { /* unreadable; detect by name */ }
        let engine = null;
        let inputId = null;
        for (const candidate of state.engines) {
            let id = null;
            try { id = candidate.detect(file, head); } catch (err) { console.warn('detect failed', err); }
            if (id && formatOf(candidate, id)?.read) { engine = candidate; inputId = id; break; }
        }
        state.files.push({
            id: nextId++, file, engine, inputId,
            status: engine ? 'ready' : 'unsupported',
            progress: null, message: '', result: null,
        });
    }
    reconcile();
    render();
}

function removeItem(item) {
    if (state.running) return;
    state.files = state.files.filter((f) => f !== item);
    reconcile();
    render();
}

function clearAll() {
    if (state.running) return;
    state.files = [];
    setTarget(null, false);
    render();
}

// ---- options ---------------------------------------------------------------

function optionDefs(engine, targetId) {
    const fmt = formatOf(engine, targetId);
    return [...(engine.options || []), ...((fmt && fmt.options) || [])];
}

const storageKey = (engine, targetId) => `file-converter:${engine.domain.id}:${targetId}`;

function coerce(def, value) {
    if (value == null || (typeof value === 'string' && !value.trim())) return def.default;
    if (def.type === 'toggle') return Boolean(value);
    if (def.type === 'range' || def.type === 'number') {
        const n = Number(value);
        if (!Number.isFinite(n)) return def.default;
        if (def.min != null && n < def.min) return def.min;
        if (def.max != null && n > def.max) return def.max;
        return n;
    }
    if (def.type === 'select') {
        const str = String(value);
        return (def.choices || []).some((c) => String(c.value) === str) ? str : String(def.default);
    }
    return value;
}

function loadOpts(engine, targetId) {
    const defs = optionDefs(engine, targetId);
    const values = {};
    for (const def of defs) values[def.id] = def.default;
    try {
        const stored = JSON.parse(localStorage.getItem(storageKey(engine, targetId)) || '{}');
        for (const def of defs) if (def.id in stored) values[def.id] = stored[def.id];
    } catch { /* storage unavailable or corrupt */ }
    for (const def of defs) values[def.id] = coerce(def, values[def.id]);
    return values;
}

function setOpt(def, value) {
    state.opts[def.id] = coerce(def, value);
    const engine = batchEngine();
    if (engine && state.target) {
        try { localStorage.setItem(storageKey(engine, state.target), JSON.stringify(state.opts)); } catch { /* ignore */ }
    }
}

function fmtOpt(def, value) {
    if (def.type === 'toggle') return value ? 'On' : 'Off';
    if (def.type === 'select') return (def.choices || []).find((c) => String(c.value) === String(value))?.label ?? String(value);
    return `${value}${def.unit ? ' ' + def.unit : ''}`;
}

// ---- target ----------------------------------------------------------------

function setTarget(id, rerender = true) {
    state.target = id;
    const engine = batchEngine();
    state.opts = engine && id ? loadOpts(engine, id) : {};
    for (const item of state.files) {
        if (item.status === 'done' || item.status === 'error') {
            item.status = 'ready';
            item.message = '';
            item.result = null;
            item.progress = null;
        }
    }
    if (engine && id && typeof engine.warmup === 'function') {
        const first = activeItems()[0];
        Promise.resolve().then(() => engine.warmup(id, first?.inputId)).catch((err) => console.warn('warmup', err));
    }
    if (rerender) render();
}

function outputName(item, ext) {
    const base = item.file.name.replace(/\.[^.]+$/, '') || 'file';
    let name = `${base}.${ext}`;
    if (name.toLowerCase() === item.file.name.toLowerCase()) name = `${base}-converted.${ext}`;
    return name;
}

function loadNoteText() {
    const engine = batchEngine();
    if (!engine || !state.target || !engine.loadNote) return '';
    if (typeof engine.needsCad === 'function') {
        if (!activeItems().some((i) => engine.needsCad(i.inputId, state.target))) return '';
    }
    return engine.loadNote;
}

// ---- conversion ------------------------------------------------------------

async function convertAll() {
    const engine = batchEngine();
    if (!engine || !state.target || state.running) return;
    const fmt = formatOf(engine, state.target);
    const queue = activeItems().filter((i) => i.status === 'ready' || i.status === 'error');
    if (!queue.length) return;

    const controller = new AbortController();
    state.abort = controller;
    state.running = true;
    state.done = 0;
    state.total = queue.length;
    render();

    for (const item of queue) {
        if (controller.signal.aborted) break;
        if (passesThrough(item)) {
            item.result = { blob: item.file, name: item.file.name };
            item.status = 'done';
            item.message = '';
            state.done += 1;
            render();
            continue;
        }
        item.status = 'converting';
        item.progress = null;
        item.message = '';
        renderFiles();
        renderActions();
        try {
            const res = await engine.convert({
                file: item.file,
                inputId: item.inputId,
                outputId: state.target,
                options: { ...state.opts },
                onProgress: (fraction, message) => {
                    item.progress = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : null;
                    item.message = message ? String(message).slice(0, 80) : '';
                    renderFiles();
                },
                signal: controller.signal,
            });
            if (!res || !(res.blob instanceof Blob)) throw new Error('The engine returned no file.');
            item.result = { blob: res.blob, name: outputName(item, res.ext || fmt.ext[0]) };
            item.status = 'done';
            item.message = '';
        } catch (err) {
            if (controller.signal.aborted) {
                item.status = 'ready';
                item.message = '';
            } else {
                console.error(err);
                item.status = 'error';
                item.message = (err && err.message) || 'Conversion failed';
            }
        }
        item.progress = null;
        state.done += 1;
        render();
    }

    state.running = false;
    state.abort = null;
    render();
}

function cancel() {
    if (state.abort) state.abort.abort();
}

// ---- saving ----------------------------------------------------------------

function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function saveAll() {
    const done = state.files.filter((f) => f.status === 'done' && f.result);
    if (!done.length || state.zipping) return;
    if (done.length === 1) return download(done[0].result.blob, done[0].result.name);

    state.zipping = true;
    state.saveError = '';
    renderActions();
    try {
        // TODO: build the archive as a Blob of parts (headers + result blobs)
        // instead of copying every result into the JS heap; see file/README.md.
        const { zipSync } = await import(FFLATE_URL);
        const entries = {};
        const seen = new Map();
        for (const item of done) {
            let name = item.result.name;
            const n = (seen.get(name) || 0) + 1;
            seen.set(name, n);
            if (n > 1) name = name.replace(/(\.[^.]+)?$/, ` (${n})$1`);
            entries[name] = [new Uint8Array(await item.result.blob.arrayBuffer()), { level: 0 }];
        }
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        download(new Blob([zipSync(entries)], { type: 'application/zip' }), `converted-${stamp}.zip`);
    } catch (err) {
        console.error(err);
        state.saveError = `Could not build the zip (${(err && err.message) || err}). Use the Save button on each file instead.`;
    } finally {
        state.zipping = false;
        renderActions();
    }
}

// ---- rendering -------------------------------------------------------------

function fmtSize(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function render() {
    renderDomains();
    renderFiles();
    renderBrowse();
    renderTargets();
    renderSettings();
    renderActions();
    renderNote();
}

function renderDomains() {
    const nav = $('#domains');
    nav.replaceChildren();
    const batch = batchEngine();
    for (const engine of state.engines) {
        const on = batch ? engine === batch : engine.domain.id === state.browse;
        nav.append(el('button', {
            type: 'button',
            class: 'segment' + (on ? ' on' : ''),
            'aria-pressed': on ? 'true' : 'false',
            onclick: () => { if (!batch) { state.browse = engine.domain.id; render(); } },
            text: engine.domain.name,
        }));
    }
    for (const name of state.failed) {
        nav.append(el('button', { type: 'button', class: 'segment', disabled: true, text: `${ENGINE_LABELS[name] || name} (unavailable)` }));
    }
    $('#dropzone-hint').textContent = state.engines.length
        ? `or tap to choose · ${state.engines.map((e) => e.domain.name.toLowerCase()).join(' · ')}`
        : 'no conversion engines could be loaded';
}

function renderFiles() {
    const list = $('#file-list');
    list.replaceChildren();
    $('#clear').hidden = !state.files.length || state.running;
    $('#dropzone').classList.toggle('compact', state.files.length > 0);
    $('#dropzone').disabled = state.running;

    for (const item of state.files) {
        const fmt = item.engine ? formatOf(item.engine, item.inputId) : null;
        const bad = item.status === 'unsupported' || item.status === 'skipped';
        const row = el('div', { class: `file ${item.status}` });
        row.append(el('div', { class: 'file-head' },
            el('span', { class: 'badge' + (bad ? ' red' : item.status === 'done' ? ' green' : ''), text: fmt ? fmt.name : '?' }),
            el('span', { class: 'file-name', text: item.file.name, title: item.file.name }),
            el('span', { class: 'file-size', text: fmtSize(item.file.size) }),
            el('button', { type: 'button', class: 'file-remove', 'aria-label': `Remove ${item.file.name}`, disabled: state.running, onclick: () => removeItem(item), text: '×' }),
        ));

        const outFmt = item.engine && state.target ? formatOf(item.engine, state.target) : null;
        switch (item.status) {
            case 'unsupported':
                row.append(el('div', { class: 'file-line err', text: 'Not a supported file type' }));
                break;
            case 'skipped':
                row.append(el('div', { class: 'file-line warn', text: item.message }));
                break;
            case 'ready':
                if (outFmt && passesThrough(item)) {
                    row.append(el('div', { class: 'file-line plain' },
                        el('span', { class: 'out-name', text: `Already ${outFmt.name} — kept as is` })));
                } else if (outFmt) {
                    row.append(el('div', { class: 'file-line plain' },
                        el('span', { class: 'out-name', text: `→ ${outputName(item, outFmt.ext[0])}` }),
                        item.inputId === state.target ? el('span', { class: 'badge light', text: 're-encode' }) : null));
                }
                break;
            case 'converting': {
                const pct = item.progress == null ? '' : ` · ${Math.round(item.progress * 100)}%`;
                row.append(el('div', { class: 'file-line' },
                    el('span', { text: `Converting${pct}` }),
                    item.message ? el('span', { class: 'status-text', text: item.message }) : null));
                const gauge = el('div', { class: 'gauge' + (item.progress == null ? ' indeterminate' : '') }, el('i'));
                if (item.progress != null) gauge.firstChild.style.width = `${item.progress * 100}%`;
                row.append(gauge);
                break;
            }
            case 'done':
                row.append(el('div', { class: 'file-line ok plain' },
                    el('span', { class: 'out-name', text: `${item.result.name} · ${fmtSize(item.result.blob.size)}` }),
                    el('button', { type: 'button', class: 'btn small', onclick: () => download(item.result.blob, item.result.name), text: 'Save' })));
                break;
            case 'error':
                row.append(el('div', { class: 'file-line err plain', text: item.message || 'Conversion failed' }));
                break;
        }
        list.append(row);
    }
}

function renderBrowse() {
    const section = $('#browse');
    section.replaceChildren();
    const show = !state.files.length && state.engines.length > 0;
    section.hidden = !show;
    if (!show) return;

    const engine = state.engines.find((e) => e.domain.id === state.browse) || state.engines[0];
    section.append(el('div', { class: 'strip' }, el('span', { text: `${engine.domain.name} formats` })));
    for (const fmt of engine.formats) {
        section.append(el('div', { class: 'fmt' },
            el('span', { class: 'fmt-name' }, fmt.name, fmt.note ? el('small', { text: fmt.note }) : null),
            el('span', { class: 'fmt-ext', text: fmt.ext.map((e) => `.${e}`).join(' ') }),
            fmt.read ? el('span', { class: 'badge', text: 'read' }) : null,
            fmt.write ? el('span', { class: 'badge green', text: 'write' }) : null,
        ));
    }
    if (engine.loadNote) section.append(el('p', { class: 'footnote', text: engine.loadNote }));
}

function renderTargets() {
    const section = $('#targets');
    section.replaceChildren();
    const items = activeItems();
    section.hidden = !items.length;
    if (!items.length) return;

    section.append(el('div', { class: 'strip' }, el('span', { text: 'Convert to' })));
    const list = targetList();
    if (!list.length) {
        section.append(el('div', { class: 'notice err', text: 'These files have no output format in common. Convert them in separate batches.' }));
        return;
    }
    const groups = new Set(list.map((f) => f.group).filter(Boolean));
    const grid = el('div', { class: 'grid' });
    let lastGroup = null;
    for (const fmt of list) {
        if (groups.size > 1 && fmt.group && fmt.group !== lastGroup) {
            grid.append(el('div', { class: 'grid-group', text: fmt.group }));
            lastGroup = fmt.group;
        }
        const reencode = items.some((i) => i.inputId === fmt.id && targetsFor(i.engine, i.inputId).has(fmt.id));
        const sub = reencode ? 're-encode' : fmt.note || '';
        grid.append(el('button', {
            type: 'button',
            class: 'opt' + (fmt.id === state.target ? ' on' : ''),
            'aria-pressed': fmt.id === state.target ? 'true' : 'false',
            disabled: state.running,
            onclick: () => setTarget(fmt.id),
        }, fmt.name, sub ? el('small', { text: sub }) : null));
    }
    section.append(grid);
}

function renderSettings() {
    const section = $('#settings');
    section.replaceChildren();
    const engine = batchEngine();
    const defs = engine && state.target ? optionDefs(engine, state.target) : [];
    section.hidden = !defs.length;
    if (!defs.length) return;

    section.append(el('div', { class: 'strip' }, el('span', { text: 'Settings' })));
    for (const def of defs) {
        const value = state.opts[def.id];
        const row = el('div', { class: 'row setting' }, el('span', { class: 'label', text: def.label }));
        if (def.type === 'select') {
            const select = el('select', { class: 'select', disabled: state.running, onchange: (e) => setOpt(def, e.target.value) });
            for (const choice of def.choices || []) {
                select.append(el('option', { value: String(choice.value), selected: String(choice.value) === String(value), text: choice.label }));
            }
            row.append(el('span', { class: 'select-wrap' }, select));
        } else if (def.type === 'range') {
            const out = el('output', { text: fmtOpt(def, value) });
            const input = el('input', {
                type: 'range', min: def.min, max: def.max, step: def.step ?? 1, value, disabled: state.running,
                oninput: (e) => { setOpt(def, e.target.value); out.textContent = fmtOpt(def, state.opts[def.id]); },
            });
            row.append(el('span', { class: 'range-wrap' }, input, out));
        } else if (def.type === 'number') {
            row.append(el('input', {
                type: 'number', class: 'number', min: def.min, max: def.max, step: def.step ?? 'any', value, disabled: state.running,
                onchange: (e) => { setOpt(def, e.target.value); e.target.value = state.opts[def.id]; },
            }));
        } else if (def.type === 'toggle') {
            row.append(el('input', {
                type: 'checkbox', class: 'toggle', checked: Boolean(value), disabled: state.running,
                'aria-label': def.label,
                onchange: (e) => setOpt(def, e.target.checked),
            }));
        }
        if (def.help) row.append(el('div', { class: 'help', text: def.help }));
        section.append(row);
    }
}

function renderActions() {
    const box = $('#actions');
    box.replaceChildren();
    const items = activeItems();
    if (!items.length) return;
    const done = items.filter((i) => i.status === 'done');
    const todo = items.filter((i) => i.status === 'ready' || i.status === 'error');

    if (state.running) {
        box.append(
            el('button', { type: 'button', class: 'btn', disabled: true, text: `Converting ${Math.min(state.done + 1, state.total)}/${state.total}` }),
            el('button', { type: 'button', class: 'btn red', onclick: cancel, text: 'Cancel' }),
        );
        return;
    }
    if (done.length) {
        box.append(el('button', {
            type: 'button', class: 'btn', disabled: state.zipping, onclick: saveAll,
            text: state.zipping ? 'Building zip…' : done.length > 1 ? `Save all ${done.length} · zip` : 'Save',
        }));
    }
    if (state.saveError) box.append(el('div', { class: 'notice err', text: state.saveError }));
    if (todo.length) {
        const retry = done.length > 0;
        box.append(el('button', {
            type: 'button',
            class: 'btn' + (retry ? ' gray' : ''),
            disabled: !state.target,
            onclick: convertAll,
            text: state.target
                ? `${retry ? 'Convert remaining' : 'Convert'} ${todo.length} ${todo.length === 1 ? 'file' : 'files'}`
                : 'Choose a format',
        }));
    }
}

function renderNote() {
    const note = $('#note');
    const text = loadNoteText();
    note.hidden = !text;
    note.textContent = text;
}

// ---- input wiring ----------------------------------------------------------

function wire() {
    const picker = $('#picker');
    $('#dropzone').addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => { addFiles(picker.files); picker.value = ''; });
    $('#clear').addEventListener('click', clearAll);

    let dragDepth = 0;
    document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth += 1; document.body.classList.add('dragging'); });
    document.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
    document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
    document.addEventListener('drop', (e) => {
        e.preventDefault();
        dragDepth = 0;
        document.body.classList.remove('dragging');
        if (!state.running && e.dataTransfer) addFiles(e.dataTransfer.files);
    });

    document.addEventListener('paste', (e) => {
        const files = Array.from(e.clipboardData?.files || []);
        if (files.length && !state.running) { e.preventDefault(); addFiles(files); }
    });

    document.addEventListener('keydown', (e) => {
        const tag = (e.target.tagName || '').toLowerCase();
        if (e.key === 'Escape') { cancel(); return; }
        if (e.key === 'Enter' && !['input', 'select', 'textarea', 'button'].includes(tag)) { e.preventDefault(); convertAll(); }
    });
}

// ---- boot ------------------------------------------------------------------

wire();
render();
loadEngines().then(render);

// Handy from the console and for tests.
window.fileConverter = { addFiles, state };
