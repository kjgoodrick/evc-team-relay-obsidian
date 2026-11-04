/** @jest-environment jsdom */
import { PathPermissionsModal } from '../../src/ui/PathPermissionsModal';
import type { App } from 'obsidian';
import type { PathRule, RelayOnPremShareClient, ShareMember } from '../../src/RelayOnPremShareClient';
jest.mock('obsidian', () => {
    const enhance = (el: HTMLElement) => Object.assign(el, {
        empty() { el.replaceChildren(); }, setText(v: string) { el.textContent = v; }, addClass(v: string) { el.classList.add(v); },
        createEl(tag: string, opts: {
            text?: string;
        } = {}) { const child = document.createElement(tag); child.textContent = opts.text ?? ''; el.append(child); return child; },
    });
    class Modal {
        contentEl = enhance(document.createElement('div'));
        close = jest.fn();
    }
    class Setting {
        constructor(private el: HTMLElement) { }
        setName() { return this; }
        setDesc() { return this; }
        add(tag: string, type: string, cb: (c: unknown) => void) {
            const el = document.createElement(tag) as HTMLInputElement;
            if (type)
                el.type = type;
            this.el.append(el);
            const c = { setButtonText(v: string) { el.textContent = v; return c; }, setValue(v: string | boolean) { if (type === 'checkbox')
                    el.checked = Boolean(v);
                else
                    el.value = String(v); return c; }, setPlaceholder(v: string) { el.placeholder = v; return c; }, setDisabled(v: boolean) { el.disabled = v; return c; }, setCta() { return c; }, addOption(v: string, t: string) { (el as unknown as HTMLSelectElement).add(new Option(t, v)); return c; }, onChange(fn: (v: unknown) => void) { el.addEventListener('input', () => fn(type === 'checkbox' ? el.checked : el.value)); return c; }, onClick(fn: () => void) { el.onclick = fn; return c; } };
            cb(c);
            return this;
        }
        addButton(cb: (c: unknown) => void) { return this.add('button', '', cb); }
        addText(cb: (c: unknown) => void) { return this.add('input', 'text', cb); }
        addToggle(cb: (c: unknown) => void) { return this.add('input', 'checkbox', cb); }
        addDropdown(cb: (c: unknown) => void) { return this.add('select', '', cb); }
    }
    return { Modal, Setting, Notice: jest.fn() };
});
const rules: PathRule[] = [{ user_id: 'bob', path: 'Existing.md', recursive: false, permission: 'read' }];
const members = [{ user_id: 'bob', user_email: 'bob@example.invalid' }, { user_id: 'alice', user_email: 'alice@example.invalid' }] as ShareMember[];
async function fixture() {
    const save = jest.fn().mockResolvedValue(undefined);
    const client = { getPathRules: async () => rules.map(rule => ({ ...rule })), setPathRules: save };
    const modal = new PathPermissionsModal({} as App, client as unknown as RelayOnPremShareClient, 'test', members);
    await modal.onOpen();
    const click = (label: string) => [...modal.contentEl.querySelectorAll('button')].find(b => b.textContent === label)!.click();
    const change = (el: HTMLInputElement | HTMLSelectElement, value: string | boolean) => { if (typeof value === 'boolean')
        (el as HTMLInputElement).checked = value;
    else
        el.value = value; el.dispatchEvent(new Event('input')); };
    return { modal, save, click, change };
}
test('removing another rule preserves every field of the unsaved rule', async () => {
    const { modal, save, click, change } = await fixture();
    change(modal.contentEl.querySelector('select')!, 'alice');
    change(modal.contentEl.querySelector('input[type=text]')!, '日本語/long-draft.md');
    change(modal.contentEl.querySelector('input[type=checkbox]')!, false);
    change(modal.contentEl.querySelectorAll('select')[1], 'write');
    click('Remove rule');
    expect(modal.contentEl.querySelector<HTMLInputElement>('input[type=text]')!.value).toBe('日本語/long-draft.md');
    expect(modal.contentEl.querySelector('select')!.value).toBe('alice');
    expect(modal.contentEl.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false);
    expect(modal.contentEl.querySelectorAll('select')[1].value).toBe('write');
    click('Add rule');
    click('Save permissions');
    expect(save).toHaveBeenCalledWith('test', [{ user_id: 'alice', path: '日本語/long-draft.md', recursive: false, permission: 'write' }]);
});
test('adding successive rules does not mutate a previously added rule', async () => {
    const { modal, save, click, change } = await fixture();
    change(modal.contentEl.querySelector('input[type=text]')!, 'First.md');
    click('Add rule');
    expect(modal.contentEl.querySelector<HTMLInputElement>('input[type=text]')!.value).toBe('');
    change(modal.contentEl.querySelector('input[type=text]')!, 'Second.md');
    click('Add rule');
    click('Save permissions');
    expect(save.mock.calls[0][1].map((r: PathRule) => r.path)).toEqual(['Existing.md', 'First.md', 'Second.md']);
});
