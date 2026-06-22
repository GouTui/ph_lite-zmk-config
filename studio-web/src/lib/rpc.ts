import { load, Type } from "protobufjs";
import {
  RpcTransport,
  createFramedReader,
  createFramedWriter,
} from "./transport";

type PlainObject = Record<string, any>;

export type LockState =
  | "ZMK_STUDIO_CORE_LOCK_STATE_LOCKED"
  | "ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED"
  | string;

export interface DeviceInfo {
  name?: string;
  serialNumber?: Uint8Array | number[] | string;
}

export interface HsbColor {
  h: number;
  s: number;
  b: number;
}

export interface RgbUnderglowState {
  on: boolean;
  color?: HsbColor;
  effect: number;
  speed: number;
  effectCount: number;
  effectNames: string[];
}

export interface LowBatteryIndicatorState {
  enabled: boolean;
  color: number;
  keyPosition: number;
  periodMs: number;
  thresholdPct: number;
  flashDurationMs: number;
}

export interface PowerSettingsState {
  idleTimeoutMs: number;
  sleepTimeoutMs: number;
}

export interface Snapshot {
  deviceInfo?: DeviceInfo;
  lockState?: LockState;
  rgb?: RgbUnderglowState;
  lowBattery?: LowBatteryIndicatorState;
  power?: PowerSettingsState;
}

interface ProtocolBundle {
  requestType: Type;
  responseType: Type;
}

let protocolPromise: Promise<ProtocolBundle> | null = null;

function getProtocolPath() {
  return `${import.meta.env.BASE_URL}proto/zmk/studio.proto`;
}

function wrapProtocolLoadError(error: unknown, protoPath: string) {
  if (error instanceof Error && error.message === "status 404") {
    return new Error(
      `页面协议文件加载失败：${protoPath} 返回 404。请强制刷新页面后重试，确认 Pages 已部署最新版本。`,
    );
  }

  return error;
}

async function loadProtocol() {
  if (!protocolPromise) {
    const protoPath = getProtocolPath();

    protocolPromise = load(protoPath)
      .then((root) => ({
        requestType: root.lookupType("zmk.studio.Request"),
        responseType: root.lookupType("zmk.studio.Response"),
      }))
      .catch((error) => {
        protocolPromise = null;
        throw wrapProtocolLoadError(error, protoPath);
      });
  }

  return protocolPromise;
}

export class RpcMetaError extends Error {
  readonly condition: string;

  constructor(condition: string) {
    super(`RPC returned ${condition}`);
    this.condition = condition;
    Object.setPrototypeOf(this, RpcMetaError.prototype);
  }
}

export class RpcNoResponseError extends Error {
  constructor() {
    super("Keyboard did not return an RPC response.");
    Object.setPrototypeOf(this, RpcNoResponseError.prototype);
  }
}

export class RpcClient {
  private readonly transport: RpcTransport;
  private readonly requestType: Type;
  private readonly responseType: Type;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly responseReader: ReadableStreamDefaultReader<Uint8Array>;
  private pending:
    | {
        requestId: number;
        resolve: (value: PlainObject) => void;
        reject: (reason?: unknown) => void;
      }
    | undefined;
  private requestId = 0;
  private requestChain: Promise<unknown> = Promise.resolve();
  private closed = false;

  onDisconnect?: (reason?: unknown) => void;

  static async connect(transport: RpcTransport) {
    const protocol = await loadProtocol();
    return new RpcClient(transport, protocol.requestType, protocol.responseType);
  }

  private constructor(
    transport: RpcTransport,
    requestType: Type,
    responseType: Type,
  ) {
    this.transport = transport;
    this.requestType = requestType;
    this.responseType = responseType;
    this.writer = createFramedWriter(transport);
    this.responseReader = createFramedReader(transport).getReader();
    void this.pumpResponses();
  }

  get label() {
    return this.transport.label;
  }

  async disconnect() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.pending?.reject(new Error("Disconnected"));
    this.pending = undefined;

    try {
      await this.writer.close();
    } catch {
      // Ignore transport shutdown errors.
    }

    this.transport.abortController.abort("disconnect");
  }

  async loadSnapshot(): Promise<Snapshot> {
    const device = await this.callRpc({ core: { getDeviceInfo: true } });
    const lock = await this.callRpc({ core: { getLockState: true } });
    const rgb = await this.callRpc({ lighting: { getRgbUnderglowState: true } });
    const lowBattery = await this.callRpc({
      lighting: { getLowBatteryIndicator: true },
    });
    const power = await this.callRpc({ core: { getPowerSettings: true } });

    return {
      deviceInfo: device.core?.getDeviceInfo as DeviceInfo | undefined,
      lockState: lock.core?.getLockState as LockState | undefined,
      rgb: rgb.lighting?.getRgbUnderglowState as RgbUnderglowState | undefined,
      lowBattery: lowBattery.lighting
        ?.getLowBatteryIndicator as LowBatteryIndicatorState | undefined,
      power: power.core?.getPowerSettings as PowerSettingsState | undefined,
    };
  }

  async callRpc(payload: PlainObject) {
    const next = this.requestChain.then(() => this.performRpc(payload));
    this.requestChain = next.catch(() => undefined);
    return next;
  }

  private async performRpc(payload: PlainObject) {
    if (this.closed) {
      throw new Error("Keyboard connection is closed.");
    }

    const requestId = this.requestId;
    this.requestId += 1;

    const request = this.requestType.create({
      requestId,
      ...payload,
    });
    const encoded = this.requestType.encode(request).finish();

    const responsePromise = new Promise<PlainObject>((resolve, reject) => {
      this.pending = { requestId, resolve, reject };
    });

    await this.writer.write(encoded);
    const response = await responsePromise;

    const meta = response.meta as PlainObject | undefined;
    if (meta?.noResponse) {
      throw new RpcNoResponseError();
    }
    if (typeof meta?.simpleError === "string") {
      throw new RpcMetaError(meta.simpleError);
    }

    return response;
  }

  private async pumpResponses() {
    try {
      while (!this.closed) {
        const { done, value } = await this.responseReader.read();
        if (done) {
          break;
        }
        if (!value) {
          continue;
        }

        const decoded = this.responseType.decode(value);
        const plain = this.responseType.toObject(decoded, {
          longs: Number,
          enums: String,
          defaults: false,
        }) as PlainObject;
        const requestResponse = plain.requestResponse as PlainObject | undefined;
        if (!requestResponse) {
          continue;
        }

        const requestId = requestResponse.requestId;
        if (
          this.pending &&
          typeof requestId === "number" &&
          requestId === this.pending.requestId
        ) {
          this.pending.resolve(requestResponse);
          this.pending = undefined;
        }
      }
    } catch (error) {
      this.pending?.reject(error);
      this.pending = undefined;
      if (!this.closed) {
        this.closed = true;
        this.onDisconnect?.(error);
      }
      return;
    }

    if (!this.closed) {
      this.closed = true;
      this.pending?.reject(new Error("Keyboard disconnected"));
      this.pending = undefined;
      this.onDisconnect?.();
    }
  }
}
