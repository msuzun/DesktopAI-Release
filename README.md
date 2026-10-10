# AI Desktop Companion

An experimental Windows desktop companion for voice conversation, permission-based screen context, and optional local visual memory. React and TypeScript provide an English/Turkish interface; Tauri and Rust own capture, credentials, provider transport, memory, and action policy.

**LAYA and JEV are BETA / EXPERIMENTAL.** Neither is production-ready or fully supported. The project license is a [draft awaiting owner approval](LICENSE); this preparation does not authorize publication or grant a new project license.

## Architecture and capabilities

| Component                        | Responsibility and limits                                                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home, Memory, Settings           | Conversation, independent provider setup, local records, English/Turkish UI; diagnostics are in Developer Mode.                                                   |
| Windows Graphics Capture / D3D11 | Owns screen pixels, capture times, snapshot identity, recent events, and established references. Windows only.                                                    |
| Current screen mode              | Selects current context after finalized transcription, immediately before response preparation. Independent of LAYA; does not answer historical-screen questions. |
| LAYA — BETA / EXPERIMENTAL       | Optional local visual-intent routing among current, recent, and established historical references. Temporal/reference accuracy has not passed acceptance.         |
| JEV — BETA / EXPERIMENTAL        | Optional remote action-intent classification after Actions opt-in. It is not a visual router or command authority.                                                |
| AI providers                     | Independent reasoning, recognition, and synthesis through native OpenAI Realtime/Gemini Live adapters or composed HTTP profiles.                                  |
| ActionPolicy / ActionExecutor    | Native policy, immutable candidate validation, explicit confirmation, and bounded execution. Real execution remains disabled.                                     |
| Persistent Memory                | Opt-in SQLite metadata and JPEG assets, bookmarks, retention, label search, and deletion. Separate from conversation history.                                     |
| Optional .NET broker             | Development-only browser voice credential service; unnecessary for the native application.                                                                        |

```text
Finalized user text + permitted sources
  -> Current screen selection OR local LAYA visual-intent routing
  -> native context preparation -> independent reasoning provider

Composed voice: selected recognizer -> text -> reasoning -> selected synthesis
Native voice: OpenAI Realtime or Gemini Live adapter

Explicit action request -> JEV classification -> structured candidate
  -> native ActionPolicy -> dedicated UI confirmation -> ActionExecutor
```

LAYA receives bounded user text, availability flags, and at most 1,024 UTF-8 bytes of prior finalized user text when a valid reference exists. It receives no pixels, OCR, window titles, assistant prose, or full transcript. JEV stays outside visual routing. Provider tool output cannot authorize OS actions or choose new screenshots.

Visual routes are `NONE`, `CURRENT`, `CURRENT_EXACT`, `RECENT`, `RECENT_EXACT`, `FOLLOW_UP_EXACT`, and `COMPARE_RECENT_CURRENT`. Missing history, routing failures, and expired references never silently substitute Current. Overview JPEGs adapt to provider byte budgets; exact PNG detail remains lossless. Permission, cancellation, source identity, freshness, and image acknowledgment checks remain enforced.

## Install and configure

Supported build target: **Windows x64, MSVC** with Windows Graphics Capture, D3D11, and a compatible graphics driver. Other platforms and Windows ARM64 are unverified.

Install Node.js and npm using the version in [.node-version](.node-version) (24.21.0), the Rust toolchain in [rust-toolchain.toml](rust-toolchain.toml) (1.93.0; resolved minimum 1.90), Visual Studio C++ build tools with Windows SDK, and Microsoft WebView2 Runtime. Python, downloaded models, .NET, and cloud credentials are not required to compile the native application.

```powershell
npm ci
npm run tauri -- dev
```

In **Settings → AI provider**, choose a native provider or add a composed profile, save a key in the masked editor, select the model, and explicitly test the connection. A connection test may incur charges and does not validate voice or screen understanding.

