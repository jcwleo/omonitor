// Ported from leominal: textareaInputBridge.ts; keep input behavior in sync.
// Keys whose keydown xterm turns into a control sequence; the textarea no longer mirrors the PTY line.
const lineBoundaryKeys = new Set([
    'Enter', 'Escape', 'Tab', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'
]);
/**
 * Makes the browser's own textarea the source of truth for text input.
 *
 * Mobile Korean keyboards do not use composition events: the Apple keyboard sends compatibility
 * jamo via keypress and combines by delete + reinsert; Naver SmartBoard sends a real Backspace and
 * a keypress carrying the full precomposed text. xterm's keypress handler forwards only the first
 * character of a multi-character insert and then drops the accurate `input` event, so characters
 * are lost. The textarea, however, always ends up with the correct text.
 *
 * This bridge attaches in the capture phase on the terminal element (so it runs before xterm's own
 * textarea listeners), stops xterm from sending printable keypress/input text, and instead mirrors
 * every textarea change as backspaces plus the newly inserted tail. Control keys (Enter, arrows,
 * Ctrl/Meta chords, Backspace on an empty textarea) are left to xterm unchanged.
 */
export function installTextareaInputBridge(xterm, send) {
    const { element, textarea } = xterm;
    if (!element || !textarea) {
        throw new TypeError('installTextareaInputBridge requires terminal.open() first');
    }
    return attach(element, textarea, send);
}
function attach(element, textarea, send) {
    let committed = '';
    function reset() {
        committed = '';
        if (textarea.value !== '') {
            textarea.value = '';
        }
    }
    function syncFromTextarea() {
        // WebKit stores a trailing typed space as U+00A0 and turns it back into U+0020 once more text
        // follows; the PTY must only ever see the space the user typed.
        const value = textarea.value.replace(/\u00a0/g, ' ');
        if (value === committed) {
            return;
        }
        const prefix = commonPrefixLength(committed, value);
        const removed = Array.from(committed.slice(prefix)).length;
        committed = value;
        send('\x7f'.repeat(removed) + value.slice(prefix));
    }
    function handleKeyDown(event) {
        if (event.target !== textarea) {
            return;
        }
        if (event.isComposing || event.keyCode === 229 || event.key === 'Process') {
            // IME frame: the text arrives through input events; keep xterm's CompositionHelper out of it.
            event.stopPropagation();
            return;
        }
        if (event.ctrlKey || event.metaKey) {
            // xterm sends the control sequence (and clears the textarea for Ctrl+C); the line restarts.
            reset();
            return;
        }
        if (event.key === 'Backspace') {
            if (textarea.value.length > 0) {
                // Let the browser edit the textarea; the input event mirrors the deletion.
                event.stopPropagation();
            }
            return;
        }
        if (!event.altKey && event.key.length === 1) {
            // Hardware keyboards report a physical keyCode (>= 48) even for IME jamo, which makes xterm
            // send ev.key on keydown and cancel the browser insert (iPad Magic Keyboard: "ㅇ ㅣ" instead
            // of "이"). Let the browser insert into the textarea; the input event mirrors the result.
            event.stopPropagation();
            return;
        }
        if (lineBoundaryKeys.has(event.key) || /^F\d+$/.test(event.key)) {
            reset();
        }
    }
    function handleKeyPress(event) {
        if (event.target !== textarea || event.ctrlKey || event.metaKey) {
            return;
        }
        if (event.charCode || event.which) {
            // Printable text is taken from the textarea instead of the (possibly truncated) keypress.
            event.stopPropagation();
        }
    }
    function handleInput(event) {
        if (event.target !== textarea) {
            return;
        }
        event.stopPropagation();
        syncFromTextarea();
    }
    function handleComposition(event) {
        if (event.target === textarea) {
            event.stopPropagation();
        }
    }
    function handleBlur(event) {
        if (event.target === textarea) {
            // xterm clears the textarea on blur.
            committed = '';
        }
    }
    const listeners = [
        ['keydown', handleKeyDown],
        ['keypress', handleKeyPress],
        ['input', handleInput],
        ['compositionstart', handleComposition],
        ['compositionupdate', handleComposition],
        ['compositionend', handleComposition],
        ['blur', handleBlur]
    ];
    for (const [type, listener] of listeners) {
        element.addEventListener(type, listener, true);
    }
    return {
        reset,
        dispose() {
            for (const [type, listener] of listeners) {
                element.removeEventListener(type, listener, true);
            }
        }
    };
}
function commonPrefixLength(a, b) {
    const limit = Math.min(a.length, b.length);
    let index = 0;
    while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) {
        index += 1;
    }
    // Never split a surrogate pair.
    if (index > 0 && index < limit) {
        const code = a.charCodeAt(index - 1);
        if (code >= 0xd800 && code <= 0xdbff) {
            index -= 1;
        }
    }
    return index;
}
