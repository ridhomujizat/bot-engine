package studioapi

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/ridhomujizat/bot-engine/internal/httperr"

	"github.com/gin-gonic/gin"
)

// sendJSON writes v with legacy key order and spacing (compact, no HTML escaping).
func sendJSON(c *gin.Context, status int, v any) {
	b, err := MarshalJS(v, 0)
	if err != nil {
		httperr.Write(c, err)
		return
	}
	c.Data(status, "application/json; charset=utf-8", b)
}

// sendSuccess mirrors legacy sendSuccess: {status, message, payload}.
func sendSuccess(c *gin.Context, message string, payload any) {
	sendJSON(c, http.StatusOK, map[string]any{"status": "success", "message": message, "payload": payload})
}

// handle wraps a handler so service errors become legacy-shaped responses.
func handle(fn func(c *gin.Context) error) gin.HandlerFunc {
	return func(c *gin.Context) {
		if err := fn(c); err != nil {
			httperr.Write(c, errorFrom(err))
		}
	}
}

// Register mounts the studio API under /api/v1/studio/:botId and the admin
// and code-editor APIs. auth must verify collaborator tokens (RequireToken).
func (s *Service) Register(r *gin.Engine, requireToken gin.HandlerFunc, externalPrefix string) {
	studio := r.Group("/api/v1/studio/:botId", requireToken, s.botGate())

	studio.GET("/flows", handle(func(c *gin.Context) error {
		flows, err := s.LoadFlows(c.Request.Context(), c.Param("botId"))
		if err != nil {
			return err
		}
		sendJSON(c, http.StatusOK, flows)
		return nil
	}))
	studio.POST("/flows", handle(func(c *gin.Context) error {
		raw, err := readBody(c)
		if err != nil {
			return err
		}
		flowObj, err := flowFromBody(raw)
		if err != nil {
			return err
		}
		if err := s.InsertFlow(c.Request.Context(), c.Param("botId"), flowObj); err != nil {
			return err
		}
		c.Status(http.StatusOK)
		return nil
	}))
	// Flow names contain "/", so one catch-all handles update, rename and delete.
	studio.POST("/flows/*flowName", handle(func(c *gin.Context) error {
		botID := c.Param("botId")
		name := strings.TrimPrefix(c.Param("flowName"), "/")
		if strings.HasSuffix(name, "/delete") {
			if err := s.DeleteFlow(c.Request.Context(), botID, strings.TrimSuffix(name, "/delete")); err != nil {
				return err
			}
			c.Status(http.StatusOK)
			return nil
		}
		raw, err := readBody(c)
		if err != nil {
			return err
		}
		flowObj, err := flowFromBody(raw)
		if err != nil {
			return err
		}
		if newName, ok := flowObj.Get("name"); ok && newName != name {
			if err := s.RenameFlow(c.Request.Context(), botID, name, newName.(string)); err != nil {
				return err
			}
			c.Status(http.StatusOK)
			return nil
		}
		if err := s.UpdateFlow(c.Request.Context(), botID, name, flowObj); err != nil {
			return err
		}
		c.Status(http.StatusOK)
		return nil
	}))

	studio.GET("/cms/types", handle(func(c *gin.Context) error {
		types, err := s.ListContentTypes(c.Request.Context(), c.Param("botId"))
		if err != nil {
			return err
		}
		sendJSON(c, http.StatusOK, map[string]any{"registered": types, "unregistered": []any{}})
		return nil
	}))
	studio.GET("/cms/elements/count", handle(func(c *gin.Context) error {
		n, err := s.countElements(c.Request.Context(), c.Param("botId"), "")
		if err != nil {
			return err
		}
		sendJSON(c, http.StatusOK, map[string]any{"count": n})
		return nil
	}))
	studio.GET("/cms/:contentType/elements/count", handle(func(c *gin.Context) error {
		n, err := s.countElements(c.Request.Context(), c.Param("botId"), c.Param("contentType"))
		if err != nil {
			return err
		}
		sendJSON(c, http.StatusOK, map[string]any{"count": n})
		return nil
	}))
	listElements := func(contentType string) gin.HandlerFunc {
		return handle(func(c *gin.Context) error {
			raw, err := readBody(c)
			if err != nil {
				return err
			}
			body, err := decodeBody(raw)
			if err != nil {
				return err
			}
			p := SearchParams{Count: defaultCount}
			if v, ok := body.Get("count"); ok {
				p.Count = ParseIntDefault(v, defaultCount)
			}
			if v, ok := body.Get("from"); ok {
				p.From = ParseIntDefault(v, 0)
			}
			if v, ok := body.Get("searchTerm"); ok {
				p.SearchTerm, _ = v.(string)
			}
			if v, ok := body.Get("ids"); ok {
				for _, id := range asSlice(v) {
					p.IDs = append(p.IDs, toString(id))
				}
			}
			els, err := s.ListElements(c.Request.Context(), c.Param("botId"), contentType, p)
			if err != nil {
				return err
			}
			sendJSON(c, http.StatusOK, els)
			return nil
		})
	}
	studio.POST("/cms/elements", listElements(""))
	studio.POST("/cms/:contentType/elements", func(c *gin.Context) { listElements(c.Param("contentType"))(c) })
	studio.GET("/cms/element/:elementId", handle(func(c *gin.Context) error {
		el, ok, err := s.GetElement(c.Request.Context(), c.Param("botId"), c.Param("elementId"))
		if err != nil {
			return err
		}
		if !ok {
			c.String(http.StatusNotFound, "Element "+c.Param("elementId")+" not found")
			return nil
		}
		sendJSON(c, http.StatusOK, el)
		return nil
	}))
	upsert := handle(func(c *gin.Context) error {
		raw, err := readBody(c)
		if err != nil {
			return err
		}
		body, err := decodeBody(raw)
		if err != nil {
			return err
		}
		fd := NewOMap()
		if v, ok := body.Get("formData"); ok {
			if m, ok := v.(*OMap); ok {
				fd = m
			}
		}
		id, err := s.UpsertElement(c.Request.Context(), c.Param("botId"), c.Param("contentType"), fd, c.Param("elementId"))
		if err != nil {
			return err
		}
		// legacy sends the element id as a plain string body.
		c.String(http.StatusOK, id)
		return nil
	})
	studio.POST("/cms/:contentType/element", upsert)
	studio.POST("/cms/:contentType/element/:elementId", upsert)
	studio.POST("/cms/elements/bulk_delete", handle(func(c *gin.Context) error {
		raw, err := readBody(c)
		if err != nil {
			return err
		}
		v, err := decodeOrdered(raw)
		if err != nil {
			return httperr.BadRequest("invalid JSON body")
		}
		var ids []string
		for _, id := range asSlice(v) {
			ids = append(ids, toString(id))
		}
		if err := s.DeleteElements(c.Request.Context(), c.Param("botId"), ids); err != nil {
			return err
		}
		c.Status(http.StatusOK)
		return nil
	}))

	studio.GET("/actions", handle(func(c *gin.Context) error {
		defs, err := s.ListActions(c.Request.Context(), c.Param("botId"))
		if err != nil {
			return err
		}
		sendJSON(c, http.StatusOK, defs)
		return nil
	}))

	studio.GET("/config", handle(func(c *gin.Context) error {
		cfg, err := s.GetBotConfig(c.Request.Context(), c.Param("botId"))
		if err != nil {
			return err
		}
		sendJSON(c, http.StatusOK, cfg)
		return nil
	}))
	studio.POST("/config", handle(func(c *gin.Context) error {
		raw, err := readBody(c)
		if err != nil {
			return err
		}
		body, err := decodeBody(raw)
		if err != nil {
			return err
		}
		botID := c.Param("botId")
		if err := s.UpdateBotConfig(c.Request.Context(), botID, body); err != nil {
			return err
		}
		sendSuccess(c, "Updated bot", map[string]any{"botId": botID})
		return nil
	}))
	studio.GET("/env", handle(func(c *gin.Context) error {
		env, err := s.Env(c.Request.Context(), c.Param("botId"), externalPrefix)
		if err != nil {
			return err
		}
		sendJSON(c, http.StatusOK, env)
		return nil
	}))
	// legacy studio-router answers an empty list here.
	studio.GET("/workspaceBotsIds", func(c *gin.Context) { sendJSON(c, http.StatusOK, []any{}) })

	studio.GET("/modules/skills", func(c *gin.Context) { sendJSON(c, http.StatusOK, ListSkills()) })
	studio.POST("/modules/:moduleName/skill/:skillId/generateFlow", handle(func(c *gin.Context) error {
		if !IsChoiceSkill(c.Param("moduleName"), c.Param("skillId")) {
			c.String(http.StatusNotFound, generateNotFound)
			return nil
		}
		raw, err := readBody(c)
		if err != nil {
			return err
		}
		body, err := decodeBody(raw)
		if err != nil {
			return err
		}
		flowObj, err := GenerateChoice(body, ParseGenerateQuery(c.Query("isOneFlow")))
		if err != nil {
			return httperr.Internal("Could not generate flow: " + err.Error())
		}
		sendJSON(c, http.StatusOK, flowObj)
		return nil
	}))
	s.registerMedia(studio)

	s.registerCodeEditor(r.Group("/api/v1/bots/:botId/mod/code-editor", requireToken, s.botGate()))

	admin := r.Group("/api/v1/admin/workspace/bots", requireToken)
	admin.GET("", handle(func(c *gin.Context) error {
		bots, err := s.ListBots(c.Request.Context())
		if err != nil {
			return err
		}
		sendSuccess(c, "Retrieved bots", map[string]any{"bots": bots})
		return nil
	}))
	admin.GET("/:botId/export", handle(func(c *gin.Context) error {
		botID := c.Param("botId")
		archive, err := s.ExportBot(c.Request.Context(), botID)
		if err != nil {
			return err
		}
		c.Header("Content-Disposition", "attachment; filename=bot_"+botID+"_"+nowMillis()+".tgz")
		c.Data(http.StatusOK, "application/tar+gzip", archive)
		return nil
	}))
	admin.POST("/:botId/import", handle(func(c *gin.Context) error {
		if !strings.HasPrefix(c.ContentType(), "application/tar+gzip") {
			return httperr.BadRequest("Bot should be imported from archive")
		}
		raw, err := readBody(c)
		if err != nil {
			return err
		}
		overwrite := c.Query("overwrite") == "true" || c.Query("overwrite") == "1"
		return s.ImportBot(c.Request.Context(), c.Param("botId"), raw, overwrite)
	}))
}

// botGate returns 404 for unknown bots and disabled bots, except GET/POST /config (legacy checkBotVisibility).
func (s *Service) botGate() gin.HandlerFunc {
	return func(c *gin.Context) {
		botID := c.Param("botId")
		if !validBotID(botID) {
			httperr.Write(c, httperr.NotFound("Invalid Bot ID"))
			return
		}
		cfg, err := s.botConfig(c.Request.Context(), botID)
		if err != nil {
			httperr.Write(c, httperr.NotFound("Invalid Bot ID"))
			return
		}
		if disabled, _ := cfg.Get("disabled"); disabled == true && !strings.HasSuffix(c.FullPath(), "/config") {
			httperr.Write(c, httperr.NotFound("Bot is disabled"))
			return
		}
		c.Next()
	}
}

func readBody(c *gin.Context) ([]byte, error) {
	if c.Request.Body == nil {
		return nil, httperr.BadRequest("empty body")
	}
	b, err := io.ReadAll(io.LimitReader(c.Request.Body, 64<<20))
	if err != nil {
		return nil, httperr.BadRequest("cannot read body")
	}
	return b, nil
}

// toString renders an id-like JSON scalar as text.
func toString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case json.Number:
		return t.String()
	}
	return ""
}
