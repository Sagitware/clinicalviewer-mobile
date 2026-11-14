/**
 * DICOM Upper Layer protocol for a query/retrieve SCU (PS3.8): association, C-ECHO, C-FIND and
 * C-GET (PS3.7, PS3.4 Annex C). C-GET returns the images on the same association, so the PACS
 * never has to connect back to the phone. Pure TypeScript, driven by any byte transport.
 */
import {
  APP_CONTEXT,
  EXPLICIT_LE,
  IMPLEMENTATION_UID,
  IMPLEMENTATION_VERSION,
  IMPLICIT_LE,
  MAX_OBJECT_BYTES,
  MAX_PDU,
  VERIFICATION,
  Writer,
  ascii,
  buildPart10,
  command,
  concat,
  item,
  parseCommand,
  pdu,
  uiBytes,
  us,
} from './dicomScpProtocol';

export const STUDY_ROOT_FIND = '1.2.840.10008.5.1.4.1.2.2.1';
export const STUDY_ROOT_GET = '1.2.840.10008.5.1.4.1.2.2.3';

/** Image storage classes the viewer can show, offered for C-GET sub-operations (SCP role). */
export const IMAGE_STORAGE_CLASSES = [
  '1.2.840.10008.5.1.4.1.1.1', // CR
  '1.2.840.10008.5.1.4.1.1.1.1', // DX for presentation
  '1.2.840.10008.5.1.4.1.1.1.1.1', // DX for processing
  '1.2.840.10008.5.1.4.1.1.1.2', // Mammography for presentation
  '1.2.840.10008.5.1.4.1.1.1.2.1', // Mammography for processing
  '1.2.840.10008.5.1.4.1.1.1.3', // Intra-oral for presentation
  '1.2.840.10008.5.1.4.1.1.1.3.1', // Intra-oral for processing
  '1.2.840.10008.5.1.4.1.1.2', // CT
  '1.2.840.10008.5.1.4.1.1.2.1', // Enhanced CT
  '1.2.840.10008.5.1.4.1.1.3.1', // US multi-frame
  '1.2.840.10008.5.1.4.1.1.4', // MR
  '1.2.840.10008.5.1.4.1.1.4.1', // Enhanced MR
  '1.2.840.10008.5.1.4.1.1.6.1', // US
  '1.2.840.10008.5.1.4.1.1.7', // Secondary capture
  '1.2.840.10008.5.1.4.1.1.7.1', // Multi-frame single bit SC
  '1.2.840.10008.5.1.4.1.1.7.2', // Multi-frame grayscale byte SC
  '1.2.840.10008.5.1.4.1.1.7.3', // Multi-frame grayscale word SC
  '1.2.840.10008.5.1.4.1.1.7.4', // Multi-frame true color SC
  '1.2.840.10008.5.1.4.1.1.12.1', // XA
  '1.2.840.10008.5.1.4.1.1.12.1.1', // Enhanced XA
  '1.2.840.10008.5.1.4.1.1.12.2', // RF
  '1.2.840.10008.5.1.4.1.1.12.2.1', // Enhanced XRF
  '1.2.840.10008.5.1.4.1.1.20', // NM
  '1.2.840.10008.5.1.4.1.1.77.1.4', // VL photographic
  '1.2.840.10008.5.1.4.1.1.77.1.5.1', // Ophthalmic photography 8 bit
  '1.2.840.10008.5.1.4.1.1.128', // PET
  '1.2.840.10008.5.1.4.1.1.130', // Enhanced PET
  '1.2.840.10008.5.1.4.1.1.481.1', // RT image
];

const Field = {
  CStoreRq: 0x0001,
  CStoreRsp: 0x8001,
  CGetRq: 0x0010,
  CGetRsp: 0x8010,
  CFindRq: 0x0020,
  CFindRsp: 0x8020,
  CEchoRq: 0x0030,
  CEchoRsp: 0x8030,
  CCancelRq: 0x0fff,
} as const;

const NO_DATA_SET = 0x0101;
const isPending = (status: number) => status === 0xff00 || status === 0xff01;

export interface ProposedContext {
  abstractSyntax: string;
  transferSyntaxes: string[];
  /** Ask to act as SCP for this class (C-STORE sub-operations of a C-GET). */
  scpRole?: boolean;
}

export interface AssociateOptions {
  callingAe: string;
  calledAe: string;
  contexts: ProposedContext[];
}

export interface ScuTransport {
  send: (bytes: Uint8Array) => void;
  close: () => void;
}

