export type PersonalInfoIdentity = {
  username?: string | null;
  address?: string | null;
};

export type PersonalInfoMasker = {
  enabled: boolean;
  maskHostAddress: (value: string) => string;
  maskText: (value: string) => string;
  maskUsername: (value: string) => string;
};

const ipv4Pattern = /(^|[^\d.])(\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})\.(\d{1,3})(?=$|[^\d.])/gu;
const endpointPattern = /(^|[^\p{L}\p{N}_.-])([\p{L}\p{N}_.-]+)@(\[[0-9a-f:]+\]|(?:\d{1,3}\.){3}\d{1,3}|[\p{L}\p{N}_.-]+)(:\d{1,5})?/giu;
const homePathPattern = /([/\\](?:Users|home)[/\\])([^/\\\s]+)/giu;

function firstCharacter(value: string) {
  return Array.from(value.trim())[0] ?? "";
}

export function maskPersonalUsername(value: string) {
  const first = firstCharacter(value);
  return first ? `${first}*` : value;
}

export function maskPersonalHostAddress(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-") return value;

  const bracketed = trimmed.startsWith("[") && trimmed.endsWith("]");
  const address = bracketed ? trimmed.slice(1, -1) : trimmed;
  const ipv4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  // IPv4 保留首尾两组，方便区分主机，同时隐藏中间两组。
  if (ipv4) return `${ipv4[1]}.xx.xx.${ipv4[4]}`;

  if (address.includes(":")) {
    const first = address.split(":").find(Boolean) ?? "x";
    const masked = `${first}:xx:xx:xx`;
    return bracketed ? `[${masked}]` : masked;
  }

  const labels = address.split(".");
  if (labels.length > 1) {
    const first = firstCharacter(labels[0]);
    return [`${first || "x"}*`, ...labels.slice(1).map(() => "xx")].join(".");
  }

  return maskPersonalUsername(address);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replaceToken(value: string, token: string, replacement: string) {
  if (!token || token === replacement) return value;
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_.-])${escapeRegExp(token)}(?=$|[^\\p{L}\\p{N}_.-])`, "giu");
  return value.replace(pattern, (_match, prefix: string) => `${prefix}${replacement}`);
}

function collectIdentityValues(identities: PersonalInfoIdentity[], key: keyof PersonalInfoIdentity) {
  return Array.from(new Set(
    identities
      .map((identity) => identity[key]?.trim() ?? "")
      .filter(Boolean)
  )).sort((left, right) => right.length - left.length);
}

export function createPersonalInfoMasker(enabled: boolean, identities: PersonalInfoIdentity[] = []): PersonalInfoMasker {
  const usernames = collectIdentityValues(identities, "username");
  const addresses = collectIdentityValues(identities, "address");

  const maskUsername = (value: string) => enabled ? maskPersonalUsername(value) : value;
  const maskHostAddress = (value: string) => enabled ? maskPersonalHostAddress(value) : value;
  const maskText = (value: string) => {
    if (!enabled || !value) return value;

    // 先处理完整 endpoint，确保用户名、地址分别脱敏且端口保持原值。
    let masked = value.replace(endpointPattern, (_match, prefix: string, username: string, address: string, port = "") => (
      `${prefix}${maskPersonalUsername(username)}@${maskPersonalHostAddress(address)}${port}`
    ));
    for (const address of addresses) masked = replaceToken(masked, address, maskPersonalHostAddress(address));
    for (const username of usernames) masked = replaceToken(masked, username, maskPersonalUsername(username));
    masked = masked.replace(ipv4Pattern, (_match, prefix: string, firstOctet: string, lastOctet: string) => `${prefix}${firstOctet}.xx.xx.${lastOctet}`);
    masked = masked.replace(homePathPattern, (_match, prefix: string, username: string) => `${prefix}${maskPersonalUsername(username)}`);
    return masked;
  };

  return { enabled, maskHostAddress, maskText, maskUsername };
}
