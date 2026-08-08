export type MonitorGpuUserColorMap = ReadonlyMap<string, string>;

export const MONITOR_UNKNOWN_GPU_USER = "unknown";

const MONITOR_GPU_USER_HUES = [
  190, 215, 155, 38, 330, 15, 250, 140, 55,
  345, 175, 285, 25, 120, 205, 355, 305
] as const;
const MONITOR_GPU_USER_SATURATION = 0.72;
const MONITOR_GPU_USER_TARGET_LUMINANCE = 0.22;
const MONITOR_UNKNOWN_GPU_USER_HUE = 275;

export const MONITOR_UNKNOWN_GPU_USER_COLOR = monitorAccessibleGpuUserColor(MONITOR_UNKNOWN_GPU_USER_HUE);

export function assignMonitorGpuUserColors(users: string[]): MonitorGpuUserColorMap {
  const colorsByUser = new Map<string, string>();
  const takenColorIndexes = new Set<number>();
  const sortedUsers = users
    .filter((user) => user !== MONITOR_UNKNOWN_GPU_USER)
    .sort((left, right) => left.localeCompare(right));

  // Reuse one snapshot-wide stable map and avoid palette collisions while hues remain.
  for (const user of sortedUsers) {
    const preferredIndex = monitorGpuUserHash(user) % MONITOR_GPU_USER_HUES.length;
    let color: string | null = null;
    for (let offset = 0; offset < MONITOR_GPU_USER_HUES.length; offset += 1) {
      const candidateIndex = (preferredIndex + offset) % MONITOR_GPU_USER_HUES.length;
      if (!takenColorIndexes.has(candidateIndex)) {
        color = monitorAccessibleGpuUserColor(MONITOR_GPU_USER_HUES[candidateIndex]);
        takenColorIndexes.add(candidateIndex);
        break;
      }
    }
    colorsByUser.set(user, color ?? monitorGeneratedGpuUserColor(user));
  }
  if (users.includes(MONITOR_UNKNOWN_GPU_USER)) {
    colorsByUser.set(MONITOR_UNKNOWN_GPU_USER, MONITOR_UNKNOWN_GPU_USER_COLOR);
  }
  return colorsByUser;
}

export function monitorGpuUserColor(user: string, userColorByUser: MonitorGpuUserColorMap) {
  return userColorByUser.get(user)
    ?? (user === MONITOR_UNKNOWN_GPU_USER ? MONITOR_UNKNOWN_GPU_USER_COLOR : monitorGeneratedGpuUserColor(user));
}

export function normalizeMonitorGpuUser(user: string | null | undefined) {
  return user?.trim() || MONITOR_UNKNOWN_GPU_USER;
}

function monitorGeneratedGpuUserColor(user: string) {
  return monitorAccessibleGpuUserColor(monitorGpuUserHash(user) % 360);
}

function monitorAccessibleGpuUserColor(hue: number) {
  let low = 0;
  let high = 1;
  // Constant saturation bans gray; the luminance target stays visible on both app themes.
  for (let attempt = 0; attempt < 18; attempt += 1) {
    const lightness = (low + high) / 2;
    const luminance = relativeLuminance(hslToRgb(hue, MONITOR_GPU_USER_SATURATION, lightness));
    if (luminance < MONITOR_GPU_USER_TARGET_LUMINANCE) low = lightness;
    else high = lightness;
  }
  return rgbToHex(hslToRgb(hue, MONITOR_GPU_USER_SATURATION, (low + high) / 2));
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const normalizedHue = ((hue % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const segment = normalizedHue / 60;
  const intermediate = chroma * (1 - Math.abs((segment % 2) - 1));
  const [red, green, blue] = segment < 1 ? [chroma, intermediate, 0]
    : segment < 2 ? [intermediate, chroma, 0]
      : segment < 3 ? [0, chroma, intermediate]
        : segment < 4 ? [0, intermediate, chroma]
          : segment < 5 ? [intermediate, 0, chroma]
            : [chroma, 0, intermediate];
  const match = lightness - chroma / 2;
  return [red + match, green + match, blue + match];
}

function relativeLuminance([red, green, blue]: [number, number, number]) {
  return 0.2126 * linearizeColorChannel(red)
    + 0.7152 * linearizeColorChannel(green)
    + 0.0722 * linearizeColorChannel(blue);
}

function linearizeColorChannel(channel: number) {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function rgbToHex(channels: [number, number, number]) {
  return `#${channels.map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0")).join("")}`;
}

function monitorGpuUserHash(user: string) {
  let hash = 0;
  for (const char of user) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}
