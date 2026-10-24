.PHONY: check
# The gate: types, the bundle and the suites, then Claude Code's own checks of
# the marketplace and the plugin. Needs Node 22.23.4, 24.22.1, 26.12.1 or
# later, npm, and Claude Code.
check:
	npm run verify
	claude plugin validate --strict .
	claude plugin validate --strict .claude-plugin/plugin.json