| Path                 | Configuration                                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI Realtime      | Native adapter; bundled default `gpt-realtime-2.1`.                                                                                                                           |
| Google Gemini Live   | Native adapter; bundled default `gemini-3.8-live`. Controlled screen-aware native turns are unavailable until finalized transcription before response release is established. |
| Composed reasoning   | Compatible Chat Completions or Anthropic Messages endpoint, model, key, and explicit capability flags.                                                                        |
| Composed recognition | Independently selected compatible `/audio/transcriptions` endpoint.                                                                                                           |
| Composed synthesis   | Independently selected compatible `/audio/speech` endpoint.                                                                                                                   |

Catalog entries do not guarantee ongoing provider availability, pricing, quotas, or capabilities. Remote URLs require HTTPS and normal certificate validation; explicitly configured loopback providers may use HTTP. Redirects and credential-bearing URLs are restricted. Vision, multiple images, and streaming require explicit profile/model capabilities. Provider replacement is explicit, with no automatic failover.

Provider switching transfers at most 12 completed messages / 16,000 characters of normalized conversation text. Images, audio, tool payloads, partial responses, and cancelled output are excluded. This history is in memory; Stop clears it.

### Optional local LAYA

Install Windows x64 Python 3.13 and `uv`, then explicitly acquire the CPU runtime and multilingual checkpoint:

```powershell
.\tools\laya\setup.ps1 -Checkpoints multilingual
```

Default development locations are ignored `src-tauri/target/laya-runtime` and `src-tauri/target/laya-models`. For a durable installation outside build output:

```powershell
$layaRoot = Join-Path $env:LOCALAPPDATA 'DesktopAI-Laya'
.\tools\laya\setup.ps1 -Checkpoints multilingual -RuntimeDirectory (Join-Path $layaRoot 'runtime') -ModelDirectory (Join-Path $layaRoot 'models')
```

In Developer Mode, configure the resulting `Scripts/python.exe`, checkpoint directory, matching checkpoint, and CPU device, then select **Prepare local model**. CUDA is unverified. [requirements-cpu.lock.txt](tools/laya/requirements-cpu.lock.txt) and [requirements-torch.lock.txt](tools/laya/requirements-torch.lock.txt) pin wheels and hashes. [models.lock.json](tools/laya/models.lock.json) pins model revisions, artifact integrity, route order, and presentation. Required adapted tensors and their license/NOTICE remain in `tools/laya/adapters/`.

Setup downloads from PyPI, the PyTorch CPU index, and Hugging Face only during explicit acquisition. It accepts pinned Windows x64 CPython 3.13 wheels, rejects source builds and unpinned resolution, and checks dependency compatibility. No model download occurs at startup or inference. Model integrity failure never silently selects another model or Current screen.

One resident worker admits one inference with no queue. Stop, replacement, and permission changes cancel/release work; stale physical inference may drain before cleanup. Initialization/inference deadlines are bounded and failures require explicit preparation to retry. Offline flags and a Python socket audit hook constrain networking; they are not an OS sandbox for native libraries.

### Optional development broker

The `apps/api/` broker uses .NET 10 (verified SDK 10.0.400) with no NuGet package references. Run `npm run broker` with a process-local `OPENAI_API_KEY`. [.env.example](.env.example) is a template; neither the broker nor the native app automatically loads it.

The broker is Development-only and binds IPv4 loopback port 4317. It checks Host/origin/client marker, rate-limits credential requests, prevents upstream redirects, and hides raw upstream failures. It is unauthenticated and must not be exposed on a LAN or deployed publicly. Frontend port 1420 and broker port 4317 are shared development defaults; change client, server, and CSP settings together. The native application does not need the broker.

## Privacy and action boundaries

**Screen Awareness, Memory, and Actions start off and require separate opt-ins.** Screen permission does not authorize saving or actions. Frequent screen perception is local; only selected permitted context is sent to the chosen reasoning provider. The application as a whole is not offline.

| Data                                      | Destination                                      |
| ----------------------------------------- | ------------------------------------------------ |
| Microphone audio                          | Selected recognizer or native realtime provider. |
| Final transcript and permitted images     | Selected reasoning provider.                     |
| Assistant text for speech                 | Selected synthesis provider.                     |
| Bounded visual-intent input               | Local LAYA worker.                               |
| Explicit action text after Actions opt-in | JEV at `https://api.typesafe.ai/v1/systemone`.   |
| Saved Memory metadata/images              | Local app data; no automatic upload.             |

