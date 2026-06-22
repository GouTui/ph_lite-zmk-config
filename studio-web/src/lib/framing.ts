const FRAMING_SOF = 0xab;
const FRAMING_ESC = 0xac;
const FRAMING_EOF = 0xad;

export function getEncoder(): Transformer<Uint8Array, Uint8Array> {
  return {
    transform(chunk, controller) {
      controller.enqueue(new Uint8Array([FRAMING_SOF]));

      let nextStartIndex = 0;
      for (let index = 0; index < chunk.length; index += 1) {
        const value = chunk[index];
        if (
          value === FRAMING_SOF ||
          value === FRAMING_ESC ||
          value === FRAMING_EOF
        ) {
          controller.enqueue(chunk.subarray(nextStartIndex, index));
          controller.enqueue(new Uint8Array([FRAMING_ESC]));
          nextStartIndex = index;
        }
      }

      if (nextStartIndex < chunk.length) {
        controller.enqueue(chunk.subarray(nextStartIndex));
      }

      controller.enqueue(new Uint8Array([FRAMING_EOF]));
    },
  };
}

enum DecodeState {
  Idle = 0,
  AwaitingData = 1,
  Escaped = 2,
}

export function getDecoder(): Transformer<Uint8Array, Uint8Array> {
  let state = DecodeState.Idle;
  let data: number[] = [];

  const processByte = (
    byte: number,
    controller: TransformStreamDefaultController<Uint8Array>,
  ) => {
    switch (state) {
      case DecodeState.Idle:
        if (byte !== FRAMING_SOF) {
          throw new Error("Expected frame start byte");
        }
        state = DecodeState.AwaitingData;
        return;
      case DecodeState.AwaitingData:
        if (byte === FRAMING_SOF) {
          throw new Error("Unexpected frame start byte");
        }
        if (byte === FRAMING_ESC) {
          state = DecodeState.Escaped;
          return;
        }
        if (byte === FRAMING_EOF) {
          controller.enqueue(new Uint8Array(data));
          data = [];
          state = DecodeState.Idle;
          return;
        }
        data.push(byte);
        return;
      case DecodeState.Escaped:
        data.push(byte);
        state = DecodeState.AwaitingData;
        return;
      default:
        throw new Error("Unknown decode state");
    }
  };

  return {
    transform(chunk, controller) {
      for (const byte of chunk) {
        processByte(byte, controller);
      }
    },
  };
}
