import { parse } from "yaml";

const requiredGuideSnippets = [
  "PORT=80",
  "127.0.0.1:3000",
  "127.0.0.1:3000:80",
  "OpenResty",
  "TLS",
  "/socket.io",
  "Upgrade",
  "443",
] as const;

const secureLoopbackHttpOrigins = new Set([
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  "http://[::1]:3000",
]);

const safeShortPortMapping = "127.0.0.1:3000:80";

type GuideEnvironmentKey = "PORT" | "PUBLIC_ORIGIN" | "WS_ALLOWED_ORIGINS";

interface GuideEnvironmentAssignment {
  key: GuideEnvironmentKey;
  value: string;
}

function rejectInsecureBackendGuide(name: string, detail: string): never {
  throw new Error(
    `${name} permits an insecure public application backend: ${detail}`,
  );
}

function parseGuideUrl(candidate: string, name: string): URL {
  try {
    return new URL(candidate);
  } catch {
    return rejectInsecureBackendGuide(name, `invalid URL ${candidate}`);
  }
}

function trimTrailingUrlPunctuation(candidate: string): string {
  let trimmed = candidate.replace(/[_.,;:!?*~，。；：！？、）】》」』]+$/u, "");
  while (
    trimmed.endsWith("]") &&
    (trimmed.match(/\]/g)?.length ?? 0) > (trimmed.match(/\[/g)?.length ?? 0)
  ) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function findGuideUrls(content: string): string[] {
  const candidates: string[] = [];
  const protocol = /(?:https?|wss?):\/\//gi;

  for (const match of content.matchAll(protocol)) {
    const start = match.index;
    if (start === undefined) continue;

    let end = start + match[0].length;
    while (
      end < content.length &&
      !/[\s`'"<>(){}，。；：！？、]/u.test(content[end]!)
    ) {
      end += 1;
    }

    const candidate = trimTrailingUrlPunctuation(content.slice(start, end));
    if (candidate.length > match[0].length) candidates.push(candidate);
  }

  return candidates;
}

function validateGuideUrl(candidate: string, name: string): void {
  const url = parseGuideUrl(candidate, name);
  const protocol = url.protocol.toLowerCase();
  if (protocol === "ws:") {
    rejectInsecureBackendGuide(name, `insecure WebSocket URL ${candidate}`);
  }
  if (protocol === "http:" && !secureLoopbackHttpOrigins.has(url.origin)) {
    rejectInsecureBackendGuide(name, `insecure HTTP URL ${candidate}`);
  }
}

function validateGuideOrigin(
  value: string,
  key: Exclude<GuideEnvironmentKey, "PORT">,
  name: string,
): void {
  const origin = value.trim();
  const rawOrigin = /^([a-z][a-z0-9+.-]*):\/\/(.+)$/iu.exec(origin);
  const rawProtocol = rawOrigin?.[1]?.toLowerCase();
  const rawAuthority = rawOrigin?.[2];
  if (
    origin === "" ||
    rawProtocol !== "https" ||
    rawAuthority === undefined ||
    rawAuthority === "" ||
    rawAuthority.endsWith(":") ||
    /[\\/?#]/u.test(rawAuthority)
  ) {
    rejectInsecureBackendGuide(
      name,
      `${key} must contain a complete HTTPS origin`,
    );
  }

  const url = parseGuideUrl(origin, name);
  if (
    url.protocol.toLowerCase() !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname === "" ||
    url.origin === "null"
  ) {
    rejectInsecureBackendGuide(
      name,
      `${key} must contain a complete HTTPS origin`,
    );
  }
}

function readGuideEnvironmentAssignments(
  content: string,
  name: string,
): GuideEnvironmentAssignment[] {
  const assignments: GuideEnvironmentAssignment[] = [];
  const assignmentStart =
    /\b(PORT|PUBLIC_ORIGIN|WS_ALLOWED_ORIGINS)\b[ \t]*=[ \t]*/g;

  for (const match of content.matchAll(assignmentStart)) {
    const key = match[1] as GuideEnvironmentKey;
    let cursor = (match.index ?? 0) + match[0].length;
    const quote = content[cursor] ?? "";
    let value = "";

    if (quote === '"' || quote === "'") {
      const valueStart = cursor + 1;
      const lineEnd = content.indexOf("\n", valueStart);
      const closingQuote = content.indexOf(quote, valueStart);
      if (closingQuote < 0 || (lineEnd >= 0 && closingQuote > lineEnd)) {
        rejectInsecureBackendGuide(name, `unterminated ${key} assignment`);
      }
      value = content.slice(valueStart, closingQuote);
    } else {
      const valueStart = cursor;
      while (
        cursor < content.length &&
        !/[\s`'"，。；：！？、]/u.test(content[cursor]!)
      ) {
        cursor += 1;
      }
      value = content.slice(valueStart, cursor);
    }

    assignments.push({ key, value });
  }

  return assignments;
}

function validateGuideEnvironmentAssignments(
  content: string,
  name: string,
): void {
  for (const assignment of readGuideEnvironmentAssignments(content, name)) {
    const value = assignment.value.trim();
    if (assignment.key === "PORT") {
      const port = value.split("#", 1)[0]!.trim();
      if (port !== "80") {
        rejectInsecureBackendGuide(name, `PORT must be 80, received ${port}`);
      }
      continue;
    }

    const origins = value.split(",");
    if (value === "" || origins.some((origin) => origin.trim() === "")) {
      rejectInsecureBackendGuide(name, `${assignment.key} must not be empty`);
    }
    for (const origin of origins) {
      validateGuideOrigin(origin, assignment.key, name);
    }
  }
}

function indentationWidth(line: string): number {
  return line.match(/^ */u)?.[0].length ?? 0;
}

function findYamlPortBlocks(content: string): string[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const start = /^( *)ports\s*:\s*(.*)$/u.exec(line);
    if (!start) continue;

    const baseIndent = start[1]!.length;
    const block = [line.slice(baseIndent)];
    let nextIndex = index + 1;
    while (nextIndex < lines.length) {
      const nextLine = lines[nextIndex]!;
      if (nextLine.trim() !== "" && indentationWidth(nextLine) <= baseIndent) {
        break;
      }
      block.push(
        nextLine.slice(Math.min(baseIndent, indentationWidth(nextLine))),
      );
      nextIndex += 1;
    }

    blocks.push(block.join("\n"));
    index = nextIndex - 1;
  }

  return blocks;
}

