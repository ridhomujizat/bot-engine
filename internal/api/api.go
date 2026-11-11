// Package api is the HTTP surface of bot-engine: auth, converse, studio/admin
// (delegated to studioapi), and the embedded editor under /studio/.
package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/ridhomujizat/bot-engine/internal/auth"
	"github.com/ridhomujizat/bot-engine/internal/engine"
	"github.com/ridhomujizat/bot-engine/internal/httperr"
	"github.com/ridhomujizat/bot-engine/internal/studioapi"

	"github.com/gin-gonic/gin"
)

// Deps are the collaborators of the HTTP layer.
type Deps struct {
	Engine         *engine.Engine
	Auth           *auth.Service
	Studio         *studioapi.Service
	ExternalPrefix string // scheme://host/prefix used in env responses
	Web            http.Handler
	Logger         *slog.Logger
}

// NewRouter builds the gin engine. Mount it on an http.Server.
func NewRouter(d Deps) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	logger := d.Logger
	if logger == nil {
		logger = slog.Default()
	}
	r.Use(gin.Recovery(), requestLog(logger))

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	r.GET("/", func(c *gin.Context) { c.Redirect(http.StatusFound, "/studio/") })
	if d.Web != nil {
		r.GET("/studio", func(c *gin.Context) { c.Redirect(http.StatusFound, "/studio/") })
		r.Any("/studio/*path", gin.WrapH(d.Web))
	}

	r.POST("/api/v1/auth/login/basic/:strategy", loginHandler(d.Auth))

	r.POST("/api/v1/bots/:botId/converse/:userId/secured",
		d.Auth.RequireToken(),
		converseHandler(d.Engine),
	)

	if d.Studio != nil {
		d.Studio.Register(r, d.Auth.RequireToken(), d.ExternalPrefix)
		d.Studio.RegisterPublic(r)
	}
	return r
}

// loginHandler implements POST /api/v1/auth/login/basic/:strategy with legacy request and response shapes.
func loginHandler(svc *auth.Service) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body struct {
			Email    string `json:"email"`
			Password string `json:"password"`
		}
		if err := json.NewDecoder(c.Request.Body).Decode(&body); err != nil || body.Email == "" {
			httperr.Write(c, httperr.BadRequest("email and password are required"))
			return
		}
		res, err := svc.Login(c.Request.Context(), c.Param("strategy"), body.Email, body.Password)
		if err != nil {
			httperr.Write(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"status":  "success",
			"message": "Login successful",
			"payload": gin.H{"jwt": res.JWT, "exp": res.Exp},
		})
	}
}

// converseHandler implements POST /api/v1/bots/:botId/converse/:userId/secured.
// The body is passed to the engine as-is, minus includedContexts (legacy omits it the same way).
func converseHandler(eng *engine.Engine) gin.HandlerFunc {
	return func(c *gin.Context) {
		botID := c.Param("botId")
		userID := c.Param("userId")

		var body map[string]any
		dec := json.NewDecoder(c.Request.Body)
		dec.UseNumber()
		if err := dec.Decode(&body); err != nil {
			httperr.Write(c, httperr.BadRequest("body must be a JSON object"))
			return
		}
		delete(body, "includedContexts")

		res, err := eng.Converse(c.Request.Context(), botID, userID, body, parseInclude(c.Query("include")))
		if err != nil {
			var ee *engine.Error
			if errors.As(err, &ee) {
				httperr.Write(c, &httperr.Error{Status: ee.Status, Type: typeForStatus(ee.Status), Message: ee.Message})
				return
			}
			httperr.Write(c, httperr.Internal(err.Error()))
			return
		}
		writeJSON(c, http.StatusOK, res)
	}
}

// parseInclude splits ?include=state,suggestions into lowercase names (legacy prepareResponse).
func parseInclude(raw string) []string {
	if raw == "" {
		return nil
	}
	var out []string
	for _, p := range strings.Split(raw, ",") {
		if p = strings.ToLower(strings.TrimSpace(p)); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func typeForStatus(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "BadRequestError"
	case http.StatusNotFound:
		return "NotFoundError"
	case http.StatusForbidden:
		return "ForbiddenError"
	case http.StatusNotImplemented:
		return "NotImplementedError"
	}
	return "InternalServerError"
}

// writeJSON encodes without HTML escaping, as JSON.stringify does.
func writeJSON(c *gin.Context, status int, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		httperr.Write(c, httperr.Internal(err.Error()))
		return
	}
	c.Data(status, "application/json; charset=utf-8", bytes.TrimRight(buf.Bytes(), "\n"))
}

// requestLog writes one structured line per request. Headers and bodies are never logged.
func requestLog(logger *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		logger.Info("http",
			"method", c.Request.Method,
			"path", c.Request.URL.Path,
			"status", c.Writer.Status(),
			"latency_ms", time.Since(start).Milliseconds(),
			"bytes", c.Writer.Size(),
		)
	}
}