Native adapters contact OpenAI `api.openai.com` and Google `generativelanguage.googleapis.com`; custom profiles contact their configured endpoints. Credentials use **Windows Credential Manager**, not the frontend bundle or memory database. Saved keys are not redisplayed. JEV development lookup checks `JEV_API_KEY`, then `TYPESAFE_API_KEY`, then its saved key. Never put secrets in `VITE_` variables, tracked configuration, logs, or source control.

Memory uses `app_local_data_dir()/memory`: SQLite migrations plus SHA-256-addressed JPEG assets. Corrupt/unsupported data is preserved; one process owns a library at a time. Saving requires an active companion and screen/memory permission. Automatic saving requires another opt-in and is limited to one significant completed visual event per minute. Defaults are seven days and 256 MiB; bookmarks are protected, and a full protected budget stops saving. Memory is not additionally encrypted; deletion is logical, not forensic erasure. OCR, semantic/vector search, saved-memory AI questions, encryption, import/export, and Turkish-aware case folding are unimplemented.

For separate provider configuration and memory, set `COMPANION_PROFILE` to a new UUID before launch. Those stores use `app_local_data_dir()/profiles/<uuid>/providers-v1.json` and `.../memory/`; an invalid UUID disables them. This does not relocate Credential Manager or isolate an OS/browser account. Unset the variable to return to the default profile.

Actions are off by default. Review opt-in allows JEV classification and candidate review; `REAL_EXECUTION_ACCEPTED` remains false. Dedicated confirmation binds an immutable candidate to its digest, epoch, turn, executable hash, arguments, directory, content, and 30-second expiry. Changed, expired, revoked, or consumed candidates cannot be reused. Stop, cancellation, replacement, and permission changes revoke pending work. Speech, model output, and quoted instructions cannot approve actions.

The bounded executor recognizes fixed applications/terminals and exact synthetic command/script demonstrations. Arbitrary commands, user scripts, destructive actions, elevation, autonomous loops, and security-software modifications are unsupported. JEV classification and AI reasoning cannot bypass native ActionPolicy.

## Dependency inventory

Versions are resolved lockfile versions, not manifest ranges. License identifiers come from package/crate metadata; review upstream license files and transitive notices before redistribution. Lockfiles contain the full dependency graph. Providers use HTTP, WebSocket, or WebRTC; no separate OpenAI, Google, Anthropic, or JEV SDK is bundled.

### JavaScript / TypeScript

<!-- NODE_DEPENDENCIES -->

| Direct dependency      | Version | Purpose                                            | Declared license  |
| ---------------------- | ------- | -------------------------------------------------- | ----------------- |
| `@tauri-apps/api`      | 2.12.2  | Runtime: Native command bridge                     | Apache-2.0 OR MIT |
| `i18next`              | 26.4.3  | Runtime: Translations                              | MIT               |
| `react`                | 19.3.0  | Runtime: UI components                             | MIT               |
| `react-dom`            | 19.3.0  | Runtime: DOM rendering                             | MIT               |
| `react-i18next`        | 17.0.16 | Runtime: React translation binding                 | MIT               |
| `@tauri-apps/cli`      | 2.12.1  | Build/development: Tauri development/release build | Apache-2.0 OR MIT |
| `@types/react`         | 19.3.0  | Build/development: React type definitions          | MIT               |
| `@types/react-dom`     | 19.3.0  | Build/development: DOM type definitions            | MIT               |
| `@vitejs/plugin-react` | 4.7.0   | Build/development: React build transform           | MIT               |
| `prettier`             | 3.9.10  | Build/development: Formatting                      | MIT               |
| `typescript`           | 5.8.3   | Build/development: Type checking                   | Apache-2.0        |
| `vite`                 | 6.4.4   | Build/development: Frontend development/bundling   | MIT               |

<!-- END_NODE_DEPENDENCIES -->

### Rust / Tauri

<!-- RUST_DEPENDENCIES -->