/** A query key: tag (group << 16 | element), value, and whether it is a UID (null padded). */
export type QueryKey = [tag: number, value: string, uid?: boolean];

export interface RetrieveProgress {
  received: number;
  remaining?: number;
  failed?: number;
}

export interface RetrieveResult {
  files: Uint8Array[];
  failed: number;
  warning: number;
  /** Final C-GET status. */
  status: number;
}

interface DimseMessage {
  contextId: number;
  cmd: ReturnType<typeof parseCommand>;
  data?: Uint8Array;
}

type AssocEvent =
  | { kind: 'accepted' }
  | { kind: 'rejected'; message: string }
  | { kind: 'message'; message: DimseMessage }
  | { kind: 'released' }
  | { kind: 'aborted'; message: string };

export class DimseError extends Error {}

export class ScuAssociation {
  private buffer: Uint8Array = new Uint8Array(0);
  private events: AssocEvent[] = [];
  private wake: (() => void) | null = null;
  private ended: string | null = null;
  private peerMaxPdu = 0;
  private proposed = new Map<number, string>();
  /** Accepted presentation contexts: id → abstract and transfer syntax. */
  private accepted = new Map<number, { abstractSyntax: string; transferSyntax: string }>();
  private commandParts: Uint8Array[] = [];
  private dataParts: Uint8Array[] = [];
  private dataBytes = 0;
  private pending: { contextId: number; cmd: ReturnType<typeof parseCommand> } | null = null;
  private nextMessageId = 1;

  constructor(private readonly t: ScuTransport) {}

  /** Feed bytes from the socket. */
  push(chunk: Uint8Array) {
    if (this.ended) return;
    this.buffer = this.buffer.length ? concat([this.buffer, chunk]) : chunk;
    try {
      while (this.buffer.length >= 6) {
        const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
        const length = view.getUint32(2, false);
        if (this.buffer.length < 6 + length) break;
        const type = this.buffer[0];
        const body = this.buffer.subarray(6, 6 + length);
        this.buffer = this.buffer.subarray(6 + length);
        this.handle(type, body);
      }
    } catch (e) {
      this.abort(e instanceof Error ? e.message : String(e));
    }
  }

  /** Call when the transport closes or fails. */
  transportClosed(reason = 'The connection to the server closed unexpectedly.') {
    this.emit({ kind: 'aborted', message: reason });
    this.ended ??= reason;
  }

  async associate(opts: AssociateOptions): Promise<void> {
    const contexts = new Writer();
    const roles = new Writer();
    opts.contexts.forEach((c, i) => {
      const id = i * 2 + 1;
      this.proposed.set(id, c.abstractSyntax);
      const syntaxes = c.transferSyntaxes.map((ts) => item(0x40, Array.from(ts, (ch) => ch.charCodeAt(0))));
      contexts.bytes(item(0x20, concat([new Uint8Array([id, 0, 0, 0]), item(0x30, Array.from(c.abstractSyntax, (ch) => ch.charCodeAt(0))), ...syntaxes])));
      if (c.scpRole) {
        roles.bytes(item(0x54, new Writer().u16(c.abstractSyntax.length).text(c.abstractSyntax).u8(0).u8(1).done()));
      }
    });
    const userInfo = item(
      0x50,
      concat([
        item(0x51, new Writer().u32(MAX_PDU).done()),
        item(0x52, Array.from(IMPLEMENTATION_UID, (c) => c.charCodeAt(0))),
        item(0x55, Array.from(IMPLEMENTATION_VERSION, (c) => c.charCodeAt(0))),
        roles.done(),
      ]),
    );
    const body = new Writer()
      .u16(1)
      .u16(0)
      .text(aeTitle(opts.calledAe), 16)
      .text(aeTitle(opts.callingAe), 16)
      .bytes(new Uint8Array(32))
      .bytes(item(0x10, Array.from(APP_CONTEXT, (c) => c.charCodeAt(0))))
      .bytes(contexts.done())
      .bytes(userInfo)
      .done();
    this.t.send(pdu(0x01, body));

    const ev = await this.next();
    if (ev.kind === 'rejected' || ev.kind === 'aborted') throw new DimseError(ev.message);
    if (ev.kind !== 'accepted') throw new DimseError('The server answered the connection request unexpectedly.');
  }

  /** Accepted context id for an abstract syntax, or null. */
  contextFor(abstractSyntax: string): number | null {
    for (const [id, c] of this.accepted) if (c.abstractSyntax === abstractSyntax) return id;
    return null;
  }

