package auth

import (
	"strings"

	"github.com/ridhomujizat/bot-engine/internal/httperr"

	"github.com/gin-gonic/gin"
)

// ContextKey is the gin context key holding the TokenUser set by RequireToken.
const ContextKey = "bot-engine.tokenUser"

// RequireToken returns middleware that verifies "Authorization: Bearer <jwt>"
// (legacy checkTokenHeader, cookie mode off). Failures answer 401 with the legacy body.
func (s *Service) RequireToken() gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.GetHeader("Authorization")
		if h == "" {
			httperr.Write(c, httperr.Unauthorized("Authorization header is missing"))
			return
		}
		parts := strings.SplitN(h, " ", 2)
		if strings.ToLower(parts[0]) != "bearer" {
			httperr.Write(c, httperr.Unauthorized(`Unknown scheme "`+parts[0]+`"`))
			return
		}
		if len(parts) < 2 || parts[1] == "" {
			httperr.Write(c, httperr.Unauthorized("Authentication token is missing"))
			return
		}
		tu, err := s.Verify(c.Request.Context(), parts[1])
		if err != nil {
			httperr.Write(c, httperr.Unauthorized("Invalid authentication token"))
			return
		}
		c.Set(ContextKey, tu)
		c.Next()
	}
}

// UserFrom returns the TokenUser set by RequireToken.
func UserFrom(c *gin.Context) (TokenUser, bool) {
	v, ok := c.Get(ContextKey)
	if !ok {
		return TokenUser{}, false
	}
	tu, ok := v.(TokenUser)
	return tu, ok
}
