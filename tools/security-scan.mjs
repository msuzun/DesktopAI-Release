import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

// Findings contain locations, classes and fingerprints, never matched values.
const root = process.cwd();
let scanStage = "arguments";
const args = process.argv.slice(2);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const rules = [
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["openai-style-key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g],
  [
    "github-token",
    /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g,
  ],
  ["aws-access-key-id", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ["stripe-live-key", /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g],
  [
    "private-key-material",
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]{20,}?-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g,
  ],
];
const textRules = [
  [
    "credential-in-url",
    /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\x00-\x20\x7f:@\/]{1,100}:[^\x00-\x20\x7f@\/]{3,200}@[^\x00-\x20\x7f"'<>]+/g,
  ],
  [
    "literal-secret-assignment",
    /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|secret[_-]?key)\s*["']?\s*[:=]\s*["']([^"'\r\n]{12,})["']/gi,
  ],
  [
    "environment-secret-assignment",
    /^[ \t]*(?:export[ \t]+)?(?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|PASSWORD|SECRET_KEY)[ \t]*=[ \t]*(?:["']([^"'\r\n]{12,})["']|([^\s"'#]{12,}))[ \t]*(?:#.*)?$/gim,
  ],
  [
    "jwt-like-token",
    /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{16,}\b/g,
  ],
];
// These exact historical synthetic fixtures test credential rejection/redaction;
// the environment template has one separately fingerprinted placeholder.
// Keep their fingerprints after test cleanup so history scans stay meaningful.
// A changed value, another path, or any other credential is a blocking finding.
const fixtures = new Map([
  [
    ".env.example:environment-secret-assignment",
    new Set([
      "99d963c43cd75cce6fc122644d70d0ce79f52c939f9ab50d2da93fde7844c610",
    ]),
  ],
  [
    "src-tauri/src/ai_provider/tests.rs:credential-in-url",
    new Set([
      "7ebecee896fb2fcad2c9491a343e73d38c66857bd77bd46ee1b1c2db172c0103",
      "245d7408cf9309f13d71c800c1bea998316a44557319d3d9e25c27af5d1286b6",
    ]),
  ],
  [
    "tests/product-preferences.test.mjs:literal-secret-assignment",
    new Set([
      "079f0ae49ddf08d48e337692aece184d753a9ee56a68fdd72822362344e6dfa2",
    ]),
  ],
  [
    "tests/voice/provider.test.mjs:literal-secret-assignment",
    new Set([
      "d7f63ea5b5f3ea3a1bd007620d20c28741d3d630acf2fbc83c32c902039f0fb6",
    ]),
  ],
  [
    "tests/voice/openai-screen.test.mjs:literal-secret-assignment",
    new Set([
      "cd481ae0bd3091c69ed263d936069d5fdff7f2a6cb26f68db25f16263296b957",
    ]),
  ],
  [
    "tests/voice/universal-profiles.test.mjs:literal-secret-assignment",
    new Set([
      "27e026f0bbe9bc360c60592847ecd2dec132dff40955e8798c5f254ee4bc6a13",
    ]),
  ],
]);
const findings = [],
  warnings = [],
  acceptedFixtures = [],
  lockedAssets = [];
function decodeContent(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return { source: bytes.subarray(2).toString("utf16le"), binary: false };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = Buffer.from(
      bytes.subarray(2, bytes.length - (bytes.length % 2)),
    );
    return { source: body.swap16().toString("utf16le"), binary: false };
  }
  return {
    source: bytes.toString("utf8").replace(/^\uFEFF/, ""),
    binary: bytes.includes(0),
  };
}
function scan(bytes, file, scope, extra = {}) {
  if (bytes.length > 64 * 1024 * 1024) {
    warnings.push({
      scope,
      file,
      category: "content-size-limit",
      bytes: bytes.length,
      ...extra,
    });
    return;
  }
  const { source, binary } = decodeContent(bytes);
  for (const [category, pattern] of [...rules, ...(binary ? [] : textRules)]) {
    for (const match of source.matchAll(pattern)) {
      const fingerprint = sha(Buffer.from(match[1] ?? match[2] ?? match[0]));
      const finding = {
        scope,
        file,
        line: source.slice(0, match.index).split("\n").length,
        category,
        fingerprint,
        ...extra,
      };
      if (fixtures.get(`${file}:${category}`)?.has(fingerprint))
        acceptedFixtures.push({
          ...finding,
          reason:
            file === ".env.example"
              ? "exact-known-template-placeholder"
              : "exact-known-synthetic-test-fixture",
        });
      else findings.push(finding);
    }
  }
  if (!binary) {
    const absoluteUserPath =
      /(?:[A-Za-z]:[\\/]+Users[\\/]+|\/Users\/|\/home\/)[A-Za-z0-9._-]+/g;
    for (const match of source.matchAll(absoluteUserPath))
      (scope === "reachable-history" ? warnings : findings).push({
        scope,
        file,
        line: source.slice(0, match.index).split("\n").length,
        category: "developer-absolute-path",
        fingerprint: sha(Buffer.from(match[0])),
        ...extra,
      });
  }
}
function insideWorkspace(input, workspaceRoot = root) {
  const full = path.resolve(workspaceRoot, input),
    rel = path.relative(workspaceRoot, full);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    throw Error("Input/output must stay inside the repository workspace");
  // New output files still inherit the physical location of existing parents.
  // In particular, a junction must not turn a lexical child into an escape.
  let existing = full;
  while (!existsSync(existing)) existing = path.dirname(existing);
  const physical = path.relative(
    realpathSync(workspaceRoot),
    realpathSync(existing),
  );
  if (
    physical === ".." ||
    physical.startsWith(`..${path.sep}`) ||
    path.isAbsolute(physical)
  )
    throw Error("Resolved input/output escapes the workspace");
  return full;
}
function git(...parameters) {
  try {
    return execFileSync("git", parameters, {
      cwd: root,
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw Error(
      "Git read failed. Run as the repository owner; this tool never changes safe.directory or prints raw Git errors.",
    );
  }
}
const gitText = (...parameters) => git(...parameters).toString("utf8");
function selfTest() {
  const checks = [];
  const check = (name, verify) => {
    verify();
    checks.push(name);
  };
  const vendor = "sk-proj-" + "a1B2".repeat(12);
  check("vendor-secret-redaction", () => {
    scan(Buffer.from(vendor), "tests/unknown-fixture.test.mjs", "self-test");
    assert.equal(findings.at(-1).category, "openai-style-key");
    assert.ok(!JSON.stringify(findings).includes(vendor));
  });
  const key =
    "-----BEGIN " +
    "PRIVATE KEY-----\n" +
    "A".repeat(64) +
    "\n-----END " +
    "PRIVATE KEY-----";
  check("private-key-detection", () => {
    scan(Buffer.from(key), "fixture.pem", "self-test");
    assert.equal(findings.at(-1).category, "private-key-material");
  });
  const assignment = 'apiKey: "' + "unknownCredentialValue12345" + '"';
  check("unknown-fixture-is-not-exempt", () => {
    scan(
      Buffer.from(assignment),
      "tests/unknown-fixture.test.mjs",
      "self-test",
    );
    assert.equal(findings.at(-1).category, "literal-secret-assignment");
  });
  check("scanner-expression-is-not-a-secret", () => {
    const baseline = findings.length;
    scan(
      Buffer.from("const expression = /sk-(?:proj-)?[A-Za-z0-9]{32,}/g;"),
      "scanner.mjs",
      "self-test",
    );
    assert.equal(findings.length, baseline);
  });
  check("lexical-workspace-boundary", () => {
    assert.throws(() => insideWorkspace("../outside"));
  });
  const personalPath = ["C:", "Users", "synthetic-account"].join("\\");
  for (const bigEndian of [false, true]) {
    check(bigEndian ? "utf16be-content" : "utf16le-content", () => {
      const baseline = findings.length;
      const body = Buffer.from(
        [vendor, assignment, personalPath].join("\n"),
        "utf16le",
      );
      if (bigEndian) body.swap16();
      scan(
        Buffer.concat([
          Buffer.from(bigEndian ? [0xfe, 0xff] : [0xff, 0xfe]),
          body,
        ]),
        "unicode.ps1",
        "tracked-working-tree",
      );
      assert.deepEqual(
        findings.slice(baseline).map(({ category }) => category),
        [
          "openai-style-key",
          "literal-secret-assignment",
          "developer-absolute-path",
        ],
      );
    });
  }
  for (const quoted of [false, true]) {
    check(
      quoted ? "quoted-environment-secret" : "unquoted-environment-secret",
      () => {
        const baseline = findings.length;
        const value = "unknownCredentialValue12345";
        scan(
          Buffer.from("CUSTOM_API_KEY=" + (quoted ? `"${value}"` : value)),
          ".env",
          "self-test",
        );
        assert.equal(findings.length, baseline + 1);
        assert.equal(findings.at(-1).category, "environment-secret-assignment");
      },
    );
  }
  check("exact-template-placeholder-only", () => {
    const placeholder = "your_" + "key_here";
    const baseline = findings.length;
    const accepted = acceptedFixtures.length;
    scan(
      Buffer.from("OPENAI_API_KEY=" + placeholder),
      ".env.example",
      "self-test",
    );
    assert.equal(findings.length, baseline);
    assert.equal(acceptedFixtures.length, accepted + 1);
    scan(
      Buffer.from("OPENAI_API_KEY=" + placeholder),
      "other.env",
      "self-test",
    );
    scan(
      Buffer.from("OPENAI_API_KEY=" + placeholder + "changed"),
      ".env.example",
      "self-test",
    );
    assert.equal(findings.length, baseline + 2);
  });
  check("history-personal-path-is-reported", () => {
    const baseline = findings.length;
    const previousWarnings = warnings.length;
    scan(Buffer.from(personalPath), "history.txt", "reachable-history");
    assert.equal(findings.length, baseline);
    assert.equal(warnings.length, previousWarnings + 1);
  });
  for (const scope of [
    "tracked-working-tree",
    "nonignored-untracked",
    "explicit-release-input",
  ]) {
    check(`${scope}-personal-path-blocks`, () => {
      const baseline = findings.length;
      scan(Buffer.from(personalPath), "current.txt", scope);
      assert.equal(findings.length, baseline + 1);
      assert.equal(findings.at(-1).category, "developer-absolute-path");
    });
  }
  check("utf8-bom-environment-secret", () => {
    const baseline = findings.length;
    scan(
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("CUSTOM_API_KEY=" + "unknownCredentialValue12345"),
      ]),
      ".env",
      "self-test",
    );
    assert.equal(findings.length, baseline + 1);
    assert.equal(findings.at(-1).category, "environment-secret-assignment");
  });
  check("nonexistent-output-junction-boundary", () => {
    // The simulated escaped target and junction both remain inside the real
    // repository's ignored output directory; no external directory is touched.
    const base = insideWorkspace("src-tauri/target");
    mkdirSync(base, { recursive: true });
    const directory = mkdtempSync(path.join(base, "security-scan-selftest-"));
    const testRoot = path.join(directory, "workspace");
    const sibling = path.join(directory, "sibling");
    const link = path.join(testRoot, "junction");
    let linked = false;
    try {
      mkdirSync(testRoot);
      mkdirSync(sibling);
      symlinkSync(
        sibling,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
      linked = true;
      assert.throws(() =>
        insideWorkspace("junction/new-output.json", testRoot),
      );
      assert.equal(
        insideWorkspace("new-output.json", testRoot),
        path.join(testRoot, "new-output.json"),
      );
    } finally {
      if (linked) unlinkSync(link);
      // Resolve and check the actual cleanup target before recursive removal.
      const safeDirectory = insideWorkspace(directory);
      if (path.dirname(safeDirectory) !== base)
        throw Error("Unexpected self-test cleanup path");
      rmSync(safeDirectory, { recursive: true, force: true });
    }
  });
  console.log(
    JSON.stringify({
      status: "PASS",
      checks: checks.length,
      verified: checks,
      secretValuesPrinted: false,
    }),
  );
}
async function main() {
  if (args.includes("--self-test")) return selfTest();
  const options = {
    history: false,
    strictPrivacy: false,
    refs: [],
    releaseInputs: [],
    output: null,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--history") options.history = true;
    else if (args[i] === "--strict-privacy") options.strictPrivacy = true;
    else if (["--ref", "--release-input", "--output"].includes(args[i])) {
      const option = args[i],
        value = args[++i];
      if (!value || value.startsWith("-"))
        throw Error(`Missing value for ${option}`);
      if (option === "--ref") {
        options.refs.push(value);
        options.history = true;
      } else if (option === "--release-input")
        options.releaseInputs.push(insideWorkspace(value));
      else options.output = insideWorkspace(value);
    } else
      throw Error(
        "Usage: node tools/security-scan.mjs [--history] [--strict-privacy] [--ref REF] [--release-input PATH] [--output PATH] [--self-test]",
      );
  }
  scanStage = "Git inventory";
  const tracked = gitText("ls-files", "-z").split("\0").filter(Boolean);
  const untracked = gitText("ls-files", "--others", "--exclude-standard", "-z")
    .split("\0")
    .filter(Boolean);
  const lock = JSON.parse(
    readFileSync(path.join(root, "tools/laya/models.lock.json"), "utf8"),
  );
  let workingTreeFiles = 0;
  for (const file of [...new Set([...tracked, ...untracked])]) {
    scanStage = `Working tree: ${file}`;
    const full = insideWorkspace(file);
    // A tracked deletion is absent from the release tree; --history still scans
    // every reachable historical blob, including the deleted file's contents.
    if (!existsSync(full)) continue;
    const bytes = readFileSync(full);
    workingTreeFiles++;
    scan(
      bytes,
      file,
      tracked.includes(file) ? "tracked-working-tree" : "nonignored-untracked",
    );
    if (/\.(?:safetensors|gguf|onnx|pt|pth)$/i.test(file)) {
      const fingerprint = sha(bytes),
        expected = lock.visualRouterAdapter;
      if (
        file === "tools/laya/adapters/visual-router-head.safetensors" &&
        fingerprint === expected.sha256 &&
        bytes.length === expected.size
      )
        lockedAssets.push({
          file,
          sha256: fingerprint,
          bytes: bytes.length,
          reason: "required-adapter-matches-exact-lock",
        });
      else
        findings.push({
          scope: "working-tree",
          file,
          category: "unapproved-model-artifact",
          fingerprint,
        });
    }
    if (/\.(?:sqlite|sqlite3|db)(?:-(?:wal|shm))?$/i.test(file))
      findings.push({
        scope: "working-tree",
        file,
        category: "unapproved-persistent-database",
        fingerprint: sha(bytes),
      });
  }
  let historyCommits = 0,
    historyBlobs = 0;
  if (options.history) {
    scanStage = "Reachable history";
    const refs = options.refs.length ? options.refs : ["--all"];
    historyCommits = gitText("rev-list", ...refs)
      .trim()
      .split("\n")
      .filter(Boolean).length;
    const objects = gitText("rev-list", "--objects", ...refs)
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf(" ");
        return {
          oid: at < 0 ? line : line.slice(0, at),
          file: at < 0 ? "" : line.slice(at + 1),
        };
      });
    const metadata = execFileSync(
      "git",
      ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      {
        cwd: root,
        input: objects.map(({ oid }) => oid).join("\n") + "\n",
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
      .trim()
      .split("\n");
    for (let i = 0; i < objects.length; i++) {
      const [oid, type, bytes] = metadata[i].split(" ");
      if (type !== "blob") continue;
      historyBlobs++;
      if (+bytes > 64 * 1024 * 1024)
        warnings.push({
          scope: "reachable-history",
          file: objects[i].file,
          oid,
          category: "content-size-limit",
          bytes: +bytes,
        });
      else
        scan(
          git("cat-file", "blob", oid),
          objects[i].file,
          "reachable-history",
          { oid },
        );
    }
  }
  const releaseInputs = [];
  function releaseInput(full) {
    scanStage = `Release input: ${path.relative(root, full)}`;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(full, { withFileTypes: true })) {
        if (entry.isSymbolicLink())
          throw Error("Release input symlinks are not followed");
        releaseInput(path.join(full, entry.name));
      }
      return;
    }
    const bytes = readFileSync(full),
      file = path.relative(root, full).replaceAll("\\", "/");
    scan(bytes, file, "explicit-release-input");
    releaseInputs.push({ file, bytes: bytes.length, sha256: sha(bytes) });
  }
  for (const input of options.releaseInputs) {
    if (!existsSync(input))
      throw Error("Explicit release input does not exist");
    releaseInput(input);
  }
  const blockingPrivacyWarnings = options.strictPrivacy
    ? warnings.filter(({ category }) => category === "developer-absolute-path")
        .length
    : 0;
  const failed = findings.length > 0 || blockingPrivacyWarnings > 0;
  const result = {
    status: failed ? "FINDINGS" : "PASS_WITH_LIMITATIONS",
    strictPrivacy: options.strictPrivacy,
    blockingPrivacyWarnings,
    observedUtc: new Date().toISOString(),
    trackedFiles: tracked.length,
    workingTreeFiles,
    nonignoredUntrackedFiles: untracked.length,
    historyCommits,
    uniqueHistoryBlobs: historyBlobs,
    releaseInputs,
    findings,
    warnings,
    acceptedFixtures,
    lockedAssets,
    secretValuesPrinted: false,
    limitations: [
      "Explicit-pattern scan, not proof of absence of every secret or personal datum.",
      "History mode scans reachable file blobs; commit/tag identity metadata, ref names, and machine identifiers require separate review.",
      "Only locally reachable requested Git refs are inspected; no fetch, history rewrite or credential-store access.",
      "Ignored files are excluded unless explicitly supplied with --release-input. Files over 64 MiB receive a size warning.",
      "UTF-8 and BOM-marked UTF-16 text receive all checks. Other binary inputs receive vendor-token/private-key checks; generic assignment/URL/JWT checks apply to text files to avoid arbitrary binary string concatenations.",
    ],
  };
  const json = JSON.stringify(result, null, 2) + "\n";
  if (options.output) writeFileSync(options.output, json);
  console.log(json);
  process.exitCode = failed ? 1 : 0;
}
try {
  await main();
} catch (error) {
  console.error(
    JSON.stringify({
      status: "ERROR",
      errorType: error.name,
      code: error.code ?? null,
      stage: scanStage,
      message:
        "Scan failed. Check arguments, workspace input paths, model-lock JSON and Git repository ownership. Raw error details are withheld.",
      secretValuesPrinted: false,
    }),
  );
  process.exitCode = 2;
}
