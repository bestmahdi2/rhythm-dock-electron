# Rhythm Dock — repository improvement plan

Audit date: 2026-10-23. Baseline: `a6fdaea53aa9e974c40900d0785860e29404e758`, master, v1.7.4.

Repository: https://github.com/bestmahdi2/rhythm-dock-electron

Status: future work only. This document does not change source, GitHub settings, issues or deployments.

## Assessment and review scope

The project already has a substantial desktop player, a separated main/preload/renderer structure, an optional room server, data-preservation tests and successful packaging across seven platform/architecture targets. The best next investment is consistency: accurate instructions, maintained runtimes, contributor onboarding, pull-request checks and predictable releases.

Reviewed the public repository and live API metadata, releases, recent workflow outcomes and community profile; inspected local tracked structure, README/documentation, manifests, packaging/release scripts, workflows, test entry points, Electron window/preload configuration and selected desktop/server services. Remote master matched the local baseline. There are 158 tracked files. Large implementation modules received targeted inspection, not a line-by-line correctness proof of every path.

This is a repository-wide planning review, not an exhaustive security audit, dependency vulnerability scan, license clearance or runtime test on every OS. Admin-only settings, effective protection rules, Pages deployment and enabled security alerts were not verified. Public feature flags do not prove that a Wiki or Project contains useful content. The search-engine copy of the homepage was stale; current facts below came from live GitHub API responses.

## Verified findings

| Finding | Evidence | Recommended response |
| --- | --- | --- |
| Releases already work | v1.7.4 is published with 25 uploaded assets; its workflow succeeded | Improve visibility and download guidance |
| Missing community files | Community API detects README/license, but no contribution guidance, conduct file or issue/PR templates | Add useful onboarding, not badges alone |
| No PR workflow trigger | release.yml triggers on pushes, version tags and manual dispatch | Add safe fork-PR validation |
| UI checks outside CI command | npm test omits separate player/playlist/settings layout and UI-smoke scripts | Add an appropriate UI validation tier |
| Full matrix on branch pushes | Seven build targets run after validation for pushes to all branches | Separate fast checks from packaging |
| Old runtime lines | Electron ^31.2.1; recent package used 31.7.7; server Docker uses Node 20 and engines allow 18 | Upgrade deliberately; Node 18/20 are EOL at audit date |
| Server builds not locked | No tracked server lockfile; Docker/CI use npm install | Commit a lockfile and use npm ci |
| README drift | Guided installer described as one-click; Linux filenames use incorrect architecture suffixes; layout/build descriptions are stale | Reconcile instructions with actual artifacts/configuration |
| Large central files | renderer.js about 276 KB, main/index.js about 99 KB, app.css about 106 KB | Extract bounded modules incrementally |
| Legacy database tracked | Rhythm Dock/lyrics.db exists and migration code considers legacy locations | Inspect provenance before any removal |
| Documentation split | Root docs, app docs, server README and overlapping task/phase records | Create one index and current backlog |
| Public configuration | Website empty; Wiki/Projects enabled; Discussions disabled | Enable only maintained surfaces |

GitHub's community health score was 42% at review. It measures recognized community files, not application quality or security.

## How to show Releases in GitHub

Releases do not need enabling here: v1.7.4 already exists. GitHub normally exposes Releases in the repository sidebar and on a dedicated page. There is no standard repository setting for adding an arbitrary custom top-level Releases tab beside Code, Issues and Pull requests.

Later, as the owner:

1. Open the repository Code page.
2. Click the gear beside About on the right.
3. Ensure Releases is selected among the items included on the home page, then save. GitHub can change the precise wording/placement.
4. Put a prominent Latest release/Download link and a useful release badge near the top of README.
5. Add a working documentation/download site to About's Website field.
6. Check signed-out and mobile views; the sidebar can appear below other content on narrow screens.

