import * as Y from 'yjs';
import { App } from './obsidian-adapter.mjs';
import { PathPermissionsModal } from '../../src/ui/PathPermissionsModal.ts';
import { ManagedConflictsModal } from '../../src/ui/ManagedConflictsModal.ts';
import { ManagedIndexTransport } from '../../src/client/ManagedIndexTransport.ts';
import { CONFLICTS, diff, makeConflict, rebase, select } from '../../src/client/managedRecovery.ts';
import { prepareRecoveryBackup } from '../../src/ManagedRecoveryBackup.ts';
import { NativeOAuthHandler } from '../../src/auth/NativeOAuthHandler.ts';
import { fixture } from './fixture-network.mjs';
const app = new App(), results = [], errors = [];
const out = () => document.querySelector('#results').textContent = results.join('\n');
const report = text => { results.push(text); out(); };
const error = e => { errors.push(String(e)); document.querySelector('#errors').textContent = errors.join('\n'); };
window.addEventListener('error', e => error(e.message));
window.addEventListener('unhandledrejection', e => error(e.reason));
const originalError = console.error;
console.error = (...args) => { error(args.join(' ')); originalError(...args); };
const viewport = () => { document.querySelector('#viewport').textContent = `${innerWidth}×${innerHeight}; visual ${Math.round(visualViewport?.width ?? 0)}×${Math.round(visualViewport?.height ?? 0)}; ${matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light'}`; };
matchMedia('(prefers-color-scheme:dark)').addEventListener('change', viewport);
window.addEventListener('resize', viewport);
visualViewport?.addEventListener('resize', viewport);
viewport();
const draft = document.querySelector('#draft');
draft.value = localStorage.getItem('relay-mobile-draft') ?? 'Unsaved mobile edit — 日本語 🌿';
draft.oninput = () => localStorage.setItem('relay-mobile-draft', draft.value);
const longPath = 'Projects/' + 'UnbrokenName'.repeat(14) + '/予算 🌿.md';
const members = [{ user_id: 'bob', user_email: 'bob+mobile@example.invalid' }, { user_id: 'alice', user_email: 'alice@example.invalid' }];
const defaults = [{ user_id: 'bob', path: '', recursive: true, permission: 'read' }, { user_id: 'bob', path: longPath, recursive: false, permission: 'none' }];
const client = { async getPathRules() { return JSON.parse(localStorage.getItem('relay-mobile-rules') ?? JSON.stringify(defaults)); }, async setPathRules(id, rules) { localStorage.setItem('relay-mobile-rules', JSON.stringify(rules)); report(`Saved ${rules.length} rules`); } };
const openPermissions = () => { const modal = new PathPermissionsModal(app, client, 'synthetic', members); modal.open(); return modal; };
const r = { id: 'doc-one', type: 'markdown', version: 0 };
let active;
async function scenario(fail = false, short = false) {
    active?.index.destroy();
    active?.doc.destroy();
    const localPath = short ? 'Local.md' : longPath;
    const base = { 'Old.md': r }, local = { [localPath]: r }, server = { 'Server.md': r };
    const doc = new Y.Doc();
    const conflict = makeConflict(diff(base, local), base, local, 'Concurrent folder/file moves; local text must survive.');
    fixture.manifest = { records: server, permissions: {}, activity: {}, owner: true };
    doc.getMap('managed_base_v1').set('snapshot', structuredClone(fixture.manifest));
    doc.getMap('filemeta_v0').set(localPath, r);
    doc.getMap('docs').set(localPath, r.id);
    doc.getMap(CONFLICTS).set(conflict.id, conflict);
    const index = new ManagedIndexTransport(doc, () => ({ endpoint: 'https://fixture.invalid/index', token: 'synthetic' }), () => { }, error);
    const files = {}, textDoc = new Y.Doc();
    textDoc.getText('contents').insert(0, 'Saved CRDT text');
    const capture = async () => ({ files: [{ path: localPath, bytes: new TextEncoder().encode('Original disk bytes').buffer }, { path: 'image.bin', bytes: new Uint8Array([0, 255, 1, 128]).buffer }], documents: [{ id: r.id, text: textDoc.getText('contents').toString(), update: Y.encodeStateAsUpdate(textDoc), unsaved: draft.value }], index: Y.encodeStateAsUpdate(doc) });
    const share = { crdtDoc: doc, _liveProvider: { managedIndex: index }, async resolveManagedConflict(id, choice, reviewed) {
            let path;
            await index.resolve(id, choice, reviewed, async (c, s) => {
                const backup = await prepareRecoveryBackup({ async mkdir() { }, async write(p, v) { if (fail)
                        throw Error('Synthetic backup failure; originals retained'); files[p] = v; }, async writeBinary(p, v) { files[p] = Array.from(new Uint8Array(v)); } }, capture, { choice, conflict: c, server: s });
                path = backup.path;
                return async () => { await backup.verify(); localStorage.setItem('relay-mobile-backup', JSON.stringify(files)); };
            });
            report(`Resolved ${choice}; backup ${Object.keys(files).length} entries; unsaved text retained=${Object.values(files).includes(draft.value)}`);
            return path;
        } };
    active = { doc, index, share, conflict, files, capture };
    return active;
}
async function openConflict(fail) { const s = await scenario(fail); new ManagedConflictsModal(app, s.share).open(); }
document.querySelector('#permissions').onclick = openPermissions;
document.querySelector('#conflict').onclick = () => openConflict(false);
document.querySelector('#fail').onclick = () => openConflict(true);
function measure() {
    const root = document.querySelector('.modal-content') ?? document.documentElement;
    report(`Layout ${innerWidth}×${innerHeight}: scrollWidth=${root.scrollWidth}, clientWidth=${root.clientWidth}; overflow=${root.scrollWidth > root.clientWidth + 1}`);
    const buttons = [...document.querySelectorAll('.modal button')];
    report(`Buttons: ${buttons.map(b => `${b.textContent} ${Math.round(b.getBoundingClientRect().width)}×${Math.round(b.getBoundingClientRect().height)}`).join('; ')}`);
}
document.querySelector('#layout').onclick = measure;
// Also measure with a dialog open without interfering with touch input.
window.addEventListener('resize', () => { if (document.querySelector('.modal'))
    measure(); });