| Direct dependency | Version | Purpose                                               | Declared license  |
| ----------------- | ------- | ----------------------------------------------------- | ----------------- |
| `base64`          | 0.23.1  | Image/audio transport encoding                        | MIT OR Apache-2.0 |
| `image`           | 0.24.9  | JPEG/PNG encoding and resizing                        | MIT OR Apache-2.0 |
| `reqwest`         | 0.12.28 | Native HTTPS provider/JEV transport (rustls)          | MIT OR Apache-2.0 |
| `rusqlite`        | 0.40.2  | Local SQLite memory, bundled engine                   | MIT               |
| `serde`           | 1.0.229 | Typed serialization                                   | MIT OR Apache-2.0 |
| `serde_json`      | 1.0.151 | JSON contracts                                        | MIT OR Apache-2.0 |
| `sha2`            | 0.10.9  | Asset and executable integrity                        | MIT OR Apache-2.0 |
| `tauri`           | 2.12.2  | Native app, IPC, WebView lifecycle                    | Apache-2.0 OR MIT |
| `tokio`           | 1.53.1  | Async synchronization, deadlines, runtime integration | MIT               |
| `uuid`            | 1.26.1  | Record/request/profile identities                     | Apache-2.0 OR MIT |
| `zeroize`         | 1.9.0   | Secret memory clearing                                | Apache-2.0 OR MIT |
| `tauri-build`     | 2.7.1   | Build-time Tauri resources/configuration              | Apache-2.0 OR MIT |
| `keyring`         | 3.6.3   | Windows Credential Manager (Windows)                  | MIT OR Apache-2.0 |
| `windows`         | 0.61.3  | Windows capture, D3D11, COM and native APIs (Windows) | MIT OR Apache-2.0 |

<!-- END_RUST_DEPENDENCIES -->

MSVC, Windows SDK, and WebView2 are external prerequisites. Bundled SQLite and native build helpers run compiler/build steps. React/Vite tooling includes native esbuild/Rollup/Tauri CLI executables. The reviewed install script is limited to `esbuild@0.25.12`, which selects/verifies its matching binary. Review version changes before approving new dependency scripts; installation runs code with the current user’s privileges.

### Optional Python runtime

| Direct dependency | Version    | Purpose                         | Declared license                                                                                    |
| ----------------- | ---------- | ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `laya`            | 0.3.6      | Local visual-intent model       | Apache-2.0                                                                                          |
| `torch`           | 2.14.0+cpu | CPU tensor/model execution      | Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause AND BSD-3-Clause AND BSL-1.0 AND MIT |
| `safetensors`     | 0.8.0      | Verified tensor/adapter loading | Apache-2.0                                                                                          |
| `psutil`          | 7.2.2      | Worker resource diagnostics     | BSD-3-Clause                                                                                        |

The closure contains 37 runtime packages (four direct imports and 33 transitive dependencies), including Transformers, tokenizers, Hugging Face tooling, numerical libraries, and metadata helpers. The pinned requirements are authoritative. Python and `uv` are external setup tools; CPU PyTorch is a native runtime. Model compatibility must be revalidated before upgrading this environment; initialization enforces LAYA 0.3.6.

