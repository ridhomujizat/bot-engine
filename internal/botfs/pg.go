package botfs

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
)

// PG reads and writes srv_ghost_files exactly as the legacy DB ghost driver does
// , so legacy and bot-engine can share one database:
//
// - upsert: INSERT... ON CONFLICT (file_path) DO UPDATE SET content, modified_on = now, deleted = false
// - every write also inserts srv_ghost_index(file_path, revision = 8-char nanoid, created_by = 'admin', created_on = now)
// - delete is soft: deleted = true plus a srv_ghost_index row (legacy does not touch modified_on on delete)
// - reads and listings ignore rows with deleted = true
type PG struct {
	DB *gorm.DB
}

// NewPG wraps a gorm handle connected to the tenant legacy database.
func NewPG(db *gorm.DB) *PG { return &PG{DB: db} }

type ghostFile struct {
	FilePath   string     `gorm:"column:file_path"`
	Content    []byte     `gorm:"column:content"`
	Deleted    bool       `gorm:"column:deleted"`
	ModifiedOn *time.Time `gorm:"column:modified_on"`
}

func (ghostFile) TableName() string { return "srv_ghost_files" }

type ghostIndex struct {
	FilePath  string    `gorm:"column:file_path"`
	Revision  string    `gorm:"column:revision"`
	CreatedBy string    `gorm:"column:created_by"`
	CreatedOn time.Time `gorm:"column:created_on"`
}

func (ghostIndex) TableName() string { return "srv_ghost_index" }

const revisionAlphabet = "_-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// newRevision mirrors nanoid(8): 8 random characters from the nanoid URL-safe alphabet.
func newRevision() (string, error) {
	const n = 8
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	out := make([]byte, n)
	for i := range b {
		// 64 symbols: masking with 63 keeps the distribution uniform.
		out[i] = revisionAlphabet[b[i]&63]
	}
	return string(out), nil
}

// ReadFile returns ErrNotFound when the row is missing or deleted.
func (p *PG) ReadFile(ctx context.Context, path string) ([]byte, error) {
	var f ghostFile
	err := p.DB.WithContext(ctx).
		Select("content").
		Where("file_path = ? AND deleted = ?", path, false).
		Take(&f).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("botfs: read %q: %w", path, err)
	}
	return f.Content, nil
}

// ListFiles uses left rather than LIKE so prefixes containing % or _ match literally.
func (p *PG) ListFiles(ctx context.Context, prefix string) ([]FileInfo, error) {
	var rows []ghostFile
	err := p.DB.WithContext(ctx).
		Select("file_path, modified_on").
		Where("deleted = ? AND left(file_path, ?) = ?", false, len([]rune(prefix)), prefix).
		Order("file_path ASC").
		Find(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("botfs: list %q: %w", prefix, err)
	}
	out := make([]FileInfo, 0, len(rows))
	for _, r := range rows {
		fi := FileInfo{Path: r.FilePath}
		if r.ModifiedOn != nil {
			fi.ModifiedOn = *r.ModifiedOn
		}
		out = append(out, fi)
	}
	return out, nil
}

// WriteFile upserts the file and records a revision in one transaction.
func (p *PG) WriteFile(ctx context.Context, path string, content []byte) error {
	rev, err := newRevision()
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	return p.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec(`
			INSERT INTO srv_ghost_files (file_path, content, deleted, modified_on)
			VALUES (?, ?, false, ?)
			ON CONFLICT (file_path) DO UPDATE
			SET content = EXCLUDED.content, modified_on = EXCLUDED.modified_on, deleted = false`,
			path, content, now).Error; err != nil {
			return fmt.Errorf("botfs: write %q: %w", path, err)
		}
		return tx.Create(&ghostIndex{FilePath: path, Revision: rev, CreatedBy: "admin", CreatedOn: now}).Error
	})
}

// DeleteFile soft-deletes the row and records a revision, as legacy does.
func (p *PG) DeleteFile(ctx context.Context, path string) error {
	rev, err := newRevision()
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	return p.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		res := tx.Model(&ghostFile{}).Where("file_path = ? AND deleted = ?", path, false).Update("deleted", true)
		if res.Error != nil {
			return fmt.Errorf("botfs: delete %q: %w", path, res.Error)
		}
		if res.RowsAffected == 0 {
			return ErrNotFound
		}
		return tx.Create(&ghostIndex{FilePath: path, Revision: rev, CreatedBy: "admin", CreatedOn: now}).Error
	})
}

// LastModified returns max(modified_on) over non-deleted files under prefix (zero when none).
func (p *PG) LastModified(ctx context.Context, prefix string) (time.Time, error) {
	var latest *time.Time
	err := p.DB.WithContext(ctx).Model(&ghostFile{}).
		Select("max(modified_on)").
		Where("deleted = ? AND left(file_path, ?) = ?", false, len([]rune(prefix)), prefix).
		Scan(&latest).Error
	if err != nil {
		return time.Time{}, fmt.Errorf("botfs: last modified %q: %w", prefix, err)
	}
	if latest == nil {
		return time.Time{}, nil
	}
	return *latest, nil
}

var _ Store = (*PG)(nil)
