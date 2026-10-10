# Dependency security review

Reviewed on 2026-10-03 (America/Sao_Paulo) against the existing lockfile.
Advisories and available releases can change; rerun the commands below for an
updated result. No dependencies or application code were changed in this review.

## Root advisory

The installed **braces 3.0.3** is affected by
[GHSA-vfj7-8cjw-p6xm / CVE-2026-93687](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
Its recursive pattern processing can exhaust the call stack when supplied a
deeply nested brace pattern, causing a denial of service if the resulting error
is uncaught. The [upstream report](https://github.com/micromatch/braces/issues/70)
describes the affected pattern-processing paths.

The advisory lists versions through 3.0.3 as affected and no patched release.
The npm registry still identifies 3.0.3 as the latest release on the review date.
Updating to the latest published braces version therefore does not resolve this
advisory.

An installed dependency path is:

```text
@adonisjs/assembler@8.5.2
  -> fast-glob@3.3.3
    -> micromatch@4.0.8
      -> braces@3.0.3
```

## Audit counts and affected packages

`npm audit --omit=dev --json` reports **13 packages rated high**. The full
`npm audit --json` reports **17**. Both reports contain the same single underlying
advisory; the other entries inherit the rating through their dependency chains.
These counts do not represent 13 or 17 independent security flaws.

Production audit entries:

| Package               | Reported through                                                      |
| --------------------- | --------------------------------------------------------------------- |
| braces                | The direct advisory above                                             |
| micromatch            | braces                                                                |
| fast-glob             | micromatch                                                            |
| @adonisjs/assembler   | fast-glob                                                             |
| @adonisjs/application | @adonisjs/assembler                                                   |
| @adonisjs/events      | @adonisjs/application                                                 |
| @adonisjs/http-server | @adonisjs/application, @adonisjs/events                               |
| @adonisjs/bodyparser  | @adonisjs/http-server                                                 |
| @adonisjs/core        | application, assembler, bodyparser, events, http-server               |
| @adonisjs/presets     | @adonisjs/assembler, @adonisjs/core                                   |
| @adonisjs/lucid       | @adonisjs/assembler, @adonisjs/core, @adonisjs/presets                |
| @adonisjs/redis       | @adonisjs/core                                                        |
| @adonisjs/queue       | @adonisjs/assembler, @adonisjs/core, @adonisjs/lucid, @adonisjs/redis |

The full audit additionally flags `@adonisjs/eslint-config`,
`@adonisjs/eslint-plugin`, `@japa/plugin-adonisjs`, and `hot-hook` through the same
dependency graph. An AdonisJS package being listed here does not mean this audit
found a separate advisory in that package's own code.

Although Assembler is declared as a development dependency by this application,
the production dependency graph also includes it through framework peer dependencies.
The `--omit=dev` audit still reports this chain; the production count must not be
dismissed as development-only tooling.

## Project exposure and remediation status

The root advisory requires an attacker-controlled deeply nested glob/brace
pattern to reach the affected parser. Current application patterns are fixed
local globs, such as Queue's job locations and HMR boundaries; the existing root
endpoint does not accept glob patterns. This is a limited code/configuration
review, not an exploitability test, and does not remove the audit finding.

npm suggests major version changes, including downgrading AdonisJS core to 5.9.0,
Lucid to 18.4.2, or Redis to 7.3.4. Those suggestions conflict with this project's
AdonisJS 7 requirements and are not an acceptable automatic remediation.
`npm audit fix --force` was not run. Queue remains pinned to 0.6.2.

There is no patched published braces release available to apply on this date.
Track the upstream fix and reassess the dependency path when a patched version
is released. Any interim patch or override needs a separate compatibility review
and validation; this documentation review introduces neither.

## Reproduce

```sh
npm audit --omit=dev --json
npm audit --json
npm ls braces micromatch fast-glob --all
npm view braces version
```

An audit exit code of 1 indicates findings; it is not a failed registry request.
