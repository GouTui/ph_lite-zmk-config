import { getDecoder, getEncoder } from "./framing";

export interface RpcTransport {
  label: string;
  abortController: AbortController;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

export class UserCancelledError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    Object.setPrototypeOf(this, UserCancelledError.prototype);
  }
}

const SERVICE_UUID = "00000000-0196-6107-c967-c5cfb1c2482a";
const RPC_CHARACTERISTIC_UUID = "00000001-0196-6107-c967-c5cfb1c2482a";

export async function connectSerialTransport(): Promise<RpcTransport> {
  let port: SerialPort;

  try {
    port = await navigator.serial.requestPort({});
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      throw new UserCancelledError("已取消 USB 设备选择。", { cause: error });
    }
    throw error;
  }

  try {
    await port.open({ baudRate: 12500 });
  } catch (error) {
    if (error instanceof DOMException && error.name === "NetworkError") {
      throw new Error("USB 端口打开失败，请确认没有被其他程序占用。", {
        cause: error,
      });
    }
    throw error;
  }

  const info = port.getInfo();
  const label = `${info.usbVendorId?.toString(16) || "usb"}:${
    info.usbProductId?.toString(16) || "device"
  }`;
  const abortController = new AbortController();

  const onAbort = async () => {
    abortController.signal.removeEventListener("abort", onAbort);
    try {
      await port.readable?.cancel();
    } catch {
      // Ignore close failures during disconnect.
    }
    try {
      await port.writable?.close();
    } catch {
      // Ignore close failures during disconnect.
    }
    try {
      await port.close();
    } catch {
      // Ignore close failures during disconnect.
    }
  };

  abortController.signal.addEventListener("abort", onAbort);

  return {
    label,
    abortController,
    readable: port.readable!,
    writable: port.writable!,
  };
}

export async function connectGattTransport(): Promise<RpcTransport> {
  let device: BluetoothDevice;

  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
      optionalServices: [SERVICE_UUID],
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      throw new UserCancelledError("已取消蓝牙设备选择。", { cause: error });
    }
    throw error;
  }

  if (!device.gatt) {
    throw new Error("当前浏览器没有提供蓝牙 GATT 接口。");
  }

  if (!device.gatt.connected) {
    await device.gatt.connect();
  }

  const service = await device.gatt.getPrimaryService(SERVICE_UUID);
  const characteristic = await service.getCharacteristic(RPC_CHARACTERISTIC_UUID);
  const abortController = new AbortController();

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      await characteristic.stopNotifications().catch(() => undefined);
      await characteristic.startNotifications();

      const onValue = (event: Event) => {
        const target = event.target as BluetoothRemoteGATTCharacteristic | null;
        const value = target?.value?.buffer;
        if (!value) {
          return;
        }
        controller.enqueue(new Uint8Array(value));
      };

      const onDisconnect = () => {
        characteristic.removeEventListener("characteristicvaluechanged", onValue);
        device.removeEventListener("gattserverdisconnected", onDisconnect);
        controller.close();
      };

      characteristic.addEventListener("characteristicvaluechanged", onValue);
      device.addEventListener("gattserverdisconnected", onDisconnect);
    },
  });

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      const payload = Uint8Array.from(chunk);
      return characteristic.writeValueWithoutResponse(payload);
    },
  });

  const onAbort = () => {
    abortController.signal.removeEventListener("abort", onAbort);
    device.gatt?.disconnect();
  };

  abortController.signal.addEventListener("abort", onAbort);

  return {
    label: device.name || "BLE Device",
    abortController,
    readable,
    writable,
  };
}

export function createFramedWriter(transport: RpcTransport) {
  const stream = new TransformStream<Uint8Array, Uint8Array>(getEncoder());
  void stream.readable.pipeTo(transport.writable, {
    signal: transport.abortController.signal,
  });
  return stream.writable.getWriter();
}

export function createFramedReader(transport: RpcTransport) {
  return transport.readable.pipeThrough(new TransformStream(getDecoder()), {
    signal: transport.abortController.signal,
  });
}
