import { describe, expect, it } from "vitest";
import { validateSecureBackendDeploymentGuide } from "./support/deployment-guide-validator.js";

const secureGuide = [
  "PORT=80",
  "PUBLIC_ORIGIN=https://poker.example.com",
  "WS_ALLOWED_ORIGINS=https://poker.example.com",
  "127.0.0.1:3000",
  "127.0.0.1:3000:80",
  "OpenResty terminates TLS on 443 and proxies /socket.io with Upgrade.",
  "https://poker.example.com",
  "wss://poker.example.com",
  "http://127.0.0.1:3000/api/health/live",
].join("\n");

function validate(extra = ""): void {
  validateSecureBackendDeploymentGuide(
    `${secureGuide}\n${extra}`,
    "validator fixture",
  );
}

const insecureUrlTokens = [
  ["uppercase HTTP in Markdown emphasis", "_HTTP://public.example_"],
  ["mixed-case HTTP", "hTtP://public.example/path"],
  ["uppercase WS", "WS://public.example/socket.io"],
  ["mixed-case WS", "wS://public.example/socket.io"],
  ["public IPv4 HTTP", "http://192.0.2.10:3000"],
  ["private IPv4 HTTP", "http://192.168.10.20:3000"],
  ["public IPv6 HTTP", "http://[2001:db8::10]:3000"],
  ["HTTP before Chinese punctuation", "HTTP://public.example。"],
  ["WS before ASCII punctuation", "ws://public.example/socket.io,."],
] as const;

const invalidAssignments = [
  ["invalid PORT in dotenv syntax", "PORT=3000"],
  ["invalid PORT in export syntax", 'export PORT = "3000" # comment'],
  ["invalid PORT in Markdown bullet", "- PORT='3000'# comment"],
  ["invalid PORT in docker -e syntax", "docker run -e PORT = 3000"],
  ["invalid PORT in an entirely quoted item", "'PORT=3000'"],
  ["empty unquoted PUBLIC_ORIGIN", "PUBLIC_ORIGIN="],
  ["empty quoted PUBLIC_ORIGIN", 'PUBLIC_ORIGIN=""'],
  ["empty quoted WS_ALLOWED_ORIGINS", "WS_ALLOWED_ORIGINS=''"],
  ["empty origin before a comment", "export PUBLIC_ORIGIN= # missing"],
  [
    "empty PUBLIC_ORIGIN cannot borrow the next line",
    "PUBLIC_ORIGIN=\nhttps://next-line.example",
  ],
  [
    "empty WS_ALLOWED_ORIGINS cannot borrow the next line",
    "WS_ALLOWED_ORIGINS =\nhttps://next-line.example",
  ],
  ["empty item in an origin list", "WS_ALLOWED_ORIGINS=https://a.example,"],
  ["origin with credentials", "PUBLIC_ORIGIN=https://user:pass@a.example"],
  ["origin with a raw trailing slash", "PUBLIC_ORIGIN=https://a.example/"],
  ["origin with a path", "PUBLIC_ORIGIN=https://a.example/room"],
  ["origin with an empty query", "PUBLIC_ORIGIN=https://a.example?"],
  ["origin with a query", "PUBLIC_ORIGIN=https://a.example?preview=1"],
  ["origin with an empty fragment", "WS_ALLOWED_ORIGINS=https://a.example#"],
  ["origin with a fragment", "WS_ALLOWED_ORIGINS=https://a.example#fragment"],
  ["origin with a raw dot segment", "PUBLIC_ORIGIN=https://a.example/a/.."],
  ["origin with another raw dot segment", "PUBLIC_ORIGIN=https://a.example/./"],
  ["origin with a raw backslash path", "PUBLIC_ORIGIN=https://a.example\\room"],
  ["origin with an empty port", "PUBLIC_ORIGIN=https://a.example:"],
  ["origin without an authority", 'PUBLIC_ORIGIN="https://"'],
] as const;

const unsafePortMappings = [
  ["hostless short mapping", 'ports:\n  - "3000:80"'],
  ["wildcard IPv4 short mapping", 'ports:\n  - "0.0.0.0:3000:80"'],
  ["private IPv4 short mapping", 'ports:\n  - "192.168.10.20:3000:80"'],
  ["arbitrary IPv4 short mapping", 'ports:\n  - "8.8.8.8:3000:80"'],
  ["public IPv6 short mapping", 'ports:\n  - "[2001:db8::10]:3000:80"'],
  ["wrong published short mapping", 'ports:\n  - "127.0.0.1:80:80"'],
  ["wrong target short mapping", 'ports:\n  - "127.0.0.1:3000:3000"'],
  ["hostless 80 to 80 mapping", 'ports:\n  - "80:80"'],
  [
    "long mapping with unsafe reordered host",
    "ports:\n  - published: 3000\n    host_ip: 0.0.0.0\n    target: 80",
  ],
  [
    "long mapping without host_ip",
    "ports:\n  - published: 3000\n    target: 80",
  ],
  [
    "long mapping with wrong host_ip",
    "ports:\n  - host_ip: 192.168.10.20\n    target: 80\n    published: 3000",
  ],
  [
    "long mapping with quoted unsafe values",
    'ports:\n  - published: "3000"\n    target: "80"\n    host_ip: "0.0.0.0"',
  ],
  [
    "long mapping in unsafe flow syntax",
    'ports: [{ published: 3000, host_ip: "0.0.0.0", target: 80 }]',
  ],
  [
    "flow sequence containing one unsafe mapping",
    'ports: ["127.0.0.1:3000:80", "3000:80"]',
  ],
  [
    "one unsafe mapping among safe mappings",
    'ports:\n  - "127.0.0.1:3000:80"\n  - "192.168.1.8:3000:80"\n  - "127.0.0.1:3000:80"',
  ],
  [
    "first long item cannot borrow fields from the next item",
    "ports:\n  - target: 80\n  - host_ip: 127.0.0.1\n    published: 3000\n    target: 80",
  ],
  [
    "first ports block cannot borrow fields from a later block",
    "ports:\n  - target: 80\nnext: true\nports:\n  - host_ip: 127.0.0.1\n    published: 3000\n    target: 80",
  ],
] as const;

