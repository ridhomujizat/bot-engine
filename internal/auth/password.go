// Package auth implements the legacy "basic" login strategy and collaborator JWTs,
// so tokens and password hashes issued by legacy keep working after cutover.
package auth

import (
	"crypto/hmac"
	"crypto/sha512"
	"encoding/hex"
)

// HashPassword returns the legacy password hash: hex(HMAC-SHA512(key = salt, msg = password)).
// legacy generates salts with 16 hex characters.
func HashPassword(password, salt string) string {
	mac := hmac.New(sha512.New, []byte(salt))
	mac.Write([]byte(password))
	return hex.EncodeToString(mac.Sum(nil))
}

// VerifyPassword reports whether password matches the stored hash and salt.
// It compares in constant time. Empty stored values never match.
func VerifyPassword(password, hash, salt string) bool {
	if hash == "" || salt == "" {
		return false
	}
	return hmac.Equal([]byte(HashPassword(password, salt)), []byte(hash))
}