  async echo(): Promise<void> {
    const ctx = this.require(VERIFICATION, 'Verification (C-ECHO)');
    const id = this.messageId();
    this.sendMessage(ctx, [
      { tag: 0x0002, value: uiBytes(VERIFICATION) },
      { tag: 0x0100, value: us(Field.CEchoRq) },
      { tag: 0x0110, value: us(id) },
      { tag: 0x0800, value: us(NO_DATA_SET) },
    ]);
    const { cmd } = await this.response(Field.CEchoRsp);
    if (cmd.status !== 0) throw statusError('C-ECHO', cmd);
  }

  /** C-FIND at study root. Stops the search with C-CANCEL once `limit` matches arrive. */
  async find(keys: QueryKey[], limit: number): Promise<Uint8Array[]> {
    const ctx = this.require(STUDY_ROOT_FIND, 'Study Root Query (C-FIND)');
    const id = this.messageId();
    this.sendMessage(ctx, requestCommand(STUDY_ROOT_FIND, Field.CFindRq, id), encodeIdentifier(keys));
    const results: Uint8Array[] = [];
    let cancelled = false;
    for (;;) {
      const { cmd, data } = await this.response(Field.CFindRsp);
      const status = cmd.status ?? 0xffff;
      if (isPending(status)) {
        if (data && results.length < limit) results.push(data);
        if (results.length >= limit && !cancelled) {
          cancelled = true;
          this.sendMessage(ctx, [
            { tag: 0x0100, value: us(Field.CCancelRq) },
            { tag: 0x0120, value: us(id) },
            { tag: 0x0800, value: us(NO_DATA_SET) },
          ]);
        }
        continue;
      }
      // 0xFE00: matching stopped because we cancelled.
      if (status === 0 || status === 0xfe00) return results;
      throw statusError('C-FIND', cmd);
    }
  }

  /** C-GET at study root; the server stores each instance back to us on this association. */
  async get(keys: QueryKey[], onProgress?: (p: RetrieveProgress) => void): Promise<RetrieveResult> {
    const ctx = this.require(STUDY_ROOT_GET, 'Study Root Retrieve (C-GET)');
    const id = this.messageId();
    this.sendMessage(ctx, requestCommand(STUDY_ROOT_GET, Field.CGetRq, id), encodeIdentifier(keys));
    const files: Uint8Array[] = [];
    for (;;) {
      const ev = await this.next();
      if (ev.kind !== 'message') throw new DimseError(eventError(ev));
      const { cmd, data, contextId } = ev.message;
      if (cmd.field === Field.CStoreRq) {
        const syntax = this.accepted.get(contextId)?.transferSyntax ?? IMPLICIT_LE;
        let status = 0;
        if (data) files.push(buildPart10(cmd.sopClass, cmd.sopInstance, syntax, data));
        else status = 0xc000;
        this.sendMessage(contextId, [
          { tag: 0x0002, value: uiBytes(cmd.sopClass) },
          { tag: 0x0100, value: us(Field.CStoreRsp) },
          { tag: 0x0120, value: us(cmd.messageId ?? 0) },
          { tag: 0x0800, value: us(NO_DATA_SET) },
          { tag: 0x0900, value: us(status) },
          { tag: 0x1000, value: uiBytes(cmd.sopInstance) },
        ]);
        onProgress?.({ received: files.length });
        continue;
      }
      if (cmd.field !== Field.CGetRsp) throw new DimseError(`Unexpected DICOM message (command 0x${(cmd.field ?? 0).toString(16)}).`);
      const status = cmd.status ?? 0xffff;
      if (isPending(status)) {
        onProgress?.({ received: files.length, remaining: cmd.remaining, failed: cmd.failed });
        continue;
      }
      // 0x0000 success, 0xB000 some sub-operations failed, 0xA702 none could be sent: report what arrived.
      if (status === 0 || status === 0xb000 || status === 0xa702 || files.length > 0) {
        return { files, failed: cmd.failed ?? 0, warning: cmd.warning ?? 0, status };
      }
      throw statusError('C-GET', cmd);
    }
  }

  /** Graceful A-RELEASE; falls back to closing if the server does not answer. */
  async release(): Promise<void> {
    if (this.ended) return;
    this.t.send(pdu(0x05, new Uint8Array(4)));
    try {
      await this.next();
    } finally {
      this.finish('Released');
    }
  }

