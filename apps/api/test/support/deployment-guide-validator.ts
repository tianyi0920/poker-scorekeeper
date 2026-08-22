import { parseAllDocuments } from "yaml";

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

const safeShortPortMappings = new Set([
  "127.0.0.1:3000:80",
  "127.0.0.1:3000:80/tcp",
]);

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
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(value);
  if (
    value === "" ||
    value !== value.trim() ||
    scheme?.[1]?.toLowerCase() !== "https"
  ) {
    rejectInsecureBackendGuide(
      name,
      `${key} must contain a complete HTTPS origin`,
    );
  }

  const schemeNormalizedOrigin = `https://${value.slice(scheme[0].length)}`;
  const url = parseGuideUrl(schemeNormalizedOrigin, name);
  if (
    url.protocol.toLowerCase() !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname === "" ||
    url.origin === "null" ||
    schemeNormalizedOrigin !== url.origin
  ) {
    rejectInsecureBackendGuide(
      name,
      `${key} must contain a complete HTTPS origin`,
    );
  }
}

function validateGuideEnvironmentValue(
  key: GuideEnvironmentKey,
  value: string,
  name: string,
): void {
  if (key === "PORT") {
    if (value !== "80") {
      rejectInsecureBackendGuide(name, `PORT must be 80, received ${value}`);
    }
    return;
  }

  const origins = value.split(",");
  if (value === "" || origins.some((origin) => origin === "")) {
    rejectInsecureBackendGuide(name, `${key} must not be empty`);
  }
  for (const origin of origins) {
    validateGuideOrigin(origin, key, name);
  }
}

