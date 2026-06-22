import { useEffect, useState } from "react";
import {
  clamp,
  hexToRgb,
  hsbToRgb,
  rgbToHex,
  rgbToHsb,
  type RgbColor,
} from "./lib/color";
import { PH60_SC_V2_KEYS } from "./lib/keyboardLayout";
import {
  RpcClient,
  RpcMetaError,
  type LowBatteryIndicatorState,
  type LockState,
  type PowerSettingsState,
  type RgbUnderglowState,
  type Snapshot,
} from "./lib/rpc";
import {
  UserCancelledError,
  connectGattTransport,
  connectSerialTransport,
} from "./lib/transport";

interface RgbDraft {
  on: boolean;
  effect: number;
  speed: number;
  rgb: RgbColor;
}

interface LowBatteryDraft {
  enabled: boolean;
  keyPosition: number;
  periodMs: number;
}

interface PowerDraft {
  idleTimeoutMs: number;
  sleepTimeoutMs: number;
}

const DEFAULT_RGB: RgbDraft = {
  on: true,
  effect: 0,
  speed: 1,
  rgb: { r: 255, g: 64, b: 48 },
};

const DEFAULT_LOW_BATTERY: LowBatteryDraft = {
  enabled: true,
  keyPosition: 0,
  periodMs: 5000,
};

const DEFAULT_POWER: PowerDraft = {
  idleTimeoutMs: 300000,
  sleepTimeoutMs: 1800000,
};

