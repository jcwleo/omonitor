// Ported from leominal: terminalReportGuards.ts; keep input behavior in sync.
const reportOscIds = [4, 10, 11, 12];
export function installInactiveTerminalReportGuards(terminal, isActive) {
    const disposables = [
        terminal.parser.registerCsiHandler({ final: 'c' }, (params) => shouldSuppressReport(isPrimaryDeviceAttributesRequest(params), isActive)),
        terminal.parser.registerCsiHandler({ prefix: '>', final: 'c' }, (params) => shouldSuppressReport(isPrimaryDeviceAttributesRequest(params), isActive)),
        terminal.parser.registerCsiHandler({ final: 'n' }, (params) => shouldSuppressReport(isDeviceStatusReportRequest(params), isActive)),
        terminal.parser.registerCsiHandler({ prefix: '?', final: 'n' }, (params) => shouldSuppressReport(isPrivateDeviceStatusReportRequest(params), isActive)),
        terminal.parser.registerCsiHandler({ final: 't' }, (params) => shouldSuppressReport(isWindowReportRequest(params), isActive)),
        terminal.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, () => shouldSuppressReport(true, isActive)),
        ...reportOscIds.map((id) => terminal.parser.registerOscHandler(id, (data) => shouldSuppressReport(isOscReportRequest(data), isActive)))
    ];
    return {
        dispose() {
            for (const disposable of disposables) {
                disposable.dispose();
            }
        }
    };
}
function shouldSuppressReport(isReportRequest, isActive) {
    return isReportRequest && !isActive();
}
function isPrimaryDeviceAttributesRequest(params) {
    return firstParam(params) === 0;
}
function isDeviceStatusReportRequest(params) {
    const report = firstParam(params);
    return report === 5 || report === 6;
}
function isPrivateDeviceStatusReportRequest(params) {
    return firstParam(params) === 6;
}
function isWindowReportRequest(params) {
    const report = firstParam(params);
    return report === 14 || report === 16 || report === 18;
}
function isOscReportRequest(data) {
    return data.split(';').some((slot) => slot === '?');
}
function firstParam(params) {
    const first = params[0];
    return typeof first === 'number' ? first : 0;
}
