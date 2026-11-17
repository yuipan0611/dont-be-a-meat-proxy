# Hub ingress validator

Deployment design, comparison of alternatives, policy maintenance and rollback:
[ops runbook](../../docs/ops/L07-validator.md).

Requires Go ≥1.24.11 for native tests (`go test -race ./...`, `go vet ./...`).
The pinned Docker builder contains Go; no host toolchain is required to build
`docker build --platform linux/amd64 -t neighbor-hub-validator:l07 server/validator`
from the repository root. Gitleaks v8.30.1 is used as a library, with its unmodified
embedded default config; this service does not maintain a secret regex list.

Run `node ops/test/validator-local-stack.mjs` from the repository root for real
Mail/Caddy/validator acceptance and all three existing MCP integration suites.
`L07_REGRESSION=0` requests only core acceptance, including the operator probe,
maximum-length latency and a HubClock tick; it explicitly omits existing suites.
The harness uses isolated Docker resources and leaves private diagnostics under
`.hub-local/l07/`, never in Git.