function readShellAssignmentWord(
  content: string,
  cursor: number,
  wrapperQuote: string | undefined,
  key: GuideEnvironmentKey,
  name: string,
): string {
  let value = "";
  let wrapperClosed = wrapperQuote === undefined;

  while (cursor < content.length) {
    const character = content[cursor]!;
    if (
      /[\s`，。；：！？、]/u.test(character) ||
      (character === "#" && key === "PORT")
    ) {
      break;
    }

    if (!wrapperClosed && character === wrapperQuote) {
      wrapperClosed = true;
      cursor += 1;
      continue;
    }

    if (character === '"' || character === "'") {
      const lineEnd = content.indexOf("\n", cursor + 1);
      const closingQuote = content.indexOf(character, cursor + 1);
      if (closingQuote < 0 || (lineEnd >= 0 && closingQuote > lineEnd)) {
        rejectInsecureBackendGuide(name, `unterminated ${key} assignment`);
      }
      value += content.slice(cursor + 1, closingQuote);
      cursor = closingQuote + 1;
      continue;
    }

    value += character;
    cursor += 1;
  }

  if (!wrapperClosed) {
    rejectInsecureBackendGuide(name, `unterminated ${key} assignment`);
  }

  return value;
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
    const matchIndex = match.index ?? 0;
    const cursor = matchIndex + match[0].length;
    const precedingCharacter = content[matchIndex - 1];
    const wrapperQuote =
      precedingCharacter === '"' || precedingCharacter === "'"
        ? precedingCharacter
        : undefined;
    const value = readShellAssignmentWord(
      content,
      cursor,
      wrapperQuote,
      key,
      name,
    );

    assignments.push({ key, value });
  }

  return assignments;
}

function validateGuideEnvironmentAssignments(
  content: string,
  name: string,
): void {
  for (const assignment of readGuideEnvironmentAssignments(content, name)) {
    validateGuideEnvironmentValue(assignment.key, assignment.value, name);
  }
}

interface YamlSnippet {
  content: string;
  failClosed: boolean;
  allowTopLevelProse: boolean;
}

const yamlFenceLanguages = new Set([
  "yaml",
  "yml",
  "compose",
  "docker-compose",
]);

function yamlCandidateBlockEnd(lines: string[], start: number): number {
  let end = start + 1;
  while (
    end < lines.length &&
    (lines[end]!.trim() === "" || /^[ \t]+/u.test(lines[end]!))
  ) {
    end += 1;
  }
  return end;
}

function findYamlSnippets(content: string): YamlSnippet[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const outsideFence = [...lines];
  const snippets: YamlSnippet[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const fence = /^```([^\s`]*)/u.exec(lines[index]!);
    if (!fence) continue;

    const language = fence[1]!.toLowerCase();
    let end = index + 1;
    while (end < lines.length && !/^```\s*$/u.test(lines[end]!)) end += 1;
    if (yamlFenceLanguages.has(language)) {
      snippets.push({
        content: lines.slice(index + 1, end).join("\n"),
        failClosed: true,
        allowTopLevelProse: false,
      });
    }
    outsideFence.fill("", index, Math.min(end + 1, lines.length));
    index = end;
  }

  for (let index = 0; index < outsideFence.length; index += 1) {
    const line = outsideFence[index]!;
    if (line.trim() === "" || /^[ \t]/u.test(line)) continue;

    const blockEnd = yamlCandidateBlockEnd(outsideFence, index);
    snippets.push({
      content: outsideFence.slice(index, blockEnd).join("\n"),
      failClosed: false,
      allowTopLevelProse: true,
    });
    if (blockEnd < outsideFence.length) {
      snippets.push({
        content: outsideFence.slice(index).join("\n"),
        failClosed: false,
        allowTopLevelProse: true,
      });
    }
  }

  return snippets;
}

function scalarText(value: unknown): string | undefined {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? String(value)
    : undefined;
}

function isGuideEnvironmentKey(key: string): key is GuideEnvironmentKey {
  return (
    key === "PORT" || key === "PUBLIC_ORIGIN" || key === "WS_ALLOWED_ORIGINS"
  );
}

function validateComposeEnvironment(environment: unknown, name: string): void {
  if (Array.isArray(environment)) {
    for (const entry of environment) {
      if (typeof entry !== "string") {
        rejectInsecureBackendGuide(name, "invalid Compose environment entry");
      }
      const inherited = /^(PORT|PUBLIC_ORIGIN|WS_ALLOWED_ORIGINS)$/u.exec(
        entry,
      );
      if (inherited) {
        rejectInsecureBackendGuide(
          name,
          `${inherited[1]} must not inherit a host value`,
        );
      }
      for (const assignment of readGuideEnvironmentAssignments(entry, name)) {
        validateGuideEnvironmentValue(assignment.key, assignment.value, name);
      }
    }
    return;
  }

  if (
    environment === null ||
    typeof environment !== "object" ||
    Array.isArray(environment)
  ) {
    rejectInsecureBackendGuide(name, "invalid Compose environment mapping");
  }

  for (const [key, rawValue] of Object.entries(
    environment as Record<string, unknown>,
  )) {
    if (!isGuideEnvironmentKey(key)) continue;
    const value = scalarText(rawValue);
    if (value === undefined) {
      rejectInsecureBackendGuide(name, `${key} must not inherit a host value`);
    }
    validateGuideEnvironmentValue(key, value, name);
  }
}

function validateParsedPortMapping(mapping: unknown, name: string): void {
  if (typeof mapping === "string" || typeof mapping === "number") {
    const shortMapping = String(mapping);
    if (!safeShortPortMappings.has(shortMapping)) {
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
    scalarText(fields.host_ip) !== "127.0.0.1" ||
    (fields.protocol !== undefined && scalarText(fields.protocol) !== "tcp")
  ) {
    rejectInsecureBackendGuide(name, "unsafe long-form port mapping");
  }
}

function validateComposePorts(ports: unknown, name: string): void {
  if (!Array.isArray(ports)) {
    rejectInsecureBackendGuide(name, "ports must be a YAML sequence");
  }
  for (const mapping of ports) {
    validateParsedPortMapping(mapping, name);
  }
}

function isTopLevelMarkdownProse(
  value: unknown,
  allowTopLevelProse: boolean,
  depth: number,
): value is string {
  return (
    allowTopLevelProse &&
    depth === 0 &&
    typeof value === "string" &&
    /\s/u.test(value) &&
    !/\$(?:[A-Za-z_{(])|\{\{|\}\}|<%|%>/u.test(value)
  );
}

function validateComposeStructure(
  value: unknown,
  name: string,
  allowTopLevelProse: boolean,
  visited = new WeakSet<object>(),
  depth = 0,
): void {
  if (value === null || typeof value !== "object") return;
  if (visited.has(value)) return;
  visited.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      validateComposeStructure(
        entry,
        name,
        allowTopLevelProse,
        visited,
        depth + 1,
      );
    }
    return;
  }

  for (const [key, nestedValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (key === "environment") {
      if (isTopLevelMarkdownProse(nestedValue, allowTopLevelProse, depth)) {
        continue;
      }
      validateComposeEnvironment(nestedValue, name);
      continue;
    }
    if (key === "ports") {
      if (isTopLevelMarkdownProse(nestedValue, allowTopLevelProse, depth)) {
        continue;
      }
      validateComposePorts(nestedValue, name);
      continue;
    }
    validateComposeStructure(
      nestedValue,
      name,
      allowTopLevelProse,
      visited,
      depth + 1,
    );
  }
}

function validateYamlComposeStructures(content: string, name: string): void {
  for (const snippet of findYamlSnippets(content)) {
    let documents;
    try {
      documents = parseAllDocuments(snippet.content, { merge: true });
    } catch {
      if (snippet.failClosed) {
        rejectInsecureBackendGuide(name, "invalid fenced YAML block");
      }
      continue;
    }
    if (
      snippet.failClosed &&
      documents.some((document) => document.errors.length > 0)
    ) {
      rejectInsecureBackendGuide(name, "invalid fenced YAML block");
    }
    for (const document of documents) {
      let value: unknown;
      try {
        value = document.toJS();
      } catch {
        if (snippet.failClosed) {
          rejectInsecureBackendGuide(name, "invalid fenced YAML block");
        }
        continue;
      }
      validateComposeStructure(value, name, snippet.allowTopLevelProse);
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
      if (!safeShortPortMappings.has(match[0])) {
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
  validateYamlComposeStructures(content, name);
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
