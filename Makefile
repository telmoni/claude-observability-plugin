.PHONY: check
# The gate: types, the bundle and the suites, then Claude Code's own check of
# the plugin. Needs Node 22.18, 24.11 or 26+, npm, and Claude Code.
check:
	npm run verify
	claude plugin validate --strict .claude-plugin/plugin.json
