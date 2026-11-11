// Package botfs abstracts where bot content lives: the srv_ghost_files table
// of the tenant's legacy database (production) or a directory (tests, dev).
//
// Paths are BPFS paths exactly as stored in srv_ghost_files.file_path,
// e.g. "data/bots/example-bot/flows/main.flow.json", "data/global/legacy.config.json".
//
// OWNERSHIP: interface = shared contract. Implementations (pg.go, disk.go) owned by the platform agent.
package botfs

import (
	"context"
	"errors"
	"strings"
	"time"
)

var ErrNotFound = errors.New("botfs: file not found")

type FileInfo struct {
	Path       string
	ModifiedOn time.Time
}

type Store interface {
	// ReadFile returns ErrNotFound for missing or deleted files.
	ReadFile(ctx context.Context, path string) ([]byte, error)
	// ListFiles returns non-deleted files whose path starts with prefix, sorted by path.
	ListFiles(ctx context.Context, prefix string) ([]FileInfo, error)
	// WriteFile creates or replaces a file (legacy semantics: upsert + revision bookkeeping where applicable).
	WriteFile(ctx context.Context, path string, content []byte) error
	// DeleteFile removes a file (legacy semantics for srv_ghost_files: delete row).
	DeleteFile(ctx context.Context, path string) error
	// LastModified returns max(modified_on) of non-deleted files under prefix (zero time if none).
	// Used for cache invalidation across replicas.
	LastModified(ctx context.Context, prefix string) (time.Time, error)
}

func BotPrefix(botID string) string { return "data/bots/" + botID + "/" }

// IsOSJunk reports whether a bot file path is operating-system metadata that is never bot content:
// macOS AppleDouble sidecars (`._name`, written by tar/cp when extended attributes exist),
// `.DS_Store`, and `__MACOSX/` folders from zip archives. Archives made on a Mac carry these;
// legacy ignores them, and parsing one as JSON fails the whole bot load.
func IsOSJunk(p string) bool {
	if strings.HasPrefix(p, "__MACOSX/") || strings.Contains(p, "/__MACOSX/") {
		return true
	}
	base := p
	if i := strings.LastIndex(p, "/"); i >= 0 {
		base = p[i+1:]
	}
	return strings.HasPrefix(base, "._") || base == ".DS_Store"
}
