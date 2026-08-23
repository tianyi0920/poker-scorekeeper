import {
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseAllDocuments,
  Scalar,
  type Document,
} from "yaml";
import { parse as parseDotenv } from "dotenv";

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
  markdownCodeDelimiterLength: number,
  key: GuideEnvironmentKey,
  name: string,
): string {
  let value = "";
  let activeQuote = wrapperQuote;
  let wrapperClosed = wrapperQuote === undefined;

  while (cursor < content.length) {
    const character = content[cursor]!;

    if (activeQuote !== undefined) {
      if (character === activeQuote) {
        if (activeQuote === wrapperQuote && !wrapperClosed) {
          wrapperClosed = true;
        }
        activeQuote = undefined;
        cursor += 1;
        continue;
      }
      if (activeQuote === '"' && character === "\\") {
        const escaped = content[cursor + 1];
        if (escaped === undefined || escaped === "\n") {
          rejectInsecureBackendGuide(name, `unterminated ${key} assignment`);
        }
        if (/[$`"\\]/u.test(escaped)) {
          value += escaped;
          cursor += 2;
          continue;
        }
      }
      value += character;
      cursor += 1;
      continue;
    }

    if (
      /[\s，。；：！？、]/u.test(character) ||
      (character === "#" && key === "PORT")
    ) {
      break;
    }

    if (character === "`") {
      let delimiterEnd = cursor;
      while (content[delimiterEnd] === "`") delimiterEnd += 1;
      if (delimiterEnd - cursor === markdownCodeDelimiterLength) {
        break;
      }
      rejectInsecureBackendGuide(name, `dynamic ${key} assignment`);
    }

    if (character === '"' || character === "'") {
      activeQuote = character;
      cursor += 1;
      continue;
    }

    if (character === "\\") {
      const escaped = content[cursor + 1];
      if (escaped === undefined || escaped === "\n") {
        rejectInsecureBackendGuide(name, `unterminated ${key} assignment`);
      }
      if (key !== "PORT") {
        rejectInsecureBackendGuide(name, `${key} must use a literal origin`);
      }
      value += escaped;
      cursor += 2;
      continue;
    }

    value += character;
    cursor += 1;
  }

  if (!wrapperClosed || activeQuote !== undefined) {
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
    let markdownCodeDelimiterLength = 0;
    for (
      let index = matchIndex - 1;
      index >= 0 && content[index] === "`";
      index -= 1
    ) {
      markdownCodeDelimiterLength += 1;
    }
    const value = readShellAssignmentWord(
      content,
      cursor,
      wrapperQuote,
      markdownCodeDelimiterLength,
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

const productionTemplateEnvironmentKeys = [
  "PORT",
  "PUBLIC_ORIGIN",
  "WS_ALLOWED_ORIGINS",
] as const satisfies readonly GuideEnvironmentKey[];

const expectedProductionTemplateEnvironmentValues = {
  PORT: "80",
  PUBLIC_ORIGIN: "https://pk.tianyi.wiki",
  WS_ALLOWED_ORIGINS: "https://pk.tianyi.wiki",
} as const satisfies Record<GuideEnvironmentKey, string>;

interface ProductionTemplateEnvironmentAssignment extends GuideEnvironmentAssignment {
  sourceLine: string;
}

function readProductionTemplateEnvironmentAssignments(
  content: string,
  name: string,
): ProductionTemplateEnvironmentAssignment[] {
  const values = parseDotenv(content);
  const assignmentLines = new Map<GuideEnvironmentKey, string[]>();
  const assignmentLine =
    /^\s*(?:export\s+)?(PORT|PUBLIC_ORIGIN|WS_ALLOWED_ORIGINS)\s*=/u;

  for (const line of content.split(/\r\n?|\n/)) {
    const key = assignmentLine.exec(line)?.[1] as
      GuideEnvironmentKey | undefined;
    if (key !== undefined) {
      assignmentLines.set(key, [...(assignmentLines.get(key) ?? []), line]);
    }
  }

  return productionTemplateEnvironmentKeys.map((key) => {
    const sourceLines = assignmentLines.get(key) ?? [];
    if (
      sourceLines.length !== 1 ||
      !Object.prototype.hasOwnProperty.call(values, key)
    ) {
      return rejectInsecureBackendGuide(
        name,
        `production template must assign ${key} exactly once`,
      );
    }

    return { key, value: values[key]!, sourceLine: sourceLines[0]! };
  });
}

/** Validates the security-critical variables copied into .env.production. */
export function validateSecureProductionEnvironmentTemplate(
  content: string,
  name: string,
): void {
  for (const assignment of readProductionTemplateEnvironmentAssignments(
    content,
    name,
  )) {
    validateGuideEnvironmentValue(assignment.key, assignment.value, name);
    const expected =
      expectedProductionTemplateEnvironmentValues[assignment.key];
    if (
      assignment.value !== expected ||
      assignment.sourceLine !== `${assignment.key}=${expected}`
    ) {
      rejectInsecureBackendGuide(
        name,
        `${assignment.key} must use the exact static production template value`,
      );
    }
  }
}

type SourcePolicy =
  "known-yaml-fence" | "unknown-fence" | "top-level-markdown" | "indented-code";

/**
 * Each source owns its policy and local ranges. Parent Markdown candidates
 * exclude child bodies before parsing; known YAML additionally retains its raw
 * strict parent. Recursive children always omit at least their opener line.
 */
interface YamlSource {
  content: string;
  policy: SourcePolicy;
  fragment?: boolean;
}

const yamlFenceLanguages = new Set([
  "yaml",
  "yml",
  "compose",
  "docker-compose",
]);

interface MarkdownFence {
  character: "`" | "~";
  length: number;
  indentation: number;
  language: string;
}

function readMarkdownFenceOpening(line: string): MarkdownFence | undefined {
  const opening = /^( {0,3})(`{3,}|~{3,})(.*)$/u.exec(line);
  if (!opening) return undefined;

  const marker = opening[2]!;
  const info = opening[3]!;
  if (marker[0] === "`" && info.includes("`")) return undefined;

  return {
    character: marker[0] as "`" | "~",
    length: marker.length,
    indentation: opening[1]!.length,
    language: info.trim().split(/[ \t]/u, 1)[0]!.toLowerCase(),
  };
}

function isMarkdownFenceClosing(line: string, fence: MarkdownFence): boolean {
  const indentation = /^( {0,3})/u.exec(line)?.[0].length ?? 0;
  let cursor = indentation;
  while (line[cursor] === fence.character) cursor += 1;
  return (
    cursor - indentation >= fence.length && line.slice(cursor).trim() === ""
  );
}

function stripFenceIndentation(line: string, indentation: number): string {
  let cursor = 0;
  while (cursor < indentation && line[cursor] === " ") cursor += 1;
  return line.slice(cursor);
}

function isIndentedCodeLine(line: string): boolean {
  return line.startsWith("\t") || line.startsWith("    ");
}

function stripIndentedCodePrefix(line: string): string {
  return line.startsWith("\t") ? line.slice(1) : line.slice(4);
}

function leadingIndentation(line: string): string {
  return /^[ \t]*/u.exec(line)?.[0] ?? "";
}

function sourceLocalYamlBlocks(lines: string[]): Array<{
  content: string;
  fragment: boolean;
}> {
  const blocks: Array<{ content: string; fragment: boolean }> = [];

  for (let start = 0; start < lines.length; start += 1) {
    if (lines[start]!.trim() === "") continue;

    const baseline = leadingIndentation(lines[start]!);
    const ends: number[] = [];
    for (let end = start + 1; end < lines.length; end += 1) {
      if (lines[end]!.trim() === "") continue;
      if (leadingIndentation(lines[end]!).length <= baseline.length) {
        ends.push(end);
      }
    }
    if (ends.length === 0 || ends[ends.length - 1] !== lines.length) {
      ends.push(lines.length);
    }

    for (const end of ends) {
      blocks.push({
        content: lines
          .slice(start, end)
          .map((line) =>
            line.startsWith(baseline) ? line.slice(baseline.length) : line,
          )
          .join("\n"),
        fragment: end < lines.length,
      });
    }
  }

  return blocks;
}

function sourcePolicyForFence(language: string): SourcePolicy {
  return yamlFenceLanguages.has(language)
    ? "known-yaml-fence"
    : "unknown-fence";
}

function sourceFailsClosed(source: YamlSource): boolean {
  return source.policy === "known-yaml-fence";
}

function sourceAllowsTopLevelPlainProse(source: YamlSource): boolean {
  switch (source.policy) {
    case "known-yaml-fence":
      return false;
    case "unknown-fence":
    case "top-level-markdown":
    case "indented-code":
      return true;
  }
}

function findYamlSources(content: string): YamlSource[] {
  const normalizedContent = content.replace(/\r\n?/g, "\n");
  const sources: YamlSource[] = [];

  function collectMarkdownSource(
    sourceContent: string,
    policy: SourcePolicy,
  ): void {
    const lines = sourceContent.split("\n");
    const outsideFence = [...lines];

    // A known YAML fence validates its original body before nested fences are
    // considered. Child extraction can add inspection, never weaken strictness.
    if (policy === "known-yaml-fence") {
      sources.push({
        content: sourceContent,
        policy,
      });
    }

    for (let index = 0; index < lines.length; index += 1) {
      const fence = readMarkdownFenceOpening(lines[index]!);
      if (!fence) continue;

      let end = index + 1;
      while (
        end < lines.length &&
        !isMarkdownFenceClosing(lines[end]!, fence)
      ) {
        end += 1;
      }
      const fencedContent = lines
        .slice(index + 1, end)
        .map((line) => stripFenceIndentation(line, fence.indentation))
        .join("\n");
      collectMarkdownSource(
        fencedContent,
        sourcePolicyForFence(fence.language),
      );
      outsideFence.fill("", index, Math.min(end + 1, lines.length));
      index = end;
    }

    for (let index = 0; index < outsideFence.length; index += 1) {
      if (
        !isIndentedCodeLine(outsideFence[index]!) ||
        (index > 0 && outsideFence[index - 1]!.trim() !== "")
      ) {
        continue;
      }

      let end = index;
      while (
        end < outsideFence.length &&
        (outsideFence[end]!.trim() === "" ||
          isIndentedCodeLine(outsideFence[end]!))
      ) {
        end += 1;
      }
      sources.push({
        content: outsideFence
          .slice(index, end)
          .map((line) =>
            line.trim() === "" ? "" : stripIndentedCodePrefix(line),
          )
          .join("\n"),
        policy: "indented-code",
      });
      outsideFence.fill("", index, end);
      index = end - 1;
    }

    if (policy === "known-yaml-fence") return;

    for (const candidate of sourceLocalYamlBlocks(outsideFence)) {
      sources.push({
        ...candidate,
        policy,
      });
    }
  }

  collectMarkdownSource(normalizedContent, "top-level-markdown");
  return sources;
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

type ComposeSectionKey = "environment" | "ports";

interface ParsedComposeSection {
  key: ComposeSectionKey;
  value: unknown;
  markdownProse: boolean;
}

function composeSectionKey(value: unknown): ComposeSectionKey | undefined {
  if (!isScalar(value)) return undefined;
  return value.value === "environment" || value.value === "ports"
    ? value.value
    : undefined;
}

function isStaticPlainMarkdownText(value: unknown): boolean {
  return (
    isScalar(value) &&
    value.type === Scalar.PLAIN &&
    value.tag === undefined &&
    typeof value.value === "string" &&
    /\s/u.test(value.value) &&
    !/\$(?:[A-Za-z_{(])|\{\{|\}\}|<%|%>/u.test(value.value)
  );
}

function isMarkdownLabelBeforeParagraph(
  map: { items: Array<{ key: unknown; value: unknown }> },
  index: number,
  source: YamlSource,
): boolean {
  const pair = map.items[index]!;
  const nextPair = map.items[index + 1];
  if (
    !nextPair ||
    !isScalar(pair.key) ||
    pair.key.type !== Scalar.PLAIN ||
    pair.key.tag !== undefined ||
    !isScalar(pair.value) ||
    pair.value.type !== Scalar.PLAIN ||
    pair.value.tag !== undefined ||
    pair.value.value !== null ||
    !isScalar(nextPair.key) ||
    nextPair.key.type !== Scalar.PLAIN ||
    nextPair.key.tag !== undefined ||
    !isStaticPlainMarkdownText(nextPair.key) ||
    nextPair.value !== null ||
    pair.value.range === undefined ||
    pair.value.range === null ||
    nextPair.key.range === undefined ||
    nextPair.key.range === null
  ) {
    return false;
  }

  const between = source.content.slice(
    pair.value.range[2],
    nextPair.key.range[0],
  );
  return /\n[ \t]*\n/u.test(between);
}

function isMarkdownProseSection(
  map: { items: Array<{ key: unknown; value: unknown }> },
  index: number,
  source: YamlSource,
  markdownProseContainer: boolean,
): boolean {
  if (!sourceAllowsTopLevelPlainProse(source) || !markdownProseContainer) {
    return false;
  }
  const pair = map.items[index]!;
  if (
    !isScalar(pair.key) ||
    pair.key.type !== Scalar.PLAIN ||
    pair.key.tag !== undefined
  ) {
    return false;
  }
  return (
    isStaticPlainMarkdownText(pair.value) ||
    isMarkdownLabelBeforeParagraph(map, index, source)
  );
}

function collectComposeSections(
  node: unknown,
  source: YamlSource,
  sections: ParsedComposeSection[],
  depth = 0,
  rootListItem = false,
): void {
  if (isMap(node)) {
    for (const [index, pair] of node.items.entries()) {
      const key = composeSectionKey(pair.key);
      if (key !== undefined) {
        sections.push({
          key,
          value: pair.value,
          markdownProse: isMarkdownProseSection(
            node,
            index,
            source,
            depth === 0 || rootListItem,
          ),
        });
        continue;
      }
      collectComposeSections(pair.value, source, sections, depth + 1, false);
    }
    return;
  }

  if (isSeq(node)) {
    for (const item of node.items) {
      collectComposeSections(item, source, sections, depth + 1, depth === 0);
    }
  }
}

function yamlNodeToJs(
  value: unknown,
  document: Document.Parsed,
  name: string,
  failClosed: boolean,
): unknown | undefined {
  if (value === null || !isNode(value)) {
    if (failClosed) {
      rejectInsecureBackendGuide(name, "invalid YAML deployment structure");
    }
    return undefined;
  }
  try {
    return value.toJS(document);
  } catch {
    if (failClosed) {
      return rejectInsecureBackendGuide(
        name,
        "invalid YAML deployment structure",
      );
    }
    return undefined;
  }
}

function validateYamlComposeStructures(content: string, name: string): void {
  for (const source of findYamlSources(content)) {
    let documents;
    try {
      documents = parseAllDocuments(source.content, { merge: true });
    } catch {
      if (sourceFailsClosed(source)) {
        rejectInsecureBackendGuide(name, "invalid fenced YAML block");
      }
      return;
    }
    if (
      sourceFailsClosed(source) &&
      documents.some((document) => document.errors.length > 0)
    ) {
      rejectInsecureBackendGuide(name, "invalid fenced YAML block");
    }
    for (const document of documents) {
      if (!sourceFailsClosed(source) && document.errors.length > 0) {
        continue;
      }
      const sections: ParsedComposeSection[] = [];
      collectComposeSections(document.contents, source, sections);
      const securitySections = sections.filter(
        (section) => !section.markdownProse,
      );
      if (document.errors.length > 0 && securitySections.length > 0) {
        rejectInsecureBackendGuide(name, "invalid YAML deployment structure");
      }
      for (const section of securitySections) {
        if (
          source.fragment &&
          (section.value === null ||
            (isScalar(section.value) && section.value.value === null))
        ) {
          continue;
        }
        const value = yamlNodeToJs(
          section.value,
          document,
          name,
          sourceFailsClosed(source),
        );
        if (value === undefined) continue;
        if (section.key === "environment") {
          validateComposeEnvironment(value, name);
        } else {
          validateComposePorts(value, name);
        }
      }
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
