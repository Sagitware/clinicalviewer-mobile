/**
 * DICOM Upper Layer protocol for a Storage SCP (PS3.8) with C-STORE and C-ECHO (PS3.7).
 * Pure TypeScript with no React Native imports, so it can be driven by any byte transport.
 */

const VERIFICATION = '1.2.840.10008.1.1';
const STORAGE_PREFIX = '1.2.840.10008.5.1.4.1.1.';
const IMPLICIT_LE = '1.2.840.10008.1.2';
const EXPLICIT_LE = '1.2.840.10008.1.2.1';
/** Uncompressed syntaxes only: the viewer displays these, and every SCU must offer Implicit VR LE. */
const SUPPORTED_SYNTAXES = [EXPLICIT_LE, IMPLICIT_LE];
const APP_CONTEXT = '1.2.840.10008.3.1.1.1';
const IMPLEMENTATION_UID = '1.2.826.0.1.3680043.8.498.1';
const IMPLEMENTATION_VERSION = 'CLINICALVIEW';
const MAX_PDU = 65536;
/** Guards against a peer streaming without end. */
const MAX_OBJECT_BYTES = 512 * 1024 * 1024;

export const Status = {
  Success: 0x0000,
  ProcessingFailure: 0x0110,
  CannotUnderstand: 0xc000,
} as const;

export interface ReceivedObject {
  sopClassUid: string;
  sopInstanceUid: string;
  /** Complete DICOM Part 10 file bytes. */
  file: Uint8Array;
  callingAe: string;
}

export interface ScpHandlers {
  send: (bytes: Uint8Array) => void;
  close: () => void;
  /** Stores one object. Resolve to a DICOM status; reject or throw to answer with a processing failure. */
  onObject: (obj: ReceivedObject) => Promise<number>;
  onAssociation?: (callingAe: string) => void;
  onError?: (error: Error) => void;
}

interface Context {
  abstractSyntax: string;
  transferSyntax: string | null;
}

const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes).replace(/[\0 ]+$/, '').replace(/^ +/, '');

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

class Writer {
  private parts: number[] = [];
  u8(v: number) {
    this.parts.push(v & 0xff);
    return this;
  }
  u16(v: number) {
    return this.u8(v >> 8).u8(v);
  }
  u32(v: number) {
    return this.u16(v >>> 16).u16(v & 0xffff);
  }
  u16le(v: number) {
    return this.u8(v).u8(v >> 8);
  }
  u32le(v: number) {
    return this.u16le(v & 0xffff).u16le(v >>> 16);
  }
  text(s: string, pad = 0) {
    for (let i = 0; i < s.length; i++) this.parts.push(s.charCodeAt(i) & 0xff);
    for (let i = s.length; i < pad; i++) this.parts.push(0x20);
    return this;
  }
  bytes(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.parts.push(b[i]);
    return this;
  }
  done() {
    return Uint8Array.from(this.parts);
  }
}

/** UI values are null-padded to an even length. */
function uiBytes(uid: string): number[] {
  const out = Array.from(uid, (c) => c.charCodeAt(0));
  if (out.length % 2) out.push(0);
  return out;
}

function item(type: number, body: Uint8Array | number[]): Uint8Array {
  return new Writer().u8(type).u8(0).u16(body.length).bytes(body).done();
}

function pdu(type: number, body: Uint8Array): Uint8Array {
  return new Writer().u8(type).u8(0).u32(body.length).bytes(body).done();
}

/** Builds an implicit VR little endian command set with its leading group length element. */
function command(elements: { tag: number; value: number[] }[]): Uint8Array {
  const body = new Writer();
  for (const e of elements) body.u16le(0x0000).u16le(e.tag).u32le(e.value.length).bytes(e.value);
  const payload = body.done();
  return new Writer().u16le(0).u16le(0).u32le(4).u32le(payload.length).bytes(payload).done();
}

const us = (v: number) => [v & 0xff, (v >> 8) & 0xff];

function pData(contextId: number, cmd: Uint8Array): Uint8Array {
  const pdv = new Writer().u32(cmd.length + 2).u8(contextId).u8(0x03).bytes(cmd).done();
  return pdu(0x04, pdv);
}

function parseCommand(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<number, Uint8Array>();
  let p = 0;
  while (p + 8 <= bytes.length) {
    const group = view.getUint16(p, true);
    const element = view.getUint16(p + 2, true);
    const len = view.getUint32(p + 4, true);
    if (p + 8 + len > bytes.length) break;
    out.set(((group << 16) | element) >>> 0, bytes.subarray(p + 8, p + 8 + len));
    p += 8 + len;
  }
  const u16 = (tag: number) => {
    const v = out.get(tag);
    return v && v.length >= 2 ? v[0] | (v[1] << 8) : undefined;
  };
  const uid = (tag: number) => {
    const v = out.get(tag);
    return v ? ascii(v) : '';
  };
  return {
    field: u16(0x00000100),
    messageId: u16(0x00000110),
    dataSetType: u16(0x00000800),
    sopClass: uid(0x00000002),
    sopInstance: uid(0x00001000),
  };
}

