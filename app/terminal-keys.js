// Ported from leominal: mobileTerminalKeys.ts; keep input behavior in sync.
const standaloneSequences = {
    escape: '\x1b',
    tab: '\t',
    enter: '\r',
    arrowUp: '\x1b[A',
    arrowDown: '\x1b[B',
    arrowRight: '\x1b[C',
    arrowLeft: '\x1b[D'
};
export function terminalKeySequence(key) {
    return standaloneSequences[key];
}
export function ctrlModifiedData(data) {
    if (!/^[a-z]$/i.test(data)) {
        return null;
    }
    return String.fromCharCode(data.toUpperCase().charCodeAt(0) - 64);
}
export function ctrlArmedOutcome(data) {
    if (data === '' || data.startsWith('\x1b')) {
        // Escape-prefixed data (focus in/out reports, bracketed paste, arrow keys) is not the
        // keystroke the user armed Ctrl for; pass it through without consuming the modifier.
        return { kind: 'passthrough' };
    }
    const modifiedFirst = ctrlModifiedData(data.charAt(0));
    if (modifiedFirst === null) {
        return { kind: 'unmodified' };
    }
    // Mobile IME composition can batch several keystrokes into one data event; Ctrl applies
    // to the first character only ("bd" -> "\x02d" keeps tmux prefix sequences working).
    return { kind: 'modified', data: modifiedFirst + data.slice(1) };
}
