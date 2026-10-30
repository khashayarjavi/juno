# make verify: typecheck -> lint -> unit tests -> container build and checks.
# One command, one answer. Each stage stops the run on failure.

COMPOSE := docker compose -f containers/docker-compose.yml

.PHONY: verify typecheck lint test test-watch build stage containers smoke clean

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

build:
	rm -rf dist
	npx tsc -p tsconfig.build.json

# Production dependencies, installed on the host for COPY into images (D-001).
stage:
	rm -rf build/stage
	mkdir -p build/stage
	cp package.json package-lock.json build/stage/
	cd build/stage && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline

containers: build stage
	$(COMPOSE) build
	npx vitest run --config vitest.containers.config.ts

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
