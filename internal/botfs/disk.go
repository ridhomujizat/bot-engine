package botfs

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Disk stores bot content under Root using the same BPFS paths as srv_ghost_files.
// It keeps no revisions; it exists for tests and local development.
type Disk struct {
	Root string
}

// NewDisk returns a Disk store rooted at dir.
func NewDisk(dir string) *Disk { return &Disk{Root: dir} }

func (d *Disk) abs(p string) (string, error) {
	clean := filepath.Clean("/" + filepath.FromSlash(p))
	if clean == "/" {
		return "", errors.New("botfs: empty path")
	}
	return filepath.Join(d.Root, clean), nil
}

func toBPFS(rel string) string { return filepath.ToSlash(rel) }

func (d *Disk) ReadFile(_ context.Context, p string) ([]byte, error) {
	full, err := d.abs(p)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(full)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	return b, err
}

func (d *Disk) ListFiles(_ context.Context, prefix string) ([]FileInfo, error) {
	var out []FileInfo
	err := filepath.WalkDir(d.Root, func(path string, de fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if de.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(d.Root, path)
		if err != nil {
			return err
		}
		bp := toBPFS(rel)
		if !strings.HasPrefix(bp, prefix) {
			return nil
		}
		info, err := de.Info()
		if err != nil {
			return err
		}
		out = append(out, FileInfo{Path: bp, ModifiedOn: info.ModTime()})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

func (d *Disk) WriteFile(_ context.Context, p string, content []byte) error {
	full, err := d.abs(p)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	return os.WriteFile(full, content, 0o644)
}

func (d *Disk) DeleteFile(_ context.Context, p string) error {
	full, err := d.abs(p)
	if err != nil {
		return err
	}
	err = os.Remove(full)
	if errors.Is(err, fs.ErrNotExist) {
		return ErrNotFound
	}
	return err
}

func (d *Disk) LastModified(ctx context.Context, prefix string) (time.Time, error) {
	files, err := d.ListFiles(ctx, prefix)
	if err != nil {
		return time.Time{}, err
	}
	var latest time.Time
	for _, f := range files {
		if f.ModifiedOn.After(latest) {
			latest = f.ModifiedOn
		}
	}
	return latest, nil
}

var _ Store = (*Disk)(nil)
