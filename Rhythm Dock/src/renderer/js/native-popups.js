"use strict";

window.DockPopups = (() => {
    let busy = false;
    const locked = () => Boolean(document.querySelector('#container.locked'));
    async function popup(trigger, items) {
        if (busy || locked() || !items.length) return null;
        busy = true;
        const rect = trigger.getBoundingClientRect();
        trigger.setAttribute('aria-expanded', 'true');
        try {
            return await window.api.showNativePopup({x: rect.left, y: rect.bottom, items});
        } catch (error) {
            console.warn('Could not open native popup', error);
            return null;
        } finally {
            busy = false;
            trigger.setAttribute('aria-expanded', 'false');
        }
    }
    async function select(control) {
        if (control.disabled || control.multiple || control.size > 1) return;
        const options = [];
        const items = [];
        for (const child of control.children) {
            if (child.tagName === 'OPTGROUP') {
                items.push({label: child.label, enabled: false});
                options.push(null);
            }
            for (const option of child.tagName === 'OPTION' ? [child] : child.children) {
                if (option.hidden || getComputedStyle(option).display === 'none') continue;
                options.push(option);
                items.push({label: option.label, checked: option.selected,
                    enabled: !option.disabled && !option.closest('optgroup')?.disabled});
            }
        }
        const index = await popup(control, items);
        const option = Number.isInteger(index) ? options[index] : null;
        if (locked() || !control.isConnected || control.disabled || !option || option.disabled ||
            option.closest('optgroup')?.disabled || !control.contains(option)) return;
        if (control.selectedIndex !== option.index) {
            control.selectedIndex = option.index;
            control.dispatchEvent(new Event('input', {bubbles: true}));
            control.dispatchEvent(new Event('change', {bubbles: true}));
        }
    }
    async function menu(element, trigger) {
        const rows = Array.from(element.children).filter(row =>
            !row.hidden && row.style.display !== 'none');
        const items = rows.map(row => {
            if (row.matches('hr, .dropdown-divider')) return {type: 'separator'};
            const actionable = row.matches('button.dropdown-item');
            const label = row.textContent.replace(/\s+/g, ' ').trim();
            const checked = row.getAttribute('aria-checked') ?? row.getAttribute('aria-pressed');
            return {label, enabled: actionable && !row.disabled,
                ...(checked !== null ? {checked: checked === 'true'} :
                    row.classList.contains('active') ? {checked: true} : {})};
        });
        trigger.parentElement?.classList.add('open');
        try {
            const index = await popup(trigger, items);
            const row = Number.isInteger(index) ? rows[index] : null;
            if (!locked() && row?.isConnected && row.matches('button') && !row.disabled) row.click();
        } finally {
            trigger.parentElement?.classList.remove('open');
        }
    }
    // Delegation includes options and selects populated after startup.
    document.addEventListener('pointerdown', event => {
        const control = event.target.closest?.('select');
        if (locked() || !control || control.disabled || control.multiple || control.size > 1 || event.button !== 0) return;
        event.preventDefault();
        control.focus();
        void select(control);
    }, true);
    document.addEventListener('keydown', event => {
        const control = event.target.closest?.('select');
        if (locked() || !control || control.disabled || control.multiple || control.size > 1) return;
        if ([' ', 'Enter', 'F4'].includes(event.key) ||
            (event.altKey && ['ArrowDown', 'ArrowUp'].includes(event.key))) {
            event.preventDefault();
            event.stopPropagation();
            void select(control);
        }
    }, true);
    return {menu};
})();
