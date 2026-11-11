package studioapi

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"

	"github.com/ridhomujizat/bot-engine/internal/botfs"
	"github.com/ridhomujizat/bot-engine/internal/httperr"

	"github.com/gin-gonic/gin"
)

// Port of legacy and
// legacy GET /media/:filename. Files live under the bot's media/ folder.

const (
	mediaDir          = "media/"
	defaultMaxBytes   = 25 << 20
	mediaCacheControl = "max-age=31556926" // legacy bots-router: one year, files are never overwritten
	mediaIDAlphabet   = "1234567890abcdefghijklmnopqrsuvwxyz"
)

// DefaultMediaTypes is the legacy engine fallback when legacy.config.json sets no allowedMimeTypes.
var DefaultMediaTypes = []string{"image/jpeg", "image/png", "image/gif", "audio/mpeg", "video/mp4"}

// MediaLimits controls uploads. Zero values mean the defaults above.
type MediaLimits struct {
	MaxBytes         int64
	AllowedMimeTypes []string
}

// SetMediaLimits applies legacy.config.json fileUpload settings to the service.
func (s *Service) SetMediaLimits(l MediaLimits) {
	if l.MaxBytes > 0 {
		s.media.MaxBytes = l.MaxBytes
	}
	if len(l.AllowedMimeTypes) > 0 {
		s.media.AllowedMimeTypes = l.AllowedMimeTypes
	}
}

func (s *Service) mediaLimits() MediaLimits {
	l := s.media
	if l.MaxBytes <= 0 {
		l.MaxBytes = defaultMaxBytes
	}
	if len(l.AllowedMimeTypes) == 0 {
		l.AllowedMimeTypes = DefaultMediaTypes
	}
	return l
}

// ParseSize reads legacy size strings such as "25mb", "1gb", "512kb" or plain bytes.
func ParseSize(v string) (int64, error) {
	s := strings.ToLower(strings.TrimSpace(v))
	if s == "" {
		return 0, errors.New("empty size")
	}
	mult := int64(1)
	for _, u := range []struct {
		suffix string
		m      int64
	}{{"gb", 1 << 30}, {"mb", 1 << 20}, {"kb", 1 << 10}, {"b", 1}} {
		if strings.HasSuffix(s, u.suffix) {
			mult = u.m
			s = strings.TrimSuffix(s, u.suffix)
			break
		}
	}
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("bad size %q", v)
	}
	return n * mult, nil
}

// mimeAllowed mirrors fileUploadMulter: the part's type and the extension's type must both
// match an allowed pattern. Patterns are unanchored, and "*" is a wildcard, as in legacy.
func mimeAllowed(partType, fileName string, allowed []string) error {
	ext := path.Ext(fileName)
	if ext == "" {
		return fmt.Errorf(`The file has no extension: %s. To allow any kind of files, set the value of "allowedMimeTypes" to "['*']" in your legacy.config.json file.`, fileName)
	}
	extType := mime.TypeByExtension(ext)
	if matchesAny(partType, allowed) && matchesAny(extType, allowed) {
		return nil
	}
	return fmt.Errorf("This type of file is not allowed: %s", partType)
}

func matchesAny(t string, patterns []string) bool {
	for _, p := range patterns {
		if strings.Contains(p, "*") {
			p = strings.Replace(p, "*", ".*", 1)
		}
		re, err := regexp.Compile("(?i)" + p)
		if err == nil && re.MatchString(t) {
			return true
		}
	}
	return false
}

// sanitizeFileName mirrors legacy sanitize(input, 'file').
var (
	ctlRe      = regexp.MustCompile(`[\x00-\x1f\x80-\x9f]`)
	illegalRe  = regexp.MustCompile(`[/?<>\\:*|"]`)
	reservedRe = regexp.MustCompile(`^\.+$`)
)

func sanitizeFileName(name string) string {
	out := ctlRe.ReplaceAllString(name, "")
	out = reservedRe.ReplaceAllString(out, "")
	return illegalRe.ReplaceAllString(out, "")
}

func safeMediaID(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	out := make([]byte, n)
	for i := range b {
		out[i] = mediaIDAlphabet[int(b[i])%len(mediaIDAlphabet)]
	}
	return string(out), nil
}

// SaveMedia stores content under media/ and returns the public URL and stored name.
func (s *Service) SaveMedia(ctx context.Context, botID, originalName string, content []byte) (string, string, error) {
	if err := s.assertWritable(ctx, botID); err != nil {
		return "", "", err
	}
	id, err := safeMediaID(20)
	if err != nil {
		return "", "", err
	}
	fileName := sanitizeFileName(id + "-" + path.Base(originalName))
	if err := s.store.WriteFile(ctx, botPath(botID, mediaDir+fileName), content); err != nil {
		return "", "", err
	}
	return mediaURL(botID, fileName), fileName, nil
}