Use [all releases](https://github.com/bestmahdi2/rhythm-dock-electron/releases) or [latest stable](https://github.com/bestmahdi2/rhythm-dock-electron/releases/latest).

Actions artifacts are temporary build outputs; tags identify source commits; Releases present downloadable versions. GitHub Packages is for registries such as container/npm packages and is unnecessary for desktop installers.

## Wiki, user Project, Discussions and website

| Surface | Recommendation | Rule |
| --- | --- | --- |
| README | Essential | Introduction, current screenshot, download, quick start, useful links |
| Repository docs | Essential | Versioned guides reviewed alongside code |
| GitHub Pages | Recommended after deployment checks | Public docs/download site; cannot run the Node room server |
| Wiki | Defer | Avoid maintaining duplicate documentation; revisit for community knowledge |
| User-owned Project | Optional, useful | One Project linked to this repo and populated with real issues |
| Milestones | Recommended | Group work for the next intended release |
| Discussions | Optional | Enable when willing to support Q&A/ideas; bugs remain Issues |
| Packages | Unnecessary now | Consider for a supported server container image later |
| Organization | Unnecessary for a solo maintainer | Revisit for shared ownership |

A GitHub Project is a planning board, not a separate code repository. Keeping master is fine. Renaming to main is optional and requires coordinated workflow/link/rules changes; it is not a professionalism requirement.

## Phase 0 — Baseline and scope

- [ ] Recheck remote head, latest release and successful builds when implementation begins.
- [ ] Distinguish packaged, automatically tested and manually verified OS/CPU support.
- [ ] Record the maintenance scope: desktop player, optional server and separately planned PWA.
- [ ] Keep PWA marked planned until delivered; link the existing offline PWA plan.
- [ ] Record decisions about release policy, documentation location, runtimes and backlog ownership.
- [ ] Inventory tracked/ignored files before cleanup; preserve personal data and migration fixtures.

Acceptance: known source/release baseline and explicit priorities. No cosmetic cleanup should delete live user data or rewrite history.

## Phase 1 — README and public presentation

- [ ] Add a current screenshot near the top and a small gallery of all five modes. Use redistributable sample media and remove private filenames.
- [ ] Explain Horizontal, Vertical, Dock, Stick and Full Screen. Distinguish app fullscreen from the separate lyrics-only view and shortcut.
- [ ] Replace the obsolete fixed 380x180 introduction with current behavior.
- [ ] Correct installer language: NSIS is configured for guided setup, not one-click.
- [ ] Correct Linux filenames: DEB uses amd64, RPM/AppImage use x86_64 in current release collection. Include ARM64 choices.
- [ ] Replace blanket no-cross-compilation claims with tested platform/CPU limits; CI cross-builds Windows ARM64 on x64.
- [ ] Correct release instructions: current version reservation on master can publish, not only manually pushed tags.
- [ ] Verify macOS native-runner build guidance and actual Makefile/npm command behavior.
- [ ] Fix x64-only command claims: the recent build:win64 invocation also built configured architectures. Use explicit target selection as CI does and verify output.
- [ ] Qualify broad claims about Linux compatibility, formats, external tools, automatic pauses and corruption prevention with tested limits/recovery guidance.
- [ ] Make unsigned-build guidance accurate and respectful of platform security; document verification and actual signing status.
- [ ] Move long build/platform details into developer docs.
- [ ] Add only useful badges: build status, release and license, optionally downloads.
- [ ] Update About description/topics/social preview and Website after verifying the destination.
- [ ] Check every download example/link against actual release assets.

Acceptance: a new visitor can understand the product, select a package and start using it without reading developer setup instructions.

## Phase 2 — Supported runtimes and reproducible dependencies

- [ ] Upgrade Electron 31 to a supported stable line; consult the current latest-three-major support policy.
- [ ] Validate preload, native SQLite rebuilds, transparent windows, edge layouts, media keys, file associations and packaged playback during upgrades.
- [ ] Use focused dependency upgrade changes, not an unreviewed all-at-once update.
- [ ] Move server Docker to a maintained Node LTS; align engines, CI, docs and container tests. Node 18 and 20 are EOL as of this audit.
- [ ] Distinguish host Node tooling from Electron's bundled Chromium/Node runtime.
- [ ] Generate and commit server/package-lock.json; switch CI to npm ci and Docker to npm ci --omit=dev after verification.
- [ ] Configure Dependabot or equivalent for desktop npm, server npm and Actions. Review major runtime upgrades separately.
- [ ] Review production/tooling advisories and reachable impact; do not equate an audit count with exploitability.
- [ ] Document and test native build prerequisites from a clean clone.

Acceptance: repeatable installs on maintained runtimes and relevant compatibility tests pass.

## Phase 3 — Contribution, support and community files

- [ ] Add CONTRIBUTING.md: working directories, setup, commands, conventions, relevant checks and PR expectations.
- [ ] Add SECURITY.md with supported versions and a real private reporting route; consider private vulnerability reporting. Do not invent contacts or response guarantees.
- [ ] Add SUPPORT.md separating usage questions, bugs, ideas and security issues.
- [ ] Add a proportionate Code of Conduct with a real enforcement contact.
- [ ] Add bug/feature issue forms and configuration linking support/security routes.
- [ ] Bug fields: version, package type, OS/CPU, reproduction, expected/actual behavior and sanitized diagnostics. Do not request credentials or copyrighted music uploads.
- [ ] Add a PR template: problem, resulting behavior, validation and UI screenshots when relevant.
- [ ] Add CODEOWNERS only for actual reviewers; avoid an impossible solo self-review requirement.
- [ ] Retain ISC unless deliberately changing policy; inventory third-party notices, fonts/icons, assets and optional tools.

Acceptance: a newcomer can report a useful problem or submit a contribution without first asking for process instructions.

## Phase 4 — PR checks and efficient CI

- [ ] Add read-only pull_request validation, including fork PRs without secrets.
- [ ] Never execute untrusted PR code through a privileged pull_request_target workflow.
- [ ] Run version consistency, relevant app/server tests and static validation on PRs.
- [ ] Add test:player-layout, test:playlist-layout, test:settings-layout and test:ui-smoke to a reliable CI tier; npm test currently omits them.
- [ ] Make expected audio-device/global-shortcut skips explicit and distinguish them from failures.
- [ ] Add cross-platform runtime smoke checks; packaging success alone does not establish runtime correctness.
- [ ] Introduce ESLint incrementally and Markdown/link/workflow validation without a whole-repo formatting diff.
- [ ] Run fast checks for routine changes; reserve full packaging for release candidates/version changes/manual requests under the chosen policy.
- [ ] Cancel superseded PR checks while preserving safe publication concurrency.
- [ ] Keep token permissions minimal; write access only where tags/releases require it.
- [ ] Pin Actions to reviewed commit SHAs with update automation.
- [ ] Set intentional artifact retention and label preview builds clearly.
- [ ] Test on a real PR before making checks required in branch rules.

Acceptance: fork PRs receive meaningful checks without secrets or publication; routine docs edits avoid unnecessary seven-target builds.

## Phase 5 — Release quality and trust

Preserve existing strengths: synchronized versions, artifact verification/checksums, exact-commit tag checks, draft uploads and publication after successful builds.

- [ ] Choose/document release policy: current master/version reservation, tags or explicit manual release. Change only for a concrete benefit.
- [ ] Preserve the early-tag permission rationale unless a replacement is tested. Document reserved-tag/failed-build recovery and never retarget published versions silently.
- [ ] Separate historical CHANGELOG.md from concise per-release notes. Current publication includes historical changes and generic package guidance.
- [ ] Include relevant changes, known issues, data/upgrade notes and comparison links.
- [ ] Explain which assets are installers and which are GitHub-generated source archives.
- [ ] Verify actual binary/package architectures, not only filenames and nonempty sizes.
- [ ] Add packaged launch/install smoke checks where feasible, preserving database/config migration tests.
- [ ] Evaluate Windows signing and macOS Developer ID/notarization according to budget/distribution goals.
- [ ] Consider provenance attestations/SBOMs and verification instructions. Checksums alone do not prove publisher identity.
- [ ] Evaluate immutable releases only after testing draft publication and retries; current --clobber behavior must respect immutable published assets.
- [ ] Add explicit prerelease handling before publishing betas; current publication uses --latest.
- [ ] Treat automatic app updates as separate work with signatures, metadata and recovery; a reliable update/download link is a valid first step.

Acceptance: release source, version, assets and notes agree; users can verify/download the correct package and failed publication has a runbook.

## Phase 6 — Documentation and optional Pages

- [ ] Build one documentation index with User, Developer and Server sections before moving existing documents.
- [ ] User guides: install, first run, shortcuts, five modes, library/playlists, lyrics, optional tools, shared rooms and troubleshooting.
- [ ] Document settings/database/cache locations, uninstall preservation and backup/recovery.
- [ ] Developer guides: architecture/IPC, native dependencies, tests, packaging and release runbook.
- [ ] Server guides: deployment, secret rotation, retention, backups, health checks and upgrades.
- [ ] Consolidate TASKS.md and overlapping ROADMAP/PHASES/LATER-PHASES records into one current backlog plus clearly labeled history.
- [ ] Distinguish implemented, planned, experimental and manually verified capabilities.
- [ ] Review docs/index.html before Pages deployment: links to ../TASKS.md and ../server/README.md will not work unchanged if only /docs is published; Markdown destinations need intentional rendering.
- [ ] Choose a small static docs generator or fix the current site. Preview the actual base path and all links.
- [ ] Verify Pages deployment/settings rather than assuming an HTML file means the site is published.
- [ ] Defer Wiki or disable its unused surface. If enabled later, give it a separate purpose rather than copying canonical docs.

Acceptance: users and developers have an obvious starting point and working links both on GitHub and the published website.

## Phase 7 — Issues, Project and protection rules

- [ ] Convert actionable work into scoped issues with acceptance criteria; do not import every historical checked task.
- [ ] Use a small label set for type, platform and area. Apply good first issue only to bounded, documented work.
- [ ] Optionally create one user-owned Project linked to this repo: Backlog, Ready, In progress, In review, Done.
- [ ] Use linked issues instead of duplicate cards; keep fields limited to useful priority/area/milestone information.
- [ ] Use milestones for intended releases without unsupported date promises.
- [ ] Enable Discussions only if maintained; start with Q&A/Ideas and route bugs to Issues.
- [ ] Inspect effective rules first. Consider default-branch no-force-push/delete and passing required checks.
- [ ] Provide a practical solo-maintainer emergency/bypass policy; do not require a nonexistent second reviewer.
- [ ] Test tag protection against the workflow's actual tag-creation identity/permissions.
- [ ] Prefer short branches and reviewable PRs; document emergency fixes.

Acceptance: the next work is discoverable, and protections improve safety without blocking the maintainer or release bot.

## Phase 8 — Security and privacy audit

Confirmed positives: main/overlay windows use contextIsolation:true and nodeIntegration:false; the renderer has CSP; diagnostics deliberately filter fields. Preserve these. The tasks below are review targets, not demonstrated exploits.

- [ ] Validate sensitive IPC senders/frames and payloads, especially filesystem writes/deletion, tool execution, network access and settings.
- [ ] Review navigation/new-window/permission policy for every BrowserWindow. Targeted search did not find setWindowOpenHandler/will-navigate guards in main sources; verify effective behavior first.
- [ ] Review contextBridge breadth, event listener disposal and upgraded-runtime sandbox behavior.
- [ ] Audit URL schemes, playlist redirects, remote download limits, private-network/SSRF boundaries and room-supplied filenames.
- [ ] Audit command construction/tool selection for FFmpeg, downloaders, MIDI and platform helpers; use argument-based execution.
- [ ] Review untrusted lyrics, tags, filenames and room payloads for injection; preserve safe text rendering.
- [ ] Review server authorization, origins, rate limits, room-code guessing, upload/relay bounds, expiry and reverse-proxy assumptions.
- [ ] Verify sample CREATE_SECRET is rejected or clearly warned about for public deployment; keep secrets out of logs/clients.
- [ ] Verify secret scanning, push protection, dependency alerts and code scanning settings before adding duplicate tooling.
- [ ] Publish accurate data-flow/privacy guidance for lyrics/translation providers, Discord, rooms, remote providers and opt-in diagnostics.
- [ ] Inspect tracked lyrics.db provenance/privacy/licensing. If a fixture, name/document it; if generated/personal, preserve migration tests with synthetic fixtures before untracking. Never delete a live user database as cleanup.

Acceptance: findings have evidence or explicit rationale, fixes have targeted validation, and security/privacy guidance reflects actual behavior.

## Phase 9 — Architecture and repository hygiene

- [ ] Extract renderer responsibilities incrementally: player, library/queue, lyrics, menus, settings and rooms.
- [ ] Separate main lifecycle/window orchestration from IPC registration and services.
- [ ] Separate CSS tokens/layouts/components gradually; verify all three tabs and five modes after cascade changes.
- [ ] Expand dense control logic where needed for review; avoid unrelated repository-wide reformatting.
- [ ] Add concise architecture diagrams and comments at boundaries; remove stale phase-history comments when misleading.
- [ ] Consider JSDoc/checkJs or targeted TypeScript after boundaries stabilize; no full rewrite is required.
- [ ] Document tools/ scripts and remove only proven obsolete utilities after reference checks.
- [ ] Simplify duplicate/broad ignore rules while preserving generated assets and example configuration intentionally.
- [ ] Keep the path with spaces unless a rename has concrete value; any apps/desktop move needs coordinated scripts/workflows/docs updates.
- [ ] Avoid cosmetic history rewriting. File cleanup and repository-history size remediation are different work.
- [ ] Include this plan and the existing offline PWA plan deliberately in a later documentation commit; both are local planning files at audit time.

Acceptance: each extraction is reviewable and preserves existing controls, behavior and data.

## Phase 10 — Measured performance and platform quality

- [ ] Record startup, idle CPU/memory, library scans, large-queue responsiveness and long-playback baselines on documented hardware.
- [ ] Measure download size, installed size and runtime memory separately.
- [ ] Inspect actual asar/unpacked contents before tightening broad node_modules inclusion/asset unpack patterns.
- [ ] Profile expensive startup work, metadata/artwork processing, listeners, timers and rendering; optimize measured bottlenecks.
- [ ] Preserve worker-backed scans, cancellation and responsiveness with large libraries.
- [ ] Test DPI/multi-monitor/negative coordinates, side/top docking, fullscreen restoration and dragging on real target systems.
- [ ] Test accessibility, focus, reduced motion, contrast, large text and RTL.
- [ ] Set realistic budgets after measurement instead of promising arbitrary RAM reductions.

Acceptance: compatibility/performance claims are reproducible and optimizations preserve playback/data safety.

## Recommended order and completion criteria

1. First: README/download accuracy, Releases visibility, private security reporting and contributor templates.
2. Treat supported-runtime work as an immediate technical priority; confirmed security exposures take precedence over presentation.
3. Next: fork-PR checks, missing UI CI, server lockfile/container reproducibility and effective protection rules.
4. Then: release-note cleanup, packaged verification, docs/Pages and one maintained backlog.
5. Later: measured modularization/performance and community/distribution features justified by demand.

The baseline is complete when a clean clone builds, the public download path is obvious, docs match shipping behavior, maintained runtimes and meaningful PR checks are in place, reporting/contribution routes work, and releases have verified assets and recovery instructions. Wiki, organization, funding and Packages are optional. Keep the future PWA as a separately scoped effort.

## Evidence and references

- [Live repository metadata](https://api.github.com/repos/bestmahdi2/rhythm-dock-electron)
- [Latest release metadata](https://api.github.com/repos/bestmahdi2/rhythm-dock-electron/releases/latest)
- [Published v1.7.4](https://github.com/bestmahdi2/rhythm-dock-electron/releases/tag/v1.7.4)
- [Successful workflow](https://github.com/bestmahdi2/rhythm-dock-electron/actions/runs/39965645899)
- [Community profile](https://api.github.com/repos/bestmahdi2/rhythm-dock-electron/community/profile)
- [Audited source baseline](https://github.com/bestmahdi2/rhythm-dock-electron/tree/a6fdaea53aa9e974c40900d0785860e29404e758)
- [GitHub Releases navigation](https://docs.github.com/en/repositories/releasing-projects-on-github/viewing-your-repositorys-releases-and-tags)
- [Sidebar visibility controls](https://github.blog/changelog/2020-06-23-design-updates-to-repositories-and-github-ui/)
- [Wikis](https://docs.github.com/en/communities/documenting-your-project-with-wikis)
- [User/organization Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects)
- [Branch/tag rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron support policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)
- [Node.js lifecycle](https://nodejs.org/en/about/previous-releases)

Revalidate live configuration, runtime support and GitHub UI wording when implementation starts. Findings are dated observations, not permanent compatibility guarantees.