const assert = (value, message) => { if (!value)
    throw Error(message); report('PASS ' + message); };
async function checks() {
    document.querySelectorAll('.modal-container').forEach(e => e.remove());
    document.querySelector('main').inert = false;
    results.length = 0;
    fixture.deny = false;
    assert(rebase(diff({ 'Old.md': r }, { 'Local.md': r }), { 'Old.md': r }, { 'Local.md': r }, { 'Old.md': r }) === 'retry', 'independent move safely rebases');
    assert(rebase(diff({ 'Old.md': r }, { 'Local.md': r }), { 'Old.md': r }, { 'Local.md': r }, { 'Server.md': r }) === 'conflict', 'competing move requires a decision');
    for (const choice of ['server', 'local']) {
        const s = await scenario(false, true);
        await s.share.resolveManagedConflict(s.conflict.id, choice, select(s.index.snapshot.records, s.conflict));
        assert(s.index.conflicts.length === 0, choice + ' choice clears conflict after backup');
        assert(Object.values(s.files).includes(draft.value), choice + ' choice retains unsaved text');
        assert(Object.values(s.files).some(v => Array.isArray(v) && v.join(',') === '0,255,1,128'), choice + ' choice retains binary bytes');
    }
    const s = await scenario(true, true);
    let rejected = false;
    try {
        await s.share.resolveManagedConflict(s.conflict.id, 'server', select(s.index.snapshot.records, s.conflict));
    }
    catch {
        rejected = true;
    }
    assert(rejected && s.index.conflicts.length === 1, 'backup failure retains conflict');
    const backup = await prepareRecoveryBackup({ async mkdir() { }, async write() { }, async writeBinary() { } }, s.capture, {});
    const old = draft.value;
    draft.value += 'late edit';
    let late = false;
    try {
        await backup.verify();
    }
    catch {
        late = true;
    }
    draft.value = old;
    assert(late, 'late edits prevent destructive completion');
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(s.doc));
    assert(restored.getMap(CONFLICTS).size === 1, 'unresolved conflict survives encoded reload');
    restored.destroy();
    fixture.pending = 0;
    let opened = '';
    const oauth = new NativeOAuthHandler('https://fixture.invalid');
    const auth = await oauth.completeOAuthFlow('pocket-id', url => { opened = url; });
    assert(auth.user.id === 'fixture-user' && opened.startsWith('https:') && fixture.pending === 2, 'production SSO handler: WebCrypto PKCE, pending poll, completion');
    oauth.destroy();
    const pm = openPermissions();
    await new Promise(resolve => setTimeout(resolve, 0));
    const field = pm.contentEl.querySelector('input[type=text]');
    field.value = 'Draft/retain-me.md';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    [...pm.contentEl.querySelectorAll('button')].find(b => b.textContent === 'Remove rule').click();
    const kept = pm.contentEl.querySelector('input[type=text]').value === 'Draft/retain-me.md';
    pm.close();
    assert(kept, 'permission draft survives removing another rule');
    measure();
    report(`Completed; runtime errors=${errors.length}; ${navigator.userAgent}`);
    document.querySelector('#notice').textContent = `${results.filter(line => line.startsWith('PASS ')).length} assertions passed; runtime errors=${errors.length}`;
    document.querySelector('#saved').textContent = 'Persisted fixture rules: ' + (await client.getPathRules()).map(rule => rule.path.length > 80 ? '(long-path fixture)' : rule.path || '(whole share)').join('; ');
    localStorage.setItem('relay-mobile-last-results', JSON.stringify({ viewport: [innerWidth, innerHeight], results, errors }));
}
document.querySelector('#checks').onclick = () => checks().catch(error);
report('Ready. Manual touch tests are separate from these assertions.');
let touchMoves = 0;
document.addEventListener('touchmove', () => { touchMoves++; document.querySelector('#telemetry').textContent = 'Touch moves: ' + touchMoves; }, { passive: true });
function telemetry() { const m = document.querySelector('.modal-content'); if (m)
    document.querySelector('#telemetry').textContent = `Dialog overflow: ${m.scrollWidth > m.clientWidth + 1} (${m.scrollWidth}/${m.clientWidth}); touch moves: ${touchMoves}`; }
window.addEventListener('harness-modal', () => { measure(); telemetry(); });
window.addEventListener('resize', telemetry);
