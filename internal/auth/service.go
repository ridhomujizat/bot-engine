package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/ridhomujizat/bot-engine/internal/httperr"
)

// Options configure the auth service from legacy.config.json.
type Options struct {
	Secret      []byte
	Duration    time.Duration // jwtToken.duration; default 1h
	Strategies  map[string]StrategyOptions
	SuperAdmins []Account
	Now         func() time.Time // nil means time.Now
}

// StrategyOptions mirrors authStrategies.<id>.options that the basic login reads.
type StrategyOptions struct {
	MaxLoginAttempt int
	LockoutDuration time.Duration // 0 means a locked account stays locked
}

// Account identifies a user by email and strategy.
type Account struct {
	Email    string
	Strategy string
}

// Service handles login and token verification.
type Service struct {
	users  UserStore
	signer signer
	opts   Options
	now    func() time.Time
}

// New builds a Service. Secret must not be empty.
func New(users UserStore, opts Options) (*Service, error) {
	if len(opts.Secret) == 0 {
		return nil, errors.New("auth: empty secret")
	}
	if opts.Duration <= 0 {
		opts.Duration = DefaultTokenDuration
	}
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	return &Service{
		users:  users,
		signer: signer{secret: opts.Secret, duration: opts.Duration, now: now},
		opts:   opts,
		now:    now,
	}, nil
}

// LoginResult is the payload of a successful login (legacy: {jwt, exp}; csrf is cookie-mode only).
type LoginResult struct {
	JWT string `json:"jwt"`
	Exp int64  `json:"exp"` // lifetime in ms, as legacy's ms(duration)
}

// Login checks email and password for strategy and returns a collaborator token.
// Errors are *httperr.Error with the legacy status and code (400 BP_0009 for bad credentials).
func (s *Service) Login(ctx context.Context, strategy, email, password string) (LoginResult, error) {
	email = strings.ToLower(email)
	if email == SERVERUser {
		return LoginResult{}, invalidCredentials()
	}
	user, err := s.users.FindUser(ctx, email, strategy)
	if err != nil {
		return LoginResult{}, err
	}
	if user == nil {
		return LoginResult{}, invalidCredentials()
	}
	so := s.opts.Strategies[strategy]

	if locked, _ := user.Attributes["locked_out"].(bool); locked {
		expired := false
		if so.LockoutDuration > 0 {
			if last, ok := parseTime(user.Attributes["last_login_attempt"]); ok {
				expired = s.now().After(last.Add(so.LockoutDuration))
			}
		}
		if !expired {
			return LoginResult{}, &httperr.Error{Status: http.StatusBadRequest, Code: "BP_0011", Type: "LockedOutError", Message: "Account locked out"}
		}
	}

	if !VerifyPassword(password, user.Password, user.Salt) {
		if err := s.recordFailure(ctx, user, so); err != nil {
			return LoginResult{}, err
		}
		return LoginResult{}, invalidCredentials()
	}

	if expired, _ := user.Attributes["password_expired"].(bool); expired {
		return LoginResult{}, &httperr.Error{Status: http.StatusBadRequest, Code: "BP_0010", Type: "PasswordExpiredError", Message: "Password Expired"}
	}
	if exp, ok := parseTime(user.Attributes["password_expiry_date"]); ok && s.now().After(exp) {
		return LoginResult{}, &httperr.Error{Status: http.StatusBadRequest, Code: "BP_0010", Type: "PasswordExpiredError", Message: "Password Expired"}
	}

	if err := s.users.PatchAttributes(ctx, user.Email, strategy, map[string]any{
		"unsuccessful_logins": 0,
		"last_login_attempt":  nil,
		"locked_out":          false,
		"last_logon":          s.now().UTC().Format(time.RFC3339Nano),
	}); err != nil {
		return LoginResult{}, err
	}

	jwt, ms, err := s.signer.issue(TokenUser{
		Email:        user.Email,
		Strategy:     strategy,
		TokenVersion: user.TokenVersion,
		IsSuperAdmin: s.isSuperAdmin(user.Email, strategy),
	})
	if err != nil {
		return LoginResult{}, httperr.Internal(err.Error())
	}
	return LoginResult{JWT: jwt, Exp: ms}, nil
}

// SERVERUser is the internal legacy pseudo-user; it can never log in.
const SERVERUser = "server::modules"

func (s *Service) recordFailure(ctx context.Context, user *User, so StrategyOptions) error {
	count := 1
	if n, ok := toInt(user.Attributes["unsuccessful_logins"]); ok {
		count = n + 1
	}
	patch := map[string]any{
		"unsuccessful_logins": count,
		"last_login_attempt":  s.now().UTC().Format(time.RFC3339Nano),
	}
	if so.MaxLoginAttempt > 0 && count > so.MaxLoginAttempt {
		patch["locked_out"] = true
	}
	return s.users.PatchAttributes(ctx, user.Email, user.Strategy, patch)
}

func (s *Service) isSuperAdmin(email, strategy string) bool {
	for _, a := range s.opts.SuperAdmins {
		if a.Strategy == strategy && strings.EqualFold(a.Email, email) {
			return true
		}
	}
	return false
}

// Verify checks a raw "Bearer" token value. It requires a valid signature, audience and
// expiry, and a tokenVersion that still matches the user (so password resets revoke tokens).
func (s *Service) Verify(ctx context.Context, raw string) (TokenUser, error) {
	tu, err := s.signer.parse(raw)
	if err != nil {
		return TokenUser{}, err
	}
	user, err := s.users.FindUser(ctx, tu.Email, tu.Strategy)
	if err != nil {
		return TokenUser{}, err
	}
	if user == nil || user.TokenVersion != tu.TokenVersion {
		return TokenUser{}, errors.New("auth: token version mismatch or unknown user")
	}
	tu.IsSuperAdmin = s.isSuperAdmin(tu.Email, tu.Strategy)
	return tu, nil
}

func invalidCredentials() error {
	return &httperr.Error{Status: http.StatusBadRequest, Code: "BP_0009", Type: "InvalidCredentialsError", Message: "Invalid credentials"}
}

// toInt accepts the numeric forms an attribute can hold (JSON gives float64).
func toInt(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		return int(n), true
	case int:
		return n, true
	}
	return 0, false
}
