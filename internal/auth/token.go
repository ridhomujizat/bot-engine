package auth

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Audience is the JWT audience legacy uses for global (collaborator) strategies.
const Audience = "collaborators"

// DefaultTokenDuration matches legacy jwtToken.duration default.
const DefaultTokenDuration = time.Hour

// TokenUser is the verified identity attached to a request.
type TokenUser struct {
	Email        string
	Strategy     string
	TokenVersion int
	IsSuperAdmin bool
}

// signer issues and verifies HS256 tokens with the legacy claim layout.
type signer struct {
	secret   []byte
	duration time.Duration
	now      func() time.Time
}

// issue returns the signed token and its lifetime in milliseconds (legacy sends ms(duration)).
func (s signer) issue(u TokenUser) (string, int64, error) {
	now := s.now()
	claims := jwt.MapClaims{
		"email":        u.Email,
		"strategy":     u.Strategy,
		"tokenVersion": u.TokenVersion,
		"isSuperAdmin": u.IsSuperAdmin,
		"aud":          Audience,
		"iat":          now.Unix(),
		"exp":          now.Add(s.duration).Unix(),
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := tok.SignedString(s.secret)
	if err != nil {
		return "", 0, err
	}
	return signed, s.duration.Milliseconds(), nil
}

// parse verifies signature, expiry and audience, and returns the identity claims.
func (s signer) parse(raw string) (TokenUser, error) {
	claims := jwt.MapClaims{}
	_, err := jwt.NewParser(
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithAudience(Audience),
		jwt.WithTimeFunc(s.now),
	).ParseWithClaims(raw, claims, func(*jwt.Token) (any, error) { return s.secret, nil })
	if err != nil {
		return TokenUser{}, err
	}
	email, _ := claims["email"].(string)
	strategy, _ := claims["strategy"].(string)
	tv, ok := claims["tokenVersion"].(float64)
	if email == "" || strategy == "" || !ok {
		return TokenUser{}, errors.New("auth: token is missing identity claims")
	}
	super, _ := claims["isSuperAdmin"].(bool)
	return TokenUser{Email: email, Strategy: strategy, TokenVersion: int(tv), IsSuperAdmin: super}, nil
}

// ParseDuration reads legacy duration strings such as "1h", "30m", "2d", or plain seconds.
func ParseDuration(s string) (time.Duration, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return DefaultTokenDuration, nil
	}
	if n, err := strconv.Atoi(s); err == nil {
		return time.Duration(n) * time.Second, nil
	}
	if strings.HasSuffix(s, "d") {
		n, err := strconv.Atoi(strings.TrimSuffix(s, "d"))
		if err != nil {
			return 0, fmt.Errorf("auth: bad duration %q", s)
		}
		return time.Duration(n) * 24 * time.Hour, nil
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0, fmt.Errorf("auth: bad duration %q", s)
	}
	return d, nil
}
