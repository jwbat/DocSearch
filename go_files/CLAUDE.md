# go_files/ — agent notes

The Go module for DocSearch. It holds two programs that share `internal/`:

- `docsearch-cli`, the write path. See `README.md` for build/usage/test
  commands and `main.go` for the command entry point.
- The read-path API Lambda, `cmd/api-lambda/` with handlers in
  `internal/api/`. It serves `GET /manifest` and `GET /file-url`.

## Build workflow

After `go build -o docsearch-cli .`, move the binary to `~/.local/bin` (it's
treated as an installed tool, not a build artifact). Never leave it sitting in
this directory, and don't add it to `.gitignore` or suggest `go clean` as a
cleanup step — that's not how this binary is managed here.

The Lambda is different: CDK builds it (linux/arm64 `bootstrap`) into
`cdk/cdk.out` during synth, and deploys it with `DocSearchWebStack`. Don't
build it by hand, and don't move it to `~/.local/bin`.

## Before calling a change done

Run `go test ./...`. `internal/api` has handler tests with fake clients, and
`internal/syncer` has coverage for the diff logic (new
file, unchanged file, local delete, soft-delete reappearing) with no AWS
dependency, so it should run clean without credentials.

## Not source

`.build` and `.editfiles` are local tooling files, not part of the CLI itself.