const validEnvironmentSyntax = [
  ["dotenv PORT", "PORT=80"],
  ["export with quoted PORT", 'export PORT = "80" # listen internally'],
  ["Markdown bullet with PORT", "- PORT='80'# listen internally"],
  ["docker -e with PORT", "docker run -e PORT = 80"],
  ["entirely quoted PORT", "'PORT=80'"],
  ["dotenv HTTPS origin", "PUBLIC_ORIGIN=https://public.example"],
  [
    "export mixed-case HTTPS origin",
    'export PUBLIC_ORIGIN = "HtTpS://public.example:8443"',
  ],
  [
    "Markdown bullet origin list",
    "- WS_ALLOWED_ORIGINS='https://a.example,HTTPS://[2001:db8::20]:8443'",
  ],
  [
    "docker -e IPv6 origin",
    "docker run -e PUBLIC_ORIGIN=HTTPS://[2001:db8::21]",
  ],
  [
    "entirely quoted origin item",
    "'WS_ALLOWED_ORIGINS=https://public.example'",
  ],
] as const;

const validPortMappings = [
  ["quoted short mapping", 'ports:\n  - "127.0.0.1:3000:80"'],
  ["unquoted short mapping", "ports:\n  - 127.0.0.1:3000:80"],
  [
    "reordered long mapping",
    "ports:\n  - published: 3000\n    host_ip: 127.0.0.1\n    target: 80",
  ],
  [
    "quoted reordered long mapping",
    "ports:\n  - host_ip: '127.0.0.1'\n    published: '3000'\n    target: '80'",
  ],
  [
    "flow long mapping",
    "ports: [{ host_ip: 127.0.0.1, target: 80, published: 3000 }]",
  ],
  [
    "multiple safe mappings",
    'ports:\n  - "127.0.0.1:3000:80"\n  - target: 80\n    published: 3000\n    host_ip: 127.0.0.1',
  ],
] as const;

describe("secure backend deployment guide validator", () => {
  it.each(insecureUrlTokens)("rejects %s", (_label, token) => {
    expect(() => validate(token)).toThrow(
      /permits an insecure public application backend/,
    );
  });

  it.each(invalidAssignments)("rejects %s", (_label, assignment) => {
    expect(() => validate(assignment)).toThrow(
      /permits an insecure public application backend/,
    );
  });

  it.each(unsafePortMappings)("rejects %s", (_label, mapping) => {
    expect(() => validate(mapping)).toThrow(
      /permits an insecure public application backend/,
    );
  });

  it.each([
    [
      "mixed-case HTTPS and WSS",
      "HtTpS://public.example/path\nWsS://public.example/socket.io",
    ],
    [
      "domain HTTPS and WSS",
      "https://public.example/path\nwss://public.example/socket.io",
    ],
    [
      "IPv6 HTTPS and WSS",
      "HTTPS://[2001:db8::30]/path\nWSS://[2001:db8::30]/socket.io",
    ],
    ["IPv4 loopback HTTP", "HTTP://127.0.0.1:3000/api/health/live"],
    ["localhost loopback HTTP", "http://LOCALHOST:3000/api/health/ready"],
    ["IPv6 loopback HTTP", "HtTp://[::1]:3000/api/health/live"],
    ["bare HTTPS scheme in explanatory prose", "完整的 `https://` 源站"],
    [
      "Chinese trailing punctuation",
      "https://public.example/path，wss://public.example/socket.io。",
    ],
    [
      "ASCII trailing punctuation",
      "https://public.example/path,; wss://public.example/socket.io:.",
    ],
  ] as const)("accepts %s", (_label, token) => {
    expect(() => validate(token)).not.toThrow();
  });

  it.each(validEnvironmentSyntax)("accepts %s", (_label, assignment) => {
    expect(() => validate(assignment)).not.toThrow();
  });

  it.each(validPortMappings)("accepts %s", (_label, mapping) => {
    expect(() => validate(mapping)).not.toThrow();
  });
});
