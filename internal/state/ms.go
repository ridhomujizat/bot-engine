package state

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// msRe is the parse regex of the `ms` package v2.1.1 (used by legacy for every expiry string).
var msRe = regexp.MustCompile(`(?i)^(-?(?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$`)

const (
	msSecond = 1000.0
	msMinute = 60 * msSecond
	msHour   = 60 * msMinute
	msDay    = 24 * msHour
	msWeek   = 7 * msDay
	msYear   = 365.25 * msDay
)

// ParseMs ports `ms(string)`. It returns milliseconds and ok=false
// where the JS function returns undefined (too long, no match, unknown unit). A bare number
// means milliseconds. The empty string is NOT handled here: the JS function throws for it,
// and callers decide what to do.
func ParseMs(s string) (float64, bool) {
	if len(s) > 100 {
		return 0, false
	}
	m := msRe.FindStringSubmatch(s)
	if m == nil {
		return 0, false
	}
	n, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0, false
	}
	unit := "ms"
	if m[2] != "" {
		unit = strings.ToLower(m[2])
	}
	switch unit {
	case "years", "year", "yrs", "yr", "y":
		return n * msYear, true
	case "weeks", "week", "w":
		return n * msWeek, true
	case "days", "day", "d":
		return n * msDay, true
	case "hours", "hour", "hrs", "hr", "h":
		return n * msHour, true
	case "minutes", "minute", "mins", "min", "m":
		return n * msMinute, true
	case "seconds", "second", "secs", "sec", "s":
		return n * msSecond, true
	case "milliseconds", "millisecond", "msecs", "msec", "ms":
		return n, true
	}
	return 0, false
}

// msToDuration converts a config interval ("5m", "30m") to a Duration. Unparseable -> 0.
func msToDuration(s string) time.Duration {
	ms, ok := ParseMs(s)
	if !ok {
		return 0
	}
	return time.Duration(ms * float64(time.Millisecond))
}
