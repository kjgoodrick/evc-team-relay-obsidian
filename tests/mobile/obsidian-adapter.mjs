// Deliberately small substitute host. Real Obsidian layout/filesystem are tested separately.
export class App {
}
Object.assign(HTMLElement.prototype, {
    empty() { this.replaceChildren(); },
    setText(text) { this.textContent = text; },
    createEl(tag, opts = {}) { const el = document.createElement(tag); el.textContent = opts.text ?? ''; if (opts.cls)
        el.className = opts.cls; this.append(el); return el; },
    addClass(...names) { this.classList.add(...names); },
});
export class Modal {
    constructor(app) {
        this.app = app;
        this.containerEl = document.createElement('div');
        this.containerEl.className = 'modal-container';
        this.modalEl = this.containerEl.createEl('section', { cls: 'modal' });
        this.modalEl.setAttribute('role', 'dialog');
        const close = this.modalEl.createEl('button', { text: 'Close', cls: 'harness-close' });
        close.onclick = () => this.close();
        const nav = this.modalEl.createEl('div', { cls: 'harness-nav' });
        for (const [label, delta] of [['Test: scroll up', -400], ['Test: scroll down', 400]]) {
            const b = nav.createEl('button', { text: label });
            b.onclick = () => this.contentEl.scrollBy({ top: delta });
        }
        this.contentEl = this.modalEl.createEl('div', { cls: 'modal-content' });
    }
    async open() { document.body.append(this.containerEl); document.querySelector('main').inert = true; await this.onOpen?.(); this.modalEl.querySelector('button').focus(); window.dispatchEvent(new Event('harness-modal')); }
    close() { this.onClose?.(); this.containerEl.remove(); document.querySelector('main').inert = false; }
}
export class Notice {
    constructor(text) { const e = document.querySelector('#notice'); e.textContent = text; }
}
class Control {
    constructor(el) { this.el = el; }
    setValue(v) { if (this.el.type === 'checkbox')
        this.el.checked = v;
    else
        this.el.value = v; return this; }
    setPlaceholder(v) { this.el.placeholder = v; return this; }
    onChange(cb) { this.el.addEventListener(this.el.tagName === 'INPUT' && this.el.type !== 'checkbox' ? 'input' : 'change', () => cb(this.el.type === 'checkbox' ? this.el.checked : this.el.value)); return this; }
    addOption(v, t) { this.el.add(new Option(t, v)); return this; }
    setButtonText(v) { this.el.textContent = v; return this; }
    setDisabled(v) { this.el.disabled = v; return this; }
    setCta() { this.el.classList.add('mod-cta'); return this; }
    onClick(cb) { this.el.onclick = cb; return this; }
}
export class Setting {
    constructor(parent) { this.settingEl = parent.createEl('div', { cls: 'setting-item' }); this.info = this.settingEl.createEl('div', { cls: 'setting-item-info' }); this.controlEl = this.settingEl.createEl('div', { cls: 'setting-item-control' }); }
    setName(v) { this.info.createEl('div', { cls: 'setting-item-name', text: v }); return this; }
    setDesc(v) { this.info.createEl('div', { cls: 'setting-item-description', text: v }); return this; }
    add(tag, type, cb) { const el = this.controlEl.createEl(tag); if (type)
        el.type = type; el.setAttribute('aria-label', this.info.querySelector('.setting-item-name')?.textContent || type || tag); cb(new Control(el)); return this; }
    addButton(cb) { return this.add('button', null, cb); }
    addText(cb) { return this.add('input', 'text', cb); }
    addToggle(cb) { return this.add('input', 'checkbox', cb); }
    addDropdown(cb) { return this.add('select', null, cb); }
}