function scalarText(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
}

function validateParsedPortMapping(mapping: unknown, name: string): void {
  if (typeof mapping === "string" || typeof mapping === "number") {
    const shortMapping = String(mapping);
    if (shortMapping !== safeShortPortMapping) {
      rejectInsecureBackendGuide(
        name,
        `unsafe short port mapping ${shortMapping}`,
      );
    }
    return;
  }

  if (
    mapping === null ||
    typeof mapping !== "object" ||
    Array.isArray(mapping)
  ) {
    rejectInsecureBackendGuide(name, "invalid long-form port mapping");
  }

  const fields = mapping as Record<string, unknown>;
  if (
    scalarText(fields.target) !== "80" ||
    scalarText(fields.published) !== "3000" ||
    scalarText(fields.host_ip) !== "127.0.0.1"
  ) {
    rejectInsecureBackendGuide(name, "unsafe long-form port mapping");
  }
}

function validateYamlPortBlocks(content: string, name: string): void {
  for (const block of findYamlPortBlocks(content)) {
    let document: unknown;
    try {
      document = parse(block);
    } catch {
      rejectInsecureBackendGuide(name, "invalid YAML ports block");
    }

    if (document === null || typeof document !== "object") {
      rejectInsecureBackendGuide(name, "invalid YAML ports block");
    }
    const ports = (document as Record<string, unknown>).ports;
    if (!Array.isArray(ports)) {
      rejectInsecureBackendGuide(name, "ports must be a YAML sequence");
    }
    for (const mapping of ports) {
      validateParsedPortMapping(mapping, name);
    }
  }
}

function validateInlineShortPortMappings(content: string, name: string): void {
  const hostMappings = [
    /\[[0-9a-f:.%]+\]:\d{1,5}:\d{1,5}(?:\/(?:tcp|udp))?/gi,
    /(?<![\w.:[\]-])(?:\d{1,3}(?:\.\d{1,3}){3}|localhost):\d{1,5}:\d{1,5}(?:\/(?:tcp|udp))?(?![\w.:])/gi,
  ] as const;

  for (const pattern of hostMappings) {
    for (const match of content.matchAll(pattern)) {
      if (match[0] !== safeShortPortMapping) {
        rejectInsecureBackendGuide(
          name,
          `unsafe short port mapping ${match[0]}`,
        );
      }
    }
  }

  for (const match of content.matchAll(
    /(?<![\w.:[\]-])(\d{1,5}):(\d{1,5})(?![\w.:])/g,
  )) {
    if (match[2] === "80") {
      rejectInsecureBackendGuide(name, `unsafe short port mapping ${match[0]}`);
    }
  }
}

function validateGuidePortMappings(content: string, name: string): void {
  validateYamlPortBlocks(content, name);
  validateInlineShortPortMappings(content, name);
}

export function validateSecureBackendDeploymentGuide(
  content: string,
  name: string,
): void {
  for (const requirement of requiredGuideSnippets) {
    if (!content.includes(requirement)) {
      throw new Error(
        `${name} is missing secure backend requirement: ${requirement}`,
      );
    }
  }

  for (const candidate of findGuideUrls(content)) {
    validateGuideUrl(candidate, name);
  }

  validateGuideEnvironmentAssignments(content, name);
  validateGuidePortMappings(content, name);

  for (const line of content.split(/\r?\n/)) {
    if (/公网 IPv6/.test(line) && !/(?:不得|禁止|不能|仅.*回环)/.test(line)) {
      rejectInsecureBackendGuide(name, "guide permits public IPv6 exposure");
    }
    if (
      /(?:公开|发布|映射).{0,24}(?:应用|容器).{0,24}(?:TCP )?80/.test(line) &&
      !/(?:不得|禁止|不能|127\.0\.0\.1)/.test(line)
    ) {
      rejectInsecureBackendGuide(name, "guide permits public port 80 exposure");
    }
  }
}
