# go_files/ — agent notes

The `docsearch-cli` write path. See `README.md` for build/usage/test commands
and `main.go` for the command entry point.

## Build workflow

After `go build -o docsearch-cli .`, move the binary to `~/.local/bin` (it's
treated as an installed tool, not a build artifact). Never leave it sitting in
this directory, and don't add it to `.gitignore` or suggest `go clean` as a
cleanup step — that's not how this binary is managed here.

## Before calling a change done

Run `go test ./...`. `internal/syncer` has coverage for the diff logic (new
file, unchanged file, local delete, soft-delete reappearing) with no AWS
dependency, so it should run clean without credentials.

## Not source

`.build` and `.editfiles` are local tooling files, not part of the CLI itself.
