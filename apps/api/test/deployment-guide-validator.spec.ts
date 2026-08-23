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

function validateAtDocumentStart(extra: string): void {
  validateSecureBackendDeploymentGuide(
    `${extra}\n${secureGuide}`,
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
  ["suffix after an entirely single-quoted PORT word", "'PORT=80'80"],
  ["suffix after an entirely double-quoted PORT word", '"PORT=80"80'],
  [
    "path suffix after an entirely quoted origin word",
    "'PUBLIC_ORIGIN=https://safe.example'/room",
  ],
  ["PORT with command substitution suffix", "PORT=80`printf 80`"],
  ["dangerous escaped PORT suffix", "PORT=80\\80"],
  [
    "origin with command substitution suffix",
    "PUBLIC_ORIGIN=https://safe.example`printf /room`",
  ],
  ["concatenated quoted PORT word", "PORT='80'80"],
  [
    "concatenated quoted origin word",
    "PUBLIC_ORIGIN='https://safe.example'/room",
  ],
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
  [
    "origin with an explicit default HTTPS port",
    "PUBLIC_ORIGIN=https://a.example:443",
  ],
  ["origin with shorthand IPv4", "PUBLIC_ORIGIN=https://127.1"],
  ["origin with non-canonical host case", "PUBLIC_ORIGIN=https://A.example"],
  ["origin without an authority", 'PUBLIC_ORIGIN="https://"'],
] as const;

const unsafeComposeEnvironments = [
  ["mapping PORT", "environment:\n  PORT: 3000"],
  ["quoted root key separated from its colon", '"environment" :\n  PORT: 3000'],
  [
    "dynamic root environment scalar",
    'environment: "${ENVIRONMENT:-production variables}"',
  ],
  ["block scalar environment", "environment: |\n  PORT: 3000"],
  ["explicit string tag environment", 'environment: !!str "PORT: 3000"'],
  ["mapping null PUBLIC_ORIGIN", "environment:\n  PUBLIC_ORIGIN:"],
  [
    "quoted flow mapping key",
    "environment: { 'PORT': '3000', PUBLIC_ORIGIN: https://safe.example }",
  ],
  ["inherited sequence PORT", "environment:\n  - PORT"],
  ["inherited flow sequence PORT", "environment: [PORT]"],
  [
    "nested Compose environment mapping",
    "services:\n  app:\n    environment:\n      PORT: 3000",
  ],
  [
    "nested Compose flow environment mapping",
    "services: { app: { environment: { PORT: 3000 } } }",
  ],
  [
    "root list cannot turn a nested Compose environment into prose",
    "- services:\n    app:\n      environment: production variables are discussed below.",
  ],
  [
    "multiline flow Compose environment mapping",
    "{\n  services: {\n    app: {\n      environment: { PORT: 3000 }\n    }\n  }\n}",
  ],
  [
    "document marker before a flow Compose environment mapping",
    "--- { services: { app: { environment: { PORT: 3000 } } } }",
  ],
  [
    "unsafe environment in the second YAML document",
    "safe: true\n--- { services: { app: { environment: { PORT: 3000 } } } }",
  ],
  [
    "quoted environment and variable keys",
    "'environment':\n  'WS_ALLOWED_ORIGINS': null",
  ],
  [
    "merged inherited environment mapping",
    "x-environment: &unsafe_environment\n  PORT: 3000\nservices:\n  app:\n    environment:\n      <<: *unsafe_environment",
  ],
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
  [
    "quoted ports key with a missing host_ip",
    "'ports':\n  - published: 3000\n    target: 80",
  ],
  [
    "quoted root ports key separated from its colon",
    '"ports" :\n  - published: 3000\n    target: 80\n    host_ip: 0.0.0.0',
  ],
  [
    "dynamic root ports scalar",
    'ports: "${PORT_BINDINGS:-production bindings}"',
  ],
  [
    "duplicate nested ports key cannot hide the unsafe first value",
    "services:\n  app:\n    ports:\n      - published: 3000\n        target: 80\n        host_ip: 0.0.0.0\n    ports:\n      - published: 3000\n        target: 80\n        host_ip: 127.0.0.1",
  ],
  [
    "quoted ports key with reordered unsafe fields",
    "'ports':\n  - published: 3000\n    host_ip: 0.0.0.0\n    target: 80",
  ],
  [
    "nested Compose quoted ports key",
    "services:\n  app:\n    'ports':\n      - target: 80\n        published: 3000",
  ],
  [
    "nested Compose flow ports mapping",
    "services: { app: { ports: [{ published: 3000, target: 80, host_ip: 0.0.0.0 }] } }",
  ],
  [
    "root list cannot turn nested Compose ports into prose",
    "- services:\n    app:\n      ports: production bindings are discussed below.",
  ],
  [
    "multiline flow Compose ports mapping",
    "{\n  services: {\n    app: {\n      ports: [{ published: 3000, target: 80, host_ip: 0.0.0.0 }]\n    }\n  }\n}",
  ],
  [
    "document marker before a flow Compose ports mapping",
    "--- { services: { app: { ports: [{ published: 3000, target: 80, host_ip: 0.0.0.0 }] } } }",
  ],
  [
    "unsafe ports in the first YAML document",
    "--- { services: { app: { ports: [{ published: 3000, target: 80, host_ip: 0.0.0.0 }] } } }\nsafe: true",
  ],
  [
    "quoted flow ports mapping",
    "{ 'ports': [{ target: 80, host_ip: 0.0.0.0, published: 3000 }] }",
  ],
  ["UDP loopback short mapping", 'ports: ["127.0.0.1:3000:80/udp"]'],
] as const;

const unsafeIndentedYamlRoots = [
  [
    "one-space indented Compose environment root at document start",
    " services:\n   app:\n     environment:\n       PORT: 3000",
  ],
  [
    "three-space indented Compose environment root at document start",
    "   services:\n     app:\n       environment:\n         PORT: 3000",
  ],
  [
    "one-space indented Compose ports root at document start",
    " services:\n   app:\n     ports:\n       - published: 3000\n         target: 80\n         host_ip: 0.0.0.0",
  ],
  [
    "three-space indented Compose ports root at document start",
    "   services:\n     app:\n       ports:\n         - published: 3000\n           target: 80\n           host_ip: 0.0.0.0",
  ],
] as const;

const unsafeMarkdownYamlBlocks = [
  [
    "four-space indented environment code block",
    "\n    services:\n      app:\n        environment:\n          PORT: 3000",
  ],
  [
    "tab-indented long ports code block",
    "\n\tservices:\n\t  app:\n\t    ports:\n\t      - published: 3000\n\t        target: 80\n\t        host_ip: 0.0.0.0",
  ],
  ["four-backtick YAML fence", "````yaml\nenvironment:\n  PORT: 3000\n````"],
  [
    "unlabelled backtick fence",
    "```\nports:\n  - published: 3000\n    target: 80\n    host_ip: 0.0.0.0\n```",
  ],
  ["unclosed unlabelled backtick fence", "```\nenvironment:\n  PORT: 3000"],
  [
    "tilde Compose fence",
    "~~~compose\nports:\n  - published: 3000\n    target: 80\n    host_ip: 0.0.0.0\n~~~",
  ],
] as const;

const unsafeUnknownFenceBodies = [
  [
    "unknown-language fence with direct environment YAML",
    "```text\nservices:\n  app:\n    environment:\n      PORT: 3000\n```",
  ],
  [
    "unknown-language fence with direct ports YAML",
    "```text\nservices:\n  app:\n    ports:\n      - published: 3000\n        target: 80\n        host_ip: 0.0.0.0\n```",
  ],
  [
    "shorter inner fence hiding environment YAML",
    "````text\n```text\nservices:\n  app:\n    environment:\n      PORT: 3000\n```\n````",
  ],
  [
    "shorter inner fence hiding ports YAML",
    "````text\n```text\nservices:\n  app:\n    ports:\n      - published: 3000\n        target: 80\n        host_ip: 0.0.0.0\n```\n````",
  ],
  [
    "backtick fence hiding environment YAML inside a tilde fence",
    "~~~~text\n```text\nservices:\n  app:\n    environment:\n      PORT: 3000\n```\n~~~~",
  ],
  [
    "crossed inner closure hiding ports YAML",
    "````text\n```text\nservices:\n  app:\n    ports:\n      - published: 3000\n        target: 80\n        host_ip: 0.0.0.0\n````",
  ],
] as const;

const validEnvironmentSyntax = [
  ["dotenv PORT", "PORT=80"],
  ["export with quoted PORT", 'export PORT = "80" # listen internally'],
  ["Markdown bullet with PORT", "- PORT='80'# listen internally"],
  ["docker -e with PORT", "docker run -e PORT = 80"],
  ["entirely quoted PORT", "'PORT=80'"],
  ["PORT inside Markdown inline code", "`PORT=80`"],
  ["PORT inside double-backtick code span", "``PORT=80``"],
  ["PORT assembled with a shell backslash", "PORT=8\\0"],
  ["PORT assembled from quoted and unquoted segments", "PORT='8'0"],
  ["dotenv HTTPS origin", "PUBLIC_ORIGIN=https://public.example"],
  [
    "HTTPS origin inside Markdown inline code",
    "`PUBLIC_ORIGIN=https://safe.example`",
  ],
  [
    "HTTPS origin assembled from quoted and unquoted segments",
    "PUBLIC_ORIGIN='https://'safe.example",
  ],
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

const validComposeEnvironments = [
  [
    "environment mapping",
    "environment:\n  PORT: 80\n  PUBLIC_ORIGIN: https://safe.example\n  WS_ALLOWED_ORIGINS: https://safe.example",
  ],
  [
    "environment sequence",
    "environment:\n  - PORT=80\n  - PUBLIC_ORIGIN=https://safe.example\n  - WS_ALLOWED_ORIGINS=https://safe.example",
  ],
  [
    "nested flow environment with quoted keys",
    "services: { app: { 'environment': { 'PORT': '80', PUBLIC_ORIGIN: 'HTTPS://safe.example', WS_ALLOWED_ORIGINS: 'https://[2001:db8::40]' } } }",
  ],
  [
    "merged inherited safe environment mapping",
    "x-environment: &safe_environment\n  PORT: 80\n  PUBLIC_ORIGIN: https://safe.example\nservices:\n  app:\n    environment:\n      <<: *safe_environment\n      WS_ALLOWED_ORIGINS: https://safe.example",
  ],
] as const;

const validPortMappings = [
  ["quoted short mapping", 'ports:\n  - "127.0.0.1:3000:80"'],
  ["unquoted short mapping", "ports:\n  - 127.0.0.1:3000:80"],
  ["explicit TCP short mapping", 'ports:\n  - "127.0.0.1:3000:80/tcp"'],
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
  [
    "nested Compose quoted ports key",
    "services:\n  app:\n    'ports':\n      - published: '3000'\n        host_ip: '127.0.0.1'\n        target: '80'",
  ],
  [
    "nested Compose flow ports mapping",
    "services: { app: { ports: [{ host_ip: 127.0.0.1, target: 80, published: 3000 }] } }",
  ],
] as const;

const validYamlDocuments = [
  [
    "safe fenced YAML documents",
    "```yaml\nenvironment:\n  PORT: 80\n  PUBLIC_ORIGIN: https://safe.example\n---\nservices:\n  app:\n    ports:\n      - target: 80\n        published: 3000\n        host_ip: 127.0.0.1\n```",
  ],
  [
    "ordinary Markdown ports prose",
    "ports: production bindings are discussed below.",
  ],
  [
    "ordinary Markdown environment prose",
    "environment: production variables are discussed below.",
  ],
  [
    "ordinary Markdown ports label before a paragraph",
    "ports:\n\nProduction bindings are discussed below.",
  ],
  [
    "ordinary Markdown environment label before a paragraph",
    "environment:\n\nProduction variables are discussed below.",
  ],
  [
    "ordinary Markdown list environment prose",
    "- environment: production variables are discussed below.",
  ],
  [
    "ordinary Markdown list ports prose",
    "- ports: production bindings are discussed below.",
  ],
  [
    "safe four-backtick YAML fence",
    "````yaml\nenvironment:\n  PORT: 80\n  PUBLIC_ORIGIN: https://safe.example\n````",
  ],
  [
    "safe unlabelled YAML fence",
    "```\nports:\n  - published: 3000\n    target: 80\n    host_ip: 127.0.0.1\n```",
  ],
  [
    "safe tilde YAML fence",
    "~~~yaml\nenvironment:\n  PORT: 80\n  PUBLIC_ORIGIN: https://safe.example\n~~~",
  ],
  [
    "ordinary prose in an unknown-language fence",
    "```text\nProduction deployment variables are discussed below.\n```",
  ],
  [
    "safe environment YAML in an unknown-language fence",
    "```text\nenvironment:\n  PORT: 80\n  PUBLIC_ORIGIN: https://safe.example\n```",
  ],
  [
    "safe ports YAML inside nested unknown-language fences",
    "````text\n```text\nports:\n  - published: 3000\n    target: 80\n    host_ip: 127.0.0.1\n```\n````",
  ],
  [
    "ordinary prose inside nested unknown-language fences",
    "````text\n```text\nProduction deployment variables are discussed below.\n```\n````",
  ],
  [
    "ordinary prose with crossed unknown fence closure",
    "````text\n```text\nProduction deployment variables are discussed below.\n````",
  ],
] as const;

const unknownTextFenceSourcePolicy = [
  [
    "accepts top-level environment prose in an unknown text fence",
    "```text\nenvironment: production variables are discussed below.\n```",
    false,
  ],
  [
    "accepts top-level ports prose in an unknown text fence",
    "```text\nports: production bindings are discussed below.\n```",
    false,
  ],
  [
    "rejects nested unsafe environment YAML in an unknown text fence",
    "```text\nservices:\n  app:\n    environment:\n      PORT: 3000\n```",
    true,
  ],
  [
    "rejects nested unsafe ports YAML in an unknown text fence",
    "```text\nservices:\n  app:\n    ports:\n      - published: 3000\n        target: 80\n        host_ip: 0.0.0.0\n```",
    true,
  ],
] as const;

const sourcePolicyStructuralRecovery = [
  [
    "rejects malformed raw content in a known YAML fence despite a nested text fence",
    "```yaml\n```text\nplain words\n```",
    true,
  ],
  [
    "rejects an indented unsafe environment after prose in an unknown text fence",
    "```text\nx\n    environment:\n      PORT: 3000\n```",
    true,
  ],
  [
    "rejects an indented unsafe ports block after prose in an unknown text fence",
    "```text\nx\n    ports:\n      - published: 3000\n        target: 80\n        host_ip: 0.0.0.0\n```",
    true,
  ],
  [
    "rejects an indented unsafe environment after prose in a no-language fence",
    "```\nx\n    environment:\n      PORT: 3000\n```",
    true,
  ],
  [
    "rejects an indented unsafe ports block after prose in a no-language fence",
    "```\nx\n    ports:\n      - published: 3000\n        target: 80\n        host_ip: 0.0.0.0\n```",
    true,
  ],
  [
    "accepts indented environment prose after prose in an unknown text fence",
    "```text\nx\n    environment: production variables are discussed below.\n```",
    false,
  ],
  [
    "accepts indented ports prose after prose in a no-language fence",
    "```\nx\n    ports: production bindings are discussed below.\n```",
    false,
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

  it.each(unsafeComposeEnvironments)("rejects %s", (_label, environment) => {
    expect(() => validate(environment)).toThrow(
      /permits an insecure public application backend/,
    );
  });

  it.each(unsafePortMappings)("rejects %s", (_label, mapping) => {
    expect(() => validate(mapping)).toThrow(
      /permits an insecure public application backend/,
    );
  });

  it.each(unsafeIndentedYamlRoots)("rejects %s", (_label, yaml) => {
    expect(() => validateAtDocumentStart(yaml)).toThrow(
      /permits an insecure public application backend/,
    );
  });

  it.each(unsafeMarkdownYamlBlocks)("rejects %s", (_label, yaml) => {
    expect(() => validate(yaml)).toThrow(
      /permits an insecure public application backend/,
    );
  });

  it.each(unsafeUnknownFenceBodies)("rejects %s", (_label, fencedBody) => {
    expect(() => validate(fencedBody)).toThrow(
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

  it.each(validComposeEnvironments)("accepts %s", (_label, environment) => {
    expect(() => validate(environment)).not.toThrow();
  });

  it.each(validPortMappings)("accepts %s", (_label, mapping) => {
    expect(() => validate(mapping)).not.toThrow();
  });

  it.each(validYamlDocuments)("accepts %s", (_label, documents) => {
    expect(() => validate(documents)).not.toThrow();
  });

  it.each(unknownTextFenceSourcePolicy)("%s", (_label, fencedBody, rejects) => {
    const validation = () => validate(fencedBody);
    if (rejects) {
      expect(validation).toThrow(
        /permits an insecure public application backend/,
      );
    } else {
      expect(validation).not.toThrow();
    }
  });

  it.each(sourcePolicyStructuralRecovery)(
    "%s",
    (_label, fencedBody, rejects) => {
      const validation = () => validate(fencedBody);
      if (rejects) {
        expect(validation).toThrow(
          /permits an insecure public application backend/,
        );
      } else {
        expect(validation).not.toThrow();
      }
    },
  );
});