  abort(message: string) {
    if (!this.ended) this.t.send(pdu(0x07, new Uint8Array([0, 0, 0, 0])));
    this.emit({ kind: 'aborted', message });
    this.finish(message);
  }

  private require(abstractSyntax: string, label: string): number {
    const id = this.contextFor(abstractSyntax);
    if (id == null) throw new DimseError(`The server does not support ${label}.`);
    return id;
  }

  private messageId() {
    const id = this.nextMessageId;
    this.nextMessageId = (this.nextMessageId % 0xffff) + 1;
    return id;
  }

  private async response(field: number): Promise<DimseMessage> {
    const ev = await this.next();
    if (ev.kind !== 'message') throw new DimseError(eventError(ev));
    if (ev.message.cmd.field !== field) throw new DimseError(`Unexpected DICOM message (command 0x${(ev.message.cmd.field ?? 0).toString(16)}).`);
    return ev.message;
  }

  private next(): Promise<AssocEvent> {
    const ev = this.events.shift();
    if (ev) return Promise.resolve(ev);
    if (this.ended) return Promise.resolve({ kind: 'aborted', message: this.ended });
    return new Promise((resolve) => {
      this.wake = () => {
        this.wake = null;
        resolve(this.events.shift() ?? { kind: 'aborted', message: this.ended ?? 'Connection closed.' });
      };
    });
  }

  private emit(ev: AssocEvent) {
    if (this.ended) return;
    this.events.push(ev);
    this.wake?.();
  }

  private finish(reason: string) {
    if (this.ended) return;
    this.ended = reason;
    this.wake?.();
    this.t.close();
  }

  /** Sends a command (and optional data set), split to fit the server's maximum PDU size. */
  private sendMessage(contextId: number, elements: { tag: number; value: number[] }[], data?: Uint8Array) {
    const cmd = command(elements.map((e) => (e.tag === 0x0800 && data ? { tag: 0x0800, value: us(0x0000) } : e)));
    this.sendFragments(contextId, cmd, true);
    if (data) this.sendFragments(contextId, data, false);
  }

  private sendFragments(contextId: number, bytes: Uint8Array, isCommand: boolean) {
    const max = this.peerMaxPdu > 12 ? this.peerMaxPdu - 6 : MAX_PDU - 6;
    let offset = 0;
    do {
      const fragment = bytes.subarray(offset, offset + max);
      offset += fragment.length;
      const flags = (isCommand ? 1 : 0) | (offset >= bytes.length ? 2 : 0);
      this.t.send(pdu(0x04, new Writer().u32(fragment.length + 2).u8(contextId).u8(flags).bytes(fragment).done()));
    } while (offset < bytes.length);
  }

  private handle(type: number, body: Uint8Array) {
    switch (type) {
      case 0x02:
        this.onAccept(body);
        return this.emit({ kind: 'accepted' });
      case 0x03:
        this.emit({ kind: 'rejected', message: rejectMessage(body) });
        return this.finish('Rejected');
      case 0x04:
        return this.pdata(body);
      case 0x05:
        // The server wants to release first: agree and stop.
        this.t.send(pdu(0x06, new Uint8Array(4)));
        this.emit({ kind: 'aborted', message: 'The server ended the connection.' });
        return this.finish('Released by server');
      case 0x06:
        this.emit({ kind: 'released' });
        return this.finish('Released');
      case 0x07:
        this.emit({ kind: 'aborted', message: 'The server aborted the connection.' });
        return this.finish('Aborted by server');
      default:
        return this.abort(`Unexpected PDU type 0x${type.toString(16)} from the server.`);
    }
  }

  private onAccept(body: Uint8Array) {
    let p = 68;
    while (p + 4 <= body.length) {
      const type = body[p];
      const len = (body[p + 2] << 8) | body[p + 3];
      const data = body.subarray(p + 4, p + 4 + len);
      p += 4 + len;
      if (type === 0x21 && data.length >= 4) {
        const id = data[0];
        const result = data[2];
        const abstractSyntax = this.proposed.get(id);
        let transferSyntax = IMPLICIT_LE;
        if (data.length >= 8 && data[4] === 0x40) transferSyntax = ascii(data.subarray(8, 8 + ((data[6] << 8) | data[7])));
        if (result === 0 && abstractSyntax) this.accepted.set(id, { abstractSyntax, transferSyntax });
      } else if (type === 0x50) {
        let q = 0;
        while (q + 4 <= data.length) {
          const sub = data[q];
          const subLen = (data[q + 2] << 8) | data[q + 3];
          if (sub === 0x51 && subLen === 4) {
            this.peerMaxPdu = new DataView(data.buffer, data.byteOffset + q + 4, 4).getUint32(0, false);
          }
          q += 4 + subLen;
        }
      }
    }
  }

