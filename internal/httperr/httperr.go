// Package httperr writes error responses in the body shape of the legacy engine,
// so clients and the editor see the same fields they see from the legacy engine.
package httperr

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
)

const docsURL = "https://example.test/docs"

// Error is an HTTP-level error with the legacy error code and type name.
type Error struct {
	Status  int
	Code    string // legacy errorCode, e.g. "BP_0009"
	Type    string // legacy error class name, e.g. "InvalidCredentialsError"
	Message string
}

func (e *Error) Error() string { return e.Message }

// Common legacy errors.

func Unauthorized(message string) *Error {
	return &Error{Status: http.StatusUnauthorized, Code: "BP_0041", Type: "UnauthorizedError", Message: "Unauthorized: " + message}
}

func BadRequest(message string) *Error {
	return &Error{Status: http.StatusBadRequest, Code: "BP_0040", Type: "BadRequestError", Message: "Bad Request: " + message}
}

func NotFound(message string) *Error {
	return &Error{Status: http.StatusNotFound, Code: "BP_0044", Type: "NotFoundError", Message: "Not Found: " + message}
}

func Forbidden(message string) *Error {
	return &Error{Status: http.StatusForbidden, Code: "BP_0043", Type: "ForbiddenError", Message: "Forbidden: " + message}
}

func Internal(message string) *Error {
	return &Error{Status: http.StatusInternalServerError, Code: "BP_0050", Type: "InternalServerError", Message: message}
}

// Body is the JSON body legacy sends for errors.
type Body struct {
	StatusCode int    `json:"statusCode"`
	ErrorCode  string `json:"errorCode,omitempty"`
	Type       string `json:"type"`
	Message    string `json:"message"`
	Full       string `json:"full"` // legacy sends the same text here
	Details    string `json:"details"`
	Docs       string `json:"docs"`
}

// Write sends err as a legacy-shaped JSON body and aborts the gin chain.
// Non-*Error values become a 500 with the message (legacy defaults to 400 for untyped errors;
// bot-engine uses 500 because it has no request-validation TypeErrors to mirror).
func Write(c *gin.Context, err error) {
	var he *Error
	if !errors.As(err, &he) {
		he = Internal(err.Error())
	}
	c.AbortWithStatusJSON(he.Status, Body{
		StatusCode: he.Status,
		ErrorCode:  he.Code,
		Type:       he.Type,
		Message:    he.Message,
		Full:       he.Message,
		Details:    "",
		Docs:       docsURL,
	})
}
