export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface HsbColor {
  h: number;
  s: number;
  b: number;
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function hsbToRgb(color: HsbColor): RgbColor {
  const hue = ((color.h % 360) + 360) % 360;
  const saturation = clamp(color.s, 0, 100) / 100;
  const brightness = clamp(color.b, 0, 100) / 100;
  const sector = Math.floor(hue / 60);
  const fraction = hue / 60 - sector;
  const p = brightness * (1 - saturation);
  const q = brightness * (1 - fraction * saturation);
  const t = brightness * (1 - (1 - fraction) * saturation);

  let r = 0;
  let g = 0;
  let b = 0;

  switch (sector % 6) {
    case 0:
      r = brightness;
      g = t;
      b = p;
      break;
    case 1:
      r = q;
      g = brightness;
      b = p;
      break;
    case 2:
      r = p;
      g = brightness;
      b = t;
      break;
    case 3:
      r = p;
      g = q;
      b = brightness;
      break;
    case 4:
      r = t;
      g = p;
      b = brightness;
      break;
    default:
      r = brightness;
      g = p;
      b = q;
      break;
  }

  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  };
}

export function rgbToHsb(color: RgbColor, fallbackHue = 0): HsbColor {
  const r = clamp(color.r, 0, 255) / 255;
  const g = clamp(color.g, 0, 255) / 255;
  const b = clamp(color.b, 0, 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = fallbackHue % 360;

  if (delta > 0.0001) {
    if (max === r) {
      hue = 60 * (((g - b) / delta) % 6);
    } else if (max === g) {
      hue = 60 * ((b - r) / delta + 2);
    } else {
      hue = 60 * ((r - g) / delta + 4);
    }
  }

  if (hue < 0) {
    hue += 360;
  }

  const saturation = max === 0 ? 0 : (delta / max) * 100;
  const brightness = max * 100;

  return {
    h: Math.round(hue) % 360,
    s: Math.round(saturation),
    b: Math.round(brightness),
  };
}

export function rgbToHex(color: RgbColor) {
  return `#${[color.r, color.g, color.b]
    .map((channel) => clamp(channel, 0, 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

export function hexToRgb(hex: string): RgbColor {
  const normalized = hex.replace("#", "").slice(0, 6).padEnd(6, "0");
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}