  private pdata(body: Uint8Array) {
    let p = 0;
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    while (p + 6 <= body.length) {
      const length = view.getUint32(p, false);
      const contextId = body[p + 4];
      const flags = body[p + 5];
      const fragment = body.subarray(p + 6, p + 4 + length);
      p += 4 + length;
      const isLast = (flags & 2) !== 0;
      if (flags & 1) {
        this.commandParts.push(fragment);
        if (!isLast) continue;
        const cmd = parseCommand(concat(this.commandParts));
        this.commandParts = [];
        if (cmd.dataSetType === NO_DATA_SET) this.emit({ kind: 'message', message: { contextId, cmd } });
        else {
          this.pending = { contextId, cmd };
          this.dataParts = [];
          this.dataBytes = 0;
        }
      } else {
        this.dataParts.push(fragment);
        this.dataBytes += fragment.length;
        if (this.dataBytes > MAX_OBJECT_BYTES) return this.abort('An image from the server is too large to load.');
        if (isLast && this.pending) {
          const { contextId: ctx, cmd } = this.pending;
          this.pending = null;
          const data = concat(this.dataParts);
          this.dataParts = [];
          this.dataBytes = 0;
          this.emit({ kind: 'message', message: { contextId: ctx, cmd, data } });
        }
      }
    }
  }
}

/** Every SCP must accept Implicit VR Little Endian, so queries are always encoded in it. */
export const QUERY_SYNTAXES = [IMPLICIT_LE];
/** Uncompressed only: the viewer decodes these, so the PACS has to transcode anything else. */
export const IMAGE_SYNTAXES = [EXPLICIT_LE, IMPLICIT_LE];

function requestCommand(sopClass: string, field: number, id: number) {
  return [
    { tag: 0x0002, value: uiBytes(sopClass) },
    { tag: 0x0100, value: us(field) },
    { tag: 0x0110, value: us(id) },
    { tag: 0x0700, value: us(0) }, // medium priority
    { tag: 0x0800, value: us(0x0000) }, // a data set follows
  ];
}

/** Implicit VR little endian data set, elements in ascending tag order. */
export function encodeIdentifier(keys: QueryKey[]): Uint8Array {
  const w = new Writer();
  for (const [tag, value, uid] of [...keys].sort((a, b) => a[0] - b[0])) {
    const bytes = utf8(value);
    if (bytes.length % 2) bytes.push(uid ? 0 : 0x20);
    w.u16le(tag >>> 16).u16le(tag & 0xffff).u32le(bytes.length).bytes(bytes);
  }
  return w.done();
}

function utf8(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

/** AE titles are up to 16 characters of plain ASCII. */
function aeTitle(ae: string): string {
  return ae.trim().slice(0, 16);
}

function eventError(ev: AssocEvent): string {
  if (ev.kind === 'aborted' || ev.kind === 'rejected') return ev.message;
  return 'The server answered unexpectedly.';
}

function statusError(op: string, cmd: ReturnType<typeof parseCommand>): DimseError {
  const status = cmd.status ?? 0xffff;
  const hex = `0x${status.toString(16).toUpperCase().padStart(4, '0')}`;
  const known: Record<number, string> = {
    0xa700: 'the server is out of resources',
    0xa701: 'the server is out of resources (could not count matches)',
    0xa702: 'the server is out of resources (could not send images)',
    0xa900: 'the request did not match what the server supports',
    0xc000: 'the server could not process the request',
  };
  const detail = known[status] ?? (status >= 0xc000 ? 'the server could not process the request' : 'the request failed');
  return new DimseError(`${op} failed: ${detail} (${hex})${cmd.errorComment ? `: ${cmd.errorComment}` : ''}.`);
}

function rejectMessage(body: Uint8Array): string {
  const source = body[2];
  const reason = body[3];
  if (source === 1) {
    if (reason === 3) return 'The server does not accept this device’s AE title. Add it on the PACS, or change “This device’s AE title”.';
    if (reason === 7) return 'The server does not recognize its AE title. Check “Server AE title”.';
    if (reason === 2) return 'The server rejected the DICOM application context.';
    return 'The server rejected the connection.';
  }
  if (source === 3 && (reason === 1 || reason === 2)) return 'The server is busy or not accepting connections right now.';
  return 'The server rejected the connection.';
}
