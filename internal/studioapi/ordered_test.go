package studioapi

import (
	"bytes"
	"testing"
)

// Round trip: bytes produced by JSON.stringify(x, undefined, 2) must come back identical.
func TestOrderedRoundTripIsByteIdentical(t *testing.T) {
	cases := []string{
		"{}",
		"[]",
		"{\n  \"startNode\": \"entry\",\n  \"nodes\": [\n    {\n      \"name\": \"entry\",\n      \"onEnter\": [\n        \"say #!builtin_text-pSsHWg\"\n      ],\n      \"onReceive\": null,\n      \"next\": [],\n      \"meta\": {},\n      \"n\": 1.5,\n      \"big\": 1e21,\n      \"neg\": -0.25,\n      \"b\": true,\n      \"s\": \"a \\\"q\\\" \\\\ \\n \\t \\u0001 <&>   é\"\n    }\n  ]\n}",
	}
	for _, in := range cases {
		v, err := decodeOrdered([]byte(in))
		if err != nil {
			t.Fatalf("decode: %v", err)
		}
		out, err := MarshalJS(v, 2)
		if err != nil {
			t.Fatalf("encode: %v", err)
		}
		if !bytes.Equal(out, []byte(in)) {
			t.Fatalf("not identical:\nwant:\n%s\ngot:\n%s", in, out)
		}
	}
}

func TestOMapPreservesOrderAndPicks(t *testing.T) {
	v, _ := decodeOrdered([]byte(`{"z":1,"a":{"y":2,"b":3}}`))
	m := v.(*OMap)
	m.Set("x", 9)
	m.Delete("z")
	out, _ := MarshalJS(m, 0)
	if string(out) != `{"a":{"y":2,"b":3},"x":9}` {
		t.Fatalf("compact: %s", out)
	}
	p := m.Pick("x", "missing", "a")
	if len(p.Keys) != 2 || p.Keys[0] != "x" || p.Keys[1] != "a" {
		t.Fatalf("pick order: %v", p.Keys)
	}
}