/** Wraps a received data set in a Part 10 file: preamble, "DICM", then group 0002 in explicit VR LE. */
export function buildPart10(sopClass: string, sopInstance: string, transferSyntax: string, dataSet: Uint8Array): Uint8Array {
  const el = (element: number, vr: string, value: number[]) => {
    const w = new Writer().u16le(0x0002).u16le(element).text(vr);
    if (vr === 'OB') w.u16le(0).u32le(value.length);
    else w.u16le(value.length);
    return w.bytes(value).done();
  };
  const text = (s: string) => {
    const b = Array.from(s, (c) => c.charCodeAt(0));
    if (b.length % 2) b.push(0x20);
    return b;
  };
  const group = concat([
    el(0x0001, 'OB', [0, 1]),
    el(0x0002, 'UI', uiBytes(sopClass)),
    el(0x0003, 'UI', uiBytes(sopInstance)),
    el(0x0010, 'UI', uiBytes(transferSyntax)),
    el(0x0012, 'UI', uiBytes(IMPLEMENTATION_UID)),
    el(0x0013, 'SH', text(IMPLEMENTATION_VERSION)),
  ]);
  const length = new Writer().u16le(0x0002).u16le(0x0000).text('UL').u16le(4).u32le(group.length).done();
  return concat([new Uint8Array(128), new Uint8Array([0x44, 0x49, 0x43, 0x4d]), length, group, dataSet]);
}