// mediaURL is the legacy public URL form: /api/v1/bots/{botId}/media/{encoded name}.
func mediaURL(botID, fileName string) string {
	return "/api/v1/bots/" + botID + "/media/" + url.PathEscape(fileName)
}

// ReadMedia returns a stored media file. ErrNotFound when missing.
func (s *Service) ReadMedia(ctx context.Context, botID, fileName string) ([]byte, error) {
	return s.store.ReadFile(ctx, botPath(botID, mediaDir+sanitizeFileName(fileName)))
}

// DeleteMedia removes one media file. A missing file is not an error here (the editor
// may delete a file it already removed).
func (s *Service) DeleteMedia(ctx context.Context, botID, fileName string) error {
	err := s.store.DeleteFile(ctx, botPath(botID, mediaDir+sanitizeFileName(fileName)))
	if errors.Is(err, botfs.ErrNotFound) {
		return nil
	}
	return err
}

// MediaFilesFromFormData lists media names referenced by image* values and items$* arrays,
// as getMediaFiles does.
func MediaFilesFromFormData(formData *OMap) []string {
	var out []string
	const marker = "/media/"
	var walk func(m *OMap)
	walk = func(m *OMap) {
		for _, k := range m.Keys {
			v := m.Vals[k]
			switch {
			case strings.HasPrefix(k, "image"):
				if s, ok := v.(string); ok && strings.Contains(s, marker) {
					out = append(out, s[strings.Index(s, marker)+len(marker):])
				}
			case strings.HasPrefix(k, "items$"):
				if arr, ok := v.([]any); ok && len(arr) > 0 {
					for _, e := range arr {
						if em, ok := e.(*OMap); ok {
							walk(em)
						}
					}
				}
			}
		}
	}
	walk(formData)
	return out
}

// registerMedia mounts the bot media upload and delete routes (studio group).
func (s *Service) registerMedia(g *gin.RouterGroup) {
	g.POST("/media", func(c *gin.Context) {
		botID := c.Param("botId")
		fh, err := c.FormFile("file")
		if err != nil {
			c.String(http.StatusBadRequest, "No file uploaded")
			return
		}
		l := s.mediaLimits()
		if fh.Size > l.MaxBytes {
			c.String(http.StatusBadRequest, "File too large")
			return
		}
		if err := mimeAllowed(fh.Header.Get("Content-Type"), fh.Filename, l.AllowedMimeTypes); err != nil {
			c.String(http.StatusBadRequest, err.Error())
			return
		}
		f, err := fh.Open()
		if err != nil {
			httperr.Write(c, err)
			return
		}
		defer f.Close()
		content, err := io.ReadAll(io.LimitReader(f, l.MaxBytes+1))
		if err != nil {
			httperr.Write(c, err)
			return
		}
		if int64(len(content)) > l.MaxBytes {
			c.String(http.StatusBadRequest, "File too large")
			return
		}
		u, _, err := s.SaveMedia(c.Request.Context(), botID, fh.Filename, content)
		if err != nil {
			httperr.Write(c, errorFrom(err))
			return
		}
		sendJSON(c, http.StatusOK, map[string]any{"url": u})
	})

	g.POST("/media/delete", handle(func(c *gin.Context) error {
		raw, err := readBody(c)
		if err != nil {
			return err
		}
		body, err := decodeBody(raw)
		if err != nil {
			return err
		}
		botID := c.Param("botId")
		for _, f := range MediaFilesFromFormData(body) {
			if err := s.DeleteMedia(c.Request.Context(), botID, f); err != nil {
				return err
			}
		}
		c.Status(http.StatusOK)
		return nil
	}))
}

// RegisterPublic mounts GET /api/v1/bots/:botId/media/:filename. No token: legacy serves media
// publicly even for private bots (checkBotVisibility exempts media paths).
func (s *Service) RegisterPublic(r *gin.Engine) {
	r.GET("/api/v1/bots/:botId/media/:filename", func(c *gin.Context) {
		data, err := s.ReadMedia(c.Request.Context(), c.Param("botId"), c.Param("filename"))
		if errors.Is(err, botfs.ErrNotFound) {
			c.String(http.StatusNotFound, "Not Found")
			return
		}
		if err != nil {
			httperr.Write(c, err)
			return
		}
		ct := mime.TypeByExtension(path.Ext(c.Param("filename")))
		if ct == "" {
			ct = "application/octet-stream"
		}
		c.Header("Cache-Control", mediaCacheControl)
		c.Data(http.StatusOK, ct, data)
	})
}
