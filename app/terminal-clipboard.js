// Ported from leominal: terminalClipboard.ts; keep input behavior in sync.
export function installTerminalClipboard(xterm) {
    xterm.attachCustomKeyEventHandler((event) => {
        if (!isTerminalCopyShortcut(event)) {
            return true;
        }
        const selection = readSelection(xterm);
        if (!selection) {
            return true;
        }
        event.preventDefault();
        event.stopPropagation();
        void writeClipboardText(selection);
        return false;
    });
    const element = xterm.element;
    if (!element) {
        return {
            dispose() {
                xterm.attachCustomKeyEventHandler(() => true);
            }
        };
    }
    const handleCopy = (event) => {
        const selection = readSelection(xterm);
        if (!selection) {
            return;
        }
        if (event.clipboardData) {
            event.clipboardData.setData('text/plain', selection);
            event.preventDefault();
            return;
        }
        event.preventDefault();
        void writeClipboardText(selection);
    };
    const handlePaste = (event) => {
        const text = event.clipboardData?.getData('text/plain');
        if (text === undefined) {
            return;
        }
        const safeText = stripTerminalExecutingTrailingLineBreaks(text);
        if (safeText === text) {
            return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        xterm.paste(safeText);
    };
    element.addEventListener('copy', handleCopy, true);
    element.addEventListener('paste', handlePaste, true);
    return {
        dispose() {
            element.removeEventListener('copy', handleCopy, true);
            element.removeEventListener('paste', handlePaste, true);
            xterm.attachCustomKeyEventHandler(() => true);
        }
    };
}
function isTerminalCopyShortcut(event) {
    if (event.type !== 'keydown' || event.altKey) {
        return false;
    }
    if (event.key.toLowerCase() !== 'c') {
        return false;
    }
    if (event.metaKey && !event.ctrlKey && !event.shiftKey) {
        return true;
    }
    return event.ctrlKey && event.shiftKey && !event.metaKey;
}
function readSelection(xterm) {
    if (!xterm.hasSelection()) {
        return '';
    }
    return xterm.getSelection();
}
export function stripTerminalExecutingTrailingLineBreaks(text) {
    return text.replace(/(?:\r\n|\r|\n)+$/, '');
}
async function writeClipboardText(text) {
    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return;
        }
        catch {
            // Fall back below for non-secure origins or clipboard permission failures.
        }
    }
    copyViaTemporaryTextArea(text);
}
function copyViaTemporaryTextArea(text) {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    try {
        if (typeof document.execCommand === 'function') {
            document.execCommand('copy');
        }
    }
    finally {
        textarea.remove();
        previousFocus?.focus({ preventScroll: true });
    }
}
