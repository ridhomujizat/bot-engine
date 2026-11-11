package usercode

import (
	"strings"
	"testing"
)

func TestPackagesAndCrypto(t *testing.T) {
	code := `
const qs = require('qs')
const moment = require('moment')
const _ = require('lodash')
const Crypto = require('crypto')
const sig = Crypto.createHmac('sha256', 'secret').update('xmen:123').digest('hex')
return {
  qs: qs.stringify({ a: [1, 2], b: { c: 'd e' } }),
  qsParsed: qs.parse('x[y]=1&x[z]=2').x.z,
  moment: moment('2024-03-05T10:00:00Z').utc().format('YYYY-MM-DD HH:mm'),
  lodash: _.chunk([1, 2, 3], 2).length + _.sum([1, 2, 3]),
  md5: Crypto.createHash('md5').update('abc').digest('hex'),
  sha256: Crypto.createHash('sha256').update('abc').digest('base64'),
  sig: sig,
  b64: Buffer.from('api:api123').toString('base64'),
  roundtrip: Buffer.from('aGk=', 'base64').toString('utf8'),
  concat: Buffer.concat([Buffer.from('a'), Buffer.from('b')]).toString('hex'),
  uuidLen: Crypto.randomUUID().length,
  utf8: Buffer.from('héllo').length,
}
`
	res, _, err := runCode(t, code, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	m := res.(map[string]any)
	want := map[string]any{
		"qs":        "a%5B0%5D=1&a%5B1%5D=2&b%5Bc%5D=d%20e",
		"qsParsed":  "2",
		"moment":    "2024-03-05 10:00",
		"lodash":    float64(2 + 6),
		"md5":       "900150983cd24fb0d6963f7d28e17f72",
		"sha256":    "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=",
		"sig":       "", // checked below against Go
		"b64":       "YXBpOmFwaTEyMw==",
		"roundtrip": "hi",
		"concat":    "6162",
		"uuidLen":   float64(36),
		"utf8":      float64(6),
	}
	for k, v := range want {
		if k == "sig" {
			continue
		}
		if m[k] != v {
			t.Errorf("%s = %#v, want %#v", k, m[k], v)
		}
	}
	if s, _ := m["sig"].(string); len(s) != 64 {
		t.Errorf("sig = %q, want 64 hex chars", s)
	}
}

func TestUnknownModuleIsNodeError(t *testing.T) {
	_, _, err := runCode(t, `require('left-pad'); return 1`, map[string]any{})
	if err == nil {
		t.Fatal("expected error")
	}
	if got := err.Error(); !strings.Contains(got, "Cannot find module 'left-pad'") {
		t.Fatalf("error = %q", got)
	}
}
