// Package localfs walks a local directory tree and computes content hashes,
// producing the data the syncer needs to diff against the remote manifest.
package localfs

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// LocalFile describes one file found under the sync root.
type LocalFile struct {
	Path      string // relative path, forward-slash separated — matches the S3 key format
	AbsPath   string // absolute path on disk, for opening the file later
	SHA256    string
	SizeBytes int64
}

// Walk scans root and returns every file found, keyed by its relative,
// forward-slash-separated path (so behavior is consistent across OSes).
//
// Hidden files and directories (anything starting with a dot — .git,
// editor swap files, etc.) are skipped, since they're never meant to sync.
func Walk(root string) (map[string]LocalFile, error) {
	result := make(map[string]LocalFile)

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		name := d.Name()
		if strings.HasPrefix(name, ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}

		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)

		hash, size, err := hashFile(path)
		if err != nil {
			return err
		}

		result[rel] = LocalFile{
			Path:      rel,
			AbsPath:   path,
			SHA256:    hash,
			SizeBytes: size,
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func hashFile(path string) (hash string, size int64, err error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()

	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}
