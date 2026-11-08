import type { OmoChildren } from './omo-children.ts';
import type { SessionIndex } from './sessions.ts';

type HostRequest = (type: string, params: Record<string, unknown>) => Promise<unknown>;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export class OmoMessageError extends Error {
  constructor(message: string, readonly rpcCode = -32000) { super(message); }
}

// Only the parent's task manager can revive a child without losing its task identity and completion notification.
// Never open/attach the child or send a regular prompt to its host routing handle.
export async function sendOmoChild(storage: { readonly children: OmoChildren; readonly index: SessionIndex }, request: HostRequest, params: unknown): Promise<Record<string, unknown>> {
  if (!object(params) || typeof params.threadId !== 'string' || !params.threadId.trim() || typeof params.parentThreadId !== 'string' || !params.parentThreadId.trim() || typeof params.text !== 'string' || !params.text.trim() || params.text.length > 32_000) {
    throw new OmoMessageError('부모·하위 세션 ID와 32,000자 이하의 비어 있지 않은 메시지가 필요합니다', -32602);
  }
  const { threadId, parentThreadId, text } = params;
  let taskId: string | undefined;
  for await (const record of storage.children.records()) {
    if (record.childId === threadId && record.parentId === parentThreadId && await storage.children.childPath(record)) {
      taskId = record.taskId;
      break;
    }
  }
  if (!taskId) throw new OmoMessageError('이 부모 세션에 속한 하위 에이전트를 찾지 못했습니다');

  // Observe all routing handles, including nested task parents; do not put workers into HostBridge's board map.
  const listing = await request('list_sessions', { include_workers: true });
  const parent = object(listing) && Array.isArray(listing.sessions)
    ? listing.sessions.find((row: unknown) => object(row) && row.durableSessionId === parentThreadId && row.status === 'open')
    : undefined;
  let handle: string;
  if (object(parent) && typeof parent.sessionId === 'string') {
    handle = parent.sessionId;
    await request('attach_session', { sessionId: handle, durableSessionId: parentThreadId });
  } else {
    const meta = (await storage.index.list()).find((row) => row.id === parentThreadId);
    if (!meta) throw new OmoMessageError('부모 세션 파일을 찾지 못했습니다');
    const protocol = await request('get_protocol_info', {});
    if (!object(protocol) || !Array.isArray(protocol.capabilities) || !protocol.capabilities.includes('attended')) throw new OmoMessageError('부모 작업을 실행하지 않고 메시지를 보내려면 omo를 업데이트하세요');
    // Sending is explicit, but reopening the owner must not also resume its goal or pending todos.
    const opened = await request('open_session', { sessionPath: meta.path, cwd: meta.cwd, attended: false, retain_on_disconnect: true });
    if (!object(opened) || typeof opened.sessionId !== 'string') throw new OmoMessageError('부모 세션을 준비하지 못했습니다');
    handle = opened.sessionId;
  }
  let result: unknown;
  try {
    result = await request('extension_request', { sessionId: handle, name: 'omo.task.send', data: { to: taskId, message: text } });
  } finally {
    try { await request('release_attachment', { sessionId: handle }); }
    catch (error) { if (!(error instanceof Error)) throw error; console.warn('[omo] 메시지 전송 연결을 해제하지 못했습니다:', error.message); }
  }
  if (!object(result) || typeof result.kind !== 'string') throw new OmoMessageError('omo task 전송 결과를 확인하지 못했습니다. 중복 전송 전에 하위 대화를 확인하세요');
  switch (result.kind) {
    case 'steered': case 'revived': case 'queued': case 'held':
      return { threadId, parentThreadId, ...result };
    case 'uncertain': case 'delivery_uncertain': case 'delivering':
      throw new OmoMessageError('메시지 전달 여부가 아직 확정되지 않았습니다. 다시 보내지 말고 하위 대화를 확인하세요');
    default:
      throw new OmoMessageError(`하위 에이전트에게 메시지를 보내지 못했습니다 (${result.kind}): ${String(result.reason || result.message || result.detail || '')}`);
  }
}