/** One DICOM association. Feed it bytes from the socket; it answers through `send`. */
export class ScpAssociation {
  private buffer: Uint8Array = new Uint8Array(0);
  private contexts = new Map<number, Context>();
  private callingAe = '';
  private associated = false;
  private closed = false;
  private commandParts: Uint8Array[] = [];
  private dataParts: Uint8Array[] = [];
  private dataBytes = 0;
  private current: ReturnType<typeof parseCommand> | null = null;
  private currentContext = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly h: ScpHandlers) {}

  push(chunk: Uint8Array) {
    if (this.closed) return;
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
        if (this.closed) return;
      }
    } catch (e) {
      this.fail(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /** Call when the transport closes. */
  dispose() {
    this.closed = true;
  }

  private handle(type: number, body: Uint8Array) {
    switch (type) {
      case 0x01:
        return this.associate(body);
      case 0x04:
        if (!this.associated) return this.abort();
        return this.pdata(body);
      case 0x05:
        // Finish queued stores before the release response so the SCU sees them complete.
        this.queue = this.queue.then(() => {
          if (this.closed) return;
          this.h.send(pdu(0x06, new Uint8Array(4)));
          this.finish();
        });
        return;
      case 0x07:
        return this.finish();
      default:
        return this.abort();
    }
  }

  private associate(body: Uint8Array) {
    if (body.length < 68) return this.abort();
    this.callingAe = ascii(body.subarray(20, 36));
    const calledRaw = body.subarray(4, 20);
    const callingRaw = body.subarray(20, 36);
    const offered: { id: number; abstract: string; syntaxes: string[] }[] = [];
    let p = 68;
    while (p + 4 <= body.length) {
      const type = body[p];
      const len = (body[p + 2] << 8) | body[p + 3];
      const data = body.subarray(p + 4, p + 4 + len);
      p += 4 + len;
      if (type !== 0x20 || data.length < 4) continue;
      const ctx = { id: data[0], abstract: '', syntaxes: [] as string[] };
      let q = 4;
      while (q + 4 <= data.length) {
        const sub = data[q];
        const subLen = (data[q + 2] << 8) | data[q + 3];
        const text = ascii(data.subarray(q + 4, q + 4 + subLen));
        if (sub === 0x30) ctx.abstract = text;
        else if (sub === 0x40) ctx.syntaxes.push(text);
        q += 4 + subLen;
      }
      offered.push(ctx);
    }

    const results = new Writer();
    let accepted = 0;
    for (const o of offered) {
      const known = o.abstract === VERIFICATION || o.abstract.startsWith(STORAGE_PREFIX);
      const syntax = SUPPORTED_SYNTAXES.find((s) => o.syntaxes.includes(s)) ?? null;
      // 0 accepted, 3 abstract syntax not supported, 4 transfer syntaxes not supported.
      const result = !known ? 3 : !syntax ? 4 : 0;
      if (result === 0) {
        accepted++;
        this.contexts.set(o.id, { abstractSyntax: o.abstract, transferSyntax: syntax });
      }
      const ts = item(0x40, Array.from(syntax ?? IMPLICIT_LE, (c) => c.charCodeAt(0)));
      results.bytes(item(0x21, concat([new Uint8Array([o.id, 0, result, 0]), ts])));
    }

    if (accepted === 0) {
      // A-ASSOCIATE-RJ: permanent rejection by the service user, no reason given.
      this.h.send(pdu(0x03, new Uint8Array([0, 1, 1, 1])));
      return this.finish();
    }

    const userInfo = item(
      0x50,
      concat([
        item(0x51, new Writer().u32(MAX_PDU).done()),
        item(0x52, Array.from(IMPLEMENTATION_UID, (c) => c.charCodeAt(0))),
        item(0x55, Array.from(IMPLEMENTATION_VERSION, (c) => c.charCodeAt(0))),
      ]),
    );
    const response = new Writer()
      .u16(1)
      .u16(0)
      .bytes(calledRaw)
      .bytes(callingRaw)
      .bytes(new Uint8Array(32))
      .bytes(item(0x10, Array.from(APP_CONTEXT, (c) => c.charCodeAt(0))))
      .bytes(results.done())
      .bytes(userInfo)
      .done();
    this.associated = true;
    this.h.send(pdu(0x02, response));
    this.h.onAssociation?.(this.callingAe);
  }

  private pdata(body: Uint8Array) {
    let p = 0;
    while (p + 6 <= body.length) {
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
      const length = view.getUint32(p, false);
      const contextId = body[p + 4];
      const flags = body[p + 5];
      const fragment = body.subarray(p + 6, p + 4 + length);
      p += 4 + length;
      const isCommand = (flags & 1) !== 0;
      const isLast = (flags & 2) !== 0;
      if (isCommand) {
        this.commandParts.push(fragment);
        if (isLast) {
          this.currentContext = contextId;
          this.current = parseCommand(concat(this.commandParts));
          this.commandParts = [];
          this.dataParts = [];
          this.dataBytes = 0;
          this.onCommand();
        }
      } else {
        this.dataParts.push(fragment);
        this.dataBytes += fragment.length;
        if (this.dataBytes > MAX_OBJECT_BYTES) return this.abort();
        if (isLast) this.onDataSet();
      }
    }
  }

  private onCommand() {
    const c = this.current;
    if (!c) return;
    if (c.field === 0x0030) {
      this.respond(0x8030, c.messageId ?? 0, VERIFICATION, '', Status.Success);
      this.current = null;
    } else if (c.field === 0x0001) {
      if (c.dataSetType === 0x0101) {
        this.respond(0x8001, c.messageId ?? 0, c.sopClass, c.sopInstance, Status.CannotUnderstand);
        this.current = null;
      }
    } else {
      this.abort();
    }
  }

  private onDataSet() {
    const c = this.current;
    if (!c || c.field !== 0x0001) return;
    const parts = this.dataParts;
    this.current = null;
    this.dataParts = [];
    this.dataBytes = 0;
    const ctx = this.contexts.get(this.currentContext);
    const syntax = ctx?.transferSyntax ?? IMPLICIT_LE;
    const file = buildPart10(c.sopClass, c.sopInstance, syntax, concat(parts));
    const obj: ReceivedObject = { sopClassUid: c.sopClass, sopInstanceUid: c.sopInstance, file, callingAe: this.callingAe };
    const messageId = c.messageId ?? 0;
    const contextId = this.currentContext;
    this.queue = this.queue.then(async () => {
      let status: number;
      try {
        status = await this.h.onObject(obj);
      } catch (e) {
        this.h.onError?.(e instanceof Error ? e : new Error(String(e)));
        status = Status.ProcessingFailure;
      }
      if (!this.closed) this.respond(0x8001, messageId, c.sopClass, c.sopInstance, status, contextId);
    });
  }

  private respond(field: number, messageId: number, sopClass: string, sopInstance: string, status: number, contextId = this.currentContext) {
    const elements = [
      { tag: 0x0002, value: uiBytes(sopClass) },
      { tag: 0x0100, value: us(field) },
      { tag: 0x0120, value: us(messageId) },
      { tag: 0x0800, value: us(0x0101) },
      { tag: 0x0900, value: us(status) },
    ];
    if (field === 0x8001) elements.push({ tag: 0x1000, value: uiBytes(sopInstance) });
    this.h.send(pData(contextId, command(elements)));
  }

  private abort() {
    if (!this.closed) this.h.send(pdu(0x07, new Uint8Array([0, 0, 2, 0])));
    this.finish();
  }

  private fail(error: Error) {
    this.h.onError?.(error);
    this.abort();
  }

  private finish() {
    if (this.closed) return;
    this.closed = true;
    this.h.close();
  }
}