The optional [.NET runtime](https://github.com/dotnet/runtime/blob/main/LICENSE.TXT) uses MIT; the broker has no NuGet dependencies. Windows SDK, MSVC, and WebView2 have their own Microsoft terms. Cloud services, including JEV, are independent services, not bundled open-source packages.

### Dependency limitations

Compatibility pins do not mean every package is current. Major updates to TypeScript, Vite, React’s Vite plugin, image, reqwest, sha2, keyring, and Windows bindings require migration and capture/codec/TLS/credential validation. Multiple Windows binding families remain because application capture and Tauri have incompatible upstream requirements.

Strict full-lock RustSec auditing remains blocked by `glib 0.18.5` (`RUSTSEC-2024-0429`, soundness) and `proc-macro-error 1.0.4` (`RUSTSEC-2024-0370`, unmaintained) in Tauri’s Linux/BSD GTK tree. They are absent from the Windows build graph but remain in the lockfile; no warnings are ignored. Linux/BSD builds are not supported release targets. See final acceptance for the actual scan results.

## Validation and portable Windows build

Run the retained checks from the repository root:

```powershell
npm ci
npm run format:check
npm run check
npm run build
npm audit --audit-level=moderate
npm run scan:secrets -- --self-test
npm run scan:secrets -- --history --strict-privacy
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo audit --file src-tauri/Cargo.lock --deny warnings
dotnet build apps/api/Companion.Broker.csproj --configuration Release
dotnet format apps/api/Companion.Broker.csproj --verify-no-changes
dotnet list apps/api/Companion.Broker.csproj package --vulnerable --include-transitive
```

Install `cargo-audit` separately; .NET checks apply only to the optional broker. The [Windows CI workflow](.github/workflows/ci.yml) runs retained automated checks. A workflow definition is not evidence of a successful remote run. Former test suites, fixtures, mock servers, benchmarks, and training experiments are absent; earlier internal results are not continuing regression coverage. Live providers, physical audio, model quality, GPU/display variations, and security-product behavior require separate acceptance. No billable service tests run automatically.

Build a portable executable with `npm run portable`, or explicitly choose a fresh output directory:

```powershell
$releaseTarget = Join-Path $PWD ('src-tauri/target/release-' + [guid]::NewGuid().ToString('N'))
.\tools\build-portable.ps1 -TargetDirectory $releaseTarget
if ($LASTEXITCODE -ne 0) { throw 'Release build failed; inspect the first failure.' }
$portableExe = Join-Path $releaseTarget 'release/ai-desktop-companion.exe'
Get-FileHash -LiteralPath $portableExe -Algorithm SHA256
& $portableExe
```

The helper requires a fresh directory under `src-tauri/target`, rejects junction/symlink ancestors, and remaps Rust source paths for the repository, Cargo/Rustup caches, and user directory. It does not edit executable bytes or change security settings. Native library strings, generated literals, and linker metadata still require a final artifact privacy scan. Use `CARGO_ENCODED_RUSTFLAGS` for custom compiler arguments; unparsed shell-style `RUSTFLAGS` are rejected. Direct Cargo/Tauri builds can embed absolute source paths.

Tauri builds the frontend before Cargo; installer bundling is disabled. Copying the executable does not install WebView2 or carry the optional Python/model environment. Credentials/memory remain in the Windows user’s app data; worker/spec resources are embedded. The executable is unsigned. Signing, installer acceptance, broad Windows compatibility, and byte-for-byte reproducibility are unestablished.

Record toolchain versions, source/lockfile hashes, the first failed build stage, executable size/SHA-256, privacy scan findings, and actual moved-executable startup/shutdown results. Avoid running an older executable from the target directory while relinking.

### Windows build and security-product investigation

An earlier remapped build failed before the required `windows_x86_64_msvc 0.52.6` dependency’s `build-script-build.exe` could execute, with Windows access denied (`os error 5`). This helper is used by essential Windows resource/source traversal dependencies. Generic access-denied or file-lock errors do not establish antivirus causation. Current reproduction, cause, and resolution belong in final acceptance below. Do not remove essential Windows dependencies, disable protection, add exclusions, bypass security controls, or weaken TLS checks to force a build.

## Experimental limitations and future work

**LAYA — BETA / EXPERIMENTAL:** local visual-intent routing. Temporal and reference-routing accuracy is not production-ready. Future versions will improve reliability and performance; no latency or accuracy guarantee is made. The retained adapter historically scored 72/140 overall (51.43%), 41/80 temporal (51.25%), and 28/60 exactness (46.67%) on an internal bilingual evaluation. These fail the quality gate. The automatic quality gate remains closed; Current screen mode works independently. These historical results have not been reproduced by this checkout.

The public source snapshot retains runtime/model integrity metadata and required adapter license/NOTICE. Prior experimental corpora, reports, benchmarks, and internal development history are not included; this repository cannot reproduce those former studies.

**JEV — BETA / EXPERIMENTAL:** action-intent classification. Real command execution and voice-action workflows are not fully validated. Future releases will improve safety, accuracy, and integration. Candidate review is not complete desktop automation, and real execution remains disabled regardless of the review setting.

Additional unverified capabilities include live-provider compatibility, physical microphone/speaker workflows, CUDA, other monitor/DPI configurations, and broad GPU/Windows compatibility. Improve these through explicit acceptance without weakening permission, integrity, or action gates.

## Contributing, security, and licensing

Keep changes focused and preserve source identity, local visual routing, independent privacy permissions, TLS verification, credential storage, and native action authority. Run retained checks and report actual manual acceptance separately. Add focused regression validation when developing behavior. Do not commit API keys, personal paths, transcripts, screen captures, databases, downloaded base models/runtimes, or build output. `.gitignore` excludes common local artifacts; it does not replace reviewing staged files or scanning history. Keep original-history backups and release-preparation evidence outside the public repository.

Use GitHub private vulnerability reporting when enabled. Otherwise request a private channel with a general description; do not post credentials or sensitive screen content in public issues. A scan cannot prove that no undiscovered secret exists.

**Project licensing remains pending owner approval.** [LICENSE](LICENSE) is an explicitly unapproved MIT draft with year/holder placeholders, not an applied license or a claim of ownership. The owner must approve the license and attribution before public distribution. Required adapter [Apache-2.0 text](tools/laya/adapters/LICENSE-APACHE-2.0.txt) and [NOTICE](tools/laya/adapters/NOTICE) remain; they do not license unrelated application code. Complete transitive notice review before redistribution.

## M14 acceptance

<!-- M14_ACCEPTANCE -->

**M14 NOT RELEASE READY — 2026-10-10.** This source candidate has a fresh initial Git commit with a generic release-preparation identity. It contains no imported development commits, remote configuration, history backups, or private acceptance artifacts. The original repository was preserved; separate local history bundles were restored and passed full Git integrity checks with every backed-up ref matching.

The audit covered all 16 upstream branches (no upstream tags) plus the original local refs: 42 unique commits, 938 unique blobs, commit metadata, and historical filenames. The expanded backup preserves all 19 combined refs. The 90 historical path occurrences identified a developer home directory and experiment-artifact layout; they were personal information, not credentials. Personal author/committer metadata was also present. Neither was carried into this public history. Fresh source/history scans and a separate metadata/known-identifier review found no confirmed secrets or personal-data findings in this candidate. No credential requiring rotation was identified. Scans are pattern-based and do not prove universal absence. Upstream histories were fetched only into a separate private audit repository; the original repository and its refs were not changed.

[LICENSE](LICENSE) remains an unapproved MIT draft. Owner approval of the license, year, and actual copyright holders is required before distribution; third-party notice review also remains open.

A fresh remapped Windows build reproduced the process-launch failure for `windows_x86_64_msvc 0.52.6`: `build-script-build.exe` was never executed because Windows returned access denied (`os error 5`). Both generated executable copies subsequently disappeared. Inspected directory permissions had no deny rules; checked inputs had no Mark-of-the-Web; dependency archives and extracted sources matched locked integrity values. These observations are consistent with security interference but do not establish its cause. No matching contemporary Kaspersky or Windows enforcement event was available. A historical Kaspersky detection for a different helper version is not proof of this failure or of a false positive. Essential dependencies remain intact; no confirmed safe code fix was established and no protection was bypassed.

**Final portable executable: not produced. Size and SHA-256: unavailable.** Consequently, startup, shutdown, basic UI, English/Turkish runtime behavior, configuration persistence, and final binary privacy scanning were not performed on an M14 executable. The retained source-path-remapping helper is not proof of a privacy-clean binary.

Locked npm installation, TypeScript, frontend production build, formatting, strict Clippy, broker build/format/advisory checks, Python syntax, and security-scanner checks passed. npm reported zero vulnerabilities. Strict Rust auditing still fails on upstream GTK dependencies `proc-macro-error 1.0.4` (`RUSTSEC-2024-0370`, unmaintained) and `glib 0.18.5` (`RUSTSEC-2024-0429`, unsound), with zero vulnerability entries. These warning dependencies are absent from the Windows target graph but remain in the lockfile, are not suppressed, and continue to block CI. No remote CI or removed test suite is claimed to have run.

Release blockers are the unapproved project license, unresolved Windows release build and portable acceptance, and strict Rust audit warnings. LAYA/JEV quality and workflow limitations remain explicitly experimental; real action execution stays disabled. No push or publication was performed.

<!-- END_M14_ACCEPTANCE -->
