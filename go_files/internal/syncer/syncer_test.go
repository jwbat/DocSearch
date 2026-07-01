package syncer

import (
	"testing"

	"docsearch-cli/internal/localfs"
	"docsearch-cli/internal/manifest"
)

func TestBuildPlan(t *testing.T) {
	local := map[string]localfs.LocalFile{
		"a.md":          {Path: "a.md", SHA256: "hash-a-new"},
		"b.md":          {Path: "b.md", SHA256: "hash-b-unchanged"},
		"recovered.txt": {Path: "recovered.txt", SHA256: "hash-recovered"},
	}

	remote := map[string]manifest.Entry{
		"b.md":          {Path: "b.md", SHA256: "hash-b-unchanged"},
		"c.md":          {Path: "c.md", SHA256: "hash-c-gone-locally"},
		"recovered.txt": {Path: "recovered.txt", SHA256: "hash-recovered", Deleted: true},
	}

	plan := BuildPlan(local, remote)

	wantUpload := map[string]bool{"a.md": true, "recovered.txt": true}
	if len(plan.Upload) != len(wantUpload) {
		t.Fatalf("upload: got %v, want keys %v", plan.Upload, wantUpload)
	}
	for _, p := range plan.Upload {
		if !wantUpload[p] {
			t.Errorf("unexpected upload entry: %s", p)
		}
	}

	wantDelete := map[string]bool{"c.md": true}
	if len(plan.Delete) != len(wantDelete) {
		t.Fatalf("delete: got %v, want keys %v", plan.Delete, wantDelete)
	}
	for _, p := range plan.Delete {
		if !wantDelete[p] {
			t.Errorf("unexpected delete entry: %s", p)
		}
	}
}
