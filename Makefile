# The plugin's gates. `check` runs after every change.
.PHONY: check test lint fmt validate

check: lint test validate

lint:
	uv run --group dev ruff check hooks tests
	uv run --group dev ruff format --check hooks tests

test:
	uv run --group dev pytest -q

fmt:
	uv run --group dev ruff format hooks tests
	uv run --group dev ruff check --fix hooks tests

# The manifests as Claude Code reads them; the CLI is Claude Code's own.
validate:
	claude plugin validate --strict .
	claude plugin validate --strict .claude-plugin/marketplace.json
