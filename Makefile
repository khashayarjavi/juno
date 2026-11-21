# make verify: typecheck -> lint -> unit tests -> container build and checks.
# One command, one answer. Each stage stops the run on failure.

COMPOSE := docker compose -f containers/docker-compose.yml

.PHONY: verify verify-rootless mediated-e2e typecheck lint test test-watch build stage containers smoke clean

verify:
	$(MAKE) typecheck
	$(MAKE) lint
	$(MAKE) test
	$(MAKE) containers
	@echo "make verify: GREEN"

typecheck:
	npx tsc -p tsconfig.json --noEmit

# The second step proves the no-shell rule is live through the real ESLint CLI:
# a deliberately non-conforming file must be rejected (DECISIONS.md D-012).
# Then rule 12: the hidden-character scan proves it rejects planted characters,
# and then scans the repository (DECISIONS.md D-058).
lint:
	npx eslint --max-warnings 0 .
	@if npx eslint --stdin --stdin-filename packages/runner/src/lint-probe.ts < test/lint/fixtures/exec-probe.ts.txt > /dev/null; then \
		echo "lint self-test FAILED: the exec() probe passed lint"; exit 1; \
	else \
		echo "lint self-test: exec() probe rejected, as required"; \
	fi
	node tools/check-unicode.js --self-test
	node tools/check-unicode.js

test:
	npx vitest run

test-watch:
	npx vitest

# The capability definitions the built code loads at run time (the hook sessions' tool table, the program list, shell.run)
# go beside it, where `dist/<package>/src/*.js` finds them as the sources do (DECISIONS.md D-197).
# The sealed workspace copy (`workspace-copy.mjs`, plain JavaScript so its text runs unchanged in the sealed container,
# DECISIONS.md D-228) goes beside the code that reads it.
# `juno-anchor-ssh.js` is run by git itself as GIT_SSH, so it is made executable (DECISIONS.md D-208).
# The last step makes everything built writable by its owner only, whatever the umask of whoever runs make: Ubuntu's
# login shell gives 0002, and `juno hook check` rightly refuses a hook client its group could change (DECISIONS.md D-219).
build:
	rm -rf dist
	npx tsc -p tsconfig.build.json
	cp -R packages/mediated/definitions dist/mediated/definitions
	cp -R packages/registry/definitions dist/registry/definitions
	cp packages/enforcement/src/workspace-copy.mjs dist/enforcement/src/workspace-copy.mjs
	chmod 0755 dist/journal/src/juno-anchor-ssh.js
	chmod -R go-w dist

# Production dependencies, installed on the host for COPY into images (D-001), writable by their owner only (D-219).
stage:
	rm -rf build/stage
	mkdir -p build/stage
	cp package.json package-lock.json build/stage/
	cd build/stage && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline
	chmod -R go-w build/stage

# The same container suite as the runner's unprivileged user under the rootless runtime (DECISIONS.md D-130,
# D-131). Run it through scripts/rootless/run-verify.sh, never as root. The first step proves the user and the
# runtime are what D-130 requires, including cgroup v2 with systemd, without which rootless Docker ignores the
# D-025 limits; only then do the seal tests run.
verify-rootless:
	@if [ "$$(id -u)" = 0 ]; then echo "verify-rootless: refusing to run as root"; exit 1; fi
	npx vitest run --config vitest.rootless.config.ts
	$(MAKE) containers
	@echo "make verify-rootless: GREEN"

containers: build stage
	$(COMPOSE) --profile anchors build
	npx vitest run --config vitest.containers.config.ts

# §4.3's acceptance in mode C with the real Claude Code binary and a scripted model (build plan Slice 1.5 §4; D-092,
# D-145). Cloud sessions only, never `verify` or CI: the binary is the session's own, mounted read-only, never vendored.
mediated-e2e: build stage
	$(COMPOSE) build runner
	npx vitest run --config vitest.mediated.config.ts

# The evidence run against the real provider (DECISIONS.md D-072, D-073).
# Run from the cloud session only, never by `verify` or CI (D-002).
# Needs the provider key in the runner's environment (docs/evidence/slice-1.1.md).
# The build steps run with the key removed; the smoke run takes it out of its
# own environment before it starts any container.
smoke:
	env -u GROQ_API_KEY $(MAKE) build stage
	env -u GROQ_API_KEY $(COMPOSE) build
	npx vitest run --config vitest.smoke.config.ts

clean:
	rm -rf dist build coverage