function formatError(error: unknown) {
  if (error instanceof UserCancelledError) {
    return error.message;
  }

  if (error instanceof RpcMetaError) {
    if (error.condition === "UNLOCK_REQUIRED") {
      return "当前固件处于 Studio 锁定状态，写入会被拒绝。请刷未锁定固件。";
    }
    return `键盘返回 RPC 错误：${error.condition}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "发生了未知错误。";
}

function rgbDraftFromState(state: RgbUnderglowState | undefined): RgbDraft {
  if (!state?.color) {
    return DEFAULT_RGB;
  }

  return {
    on: state.on,
    effect: state.effect,
    speed: state.speed,
    rgb: hsbToRgb(state.color),
  };
}

function lowBatteryDraftFromState(
  state: LowBatteryIndicatorState | undefined,
): LowBatteryDraft {
  if (!state) {
    return DEFAULT_LOW_BATTERY;
  }

  return {
    enabled: state.enabled,
    keyPosition: state.keyPosition,
    periodMs: state.periodMs,
  };
}

function powerDraftFromState(state: PowerSettingsState | undefined): PowerDraft {
  if (!state) {
    return DEFAULT_POWER;
  }

  return {
    idleTimeoutMs: state.idleTimeoutMs,
    sleepTimeoutMs: state.sleepTimeoutMs,
  };
}

export default function App() {
  const [client, setClient] = useState<RpcClient | null>(null);
  const [deviceName, setDeviceName] = useState("未连接");
  const [transportLabel, setTransportLabel] = useState("");
  const [lockState, setLockState] = useState<LockState>();
  const [rgbState, setRgbState] = useState<RgbUnderglowState>();
  const [lowBatteryState, setLowBatteryState] =
    useState<LowBatteryIndicatorState>();
  const [powerState, setPowerState] = useState<PowerSettingsState>();
  const [rgbDraft, setRgbDraft] = useState<RgbDraft>(DEFAULT_RGB);
  const [lowBatteryDraft, setLowBatteryDraft] =
    useState<LowBatteryDraft>(DEFAULT_LOW_BATTERY);
  const [powerDraft, setPowerDraft] = useState<PowerDraft>(DEFAULT_POWER);
  const [busyArea, setBusyArea] = useState<
    "connect" | "refresh" | "rgb" | "battery" | "power" | null
  >(null);
  const [statusText, setStatusText] = useState("等待连接");
  const [lastError, setLastError] = useState("");

  const serialSupported =
    typeof navigator !== "undefined" && "serial" in navigator;
  const bleSupported =
    typeof navigator !== "undefined" &&
    "bluetooth" in navigator &&
    /Linux/i.test(navigator.userAgent);

  useEffect(() => {
    return () => {
      void client?.disconnect();
    };
  }, [client]);

  async function applySnapshot(snapshot: Snapshot, activeClient: RpcClient) {
    setClient(activeClient);
    setDeviceName(snapshot.deviceInfo?.name || activeClient.label);
    setTransportLabel(activeClient.label);
    setLockState(snapshot.lockState);
    setRgbState(snapshot.rgb);
    setLowBatteryState(snapshot.lowBattery);
    setPowerState(snapshot.power);
    setRgbDraft(rgbDraftFromState(snapshot.rgb));
    setLowBatteryDraft(lowBatteryDraftFromState(snapshot.lowBattery));
    setPowerDraft(powerDraftFromState(snapshot.power));
  }

  async function refresh(activeClient = client) {
    if (!activeClient) {
      return;
    }

    setBusyArea("refresh");
    setStatusText("正在同步键盘状态");
    setLastError("");

    try {
      const snapshot = await activeClient.loadSnapshot();
      await applySnapshot(snapshot, activeClient);
      setStatusText("状态已同步");
    } catch (error) {
      setLastError(formatError(error));
      setStatusText("同步失败");
    } finally {
      setBusyArea(null);
    }
  }

  async function connect(mode: "usb" | "ble") {
    setBusyArea("connect");
    setStatusText(mode === "usb" ? "正在连接 USB" : "正在连接 BLE");
    setLastError("");

    try {
      const transport =
        mode === "usb"
          ? await connectSerialTransport()
          : await connectGattTransport();
      const nextClient = await RpcClient.connect(transport);
      nextClient.onDisconnect = () => {
        setClient(null);
        setDeviceName("未连接");
        setTransportLabel("");
        setStatusText("连接已断开");
      };

      await client?.disconnect();
      await refresh(nextClient);
    } catch (error) {
      setLastError(formatError(error));
      setStatusText("连接失败");
    } finally {
      setBusyArea(null);
    }
  }

  async function disconnect() {
    await client?.disconnect();
    setClient(null);
    setDeviceName("未连接");
    setTransportLabel("");
    setStatusText("已断开连接");
  }

  async function writeRgb() {
    if (!client) {
      return;
    }

    setBusyArea("rgb");
    setStatusText("正在写入 RGB");
    setLastError("");

    try {
      const hsb = rgbToHsb(rgbDraft.rgb, rgbState?.color?.h ?? 0);
      await client.callRpc({
        lighting: { setRgbUnderglowState: { on: rgbDraft.on } },
      });
      await client.callRpc({
        lighting: { setRgbUnderglowState: { effect: rgbDraft.effect } },
      });
      await client.callRpc({
        lighting: { setRgbUnderglowState: { speed: rgbDraft.speed } },
      });
      await client.callRpc({
        lighting: { setRgbUnderglowState: { color: hsb } },
      });
      await refresh(client);
      setStatusText("RGB 已写入");
    } catch (error) {
      setLastError(formatError(error));
      setStatusText("RGB 写入失败");
    } finally {
      setBusyArea(null);
    }
  }

  async function writeLowBattery() {
    if (!client) {
      return;
    }

    setBusyArea("battery");
    setStatusText("正在写入低电量提示");
    setLastError("");

    try {
      await client.callRpc({
        lighting: { setLowBatteryIndicator: { enabled: lowBatteryDraft.enabled } },
      });
      await client.callRpc({
        lighting: {
          setLowBatteryIndicator: { keyPosition: lowBatteryDraft.keyPosition },
        },
      });
      await client.callRpc({
        lighting: { setLowBatteryIndicator: { periodMs: lowBatteryDraft.periodMs } },
      });
      await refresh(client);
      setStatusText("低电量提示已写入");
    } catch (error) {
      setLastError(formatError(error));
      setStatusText("低电量提示写入失败");
    } finally {
      setBusyArea(null);
    }
  }

  async function writePower() {
    if (!client) {
      return;
    }

    setBusyArea("power");
    setStatusText("正在写入休眠参数");
    setLastError("");

    try {
      await client.callRpc({
        core: { setPowerSettings: { idleTimeoutMs: powerDraft.idleTimeoutMs } },
      });
      await client.callRpc({
        core: { setPowerSettings: { sleepTimeoutMs: powerDraft.sleepTimeoutMs } },
      });
      await refresh(client);
      setStatusText("休眠参数已写入");
    } catch (error) {
      setLastError(formatError(error));
      setStatusText("休眠参数写入失败");
    } finally {
      setBusyArea(null);
    }
  }

  const selectedKey =
    PH60_SC_V2_KEYS.find((key) => key.position === lowBatteryDraft.keyPosition) ||
    PH60_SC_V2_KEYS[0];
  const rgbHex = rgbToHex(rgbDraft.rgb);
  const effectNames = rgbState?.effectNames || [];

  return (
    <div className="app-shell">
      <div className="hero">
        <div>
          <p className="eyebrow">PH60 SC Browser Console</p>
          <h1>直接在浏览器里改 PH60 SC V2 固件参数</h1>
          <p className="hero-copy">
            页面通过 ZMK Studio RPC 与键盘通信，适合调 RGB、低电量闪灯和电池模式休眠时间。
          </p>
        </div>
        <div className="hero-status">
          <div className="status-chip">{statusText}</div>
          <div className="status-meta">
            <span>设备：{deviceName}</span>
            <span>链路：{transportLabel || "未连接"}</span>
            <span>
              锁定：{lockState === "ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED" ? "未锁定" : "已锁定"}
            </span>
          </div>
        </div>
      </div>

      <section className="surface connection-surface">
        <div className="section-head">
          <div>
            <p className="section-kicker">Connection</p>
            <h2>连接键盘</h2>
          </div>
          <div className="section-actions">
            <button
              className="ghost-button"
              disabled={!client || busyArea !== null}
              onClick={() => void refresh()}
              type="button"
            >
              刷新状态
            </button>
            <button
              className="ghost-button"
              disabled={!client}
              onClick={() => void disconnect()}
              type="button"
            >
              断开连接
            </button>
          </div>
        </div>

        <div className="connection-grid">
          <button
            className="primary-button"
            disabled={!serialSupported || busyArea === "connect"}
            onClick={() => void connect("usb")}
            type="button"
          >
            通过 USB 连接
          </button>
          <button
            className="secondary-button"
            disabled={!bleSupported || busyArea === "connect"}
            onClick={() => void connect("ble")}
            type="button"
          >
            通过 BLE 连接
          </button>
          <div className="hint-block">
            <strong>浏览器要求</strong>
            <p>推荐 Chrome 或 Edge。Windows 下优先使用 USB；浏览器 BLE 基本只在 Linux 更稳定。</p>
          </div>
          <div className="hint-block">
            <strong>固件要求</strong>
            <p>请使用启用了 Studio RPC 的固件。若页面显示“已锁定”，写入会被拒绝。</p>
          </div>
        </div>

        {lastError ? <div className="error-banner">{lastError}</div> : null}
      </section>

      <div className="workspace">
        <section className="surface">
          <div className="section-head">
            <div>
              <p className="section-kicker">RGB</p>
              <h2>主 RGB 控制</h2>
            </div>
            <button
              className="primary-button"
              disabled={!client || busyArea !== null}
              onClick={() => void writeRgb()}
              type="button"
            >
              写入 RGB
            </button>
          </div>

          <div className="control-grid">
            <label className="toggle-row">
              <span>RGB 开关</span>
              <input
                checked={rgbDraft.on}
                onChange={(event) =>
                  setRgbDraft((current) => ({ ...current, on: event.target.checked }))
                }
                type="checkbox"
              />
            </label>

            <label>
              <span>灯效</span>
              <select
                value={rgbDraft.effect}
                onChange={(event) =>
                  setRgbDraft((current) => ({
                    ...current,
                    effect: Number.parseInt(event.target.value, 10),
                  }))
                }
              >
                {effectNames.map((name, index) => (
                  <option key={name} value={index}>
                    {index}. {name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>速度 {rgbDraft.speed}</span>
              <input
                max={10}
                min={1}
                onChange={(event) =>
                  setRgbDraft((current) => ({
                    ...current,
                    speed: Number.parseInt(event.target.value, 10),
                  }))
                }
                type="range"
                value={rgbDraft.speed}
              />
            </label>

            <div className="color-preview" style={{ background: rgbHex }}>
              <span>{rgbHex.toUpperCase()}</span>
            </div>

            <label>
              <span>快捷拾色</span>
              <input
                onChange={(event) =>
                  setRgbDraft((current) => ({
                    ...current,
                    rgb: hexToRgb(event.target.value),
                  }))
                }
                type="color"
                value={rgbHex}
              />
            </label>

            {(["r", "g", "b"] as const).map((channel) => (
              <label key={channel}>
                <span>
                  {channel.toUpperCase()} {rgbDraft.rgb[channel]}
                </span>
                <input
                  max={255}
                  min={0}
                  onChange={(event) =>
                    setRgbDraft((current) => ({
                      ...current,
                      rgb: {
                        ...current.rgb,
                        [channel]: Number.parseInt(event.target.value, 10),
                      },
                    }))
                  }
                  type="range"
                  value={rgbDraft.rgb[channel]}
                />
              </label>
            ))}
          </div>
        </section>

        <section className="surface">
          <div className="section-head">
            <div>
              <p className="section-kicker">Low Battery</p>
              <h2>低电量闪灯</h2>
            </div>
            <button
              className="primary-button"
              disabled={!client || busyArea !== null}
              onClick={() => void writeLowBattery()}
              type="button"
            >
              写入闪灯设置
            </button>
          </div>

          <div className="control-grid">
            <label className="toggle-row">
              <span>启用低电量提示</span>
              <input
                checked={lowBatteryDraft.enabled}
                onChange={(event) =>
                  setLowBatteryDraft((current) => ({
                    ...current,
                    enabled: event.target.checked,
                  }))
                }
                type="checkbox"
              />
            </label>

            <label>
              <span>闪烁周期（毫秒）</span>
              <input
                min={200}
                onChange={(event) =>
                  setLowBatteryDraft((current) => ({
                    ...current,
                    periodMs: clamp(
                      Number.parseInt(event.target.value || "0", 10),
                      200,
                      600000,
                    ),
                  }))
                }
                type="number"
                value={lowBatteryDraft.periodMs}
              />
            </label>

            <label>
              <span>键位位置号</span>
              <input
                max={60}
                min={0}
                onChange={(event) =>
                  setLowBatteryDraft((current) => ({
                    ...current,
                    keyPosition: clamp(
                      Number.parseInt(event.target.value || "0", 10),
                      0,
                      60,
                    ),
                  }))
                }
                type="number"
                value={lowBatteryDraft.keyPosition}
              />
            </label>

            <div className="meta-strip">
              <span>当前选中：{selectedKey.label}</span>
              <span>默认阈值：{lowBatteryState?.thresholdPct ?? 20}%</span>
              <span>闪灯时长：{lowBatteryState?.flashDurationMs ?? 200} ms</span>
            </div>
          </div>

          <div className="keyboard-stage">
            <div className="keyboard-grid">
              {PH60_SC_V2_KEYS.map((key) => (
                <button
                  key={key.position}
                  className={
                    key.position === lowBatteryDraft.keyPosition
                      ? "key-button key-button-active"
                      : "key-button"
                  }
                  onClick={() =>
                    setLowBatteryDraft((current) => ({
                      ...current,
                      keyPosition: key.position,
                    }))
                  }
                  style={{
                    left: `${(key.x / 1488) * 100}%`,
                    top: `${(key.y / 500) * 100}%`,
                  }}
                  type="button"
                >
                  <strong>{key.label}</strong>
                  <span>{key.position}</span>
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>

      <section className="surface">
        <div className="section-head">
          <div>
            <p className="section-kicker">Battery Mode</p>
            <h2>电池模式休眠参数</h2>
          </div>
          <button
            className="primary-button"
            disabled={!client || busyArea !== null}
            onClick={() => void writePower()}
            type="button"
          >
            写入休眠参数
          </button>
        </div>

        <div className="control-grid dual-columns">
          <label>
            <span>Idle 进入时间（毫秒，0 为禁用）</span>
            <input
              min={0}
              onChange={(event) =>
                setPowerDraft((current) => ({
                  ...current,
                  idleTimeoutMs: Math.max(
                    0,
                    Number.parseInt(event.target.value || "0", 10),
                  ),
                }))
              }
              type="number"
              value={powerDraft.idleTimeoutMs}
            />
          </label>

          <label>
            <span>Deep Sleep 进入时间（毫秒，0 为禁用）</span>
            <input
              min={0}
              onChange={(event) =>
                setPowerDraft((current) => ({
                  ...current,
                  sleepTimeoutMs: Math.max(
                    0,
                    Number.parseInt(event.target.value || "0", 10),
                  ),
                }))
              }
              type="number"
              value={powerDraft.sleepTimeoutMs}
            />
          </label>

          <div className="meta-strip">
            <span>当前 Idle：{powerState?.idleTimeoutMs ?? 0} ms</span>
            <span>当前 Deep Sleep：{powerState?.sleepTimeoutMs ?? 0} ms</span>
          </div>
        </div>
      </section>
    </div>
  );
}
