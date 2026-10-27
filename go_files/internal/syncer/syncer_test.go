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

func TestBuildPlanRenameBecomesCopy(t *testing.T) {
	local := map[string]localfs.LocalFile{
		"new/x.md": {Path: "new/x.md", SHA256: "hash-x"},
		"new/y.md": {Path: "new/y.md", SHA256: "hash-y"},
		"new/z.md": {Path: "new/z.md", SHA256: "hash-z-edited"},
	}

	remote := map[string]manifest.Entry{
		"old/x.md": {Path: "old/x.md", SHA256: "hash-x"},
		"old/y.md": {Path: "old/y.md", SHA256: "hash-y"},
		"old/z.md": {Path: "old/z.md", SHA256: "hash-z"},
	}

	plan := BuildPlan(local, remote)

	wantCopy := []CopyOp{
		{From: "old/x.md", To: "new/x.md"},
		{From: "old/y.md", To: "new/y.md"},
	}
	if len(plan.Copy) != len(wantCopy) {
		t.Fatalf("copy: got %v, want %v", plan.Copy, wantCopy)
	}
	for i := range wantCopy {
		if plan.Copy[i] != wantCopy[i] {
			t.Errorf("copy[%d]: got %v, want %v", i, plan.Copy[i], wantCopy[i])
		}
	}

	if len(plan.Upload) != 1 || plan.Upload[0] != "new/z.md" {
		t.Errorf("upload: got %v, want [new/z.md]", plan.Upload)
	}

	if len(plan.Delete) != 3 {
		t.Errorf("delete: got %v, want all three old/ paths", plan.Delete)
	}
}

func TestBuildPlanCopySourceRules(t *testing.T) {
	local := map[string]localfs.LocalFile{
		// a.md is being overwritten, so it can't serve as a copy source.
		"a.md":      {Path: "a.md", SHA256: "hash-a-new"},
		"copy-a.md": {Path: "copy-a.md", SHA256: "hash-a-old"},
		// The only remote holder of this content is soft-deleted, so its
		// S3 object isn't current and can't be copied from.
		"back.md": {Path: "back.md", SHA256: "hash-gone"},
	}

	remote := map[string]manifest.Entry{
		"a.md":    {Path: "a.md", SHA256: "hash-a-old"},
		"gone.md": {Path: "gone.md", SHA256: "hash-gone", Deleted: true},
	}

	plan := BuildPlan(local, remote)

	if len(plan.Copy) != 0 {
		t.Errorf("copy: got %v, want none", plan.Copy)
	}
	want := map[string]bool{"a.md": true, "copy-a.md": true, "back.md": true}
	if len(plan.Upload) != len(want) {
		t.Fatalf("upload: got %v, want keys %v", plan.Upload, want)
	}
	for _, p := range plan.Upload {
		if !want[p] {
			t.Errorf("unexpected upload entry: %s", p)
		}
	}
}

func TestEscapeKey(t *testing.T) {
	got := escapeKey("my docs/notes #1.md")
	want := "my%20docs/notes%20%231.md"
	if got != want {
		t.Errorf("escapeKey: got %q, want %q", got, want)
	}
}
