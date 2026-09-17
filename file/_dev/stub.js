// Fake engine for exercising the UI without any real codecs.
// Loaded only when the page is opened as index.html?stub (see app.js).
export const domain = { id: 'stub', name: 'Stub' };

export const formats = [
    { id: 'txt', name: 'Text', ext: ['txt'], mime: 'text/plain', read: true, write: true, group: 'Plain',
      options: [{ id: 'upper', label: 'Uppercase', type: 'toggle', default: false }] },
    { id: 'md', name: 'Markdown', ext: ['md'], mime: 'text/markdown', read: true, write: true, group: 'Plain' },
    { id: 'json', name: 'JSON', ext: ['json'], mime: 'application/json', read: false, write: true, group: 'Structured', note: 'wraps the text',
      options: [{ id: 'indent', label: 'Indent', type: 'select', default: '2', choices: [{ value: '0', label: 'None' }, { value: '2', label: '2 spaces' }, { value: '4', label: '4 spaces' }] }] },
];

export const options = [
    { id: 'delay', label: 'Fake delay', type: 'range', min: 0, max: 5, step: 0.5, unit: 's', default: 1.5, help: 'How long each pretend conversion takes' },
    { id: 'copies', label: 'Copies', type: 'number', min: 1, max: 9, step: 1, default: 1 },
];

export const loadNote = 'Stub engine: downloads nothing, converts nothing real.';

export function detect(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    return formats.find((f) => f.read && f.ext.includes(ext))?.id ?? null;
}

// Includes the input id itself so the UI's re-encode label gets exercised.
export function targets() {
    return formats.filter((f) => f.write).map((f) => f.id);
}

export async function warmup() {}

export async function convert({ file, outputId, options, onProgress, signal }) {
    const total = (options.delay ?? 1.5) * 1000;
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
        if (signal?.aborted) throw new Error('Cancelled');
        await new Promise((r) => setTimeout(r, total / steps));
        onProgress(i / steps, i === 5 ? 'halfway there' : undefined);
    }
    if (/fail/i.test(file.name)) throw new Error('This file is called "fail", so it failed on purpose.');
    let text = await file.text();
    if (options.upper) text = text.toUpperCase();
    text = text.repeat(Math.max(1, options.copies || 1));
    if (outputId === 'json') text = JSON.stringify({ text }, null, Number(options.indent || 0));
    return { blob: new Blob([text], { type: formats.find((f) => f.id === outputId).mime }) };
}
