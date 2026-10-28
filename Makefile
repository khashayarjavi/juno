# make verify: typecheck -> lint -> unit tests -> container build and checks.
# One command, one answer. Each stage stops the run on failure.

COMPOSE := docker compose -f containers/docker-compose.yml

.PHONY: verify typecheck lint test test-watch build stage containers clean

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
lint:
	npx eslint --max-warnings 0 .
	@if npx eslint --stdin --stdin-filename packages/runner/src/lint-probe.ts < test/lint/fixtures/exec-probe.ts.txt > /dev/null; then \
		echo "lint self-test FAILED: the exec() probe passed lint"; exit 1; \
	else \
		echo "lint self-test: exec() probe rejected, as required"; \
	fi

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

clean:
	rm -rf dist build coverage
